// The opportunity panel: every opportunity (from calls, or added by the owner) with its person, stage
// and chance, and "nudges" when something has stalled. Moving a card uses the normal opportunity
// update (POST /api/opportunities/:id { stage }), which logs the move.
//
// Nudges are plain facts from the data, never guesses: a next step past its due date, a deal whose
// person has not been in a call or chat for a while, a deal that has not moved for weeks, a deal
// committed long ago but not marked won. Each says what was seen and suggests a move; the owner decides.

import { getPool } from "./pool.js";
import { chanceOf } from "./personWork.js";
import { CLOSED_STAGES, OPEN_STAGES, STAGES, STAGE_CHANCE, stageIndex } from "../stages.js";
import { uid } from "../tenant.js";

const DAY = 86_400_000;
const QUIET_DAYS = 14; // no call or chat with the person
const STALLED_DAYS = 21; // the deal has not changed
const COMMITTED_DAYS = 14; // committed but not marked won

const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const isoOf = (epoch) => (epoch === null || epoch === undefined ? null : new Date(Math.round(Number(epoch) * 1000)).toISOString());
const initialsOf = (name) => {
  const w = String(name).split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || "?";
};
const fmtInr = (v) => (v >= 1e7 ? `₹${+(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString("en-IN")}`);

/** The board: stages (with chance), every opportunity, and nudges. */
export async function opportunityBoard({ now = Date.now() } = {}) {
  const db = getPool();
  const user = uid();
  // people and opportunities times are written from JavaScript Dates (read back as Dates);
  // audio_files.created_at is written by MySQL (read with UNIX_TIMESTAMP), as elsewhere.
  const [rows] = await db.query(
    `SELECT o.id, o.title, o.stage, o.department, o.value_inr, o.chance_pct, o.next_step, o.due_date, o.origin, o.source_job_id,
            o.created_at, o.updated_at, o.closed_at,
            p.id AS person_id, p.name AS person_name, p.category, p.role_title, p.organisation, p.city, p.score, p.last_contact_at, p.last_contact_kind,
            j.kind AS source_kind, f.original_name AS source_name, UNIX_TIMESTAMP(f.created_at) AS source_epoch
       FROM opportunities o
       JOIN people p ON p.id = o.person_id AND p.user_id = o.user_id
       LEFT JOIN processing_jobs j ON j.id = o.source_job_id AND j.user_id = o.user_id
       LEFT JOIN audio_files f ON f.id = j.audio_file_id
      WHERE o.user_id = ?
      ORDER BY o.updated_at DESC`,
    [user],
  );
  // Each opportunity's latest stage change (migration 014): when, and the stage it came from (so the
  // card can say "from Negotiation" after a move). Before that table, its last update.
  let moved = new Map();
  let cameFrom = new Map();
  try {
    const [m] = await db.query(
      `SELECT c.opportunity_id, c.from_stage, c.to_stage, c.created_at AS at
         FROM opportunity_stage_changes c
         JOIN (SELECT sc.opportunity_id, MAX(sc.id) AS last_id
                 FROM opportunity_stage_changes sc JOIN opportunities o ON o.id = sc.opportunity_id
                WHERE o.user_id = ? GROUP BY sc.opportunity_id) l ON l.last_id = c.id`,
      [user],
    );
    moved = new Map(m.map((r) => [r.opportunity_id, dateIso(r.at)]));
    cameFrom = new Map(m.filter((r) => r.from_stage).map((r) => [r.opportunity_id, { stage: r.from_stage, to: r.to_stage, at: dateIso(r.at) }]));
  } catch (exc) {
    if (exc?.code !== "ER_NO_SUCH_TABLE") throw exc;
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const opportunities = rows.map((r) => {
    const stage = r.stage;
    const lastContact = dateIso(r.last_contact_at);
    const stageSince = moved.get(r.id) ?? dateIso(r.created_at);
    const due = dayOf(r.due_date);
    const open = !CLOSED_STAGES.includes(stage);
    return {
      id: r.id,
      title: r.title,
      stage,
      chance: chanceOf(r),
      chance_pct: r.chance_pct === null ? null : Number(r.chance_pct),
      department: r.department,
      value_inr: r.value_inr === null ? null : Number(r.value_inr),
      next_step: r.next_step,
      due_date: due,
      overdue: open && !!due && due < today,
      origin: r.origin ?? "manual",
      person: {
        id: r.person_id,
        name: r.person_name,
        initials: initialsOf(r.person_name),
        category: r.category,
        role_title: r.role_title,
        organisation: r.organisation,
        city: r.city,
        score: r.score === null ? null : Number(r.score), // null = interest not clear yet
        last_contact_at: lastContact,
        last_contact_kind: r.last_contact_kind,
      },
      source: r.source_job_id ? { job_id: r.source_job_id, kind: r.source_kind, file_name: r.source_name, at: isoOf(r.source_epoch) } : null,
      stage_since: stageSince,
      // The stage it was in before its latest move (only when that move brought it to where it is now).
      came_from: (() => {
        const c = cameFrom.get(r.id);
        return c && c.to === stage ? { stage: c.stage, at: c.at } : null;
      })(),
      created_at: dateIso(r.created_at),
      updated_at: dateIso(r.updated_at),
      closed_at: dateIso(r.closed_at),
    };
  });

  return {
    stages: STAGES.map((s) => ({ stage: s, chance: STAGE_CHANCE[s], open: OPEN_STAGES.includes(s) })),
    opportunities,
    nudges: nudgesFor(opportunities, now),
  };
}

/** One step back in the flow (for "move it back"), or null at the start. */
const stepBack = (stage) => {
  const i = stageIndex(stage);
  return i > 0 ? STAGES[i - 1] : null;
};

/** Facts that need the owner, most important first (at most 5). */
export function nudgesFor(opportunities, now = Date.now()) {
  const out = [];
  const daysSince = (iso) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : null);
  for (const o of opportunities) {
    if (CLOSED_STAGES.includes(o.stage)) continue;
    const who = o.person.name;
    const amount = o.value_inr ? ` (${fmtInr(o.value_inr)})` : "";
    if (o.overdue) {
      out.push({ opportunity_id: o.id, kind: "overdue", rank: 1, value: o.value_inr ?? 0, text: `${who}: “${o.next_step ?? "the next step"}” on ${o.title}${amount} was due ${o.due_date}. Do it, or move the deal back.`, move_to: stepBack(o.stage) });
      continue;
    }
    const quiet = daysSince(o.person.last_contact_at);
    if (quiet !== null && quiet >= QUIET_DAYS && stageIndex(o.stage) > 0) {
      out.push({ opportunity_id: o.id, kind: "quiet", rank: 2, value: o.value_inr ?? 0, text: `No call with ${who} for ${quiet} days on ${o.title}${amount}. Follow up, or move it back to “${stepBack(o.stage)}”.`, move_to: stepBack(o.stage) });
      continue;
    }
    const still = daysSince(o.stage_since);
    if (o.stage === "Committed" && still !== null && still >= COMMITTED_DAYS) {
      out.push({ opportunity_id: o.id, kind: "committed", rank: 3, value: o.value_inr ?? 0, text: `${who} committed to ${o.title}${amount} ${still} days ago. Mark it Won when the money is in, or follow up.`, move_to: "Won" });
      continue;
    }
    if (still !== null && still >= STALLED_DAYS) {
      out.push({ opportunity_id: o.id, kind: "stalled", rank: 4, value: o.value_inr ?? 0, text: `${o.title}${amount} with ${who} has been in “${o.stage}” for ${still} days.`, move_to: null });
    }
  }
  return out
    .sort((a, b) => a.rank - b.rank || b.value - a.value)
    .slice(0, 5)
    .map(({ rank, value, ...n }) => n);
}
