// People and the new-person inbox in MySQL (tables from migrations 004 and 005). All statements are
// parameterized.
//
// recordPeople() handles the people found in one finished job, in one transaction:
//   - a name that matches exactly one person in People adds this conversation to their timeline;
//   - a person talked about who is not in People yet, or whose name matches more than one person,
//     becomes an inbox suggestion. Nobody is added to People without the owner's approval, and two
//     people with the same name are never merged on the name alone;
//   - someone who only took part (a speaker or chat sender) and is not in People is not suggested.
// approveSuggestion() / ignoreSuggestion() are the owner's decision on a suggestion.
//
// Every person, suggestion and opportunity belongs to the signed-in user (user_id, migration 023):
// each statement is limited to the current user's rows (uid()), so one account never reads, matches,
// links or changes another account's people.

import { getPool, withTransaction } from "./pool.js";
import { CATEGORIES, initialsOf, interestScore, localYmd, nameKey, scoreValue } from "../services/people.js";
import { dueFromWords } from "../dueWords.js";
import { uid } from "../tenant.js";
import { hexId } from "../util.js";
import { WorkError, logStageChange } from "./personWork.js";
import { AI_STAGES, normalizeStage, stageIndex } from "../stages.js";

const splitSet = (s) => (Array.isArray(s) ? s : s ? String(s).split(",").filter(Boolean) : []);
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
// Department names are checked against the departments table before they get here (AI answers and
// the owner's input); this only keeps the stored list well-formed (no commas, no empties, no dups).
const deptSet = (...lists) =>
  [...new Set(lists.flat())]
    .filter((d) => typeof d === "string" && d.trim() && !d.includes(",") && d.length <= 40)
    .join(",")
    .slice(0, 1000);

/** A decision on the inbox that cannot be made (HTTP status in `status`). */
export class InboxError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "InboxError";
    this.status = status;
  }
}

// ------------------------------------------------------------------------- helpers

/**
 * Add what one conversation says to a person (a category the owner chose is never changed, and a
 * department the owner took them out of is never added back).
 */
async function applyFacts(conn, id, p, kind, at) {
  const [[row]] = await conn.execute("SELECT departments, departments_removed FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [id, uid()]);
  if (!row) return;
  const removed = splitSet(row.departments_removed);
  p = { ...p, departments: splitSet(p.departments).filter((d) => !removed.includes(d)) };
  await conn.execute(
    `UPDATE people SET category = IF(category_locked, category, COALESCE(?, category)), role_title = COALESCE(?, role_title),
       organisation = COALESCE(?, organisation), city = COALESCE(?, city), departments = ?,
       last_contact_kind = IF(? >= last_contact_at, ?, last_contact_kind), last_contact_at = GREATEST(last_contact_at, ?)
     WHERE id = ? AND user_id = ?`,
    [p.category, p.role_title, p.organisation, p.city, deptSet(splitSet(row.departments), splitSet(p.departments)), at, kind, at, id, uid()],
  );
}

/** Store (or replace, when the same job is processed again) a job's mention of a person. */
async function upsertMention(conn, personId, jobId, p, at) {
  await conn.execute(
    `INSERT INTO person_mentions (person_id, job_id, relation, category, role_title, organisation, city, departments, interest,
       introduced_by_name, context, quote, evidence_lines, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE relation = new.relation, category = new.category, role_title = new.role_title,
       organisation = new.organisation, city = new.city, departments = new.departments, interest = new.interest,
       introduced_by_name = new.introduced_by_name, context = new.context, quote = new.quote,
       evidence_lines = new.evidence_lines`,
    [personId, jobId, p.relation, p.category, p.role_title, p.organisation, p.city, deptSet(p.departments ?? []), p.interest, p.introduced_by, p.context, p.quote, JSON.stringify(p.evidence), at],
  );
}

const normOrg = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Facts in a conversation that do not fit the one person in People with this name: a different city
 * or a different company (both said, and neither contains the other). Then it may be someone else
 * with the same name, so the owner is asked instead of the call being added to that person.
 * The category is not compared: it is often worded differently for the same person.
 */
export function detailsConflict(known, p) {
  const out = [];
  if (known.city && p.city && known.city.toLowerCase() !== p.city.toLowerCase()) out.push({ field: "city", known: known.city, said: p.city });
  const a = normOrg(known.organisation);
  const b = normOrg(p.organisation);
  if (a && b && !a.includes(b) && !b.includes(a)) out.push({ field: "organisation", known: known.organisation, said: p.organisation });
  // Two people with one name in different departments ("Prem" in Sales, "Prem" in Tech & AI): a call
  // about the other department may be the other Prem, so the owner is asked instead of guessing.
  const kd = splitSet(known.departments);
  const pd = splitSet(p.departments);
  if (kd.length && pd.length && !pd.some((d) => kd.includes(d))) out.push({ field: "department", known: kd.join(", "), said: pd.join(", ") });
  return out;
}

/** The last 4 digits of a phone number: enough to tell two same-name people apart, never the number. */
const phoneEnd = (phone) => (phone ? String(phone).replace(/\D/g, "").slice(-4) || null : null);

/** Who introduced whom: linked only when the introducer is exactly one known person (first introduction kept). */
async function linkIntroducer(conn, personId, introducedBy) {
  if (!introducedBy) return;
  const user = uid();
  const [rows] = await conn.execute("SELECT id FROM people WHERE user_id = ? AND name_key = ? LIMIT 2", [user, nameKey(introducedBy)]);
  if (rows.length === 1 && rows[0].id !== personId) {
    await conn.execute("UPDATE people SET introduced_by_id = ? WHERE id = ? AND user_id = ? AND introduced_by_id IS NULL", [rows[0].id, personId, user]);
  }
}

/**
 * Score: average interest across every conversation the person appears in. Snapshot: what the
 * conversation that says most about who they are (category, role, organisation, city) said; the
 * newest wins a tie, so a passing mention never replaces a real description.
 */
async function refresh(conn, id) {
  const [rows] = await conn.execute("SELECT interest, category, role_title, organisation, city, context FROM person_mentions WHERE person_id = ? ORDER BY created_at, id", [id]);
  const facts = (m) => [m.category, m.role_title, m.organisation, m.city].filter(Boolean).length;
  const best = rows.reduce((a, m) => (!a || facts(m) >= facts(a) ? m : a), null);
  const score = interestScore(rows.map((r) => r.interest)); // oldest to newest; null = not clear yet
  await conn.execute("UPDATE people SET summary = COALESCE(?, summary), score = ? WHERE id = ? AND user_id = ?", [best?.context ?? null, score, id, uid()]);
}

const TITLE_STOP = new Set(["the", "a", "an", "for", "of", "to", "in", "on", "and", "with", "teemly", "deal", "opportunity"]);
/** A word's stem, so "distribution" / "distributor" / "distributing" or "licence" / "licences" match. */
const stem = (w) => {
  let s = w.length > 4 ? w.replace(/(?<!s)s$/, "") : w;
  const cut = s.replace(/(ions?|ors?|ers?|ings?|ments?|ships?|ance|ence)$/, "");
  if (cut.length >= 4) s = cut;
  return s;
};
const titleWords = (t) => new Set(String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !TITLE_STOP.has(w)).map(stem));

