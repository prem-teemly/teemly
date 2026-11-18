// New departments suggested in conversations (migration 013), shown in the inbox. The owner creates
// one (it becomes a department, like adding it in Settings) or ignores it. All statements are
// parameterized.

import { getPool, withTransaction } from "./pool.js";
import { WorkError } from "./personWork.js";
import { createDepartment, listDepartments, parseDepartment } from "./departments.js";
import { hexId } from "../util.js";

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const keyOf = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(department|dept|team|division|cell|wing)\b/g, " ").replace(/\s+/g, " ").trim();

/** Is there a department with this name already (name, slug or the name without "team")? */
async function existing(name) {
  const k = keyOf(name);
  return (await listDepartments({ fresh: true })).find((d) => keyOf(d.name) === k || keyOf(d.slug.replace(/-/g, " ")) === k) ?? null;
}

/**
 * Store the department ideas of one conversation. Skipped: a department that exists now, and a name
 * already waiting in the inbox (from any conversation) or already decided for this one. Returns how many.
 */
export async function recordDepartmentIdeas(jobId, ideas) {
  if (!ideas?.length) return 0;
  let added = 0;
  for (const idea of ideas) {
    if (await existing(idea.name)) continue;
    const done = await withTransaction(async (conn) => {
      const [[same]] = await conn.execute("SELECT id FROM department_suggestions WHERE name_key = ? AND (status = 'pending' OR job_id = ?) LIMIT 1 FOR UPDATE", [idea.key, jobId]);
      if (same) return false;
      await conn.execute(
        `INSERT INTO department_suggestions (id, job_id, name, name_key, description, reason, said_by, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [hexId(), jobId, idea.name, idea.key, idea.description, idea.reason, idea.said_by || null, JSON.stringify(idea.evidence ?? []), new Date()],
      );
      return true;
    });
    if (done) added += 1;
  }
  return added;
}

const STATUS = { pending: "pending", added: "created", created: "created", ignored: "ignored" };

/** Suggested departments for the inbox tab ("pending", "added" = created, "ignored"), newest first. */
export async function listDepartmentIdeas(status = "pending") {
  const [rows] = await getPool().query(
    `SELECT s.*, j.kind, f.original_name, d.slug AS department_slug
       FROM department_suggestions s
       JOIN processing_jobs j ON j.id = s.job_id JOIN audio_files f ON f.id = j.audio_file_id
       LEFT JOIN departments d ON d.id = s.department_id
      WHERE s.status = ? ORDER BY s.created_at DESC LIMIT 100`,
    [STATUS[status] ?? "pending"],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    name: r.name,
    description: r.description,
    reason: r.reason,
    said_by: r.said_by,
    evidence: parseJson(r.evidence) ?? [],
    source: { job_id: r.job_id, kind: r.kind, file_name: r.original_name },
    department: r.department_id && r.department_slug ? { id: r.department_id, slug: r.department_slug } : null,
    found_at: iso(r.created_at),
    decided_at: iso(r.decided_at),
  }));
}

export async function pendingIdeasCount() {
  try {
    const [[r]] = await getPool().query("SELECT COUNT(*) AS n FROM department_suggestions WHERE status = 'pending'");
    return Number(r.n);
  } catch {
    return 0; // migration 013 not applied yet
  }
}

async function lockPending(conn, id) {
  const [[s]] = await conn.execute("SELECT * FROM department_suggestions WHERE id = ? FOR UPDATE", [id]);
  if (!s) throw new WorkError(404, "This suggestion was not found.");
  if (s.status !== "pending") throw new WorkError(409, `This suggestion was already ${s.status === "created" ? "created" : "ignored"}.`);
  return s;
}

/**
 * Create the department (the owner may edit the name, colour and description first) and mark the
 * suggestion created. A department with that name created meanwhile is a 409.
 */
export async function createFromIdea(id, edits = {}) {
  const s = await withTransaction((conn) => lockPending(conn, id));
  const data = parseDepartment({ name: edits.name ?? s.name, color: edits.color, description: edits.description === undefined ? s.description : edits.description });
  const clash = await existing(data.name);
  if (clash) throw new WorkError(409, `A department called "${clash.name}" already exists.`);
  const dept = await createDepartment(data);
  await getPool().execute("UPDATE department_suggestions SET status = 'created', department_id = ?, decided_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'pending'", [dept.id, id]);
  return dept;
}

export async function ignoreIdea(id) {
  await withTransaction(async (conn) => {
    await lockPending(conn, id);
    await conn.execute("UPDATE department_suggestions SET status = 'ignored', decided_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
  });
}
