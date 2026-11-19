// Notes and opportunities on a person's page (tables from migration 006). All statements are
// parameterized; inputs are validated by the routes before they reach here. Every row belongs to the
// signed-in user (user_id, migration 023): reads and changes only ever touch the current user's rows.

import { getPool, withTransaction } from "./pool.js";
import { STAGE_CHANCE } from "../stages.js";
import { uid } from "../tenant.js";
import { hexId } from "../util.js";

/** A change that cannot be made (HTTP status in `status`). */
export class WorkError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "WorkError";
    this.status = status;
  }
}

/**
 * Log one stage move (migration 014): by the owner (panel, person page) or the AI (a later call moved
 * the deal on). Inside the caller's transaction; skipped quietly before migration 014 is applied.
 */
export async function logStageChange(conn, opportunityId, from, to, changedBy = "owner", jobId = null) {
  if (from === to) return;
  try {
    await conn.execute("INSERT INTO opportunity_stage_changes (opportunity_id, from_stage, to_stage, changed_by, source_job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [opportunityId, from, to, changedBy, jobId, new Date()]);
  } catch (exc) {
    if (exc?.code !== "ER_NO_SUCH_TABLE") throw exc;
  }
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const CLOSED = new Set(["Won", "Lost"]);

async function assertPerson(conn, personId) {
  const [[row]] = await conn.execute("SELECT id FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [personId, uid()]);
  if (!row) throw new WorkError(404, "Person not found.");
}

// ---------------------------------------------------------------------------- notes

const publicNote = (r) => ({ id: r.id, body: r.body, pinned: Boolean(r.pinned), created_at: iso(r.created_at), updated_at: iso(r.updated_at) });

/** A person's notes: pinned first, then newest first. */
export async function listNotes(personId) {
  const [rows] = await getPool().execute("SELECT * FROM person_notes WHERE person_id = ? AND user_id = ? ORDER BY pinned DESC, created_at DESC, id LIMIT 500", [personId, uid()]);
  return rows.map(publicNote);
}

export async function createNote(personId, { body, pinned = false }) {
  return withTransaction(async (conn) => {
    await assertPerson(conn, personId);
    const id = hexId();
    const now = new Date();
    await conn.execute("INSERT INTO person_notes (id, user_id, person_id, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, uid(), personId, body, pinned ? 1 : 0, now, now]);
    return publicNote({ id, body, pinned, created_at: now, updated_at: now });
  });
}

/** Change a note's text and/or pin. Returns the note, or null if it does not exist. */
export async function updateNote(id, { body, pinned }) {
  const sets = [];
  const params = [];
  if (body !== undefined) {
    // updated_at means "the text was edited": pinning alone does not change it.
    sets.push("body = ?", "updated_at = ?");
    params.push(body, new Date());
  }
  if (pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(pinned ? 1 : 0);
  }
  const db = getPool();
  const user = uid();
  if (sets.length) {
    const [r] = await db.execute(`UPDATE person_notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...params, id, user]);
    if (!r.affectedRows) return null;
  }
  const [[row]] = await db.execute("SELECT * FROM person_notes WHERE id = ? AND user_id = ?", [id, user]);
  return row ? publicNote(row) : null;
}

export async function deleteNote(id) {
  const [r] = await getPool().execute("DELETE FROM person_notes WHERE id = ? AND user_id = ?", [id, uid()]);
  return r.affectedRows > 0;
}

// -------------------------------------------------------------------- opportunities

// Callers add `WHERE o.user_id = ? AND …`: an opportunity is only ever read by its owner.
export const OPP_SELECT = `
  SELECT o.*, j.kind AS source_kind, f.original_name AS source_name, f.duration_seconds AS source_duration, UNIX_TIMESTAMP(f.created_at) AS source_epoch
  FROM opportunities o
  LEFT JOIN processing_jobs j ON j.id = o.source_job_id AND j.user_id = o.user_id
  LEFT JOIN audio_files f ON f.id = j.audio_file_id`;

export const publicOpportunity = (r) => ({
  id: r.id,
  person_id: r.person_id,
  title: r.title,
  stage: r.stage,
  department: r.department,
  value_inr: r.value_inr === null ? null : Number(r.value_inr),
  // The owner's chance for this deal (migration 015), else the stage's chance.
  chance_pct: r.chance_pct === null || r.chance_pct === undefined ? null : Number(r.chance_pct),
  chance: chanceOf(r),
  next_step: r.next_step,
  due_date: day(r.due_date),
  // Upload time: read with UNIX_TIMESTAMP (written in the session time zone, see repository.js).
  source: r.source_job_id
    ? {
        job_id: r.source_job_id,
        kind: r.source_kind,
        file_name: r.source_name,
        duration_seconds: r.source_duration === null || r.source_duration === undefined ? null : Number(r.source_duration),
        at: new Date(Math.round(Number(r.source_epoch) * 1000)).toISOString(),
      }
    : null,
  // 'ai' = captured from the source conversation; its cited lines are in `evidence`.
  origin: r.origin ?? "manual",
  evidence: (typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence) ?? [],
  closed_at: iso(r.closed_at),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

/** A person's opportunities: open ones first (by due date), then won/lost. */
export async function listOpportunities(personId) {
  const [rows] = await getPool().execute(
    `${OPP_SELECT} WHERE o.user_id = ? AND o.person_id = ?
     ORDER BY o.stage IN ('Won','Lost'), o.due_date IS NULL, o.due_date, o.created_at DESC LIMIT 500`,
    [uid(), personId],
  );
  return rows.map(publicOpportunity);
}

/** The source conversation must be one on this person's timeline. */
async function assertSource(conn, personId, jobId) {
  if (!jobId) return;
  const [[m]] = await conn.execute("SELECT 1 AS ok FROM person_mentions WHERE person_id = ? AND job_id = ?", [personId, jobId]);
  if (!m) throw new WorkError(422, "source_job_id: should be a call or chat on this person's timeline");
}

const FIELDS = ["title", "stage", "department", "value_inr", "chance_pct", "next_step", "due_date", "source_job_id"];

/** A deal's chance of closing (0-1): the owner's chance if set, else its stage's. */
export const chanceOf = (r) => (r.chance_pct === null || r.chance_pct === undefined ? (STAGE_CHANCE[r.stage] ?? 0) : Number(r.chance_pct) / 100);

export async function createOpportunity(personId, data) {
  return withTransaction(async (conn) => {
    await assertPerson(conn, personId);
    await assertSource(conn, personId, data.source_job_id);
    const id = hexId();
    const now = new Date();
    const stage = data.stage ?? "Identified";
    const user = uid();
    await conn.execute(
      `INSERT INTO opportunities (id, user_id, person_id, title, stage, department, value_inr, next_step, due_date, source_job_id, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, user, personId, data.title, stage, data.department ?? null, data.value_inr ?? null, data.next_step ?? null, data.due_date ?? null, data.source_job_id ?? null, CLOSED.has(stage) ? now : null, now, now],
    );
    await logStageChange(conn, id, null, stage, "owner");
    const [[row]] = await conn.execute(`${OPP_SELECT} WHERE o.user_id = ? AND o.id = ?`, [user, id]);
    return publicOpportunity(row);
  });
}

/** Change some fields. Won/Lost sets closed_at (once); moving back to an open stage clears it. */
export async function updateOpportunity(id, data) {
  const user = uid();
  return withTransaction(async (conn) => {
    const [[cur]] = await conn.execute("SELECT person_id, stage FROM opportunities WHERE id = ? AND user_id = ? FOR UPDATE", [id, user]);
    if (!cur) return null;
    if (data.source_job_id !== undefined) await assertSource(conn, cur.person_id, data.source_job_id);
    const sets = [];
    const params = [];
    for (const f of FIELDS) {
      if (data[f] === undefined) continue;
      sets.push(`${f} = ?`);
      params.push(data[f]);
    }
    if (data.stage !== undefined && CLOSED.has(data.stage) !== CLOSED.has(cur.stage)) {
      sets.push("closed_at = ?");
      params.push(CLOSED.has(data.stage) ? new Date() : null);
    }
    // A new stage brings its own chance: the owner's chance for the old stage no longer applies.
    if (data.stage !== undefined && data.stage !== cur.stage && data.chance_pct === undefined) sets.push("chance_pct = NULL");
    if (sets.length) await conn.execute(`UPDATE opportunities SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND user_id = ?`, [...params, new Date(), id, user]);
    if (data.stage !== undefined) await logStageChange(conn, id, cur.stage, data.stage, "owner");
    const [[row]] = await conn.execute(`${OPP_SELECT} WHERE o.user_id = ? AND o.id = ?`, [user, id]);
    return publicOpportunity(row);
  });
}

export async function deleteOpportunity(id) {
  const [r] = await getPool().execute("DELETE FROM opportunities WHERE id = ? AND user_id = ?", [id, uid()]);
  return r.affectedRows > 0;
}