/**
 * The same deal, said again in another conversation: the same amount in the same department, or
 * titles that share most of their words ("Teemly launch campaign" / "Launch campaign for Teemly").
 */
export function sameDeal(existing, o) {
  const value = (v) => (v === null || v === undefined ? null : Number(v));
  const a = titleWords(existing.title);
  const b = titleWords(o.title);
  const shared = [...a].filter((w) => b.has(w)).length; // stems: plurals and word forms already match
  const sameValue = value(o.value_inr) !== null && value(o.value_inr) === value(existing.value_inr);
  const sameDept = (o.department ?? null) === (existing.department ?? null);
  // Same amount, same department and something in common in the title.
  if (sameValue && sameDept && shared >= 1) return true;
  // No amount said this time ("the distribution to the 200 shops"), same department and something in
  // common in the title: the deal already open with them, talked about again.
  if (value(o.value_inr) === null && sameDept && existing.department && shared >= 1) return true;
  // Nearly the same title, and no amount that says otherwise.
  if (!a.size || !b.size) return false;
  return shared / Math.min(a.size, b.size) >= 0.8 && (value(o.value_inr) === null || value(existing.value_inr) === null || sameValue);
}

/**
 * Opportunities the AI found with a person in one conversation, added to their Opportunities with
 * that conversation as the source (origin 'ai'). Captured once per person per conversation: when the
 * same job is processed again the AI may word a title differently, so if this conversation already
 * gave this person AI opportunities nothing is added (the owner's edits and deletes stay). Returns how many.
 */
async function addOpportunities(conn, personId, jobId, opportunities) {
  if (!opportunities?.length) return 0;
  const user = uid();
  const [[already]] = await conn.execute("SELECT 1 AS ok FROM opportunities WHERE user_id = ? AND person_id = ? AND source_job_id = ? AND origin = 'ai' LIMIT 1", [user, personId, jobId]);
  if (already) return 0;
  // The person's open opportunities: a later call often talks about the same deal again ("the
  // campaign for two lakh, as we discussed"). That moves the existing one on instead of adding a copy.
  const [open] = await conn.execute("SELECT id, title, stage, department, value_inr, next_step, due_date, origin FROM opportunities WHERE user_id = ? AND person_id = ? AND stage NOT IN ('Won','Lost') FOR UPDATE", [user, personId]);
  let added = 0;
  for (const raw of opportunities ?? []) {
    // Suggestions saved before migration 014 may still say "Proposal"; the AI never sets Won/Lost.
    const stage = AI_STAGES.includes(normalizeStage(raw.stage)) ? normalizeStage(raw.stage) : "Identified";
    const o = { ...raw, stage };
    const [[dup]] = await conn.execute("SELECT 1 AS ok FROM opportunities WHERE user_id = ? AND person_id = ? AND source_job_id = ? AND title = ? LIMIT 1", [user, personId, jobId, o.title]);
    if (dup) continue;
    const same = open.find((e) => sameDeal(e, o));
    if (same) {
      // Only AI-captured ones are moved on (stage forward, a newly said next step); the owner's own
      // opportunities are left exactly as they are. Never backwards: the owner may have moved it on.
      if (same.origin === "ai") {
        const forward = stageIndex(o.stage) > stageIndex(same.stage);
        // A date said in a later call fills an empty due date (a date already set is never changed).
        const newDate = o.due_date && !same.due_date ? o.due_date : null;
        if (forward || (o.next_step && o.next_step !== same.next_step) || newDate) {
          await conn.execute("UPDATE opportunities SET stage = ?, next_step = COALESCE(?, next_step), due_date = COALESCE(due_date, ?), updated_at = ? WHERE id = ? AND user_id = ?", [forward ? o.stage : same.stage, o.next_step ?? null, newDate, new Date(), same.id, user]);
          if (newDate) same.due_date = newDate;
          if (forward) {
            await logStageChange(conn, same.id, same.stage, o.stage, "ai", jobId);
            same.stage = o.stage;
          }
        }
      }
      continue;
    }
    const now = new Date();
    const newId = hexId();
    await conn.execute(
      `INSERT INTO opportunities (id, user_id, person_id, title, stage, department, value_inr, next_step, due_date, source_job_id, origin, evidence, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, NULL, ?, ?)`,
      [newId, uid(), personId, o.title, o.stage, o.department ?? null, o.value_inr ?? null, o.next_step ?? null, o.due_date ?? null, jobId, JSON.stringify(o.evidence ?? []), now, now],
    );
    await logStageChange(conn, newId, null, o.stage, "ai", jobId);
    added += 1;
  }
  return added;
}

/** The cited lines, kept with the suggestion so its evidence survives (speaker, time, words). */
function evidenceOf(p, lines) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  let ids = p.evidence;
  if (!ids.length) ids = lines.filter((l) => nameKey(l.speaker ?? "") === p.key).slice(0, 2).map((l) => l.id);
  return ids
    .map((i) => byId.get(i))
    .filter(Boolean)
    .slice(0, 6)
    .map((l) => ({ id: l.id, speaker: l.speaker ?? null, time_label: l.time_label ?? null, text: String(l.original ?? "").slice(0, 600), english: l.english ? String(l.english).slice(0, 600) : null }));
}

// ---------------------------------------------------------------------- after a job

/**
 * Handle the validated people of one job (see the top of this file). `lines` are the job's numbered
 * lines (for the evidence kept with a suggestion). Returns { linked: [person ids], suggested: n }.
 */
