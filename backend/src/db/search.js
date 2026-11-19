// Global search (the search box in the top bar): the current user's people, deals, calls and notes
// whose words contain what was typed. A few of each, best match first; only the signed-in user's room.

import { getPool } from "./pool.js";
import { uid } from "../tenant.js";

export const MIN_QUERY = 2;
const PER_KIND = 5;

/** `text` for a LIKE pattern: % and _ match themselves. */
const likeOf = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
/** A short piece of `text` around the first match. */
function snippet(text, q, width = 90) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || s.length <= width) return s.slice(0, width);
  const from = Math.max(0, i - 30);
  return `${from ? "…" : ""}${s.slice(from, from + width)}${from + width < s.length ? "…" : ""}`;
}

/** { people, opportunities, calls, notes } matching `q` (each at most 5, names first). */
export async function searchRoom(q) {
  const db = getPool();
  const user = uid();
  const like = likeOf(q);
  const starts = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const [people] = await db.query(
    `SELECT id, name, role_title, organisation, city, category
       FROM people
      WHERE user_id = ? AND (name LIKE ? OR organisation LIKE ? OR city LIKE ? OR role_title LIKE ? OR phone LIKE ?)
      ORDER BY name LIKE ? DESC, last_contact_at DESC LIMIT ?`,
    [user, like, like, like, like, like, starts, PER_KIND],
  );
  const [opps] = await db.query(
    `SELECT o.id, o.title, o.stage, o.value_inr, o.department, p.id AS person_id, p.name AS person
       FROM opportunities o JOIN people p ON p.id = o.person_id AND p.user_id = o.user_id
      WHERE o.user_id = ? AND (o.title LIKE ? OR o.next_step LIKE ? OR p.name LIKE ?)
      ORDER BY o.stage IN ('Won','Lost'), o.title LIKE ? DESC, o.updated_at DESC LIMIT ?`,
    [user, like, like, like, starts, PER_KIND],
  );
  // Calls: by file name, or by a person in them; each opens on the timeline of its first person.
  const [calls] = await db.query(
    `SELECT j.id AS job_id, j.kind, f.original_name, f.created_at,
            (SELECT m.person_id FROM person_mentions m JOIN people p ON p.id = m.person_id
              WHERE m.job_id = j.id AND p.user_id = j.user_id ORDER BY m.relation = 'participant' DESC, m.id LIMIT 1) AS person_id,
            (SELECT p.name FROM person_mentions m JOIN people p ON p.id = m.person_id
              WHERE m.job_id = j.id AND p.user_id = j.user_id ORDER BY m.relation = 'participant' DESC, m.id LIMIT 1) AS person
       FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id
      WHERE j.user_id = ? AND j.status = 'completed'
        AND (f.original_name LIKE ? OR EXISTS (SELECT 1 FROM person_mentions m JOIN people p ON p.id = m.person_id
                                                WHERE m.job_id = j.id AND p.user_id = j.user_id AND p.name LIKE ?))
      ORDER BY f.created_at DESC LIMIT ?`,
    [user, like, like, PER_KIND],
  );
  const [notes] = await db.query(
    `SELECT n.id, n.body, n.updated_at, p.id AS person_id, p.name AS person
       FROM person_notes n JOIN people p ON p.id = n.person_id AND p.user_id = n.user_id
      WHERE n.user_id = ? AND n.body LIKE ?
      ORDER BY n.updated_at DESC LIMIT ?`,
    [user, like, PER_KIND],
  );

  return {
    people: people.map((p) => ({ id: p.id, name: p.name, sub: [p.role_title, p.organisation, p.city].filter(Boolean).join(" · ") || p.category || null, link: `/people/${p.id}` })),
    opportunities: opps.map((o) => ({ id: o.id, title: o.title, sub: [o.person, o.stage, o.department].filter(Boolean).join(" · "), value_inr: o.value_inr === null ? null : Number(o.value_inr), link: `/opportunities/${o.id}` })),
    calls: calls
      .filter((c) => c.person_id) // a call opens on a person's timeline
      .map((c) => ({ id: c.job_id, title: String(c.original_name ?? "Call").replace(/\.[^.]+$/, ""), sub: [c.person, c.kind === "whatsapp" ? "Chat" : "Call"].filter(Boolean).join(" · "), at: iso(c.created_at), link: `/people/${c.person_id}/calls/${c.job_id}` })),
    notes: notes.map((n) => ({ id: n.id, title: snippet(n.body, q), sub: `Note on ${n.person}`, at: iso(n.updated_at), link: `/people/${n.person_id}` })),
  };
}