export async function recordPeople(jobId, kind, people, lines = [], target = null) {
  if (!people.length) return { linked: [], suggested: 0, opportunities: 0 };
  // A file added on a person's page: that person's name (or first name) in it is them.
  const targetFirst = target ? target.key.split(" ")[0] : null;
  const isTarget = (p) => !!target && (p.key === target.key || p.key.split(" ")[0] === targetFirst);
  const user = uid();
  return withTransaction(async (conn) => {
    const now = new Date();
    const linked = new Map(); // name key -> person id
    let suggested = 0;
    let opportunities = 0; // captured for people already in People
    for (const p of people) {
      if (isTarget(p)) {
        await applyFacts(conn, target.id, p, kind, now);
        await upsertMention(conn, target.id, jobId, p, now);
        opportunities += await addOpportunities(conn, target.id, jobId, p.opportunities);
        linked.set(p.key, target.id);
        continue;
      }
      const [[decided]] = await conn.execute("SELECT id, status FROM person_suggestions WHERE user_id = ? AND job_id = ? AND name_key = ? FOR UPDATE", [user, jobId, p.key]);
      if (decided?.status === "ignored") continue; // the owner said no for this conversation
      const [matches] = await conn.execute("SELECT id, city, organisation, departments FROM people WHERE user_id = ? AND name_key = ? LIMIT 2 FOR UPDATE", [user, p.key]);

      // Exactly one person with this name, and nothing in this conversation says otherwise: it is them.
      // A different city or company means it may be someone else: the owner is asked (inbox).
      if (matches.length === 1 && !detailsConflict(matches[0], p).length) {
        const id = matches[0].id;
        await applyFacts(conn, id, p, kind, now);
        await upsertMention(conn, id, jobId, p, now);
        opportunities += await addOpportunities(conn, id, jobId, p.opportunities);
        linked.set(p.key, id);
        continue;
      }
      if (p.relation === "participant" && matches.length === 0) continue; // speakers are not suggested
      if (decided && decided.status !== "pending") continue;

      // Opportunities with someone new wait on the suggestion until the owner approves the person.
      // The AI's department suggestion (with why) is shown on the inbox item to route the person.
      const values = [p.name, p.relation, p.category, p.role_title, p.organisation, p.city, deptSet(p.departments), JSON.stringify(p.department_suggestions ?? []), p.interest, p.introduced_by, p.context, p.quote, JSON.stringify(evidenceOf(p, lines)), JSON.stringify(p.opportunities ?? [])];
      if (decided) {
        await conn.execute(
          `UPDATE person_suggestions SET name = ?, relation = ?, category = ?, role_title = ?, organisation = ?, city = ?, departments = ?, department_suggestions = ?,
             interest = ?, introduced_by_name = ?, context = ?, quote = ?, evidence = ?, opportunities = ? WHERE id = ? AND user_id = ?`,
          [...values, decided.id, user],
        );
      } else {
        await conn.execute(
          `INSERT INTO person_suggestions (name, relation, category, role_title, organisation, city, departments, department_suggestions, interest,
             introduced_by_name, context, quote, evidence, opportunities, id, user_id, job_id, name_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, hexId(), user, jobId, p.key, now],
        );
      }
      suggested += 1;
    }
    for (const p of people) if (linked.has(p.key)) await linkIntroducer(conn, linked.get(p.key), p.introduced_by);
    for (const id of new Set(linked.values())) await refresh(conn, id);
    return { linked: [...linked.values()], suggested, opportunities };
  });
}

// ------------------------------------------------------------- files added on a person's page

/** Set or clear a person's phone number. A number saved for someone else is a 409. */
export async function setPhone(id, phone) {
  try {
    const [r] = await getPool().execute("UPDATE people SET phone = ? WHERE id = ? AND user_id = ?", [phone, id, uid()]);
    return r.affectedRows > 0;
  } catch (exc) {
    if (exc?.code === "ER_DUP_ENTRY") throw new WorkError(409, "This phone number is already saved for another person.");
    throw exc;
  }
}

/**
 * The owner sets a person's departments (names already checked against the departments table).
 * Departments taken away are remembered so later calls do not add them back; ones given back are
 * forgotten from that list. Returns the new list, or null when the person does not exist.
 */
export async function setDepartments(id, departments) {
  const user = uid();
  return withTransaction(async (conn) => {
    const [[row]] = await conn.execute("SELECT departments, departments_removed FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [id, user]);
    if (!row) return null;
    const next = splitSet(deptSet(departments));
    const takenAway = splitSet(row.departments).filter((d) => !next.includes(d));
    const removed = [...splitSet(row.departments_removed), ...takenAway].filter((d) => !next.includes(d));
    await conn.execute("UPDATE people SET departments = ?, departments_removed = ? WHERE id = ? AND user_id = ?", [deptSet(next), deptSet(removed), id, user]);
    return next;
  });
}

/** People already in People with this name (to ask before adding someone with the same name). */
export async function sameNamePeople(name) {
  const [rows] = await getPool().query("SELECT id, name, city, organisation, departments, phone FROM people WHERE user_id = ? AND name_key = ? ORDER BY last_contact_at DESC LIMIT 5", [uid(), nameKey(name)]);
  return rows.map((r) => ({ id: r.id, name: r.name, city: r.city, organisation: r.organisation, departments: splitSet(r.departments), phone_end: phoneEnd(r.phone) }));
}

/** The person a phone number (E.164, e.g. +919876543210) is saved for, or null. */
export async function personByPhone(phone) {
  if (!phone) return null;
  const [[r]] = await getPool().query("SELECT id, name, city, organisation, departments, phone FROM people WHERE user_id = ? AND phone = ? LIMIT 1", [uid(), phone]);
  return r ? { id: r.id, name: r.name, city: r.city, organisation: r.organisation, departments: splitSet(r.departments), phone_end: phoneEnd(r.phone) } : null;
}

/**
 * The owner adds a person by hand (no call or chat yet). `form` is checked by the route
 * (parseNewPerson); `introducedById`: someone already in People. Returns the new person's id.
 */
export async function createPerson(form, { introducedById = null } = {}) {
  const user = uid();
  return withTransaction(async (conn) => {
    if (introducedById) {
      const [[intro]] = await conn.execute("SELECT id FROM people WHERE id = ? AND user_id = ?", [introducedById, user]);
      if (!intro) throw new WorkError(422, "introduced_by_id: that person is no longer in People");
    }
    const id = hexId();
    const now = new Date();
    try {
      await conn.execute(
        `INSERT INTO people (id, user_id, name, name_key, category, category_locked, role_title, organisation, city, phone, departments, consent,
           introduced_by_id, summary, first_seen_at, last_contact_at, last_contact_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'added')`,
        [
          id, user, form.name, nameKey(form.name), form.category ?? null, form.category ? 1 : 0, form.role_title ?? null, form.organisation ?? null,
          form.city ?? null, form.phone ?? null, deptSet(form.departments ?? []), form.consent ?? "Ask", introducedById, form.context ?? null, now, now,
        ],
      );
    } catch (exc) {
      if (exc?.code === "ER_DUP_ENTRY") throw new WorkError(409, "This phone number is already saved for another person.");
      throw exc;
    }
    return id;
  });
}

/** { id, name, key } of a person, or null. */
export async function personRef(id) {
  const [[row]] = await getPool().execute("SELECT id, name, name_key FROM people WHERE id = ? AND user_id = ?", [id, uid()]);
  return row ? { id: row.id, name: row.name, key: row.name_key } : null;
}

/** Remember that a job was uploaded on a person's page (processing_jobs.person_id, migration 007). */
export async function setJobPerson(jobId, personId) {
  const user = uid();
  await getPool().execute(
    "UPDATE processing_jobs j JOIN people p ON p.id = ? AND p.user_id = j.user_id SET j.person_id = p.id WHERE j.id = ? AND j.user_id = ?",
    [personId, jobId, user],
  );
}

/**
 * Make sure a job uploaded on a person's page is on their timeline, even when the AI did not find
 * them in it (then as a participant, with `context` as what it was about). Does nothing if the job is
 * already on their timeline. Returns true when a mention was added.
 */
export async function linkJobToPerson(jobId, kind, personId, context) {
  const user = uid();
  return withTransaction(async (conn) => {
    const [[person]] = await conn.execute("SELECT id FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [personId, user]);
    if (!person) return false;
    const [[job]] = await conn.execute("SELECT 1 AS ok FROM processing_jobs WHERE id = ? AND user_id = ?", [jobId, user]);
    if (!job) return false;
    const [[has]] = await conn.execute("SELECT 1 AS ok FROM person_mentions WHERE person_id = ? AND job_id = ?", [personId, jobId]);
    if (has) return false;
    const now = new Date();
    const p = { relation: "participant", category: null, role_title: null, organisation: null, city: null, departments: [], interest: "unknown", introduced_by: null, context, quote: null, evidence: [] };
    await applyFacts(conn, personId, p, kind, now);
    await upsertMention(conn, personId, jobId, p, now);
    await refresh(conn, personId);
    return true;
  });
}

// ----------------------------------------------------- a call on the wrong person's timeline

/**
 * Take away what one conversation gave a person, after it was moved off their timeline: a city,
 * company, role or category that only that conversation said goes back to what their other
 * conversations say; its departments go unless another conversation or an opportunity keeps them
 * (only when every remaining conversation recorded its departments, migration 011).
 */
async function forgetFacts(conn, id, moved) {
  const user = uid();
  const [[person]] = await conn.execute("SELECT category, category_locked, role_title, organisation, city, departments, summary FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [id, user]);
  if (!person) return;
  const [rest] = await conn.execute("SELECT category, role_title, organisation, city, departments, context FROM person_mentions WHERE person_id = ? ORDER BY created_at, id", [id]);
  const latest = (f) => [...rest].reverse().find((r) => r[f])?.[f] ?? null;
  const sets = [];
  const params = [];
  // The AI snapshot came from the moved conversation: refresh() picks one of the remaining ones.
  if (person.summary && person.summary === moved.context) {
    sets.push("summary = ?");
    params.push(latest("context"));
  }
  for (const f of ["role_title", "organisation", "city", "category"]) {
    if (f === "category" && person.category_locked) continue;
    // Only a value that came from the moved conversation (and from no other one) is changed.
    if (moved[f] && person[f] === moved[f] && !rest.some((r) => r[f] === moved[f])) {
      sets.push(`${f} = ?`);
      params.push(latest(f));
    }
  }
  const movedDepts = splitSet(moved.departments);
  if (movedDepts.length && rest.every((r) => r.departments !== null)) {
    const [opps] = await conn.execute("SELECT DISTINCT department FROM opportunities WHERE user_id = ? AND person_id = ? AND department IS NOT NULL", [user, id]);
    const keep = new Set([...rest.flatMap((r) => splitSet(r.departments)), ...opps.map((o) => o.department)]);
    const next = splitSet(person.departments).filter((d) => !movedDepts.includes(d) || keep.has(d));
    sets.push("departments = ?");
    params.push(deptSet(next));
  }
  if (sets.length) await conn.execute(`UPDATE people SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...params, id, user]);
}

/**
 * Move a conversation from one person's timeline (two people with the same name, the wrong one got
 * it): to another person in People, or back to the inbox as a new suggestion ("someone new"), where
 * the owner adds the right person. Its AI opportunities move with it; the first person keeps only
 * what their other conversations say. `lines` (the job's numbered lines) give the inbox its evidence.
 * Returns { person_id } or { suggestion_id }.
 */
export async function moveMention(fromId, jobId, { toPersonId = null, toInbox = false, lines = [] } = {}) {
  const user = uid();
  return withTransaction(async (conn) => {
    const [[m]] = await conn.execute(
      `SELECT m.*, j.kind, p.name, p.name_key FROM person_mentions m
         JOIN people p ON p.id = m.person_id JOIN processing_jobs j ON j.id = m.job_id
        WHERE m.person_id = ? AND m.job_id = ? AND p.user_id = ? AND j.user_id = ? FOR UPDATE`,
      [fromId, jobId, user, user],
    );
    if (!m) throw new WorkError(404, "This conversation is not on this person's timeline.");
    const [opps] = await conn.execute("SELECT * FROM opportunities WHERE user_id = ? AND person_id = ? AND source_job_id = ? AND origin = 'ai' FOR UPDATE", [user, fromId, jobId]);
    const at = m.created_at instanceof Date ? m.created_at : new Date(m.created_at);
    let result;

    if (toPersonId) {
      if (toPersonId === fromId) throw new WorkError(422, "person_id: choose a different person");
      const [[to]] = await conn.execute("SELECT id FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [toPersonId, user]);
      if (!to) throw new WorkError(404, "That person is not in People.");
      const [[has]] = await conn.execute("SELECT id FROM person_mentions WHERE person_id = ? AND job_id = ?", [toPersonId, jobId]);
      if (has) await conn.execute("DELETE FROM person_mentions WHERE id = ?", [m.id]);
      else await conn.execute("UPDATE person_mentions SET person_id = ? WHERE id = ?", [toPersonId, m.id]);
      const [[toHasOpps]] = await conn.execute("SELECT 1 AS ok FROM opportunities WHERE user_id = ? AND person_id = ? AND source_job_id = ? AND origin = 'ai' LIMIT 1", [user, toPersonId, jobId]);
      if (opps.length) {
        if (toHasOpps) await conn.query("DELETE FROM opportunities WHERE user_id = ? AND id IN (?)", [user, opps.map((o) => o.id)]);
        else await conn.query("UPDATE opportunities SET person_id = ?, updated_at = ? WHERE user_id = ? AND id IN (?)", [toPersonId, new Date(), user, opps.map((o) => o.id)]);
      }
      await applyFacts(conn, toPersonId, { ...m, departments: splitSet(m.departments) }, m.kind, at);
      await linkIntroducer(conn, toPersonId, m.introduced_by_name);
      await refresh(conn, toPersonId);
      result = { person_id: toPersonId };
    } else if (toInbox) {
      // The suggestion this conversation would have made for "someone new" with this name.
      const evidence = evidenceOf({ evidence: parseJson(m.evidence_lines) ?? [], key: m.name_key }, lines);
      const oppsJson = opps.map((o) => ({ title: o.title, stage: o.stage, department: o.department, value_inr: o.value_inr === null ? null : Number(o.value_inr), next_step: o.next_step, evidence: parseJson(o.evidence) ?? [] }));
      const values = [m.name, m.relation, m.category, m.role_title, m.organisation, m.city, m.departments ?? "", m.interest, m.introduced_by_name, m.context, m.quote, JSON.stringify(evidence), JSON.stringify(oppsJson)];
      const [[old]] = await conn.execute("SELECT id FROM person_suggestions WHERE user_id = ? AND job_id = ? AND name_key = ? FOR UPDATE", [user, jobId, m.name_key]);
      let sid = old?.id;
      if (old) {
        await conn.execute(
          `UPDATE person_suggestions SET name = ?, relation = ?, category = ?, role_title = ?, organisation = ?, city = ?, departments = ?,
             interest = ?, introduced_by_name = ?, context = ?, quote = ?, evidence = ?, opportunities = ?,
             status = 'pending', person_id = NULL, decided_at = NULL WHERE id = ? AND user_id = ?`,
          [...values, sid, user],
        );
      } else {
        sid = hexId();
        await conn.execute(
          `INSERT INTO person_suggestions (name, relation, category, role_title, organisation, city, departments, interest,
             introduced_by_name, context, quote, evidence, opportunities, id, user_id, job_id, name_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, sid, user, jobId, m.name_key, new Date()],
        );
      }
      if (opps.length) await conn.query("DELETE FROM opportunities WHERE user_id = ? AND id IN (?)", [user, opps.map((o) => o.id)]);
      await conn.execute("DELETE FROM person_mentions WHERE id = ?", [m.id]);
      result = { suggestion_id: sid };
    } else {
      throw new WorkError(422, "Choose a person, or send it to the inbox as someone new.");
    }

    await forgetFacts(conn, fromId, m);
    await refresh(conn, fromId);
    return result;
  });
}

// ---------------------------------------------------------------------------- inbox

const SUGGESTION_SELECT = `
  SELECT s.*, j.kind, f.original_name, f.duration_seconds
  FROM person_suggestions s
  JOIN processing_jobs j ON j.id = s.job_id
  JOIN audio_files f ON f.id = j.audio_file_id`;

/** A suggestion's departments with the AI's reasons (only departments still on the item). */
function suggestionsOf(r) {
  const depts = splitSet(r.departments);
  const saved = (parseJson(r.department_suggestions) ?? []).filter((s) => depts.includes(s.department));
  for (const d of depts) if (!saved.some((s) => s.department === d)) saved.push({ department: d, reason: null, confidence: null, evidence: [] });
  return saved.map((s) => ({ department: s.department, reason: s.reason ?? null, confidence: s.confidence ?? null, evidence: (s.evidence ?? []).map(({ id, speaker, time_label, text, english }) => ({ id, speaker, time_label, text, english })) }));
}

/** Inbox items, newest first, each with the people that share its name and its introducer. */
export async function listSuggestions({ status = "pending", limit = 200 } = {}) {
  const db = getPool();
  const user = uid();
  const [rows] = await db.query(`${SUGGESTION_SELECT} WHERE s.user_id = ? AND s.status = ? ORDER BY s.created_at DESC, s.id LIMIT ?`, [user, status, limit]);
  const keys = [...new Set(rows.flatMap((r) => [r.name_key, r.introduced_by_name ? nameKey(r.introduced_by_name) : null]).filter(Boolean))];
  const firsts = [...new Set(rows.map((r) => r.name_key.split(" ")[0]))];
  const byKey = new Map();
  const all = [];
  if (keys.length) {
    // Same name, or the same first name (to show "Vimal" as a possible match for "Vimal Raj").
    const [people] = await db.query(
      `SELECT p.id, p.name, p.name_key, p.category, p.role_title, p.organisation, p.city, p.departments, p.phone,
              (SELECT COUNT(*) FROM person_mentions m WHERE m.person_id = p.id) AS mention_count
       FROM people p WHERE p.user_id = ? AND (p.name_key IN (?) OR SUBSTRING_INDEX(p.name_key, ' ', 1) IN (?)) ORDER BY p.last_contact_at DESC`,
      [user, keys, firsts],
    );
    for (const p of people) {
      const card = { id: p.id, name: p.name, initials: initialsOf(p.name), category: p.category, role_title: p.role_title, organisation: p.organisation, city: p.city, departments: splitSet(p.departments), phone_end: phoneEnd(p.phone), mention_count: Number(p.mention_count) };
      all.push({ key: p.name_key, card });
      const list = byKey.get(p.name_key) ?? [];
      list.push(card);
      byKey.set(p.name_key, list);
    }
  }
  /**
   * Possible matches for a suggestion: everyone with the same name; and, when either name is a first
   * name only, everyone with the same first name ("Vimal" / "Vimal Raj"). Two different full names
   * ("Vimal Raj" / "Vimal Kumar") are not a match.
   */
  const matchesFor = (key) => {
    const first = key.split(" ")[0];
    const single = !key.includes(" ");
    return all.filter((x) => x.key === key || ((single || !x.key.includes(" ")) && x.key.split(" ")[0] === first)).map((x) => x.card);
  };
  return rows.map((r) => {
    const introKey = r.introduced_by_name ? nameKey(r.introduced_by_name) : null;
    const introMatches = introKey ? (byKey.get(introKey) ?? []) : [];
    return {
      id: r.id,
      status: r.status,
      name: r.name,
      initials: initialsOf(r.name),
      relation: r.relation,
      category: CATEGORIES.includes(r.category) ? r.category : null,
      role_title: r.role_title,
      organisation: r.organisation,
      city: r.city,
      departments: splitSet(r.departments),
      // Why each department (AI, from the conversation). Older items: the departments without a reason.
      department_suggestions: suggestionsOf(r),
      interest: r.interest,
      introduced_by: r.introduced_by_name ? { name: r.introduced_by_name, person: introMatches.length === 1 ? { id: introMatches[0].id, name: introMatches[0].name } : null } : null,
      context: r.context,
      quote: r.quote,
      evidence: parseJson(r.evidence) ?? [],
      opportunities: (parseJson(r.opportunities) ?? []).map((o) => ({ title: o.title, stage: o.stage, department: o.department, value_inr: o.value_inr, next_step: o.next_step })),
      matches: matchesFor(r.name_key),
      source: { job_id: r.job_id, kind: r.kind, file_name: r.original_name, duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds) },
      person_id: r.person_id,
      found_at: iso(r.created_at),
      decided_at: iso(r.decided_at),
    };
  });
}

export async function pendingCount() {
  const [[row]] = await getPool().query("SELECT COUNT(*) AS n FROM person_suggestions WHERE user_id = ? AND status = 'pending'", [uid()]);
  return Number(row.n);
}

async function lockPending(conn, id) {
  const [[s]] = await conn.execute(`${SUGGESTION_SELECT} WHERE s.id = ? AND s.user_id = ? FOR UPDATE`, [id, uid()]);
  if (!s) throw new InboxError(404, "This inbox item was not found.");
  if (s.status !== "pending") throw new InboxError(409, `This item was already ${s.status === "added" ? "added" : "ignored"}.`);
  return s;
}

/**
 * Add the person of a suggestion to People. With `personId`, the conversation is added to that
 * existing person; otherwise a new person is created from the owner's (edited) details in `form`:
 * { name, city, phone, category, departments, role_title, organisation, consent, context }.
 * Returns the person id. One transaction: the suggestion is decided exactly once.
 */
export async function approveSuggestion(id, { personId = null, form = {} } = {}) {
  return withTransaction(async (conn) => {
    const s = await lockPending(conn, id);
    const at = s.created_at instanceof Date ? s.created_at : new Date(s.created_at);
    const evidence = parseJson(s.evidence) ?? [];
    const mention = {
      relation: s.relation,
      category: s.category,
      role_title: s.role_title,
      organisation: s.organisation,
      city: s.city,
      departments: form.departments ?? splitSet(s.departments),
      interest: s.interest,
      introduced_by: s.introduced_by_name,
      context: form.context || s.context,
      quote: s.quote,
      evidence: evidence.map((e) => e.id),
    };

    const user = uid();
    let target = personId;
    if (target) {
      const [[row]] = await conn.execute("SELECT id FROM people WHERE id = ? AND user_id = ? FOR UPDATE", [target, user]);
      if (!row) throw new InboxError(404, "That person is no longer in People.");
      await applyFacts(conn, target, mention, s.kind, at);
    } else {
      target = hexId();
      const name = form.name || s.name;
      const category = form.category === undefined ? s.category : form.category;
      try {
        await conn.execute(
          `INSERT INTO people (id, user_id, name, name_key, category, category_locked, role_title, organisation, city, phone, departments, consent,
             summary, first_seen_at, last_contact_at, last_contact_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            target, user, name, nameKey(name), category, category !== s.category ? 1 : 0,
            form.role_title === undefined ? s.role_title : form.role_title,
            form.organisation === undefined ? s.organisation : form.organisation,
            form.city === undefined ? s.city : form.city,
            form.phone ?? null,
            deptSet(form.departments ?? splitSet(s.departments)),
            form.consent ?? "Ask",
            mention.context, at, at, s.kind,
          ],
        );
      } catch (exc) {
        if (exc?.code === "ER_DUP_ENTRY") throw new InboxError(409, "This phone number is already saved for another person.");
        throw exc;
      }
    }
    await upsertMention(conn, target, s.job_id, mention, at);
    await addOpportunities(conn, target, s.job_id, parseJson(s.opportunities) ?? []);
    await linkIntroducer(conn, target, s.introduced_by_name);
    await refresh(conn, target);
    await conn.execute("UPDATE person_suggestions SET status = 'added', person_id = ?, decided_at = UTC_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [target, id, user]);
    return target;
  });
}

/** The owner does not want this person: nothing is added, and this conversation will not suggest them again. */
export async function ignoreSuggestion(id) {
  return withTransaction(async (conn) => {
    await lockPending(conn, id);
    await conn.execute("UPDATE person_suggestions SET status = 'ignored', decided_at = UTC_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [id, uid()]);
  });
}

// --------------------------------------------------------------------------- people

function publicPerson(r) {
  return {
    id: r.id,
    name: r.name,
    initials: initialsOf(r.name),
    category: CATEGORIES.includes(r.category) ? r.category : null,
    category_locked: Boolean(r.category_locked),
    role_title: r.role_title,
    organisation: r.organisation,
    city: r.city,
    phone: r.phone ?? null,
    departments: splitSet(r.departments),
    score: scoreValue(r.score),
    consent: r.consent,
    summary: r.summary,
    introduced_by: r.intro_id ? { id: r.intro_id, name: r.intro_name } : null,
    mention_count: Number(r.mention_count ?? 0),
    first_seen_at: iso(r.first_seen_at),
    last_contact_at: iso(r.last_contact_at),
    last_contact_kind: r.last_contact_kind,
  };
}

// Callers add `WHERE p.user_id = ? …`.
const PERSON_SELECT = `
  SELECT p.*, i.id AS intro_id, i.name AS intro_name,
         (SELECT COUNT(*) FROM person_mentions m WHERE m.person_id = p.id) AS mention_count
  FROM people p LEFT JOIN people i ON i.id = p.introduced_by_id AND i.user_id = p.user_id`;

export async function listPeople() {
  const [rows] = await getPool().query(`${PERSON_SELECT} WHERE p.user_id = ? ORDER BY p.last_contact_at DESC, p.name LIMIT 1000`, [uid()]);
  return rows.map(publicPerson);
}

const CONCERNS = "'question_concern','pain_point','negative_feedback'";
const LEVEL_NAME = { 3: "high", 2: "medium", 1: "low" };
// The call's interest (Pulse), in the same words as a person's interest; nothing shown when unclear.
const TONE = { high: "Very interested", medium: "Interested", low: "Slightly interested", none: "Not interested" };

// ------------------------------------------------------------------- a person's commitments

export const COMMITMENTS_FIRST = 5; // shown at first on a person's page
export const COMMITMENTS_MAX_PAGE = 50;
export const COMMITMENT_VIEWS = ["open", "theirs", "yours", "done"];
const DAY_MS = 86_400_000;
/** "Send Arun's number to Prem" and "send arun s number to prem": one promise. */
const taskKey = (who, task) => `${nameKey(who ?? "")}|${String(task ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;

/**
 * One page of the promises from a person's conversations (all of a conversation they took part in;
 * otherwise only the ones that name them), with the real totals per view:
 *   open   – not done yet; theirs – open, someone else does it; yours – open, the owner does it;
 *   done   – ticked off.
 * The same promise said in two conversations (or the same call uploaded twice) is one line, ticked
 * off together (`ids`). Open ones are sorted by when they are due: the due day comes from the words
 * said, counted from the day of the call ("today" in a call on 13 Nov is 13 Nov, not every day after);
 * those with no day last, newest call first. Returns null when the person does not exist.
 */
export async function personCommitments(id, { ownerName = null, name = null, view = "open", offset = 0, limit = COMMITMENTS_FIRST, now = Date.now() } = {}) {
  const db = getPool();
  if (name === null) {
    const [[p]] = await db.execute("SELECT name FROM people WHERE id = ? AND user_id = ?", [id, uid()]);
    if (!p) return null;
    name = p.name;
  }
  const [actions] = await db.execute(
    `SELECT a.id, a.task, a.responsible_person, a.date_text, a.deadline_text, a.evidence, a.status, a.seq, a.updated_at,
            s.job_id, m.relation, UNIX_TIMESTAMP(f.created_at) AS at
     FROM action_items a
     JOIN summaries s ON s.id = a.summary_id
     JOIN person_mentions m ON m.job_id = s.job_id AND m.person_id = ?
     JOIN processing_jobs j ON j.id = s.job_id
     JOIN audio_files f ON f.id = j.audio_file_id
     WHERE j.user_id = ?
     ORDER BY f.created_at DESC, a.seq
     LIMIT 1000`,
    [id, uid()],
  );
  const first = nameKey(name).split(" ")[0];
  const names = (t) => nameKey(t ?? "").split(/[^a-z0-9]+/);
  const owner = ownerName ? nameKey(ownerName).split(" ")[0] : null;
  const today = localYmd(now);

  // Newest first, so the first of each same promise is the one kept.
  const groups = new Map();
  for (const a of actions) {
    if (!(a.relation === "participant" || [a.task, a.responsible_person, a.evidence].some((t) => names(t).includes(first)))) continue;
    const key = taskKey(a.responsible_person, a.task);
    const g = groups.get(key);
    if (g) {
      g.ids.push(Number(a.id));
      g.open ||= a.status !== "done";
      continue;
    }
    const callYmd = localYmd(Number(a.at) * 1000);
    const words = a.deadline_text || a.date_text || null;
    groups.set(key, { a, ids: [Number(a.id)], open: a.status !== "done", words, due: dueFromWords(words, callYmd) });
  }
  const all = [...groups.values()].map(({ a, ids, open, words, due }) => {
    const you = !!owner && !!a.responsible_person && nameKey(a.responsible_person).split(" ")[0] === owner;
    return {
      id: Number(a.id),
      ids,
      job_id: a.job_id,
      task: a.task,
      who: a.responsible_person ? (you ? "You" : a.responsible_person) : null,
      yours: you,
      due: words, // the words said ("this week"); kept for older pages
      due_date: open ? due : null,
      // Days from today to the due day: negative = late (-5 = five days late), 0 = today.
      due_in_days: open && due ? Math.round((Date.parse(due) - Date.parse(today)) / DAY_MS) : null,
      done: !open,
      done_at: open ? null : iso(a.updated_at),
      calls: new Set(actions.filter((x) => ids.includes(Number(x.id))).map((x) => x.job_id)).size,
      _at: Number(a.at),
      _seq: Number(a.seq),
    };
  });
  const inView = {
    open: (c) => !c.done,
    theirs: (c) => !c.done && !c.yours,
    yours: (c) => !c.done && c.yours,
    done: (c) => c.done,
  };
  const counts = Object.fromEntries(COMMITMENT_VIEWS.map((v) => [v, all.filter(inView[v]).length]));
  const v = COMMITMENT_VIEWS.includes(view) ? view : "open";
  const list = all.filter(inView[v]);
  if (v === "done") list.sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)) || b._at - a._at);
  else list.sort((a, b) => (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31") || b._at - a._at || a._seq - b._seq || a.id - b.id);
  const n = Math.max(1, Math.min(COMMITMENTS_MAX_PAGE, Number(limit) || COMMITMENTS_FIRST));
  const from = Math.max(0, Number(offset) || 0);
  const items = list.slice(from, from + n).map(({ _at, _seq, ...c }) => c);
  return { view: v, items, total: list.length, has_more: from + items.length < list.length, offset: from, counts };
}

/**
 * A person with every conversation they are in (newest upload first), the commitments from those
 * conversations that concern them, and the people they introduced.
 */
export async function getPerson(id, { ownerName = null } = {}) {
  const db = getPool();
  const user = uid();
  const [[row]] = await db.execute(`${PERSON_SELECT} WHERE p.id = ? AND p.user_id = ?`, [id, user]);
  if (!row) return null;
  const [mentions] = await db.execute(
    `SELECT m.job_id, m.relation, m.category, m.role_title, m.organisation, m.city, m.interest, m.introduced_by_name,
            m.context, m.quote, m.evidence_lines, j.kind, f.original_name, f.duration_seconds, UNIX_TIMESTAMP(f.created_at) AS uploaded_epoch,
            (SELECT COUNT(*) FROM transcript_segments ts JOIN transcripts t ON t.id = ts.transcript_id
              WHERE t.job_id = m.job_id AND ts.message_kind = 'text') AS message_count,
            (SELECT COUNT(*) FROM action_items a JOIN summaries s ON s.id = a.summary_id WHERE s.job_id = m.job_id) AS commitment_count,
            (SELECT COUNT(*) FROM person_suggestions ps WHERE ps.job_id = m.job_id) AS new_people,
            (SELECT COUNT(*) FROM opportunities o WHERE o.person_id = m.person_id AND o.source_job_id = m.job_id) AS opportunity_count,
            (SELECT d.decision FROM decisions d JOIN summaries s ON s.id = d.summary_id WHERE s.job_id = m.job_id ORDER BY d.seq LIMIT 1) AS headline,
            (SELECT pi.overall_interest FROM pulse_insights pi WHERE pi.job_id = m.job_id AND pi.row_type = 'overview' LIMIT 1) AS overall_interest,
            (SELECT MAX(CASE pi.level WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 END) FROM pulse_insights pi
              WHERE pi.job_id = m.job_id AND pi.row_type = 'signal' AND pi.category IN (${CONCERNS})) AS concern_level
     FROM person_mentions m
     JOIN processing_jobs j ON j.id = m.job_id
     JOIN audio_files f ON f.id = j.audio_file_id
     WHERE m.person_id = ? AND j.user_id = ?
     ORDER BY f.created_at DESC, m.id DESC`,
    [id, user],
  );
  const [introduced] = await db.execute("SELECT id, name, category, departments FROM people WHERE user_id = ? AND introduced_by_id = ? ORDER BY first_seen_at DESC, name", [user, id]);

  // Commitments: the first page of the open ones (more with personCommitments()).
  const commitmentsPage = await personCommitments(id, { ownerName, name: row.name });

  return {
    person: publicPerson(row),
    mentions: mentions.map((m) => ({
      job_id: m.job_id,
      kind: m.kind,
      file_name: m.original_name,
      duration_seconds: m.duration_seconds === null ? null : Number(m.duration_seconds),
      message_count: m.kind === "whatsapp" ? Number(m.message_count) : null,
      relation: m.relation,
      category: m.category,
      role_title: m.role_title,
      organisation: m.organisation,
      city: m.city,
      interest: m.interest,
      introduced_by_name: m.introduced_by_name,
      context: m.context,
      quote: m.quote,
      evidence_lines: parseJson(m.evidence_lines) ?? [],
      // When the recording or chat was uploaded. audio_files.created_at is written in the session time
      // zone (see repository.js), so it is read back with UNIX_TIMESTAMP to get the exact instant.
      at: new Date(Math.round(Number(m.uploaded_epoch) * 1000)).toISOString(),
      tone: TONE[m.overall_interest] ?? null,
      commitment_count: Number(m.commitment_count),
      new_people: Number(m.new_people),
      opportunity_count: Number(m.opportunity_count),
      headline: m.headline,
      concern: LEVEL_NAME[m.concern_level] ?? null,
    })),
    commitments: commitmentsPage.items,
    commitments_page: { view: commitmentsPage.view, total: commitmentsPage.total, has_more: commitmentsPage.has_more, counts: commitmentsPage.counts },
    introduced: introduced.map((r) => ({ id: r.id, name: r.name, initials: initialsOf(r.name), category: r.category, departments: splitSet(r.departments) })),
  };
}

/** Tick or untick a commitment. Returns false when it does not exist. */
export async function setCommitmentDone(actionId, done) {
  // A commitment is the current user's when its conversation is (action_items -> summaries -> job).
  const [r] = await getPool().execute(
    `UPDATE action_items a JOIN summaries s ON s.id = a.summary_id JOIN processing_jobs j ON j.id = s.job_id
        SET a.status = ? WHERE a.id = ? AND j.user_id = ?`,
    [done ? "done" : "open", actionId, uid()],
  );
  return r.affectedRows > 0;
}

/** The stored file of a job (for playing it back): { stored_name, kind, original_name, file_format } or null. */
export async function jobFile(jobId) {
  const [[row]] = await getPool().execute(
    "SELECT f.stored_name, f.kind, f.original_name, f.file_format FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id WHERE j.id = ? AND j.user_id = ? AND f.user_id = j.user_id AND f.deleted_at IS NULL",
    [jobId, uid()],
  );
  return row ?? null;
}

/** Counts for the owner's profile: people, conversations on timelines, open opportunities, inbox. */
export async function roomStats() {
  const user = uid();
  const [[r]] = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM people WHERE user_id = ?) AS people,
       (SELECT COUNT(DISTINCT m.job_id) FROM person_mentions m JOIN people p ON p.id = m.person_id WHERE p.user_id = ?) AS conversations,
       (SELECT COUNT(*) FROM opportunities WHERE user_id = ? AND stage NOT IN ('Won','Lost')) AS open_opportunities,
       (SELECT COALESCE(SUM(value_inr), 0) FROM opportunities WHERE user_id = ? AND stage NOT IN ('Won','Lost')) AS open_value_inr,
       (SELECT COUNT(*) FROM person_suggestions WHERE user_id = ? AND status = 'pending') AS inbox_pending`,
    [user, user, user, user, user],
  );
  return {
    people: Number(r.people),
    conversations: Number(r.conversations),
    open_opportunities: Number(r.open_opportunities),
    open_value_inr: Number(r.open_value_inr),
    inbox_pending: Number(r.inbox_pending),
  };
}

/** Delete a person and everything stored about them (mentions cascade). */
export async function deletePerson(id) {
  const [r] = await getPool().execute("DELETE FROM people WHERE id = ? AND user_id = ?", [id, uid()]);
  return r.affectedRows > 0;
}
