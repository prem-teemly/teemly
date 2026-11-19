// Notifications (the bell). Every notification is a fact read from the database, never a guess:
//   analysis    a call or chat was analysed (who was in it, opportunities, follow-ups)
//   failed      an upload could not be analysed
//   opportunity a new opportunity was found in a call
//   stage       a later call moved a deal to another stage (the AI; the owner's own moves are not announced)
//   thanks      a deal of someone a connector introduced moved forward: update and thank the connector
//   inbox       new people (or a new department idea) from a call wait for the owner
//   due/overdue a deal's next step is due today, or its date has passed
//   quiet       a deal has gone quiet, stalled, or was committed long ago but not won (the panel's nudges)
//   digest      the day-end summary, once a day after the chosen hour
//
// How they are made: `sweep()` looks at the database and adds what is new. Each notification has a
// dedupe key, so a sweep can run any number of times and never adds one twice. A sweep runs right after
// a call's people are found (so it shows at once) and when the bell asks (at most every few seconds).
// Only things after notifications were switched on (the "installed" row) are announced.
//
// Times: notifications.created_at and the "installed" row are UTC (pool timezone "Z"). "Today" for due
// dates and the digest hour is the server's local day (the owner's machine).
//
// Accounts (migration 023): notifications, their facts and settings belong to one user. A sweep runs as
// one user (the one whose bell asked, or whose call finished) and reads and writes only that user's
// rows, so a call uploaded by one account never notifies another.

import { getPool } from "./pool.js";
import { opportunityBoard } from "./opportunityBoard.js";
import { getLogger } from "../util.js";
import { stageIndex } from "../stages.js";
import { uid } from "../tenant.js";

const logger = getLogger("app.db.notifications");

export const KINDS = ["analysis", "opportunity", "stage", "inbox", "due", "quiet", "digest"];
export const DEFAULT_PREFS = Object.freeze({ analysis: true, opportunity: true, stage: true, inbox: true, due: true, quiet: true, digest: true, digest_hour: 21 });
const PREF_OF = { analysis: "analysis", failed: "analysis", opportunity: "opportunity", stage: "stage", thanks: "stage", inbox: "inbox", due: "due", overdue: "due", quiet: "quiet", digest: "digest" };

const ANALYSIS_FALLBACK_MS = 10 * 60_000; // a call finished this long ago without its "analysed" note (e.g. a restart): add it
const SWEEP_EVERY_MS = 10_000;
const DAY = 86_400_000;

const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const fmtInr = (v) => (v >= 1e7 ? `₹${+(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString("en-IN")}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** YYYY-MM-DD of the server's local day. */
export const localYmd = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const missingTable = (exc) => exc?.code === "ER_NO_SUCH_TABLE";

// ------------------------------------------------------------------------------- settings

/** Which notifications to make, and the digest hour (0-23, server local time). */
export async function getPrefs() {
  try {
    const [[r]] = await getPool().query("SELECT value FROM app_settings WHERE user_id = ? AND name = 'notifications'", [uid()]);
    return { ...DEFAULT_PREFS, ...(r ? parseJson(r.value) : {}) };
  } catch (exc) {
    if (missingTable(exc)) return { ...DEFAULT_PREFS };
    throw exc;
  }
}

/** Validate a change of the settings; throws { status: 422 } on bad input. Returns the clean change. */
export function parsePrefs(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bad = (m) => {
    const e = new Error(m);
    e.status = 422;
    throw e;
  };
  const out = {};
  for (const k of KINDS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") bad(`${k}: should be true or false`);
    out[k] = b[k];
  }
  if (b.digest_hour !== undefined) {
    if (!Number.isInteger(b.digest_hour) || b.digest_hour < 0 || b.digest_hour > 23) bad("digest_hour: should be a whole hour from 0 to 23");
    out.digest_hour = b.digest_hour;
  }
  for (const k of Object.keys(b)) if (!KINDS.includes(k) && k !== "digest_hour") bad(`${k}: unknown setting`);
  if (!Object.keys(out).length) bad("nothing to change");
  return out;
}

export async function savePrefs(change) {
  const next = { ...(await getPrefs()), ...change };
  await getPool().query(
    "INSERT INTO app_settings (user_id, name, value, updated_at) VALUES (?, 'notifications', ?, ?) AS new ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at",
    [uid(), JSON.stringify(next), new Date()],
  );
  return next;
}

// ---------------------------------------------------------------------------------- read

const initialsOf = (name) => {
  const w = String(name ?? "").split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || null;
};
const publicNote = (r) => ({
  id: Number(r.id),
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  read: r.read_at !== null,
  at: dateIso(r.updated_at ?? r.created_at), // the latest update
  created_at: dateIso(r.created_at),
  count: Number(r.item_count ?? 1),
  grouped: String(r.group_key ?? "").split(":")[0] || null, // "call" | "deal" | "bulk"
  items: parseJson(r.items) ?? [],
  avatar: r.avatar_name ? { name: r.avatar_name, initials: initialsOf(r.avatar_name) } : null,
});

const LATEST = "COALESCE(updated_at, created_at)";
const KIND_LIST = ["analysis", "failed", "opportunity", "stage", "thanks", "inbox", "due", "overdue", "quiet", "digest"];

/**
 * Notifications, latest first (a row updated by a newer fact comes back to the top).
 * filter "unread": only unread; kind: one kind; offset/limit: paging ("View all").
 * unread = rows not opened yet (blue dot); unseen = unread rows that came since the bell was last
 * opened (the number on the bell).
 */
export async function listNotifications({ limit = 30, offset = 0, filter = "all", kind = null } = {}) {
  const db = getPool();
  const user = uid();
  try {
    const where = ["user_id = ?", "kind <> 'system'"];
    const params = [user];
    if (filter === "unread") where.push("read_at IS NULL");
    if (kind && KIND_LIST.includes(kind)) {
      where.push(kind === "due" ? "kind IN ('due', 'overdue')" : kind === "analysis" ? "kind IN ('analysis', 'failed')" : "kind = ?");
      if (kind !== "due" && kind !== "analysis") params.push(kind);
    }
    const [rows] = await db.query(
      `SELECT id, kind, title, body, link, avatar_name, group_key, item_count, items, read_at, created_at, updated_at
         FROM notifications WHERE ${where.join(" AND ")} ORDER BY ${LATEST} DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset],
    );
    const seenAt = await getSeenAt();
    const [[c]] = await db.query(
      `SELECT SUM(read_at IS NULL) AS unread, SUM(read_at IS NULL AND ${LATEST} > ?) AS unseen FROM notifications WHERE user_id = ? AND kind <> 'system'`,
      [seenAt, user],
    );
    return { items: rows.slice(0, limit).map(publicNote), has_more: rows.length > limit, unread: Number(c.unread ?? 0), unseen: Number(c.unseen ?? 0) };
  } catch (exc) {
    if (missingTable(exc) || exc?.code === "ER_BAD_FIELD_ERROR") return { items: [], has_more: false, unread: 0, unseen: 0, unavailable: true };
    throw exc;
  }
}

/** Mark some (ids) or all notifications read. Returns how many changed. */
export async function markRead({ ids = null, all = false } = {}) {
  const now = new Date();
  const user = uid();
  if (all) {
    const [r] = await getPool().query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [now, user]);
    return r.affectedRows;
  }
  if (!ids?.length) return 0;
  const [r] = await getPool().query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (?)", [now, user, ids]);
  return r.affectedRows;
}

/** Mark notifications unread again (the owner wants to come back to them). */
export async function markUnread(ids) {
  if (!ids?.length) return 0;
  const [r] = await getPool().query("UPDATE notifications SET read_at = NULL WHERE user_id = ? AND read_at IS NOT NULL AND kind <> 'system' AND id IN (?)", [uid(), ids]);
  return r.affectedRows;
}

/** When the bell was last opened: rows before that are "seen" (no number on the bell), even if unread. */
async function getSeenAt() {
  const [[r]] = await getPool().query("SELECT value FROM app_settings WHERE user_id = ? AND name = 'notifications_seen'", [uid()]);
  const at = r ? parseJson(r.value)?.at : null;
  return at ? new Date(at) : new Date(0);
}
export async function markSeen(now = new Date()) {
  await getPool().query(
    "INSERT INTO app_settings (user_id, name, value, updated_at) VALUES (?, 'notifications_seen', ?, ?) AS new ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at",
    [uid(), JSON.stringify({ at: now.toISOString() }), now],
  );
}

// ---------------------------------------------------------------------------------- make
//
// A note (one fact) is { kind, key, title, body, link, at, avatar, group?, merge?, item?, items?, also? }:
//   key     the fact (announced once, ever; notification_facts)
//   group   rows to merge into: "call:<job>" (merge "append": the call's row gains an item) or
//           "deal:<opportunity>:<what>" (merge "replace": the row shows the latest, "N updates")
//   item    how the fact shows inside a grouped row; items: a new row's own contents; also: facts
//           the new row already covers (e.g. the people and deals of a call)

const BULK_AT = 3; // more new notes of one kind than this in one sweep: one summary row
const BULK = {
  overdue: (n) => ({ title: `${n} deals overdue`, link: "/opportunity-panel" }),
  due: (n) => ({ title: `${n} next steps due today`, link: "/opportunity-panel" }),
  quiet: (n) => ({ title: `${n} deals need a nudge`, link: "/opportunity-panel" }),
  thanks: (n) => ({ title: `${n} connectors to thank`, link: "/network-map" }),
  stage: (n) => ({ title: `${n} deals moved after calls`, link: "/opportunity-panel" }),
  opportunity: (n) => ({ title: `${n} new opportunities`, link: "/opportunity-panel" }),
};
const itemOf = (n) => n.item ?? { kind: n.kind, text: n.title, sub: n.body ?? null, link: n.link ?? null };
const MAX_ITEMS = 12;

/** Add notifications: new facts only, merged into their group's row when there is one. */
async function add(notes, prefs, now = Date.now()) {
  const db = getPool();
  const user = uid();
  const keep = notes.filter((n) => prefs[PREF_OF[n.kind] ?? n.kind] !== false);
  if (!keep.length) return 0;
  const keys = [...new Set(keep.flatMap((n) => [n.key, ...(n.also ?? [])]))];
  const [known] = await db.query("SELECT fact_key FROM notification_facts WHERE user_id = ? AND fact_key IN (?)", [user, keys]);
  const done = new Set(known.map((r) => r.fact_key));
  const fresh = [];
  for (const n of keep) {
    if (done.has(n.key)) continue;
    done.add(n.key);
    for (const k of n.also ?? []) done.add(k); // e.g. a call's row covers its new people: not again
    fresh.push(n);
  }
  if (!fresh.length) return 0;

  const stamp = new Date(now);
  const facts = async (id, ks) => {
    const list = [...new Set(ks)].filter(Boolean);
    if (list.length) await db.query("INSERT IGNORE INTO notification_facts (user_id, fact_key, notification_id, created_at) VALUES ?", [list.map((k) => [user, k, id, stamp])]);
  };
  // Rows to merge into: the latest row of each group, from the last 30 days.
  const groups = [...new Set(fresh.map((n) => n.group).filter(Boolean))];
  const byGroup = new Map();
  if (groups.length) {
    const [rows] = await db.query(
      `SELECT id, group_key, item_count, items FROM notifications WHERE user_id = ? AND group_key IN (?) AND ${LATEST} > ? ORDER BY ${LATEST}`,
      [user, groups, new Date(now - 30 * DAY)],
    );
    for (const r of rows) byGroup.set(r.group_key, { id: Number(r.id), count: Number(r.item_count), items: parseJson(r.items) ?? [] });
  }

  let changed = 0;
  const insert = async (n, extra = {}) => {
    // A part of a call shown on its own keeps itself as an item, so the call's row can take it in later.
    const items = extra.items ?? n.items ?? (n.group ? [{ ...itemOf(n), at: stamp.toISOString() }] : []);
    const [r] = await db.query(
      `INSERT IGNORE INTO notifications (user_id, kind, title, body, link, avatar_name, dedupe_key, group_key, item_count, items, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user, n.kind, clip(n.title, 200), clip(n.body ?? null, 600), n.link ?? null, clip(n.avatar ?? null, 80), extra.key ?? n.key, extra.group ?? n.group ?? null, extra.count ?? Math.max(1, items.length && n.merge === "append" ? items.length : 1), items.length ? JSON.stringify(items.slice(0, MAX_ITEMS)) : null, n.at ?? stamp, n.at ?? stamp],
    );
    changed += r.affectedRows;
    return r.insertId ? Number(r.insertId) : null;
  };
  const mergeInto = async (row, n) => {
    if (n.items) {
      // The call's own row arrives after a part of it (e.g. its new people): that row becomes the call's
      // row, keeping what it had and adding what the call brought (no item twice).
      const texts = new Set(row.items.map((i) => i.text));
      row.items = [...row.items, ...n.items.filter((i) => !texts.has(i.text))].slice(0, MAX_ITEMS);
      await db.query(
        "UPDATE notifications SET kind = ?, title = ?, body = ?, link = ?, avatar_name = COALESCE(?, avatar_name), item_count = ?, items = ?, updated_at = ?, read_at = NULL WHERE id = ? AND user_id = ?",
        [n.kind, clip(n.title, 200), clip(n.body ?? null, 600), n.link ?? null, clip(n.avatar ?? null, 80), Math.max(1, row.items.length), JSON.stringify(row.items), stamp, row.id, user],
      );
      changed += 1;
      await facts(row.id, [n.key, ...(n.also ?? [])]);
      return;
    }
    const item = { ...itemOf(n), at: stamp.toISOString() };
    const items = n.merge === "replace" ? [item, ...row.items] : [...row.items, item];
    row.items = items.slice(0, MAX_ITEMS);
    row.count += 1;
    if (n.merge === "replace") {
      await db.query("UPDATE notifications SET title = ?, body = ?, link = ?, avatar_name = COALESCE(?, avatar_name), item_count = ?, items = ?, updated_at = ?, read_at = NULL WHERE id = ? AND user_id = ?", [clip(n.title, 200), clip(n.body ?? null, 600), n.link ?? null, clip(n.avatar ?? null, 80), row.count, JSON.stringify(row.items), stamp, row.id, user]);
    } else {
      await db.query("UPDATE notifications SET item_count = ?, items = ?, updated_at = ?, read_at = NULL WHERE id = ? AND user_id = ?", [row.items.length, JSON.stringify(row.items), stamp, row.id, user]);
    }
    changed += 1;
    await facts(row.id, [n.key, ...(n.also ?? [])]);
  };

  // 1) Into existing groups; 2) many new ones of a kind: one summary row; 3) the rest: a row each.
  const standalone = [];
  for (const n of fresh) {
    const row = n.group ? byGroup.get(n.group) : null;
    if (row) await mergeInto(row, n);
    else standalone.push(n);
  }
  const ymd = localYmd(now);
  for (const [kind, make] of Object.entries(BULK)) {
    const same = standalone.filter((n) => n.kind === kind);
    if (same.length <= BULK_AT) continue;
    const { title, link } = make(same.length);
    const items = same.map((n) => ({ ...itemOf(n), at: (n.at ?? stamp).toISOString?.() ?? stamp.toISOString() }));
    const id = await insert({ kind, title, body: same.slice(0, 3).map((n) => n.avatar ?? n.title).join(", ") + (same.length > 3 ? ` and ${same.length - 3} more` : ""), link, at: stamp }, { key: `bulk:${kind}:${ymd}:${same[0].key}`, group: `bulk:${kind}:${ymd}`, items, count: same.length });
    await facts(id, same.flatMap((n) => [n.key, ...(n.also ?? [])]));
    for (const n of same) standalone.splice(standalone.indexOf(n), 1);
  }
  for (const n of standalone) {
    const row = n.group ? byGroup.get(n.group) : null; // a group started earlier in this same sweep
    if (row) {
      await mergeInto(row, n);
      continue;
    }
    const id = await insert(n);
    if (!id) continue;
    await facts(id, [n.key, ...(n.also ?? [])]);
    if (n.group) byGroup.set(n.group, { id, count: n.items ? n.items.length : 1, items: n.items ?? [{ ...itemOf(n), at: stamp.toISOString() }] });
  }
  return changed;
}

/**
 * When this user's notifications start: their "installed" row (made when the account was created, or
 * by migration 016 for the room that existed before accounts). A user without one gets it now.
 */
async function installedAt() {
  const db = getPool();
  const user = uid();
  const [[r]] = await db.query("SELECT created_at FROM notifications WHERE user_id = ? AND dedupe_key = 'installed'", [user]);
  if (r) return r.created_at;
  const now = new Date();
  await db.query(
    "INSERT IGNORE INTO notifications (user_id, kind, title, body, link, dedupe_key, read_at, created_at, updated_at) VALUES (?, 'system', 'Notifications are on', NULL, NULL, 'installed', ?, ?, ?)",
    [user, now, now, now],
  );
  return now;
}

/** "Call · 2 people · 1 new opportunity (₹5 L) · 3 follow-ups" for one finished conversation. */
async function analysisNote(job) {
  const db = getPool();
  const user = uid();
  const [people] = await db.query(
    "SELECT p.id, p.name FROM person_mentions m JOIN people p ON p.id = m.person_id WHERE m.job_id = ? AND p.user_id = ? ORDER BY m.relation = 'participant' DESC, m.id",
    [job.id, user],
  );
  const [waiting] = await db.query("SELECT id, name, relation, city, departments, department_suggestions FROM person_suggestions WHERE user_id = ? AND job_id = ? AND status = 'pending' ORDER BY id", [user, job.id]);
  const [opps] = await db.query("SELECT o.id, o.title, o.stage, o.value_inr, o.due_date, p.name AS person FROM opportunities o JOIN people p ON p.id = o.person_id WHERE o.user_id = ? AND o.source_job_id = ? AND o.origin = 'ai' ORDER BY o.created_at", [user, job.id]);
  const [[actions]] = await db.query("SELECT COUNT(*) AS n FROM action_items a JOIN summaries s ON s.id = a.summary_id JOIN processing_jobs j ON j.id = s.job_id WHERE j.user_id = ? AND s.job_id = ?", [user, job.id]);
  let moves = [];
  let ideas = [];
  try {
    [moves] = await db.query(
      `SELECT c.id, c.from_stage, c.to_stage, o.id AS opp_id, o.title, p.name AS person FROM opportunity_stage_changes c
         JOIN opportunities o ON o.id = c.opportunity_id JOIN people p ON p.id = o.person_id
        WHERE o.user_id = ? AND c.source_job_id = ? AND c.changed_by = 'ai' AND c.from_stage IS NOT NULL ORDER BY c.id`,
      [user, job.id],
    );
    [ideas] = await db.query("SELECT id, name, said_by FROM department_suggestions WHERE user_id = ? AND job_id = ? AND status = 'pending'", [user, job.id]);
  } catch (exc) {
    if (!missingTable(exc)) throw exc;
  }
  const value = opps.reduce((s, o) => s + Number(o.value_inr ?? 0), 0);
  const parts = [];
  if (people.length) parts.push(people.length <= 2 ? people.map((p) => p.name).join(" and ") : plural(people.length, "person", "people"));
  if (Number(actions.n)) parts.push(plural(Number(actions.n), "follow-up"));
  if (!parts.length && !waiting.length && !opps.length) parts.push(`Nothing new found in this ${job.kind === "whatsapp" ? "chat" : "call"}.`);
  // What the call brought, shown inside the row (each a fact of its own, announced here once).
  const suggested = (s) => {
    const why = (parseJson(s.department_suggestions) ?? []).map((w) => w.department);
    const depts = [...new Set([...why, ...String(s.departments ?? "").split(",").filter(Boolean)])].slice(0, 2);
    return [depts.join(" / ") || null, s.city].filter(Boolean).join(" · ") || null;
  };
  const items = [
    ...waiting.map((s) => ({ kind: "inbox", text: `${s.relation === "mentioned" ? "New person mentioned" : "New person in the call"}: ${s.name}`, sub: suggested(s), link: "/inbox", action: "Add person" })),
    ...opps.map((o) => ({ kind: "opportunity", text: `New opportunity: ${o.title}`, sub: [o.person, o.value_inr !== null ? fmtInr(Number(o.value_inr)) : null, o.stage, o.due_date ? `due ${dayOf(o.due_date)}` : null].filter(Boolean).join(" · "), link: `/opportunities/${o.id}` })),
    ...moves.map((m) => ({ kind: "stage", text: `${m.person} moved to ${m.to_stage}`, sub: `${m.title}: ${m.from_stage} → ${m.to_stage}`, link: `/opportunities/${m.opp_id}` })),
    ...ideas.map((d) => ({ kind: "inbox", text: `Department idea: ${d.name}`, sub: d.said_by ? `Suggested by ${d.said_by}` : null, link: "/inbox", action: "Review" })),
  ];
  const what = job.kind === "whatsapp" ? "Chat" : "Call";
  return {
    kind: "analysis",
    key: `job:${job.id}:analysed`,
    group: `call:${job.id}`,
    merge: "append",
    title: `${what} analysed: ${job.name}`,
    body: parts.join(" · "),
    link: people.length ? `/people/${people[0].id}/calls/${job.id}` : waiting.length ? "/inbox" : "/today",
    avatar: people[0]?.name ?? waiting[0]?.name ?? null,
    items: items.map((i) => ({ ...i, at: new Date().toISOString() })),
    also: [...(waiting.length ? [`inbox:${job.id}:people`] : []), ...opps.map((o) => `opp:${o.id}:new`), ...moves.map((m) => `move:${m.id}`), ...ideas.map((d) => `idea:${d.id}`)],
  };
}
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/**
 * Look at the database and add every notification that is due. Safe to run any time (dedupe keys).
 * `doneJobs`: ids of conversations whose people were just found (their "analysed" note is added now).
 */
export async function sweep({ now = Date.now(), doneJobs = [] } = {}) {
  const db = getPool();
  const user = uid();
  let since;
  try {
    since = await installedAt();
  } catch (exc) {
    if (missingTable(exc)) return 0; // migration 016 not applied yet
    throw exc;
  }
  const prefs = await getPrefs();
  const notes = [];

  // Calls and chats: analysed (when their people are known, or after a while), or failed.
  const [jobs] = await db.query(
    `SELECT j.id, j.kind, j.status, j.error_message, j.finished_at, f.original_name AS name
       FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id
      WHERE j.user_id = ? AND j.status IN ('completed', 'failed') AND j.finished_at > ? ORDER BY j.finished_at`,
    [user, since],
  );
  for (const j of jobs) {
    if (j.status === "failed") {
      notes.push({ kind: "failed", key: `job:${j.id}:failed`, title: `Could not analyse ${j.name}`, body: j.error_message ?? "The upload could not be analysed.", link: "/today", at: j.finished_at });
    } else if (doneJobs.includes(j.id) || now - j.finished_at.getTime() >= ANALYSIS_FALLBACK_MS) {
      notes.push({ ...(await analysisNote(j)), at: doneJobs.includes(j.id) ? new Date(now) : j.finished_at });
    }
  }

  // New opportunities found in calls (also those added with a person from the inbox).
  const [opps] = await db.query(
    `SELECT o.id, o.title, o.stage, o.value_inr, o.due_date, o.source_job_id, o.created_at, p.name AS person
       FROM opportunities o JOIN people p ON p.id = o.person_id
      WHERE o.user_id = ? AND o.origin = 'ai' AND o.created_at > ? ORDER BY o.created_at`,
    [user, since],
  );
  for (const o of opps) {
    const sub = [o.title, o.value_inr !== null ? fmtInr(Number(o.value_inr)) : null, o.stage, o.due_date ? `due ${dayOf(o.due_date)}` : null].filter(Boolean).join(" · ");
    notes.push({
      kind: "opportunity",
      key: `opp:${o.id}:new`,
      // Found in a call: it joins that call's row (e.g. added later with a person from the inbox).
      group: o.source_job_id ? `call:${o.source_job_id}` : null,
      merge: "append",
      item: { kind: "opportunity", text: `New opportunity: ${o.title}`, sub: [o.person, ...sub.split(" · ").slice(1)].join(" · "), link: `/opportunities/${o.id}` },
      title: `New opportunity: ${o.person}`,
      body: sub,
      link: `/opportunities/${o.id}`,
      avatar: o.person,
      at: o.created_at,
    });
  }

  // Stages the AI moved after a later call (the owner's own moves are not announced back to them).
  try {
    const [moves] = await db.query(
      `SELECT c.id, c.from_stage, c.to_stage, c.created_at, o.id AS opp_id, o.title, p.name AS person
         FROM opportunity_stage_changes c JOIN opportunities o ON o.id = c.opportunity_id JOIN people p ON p.id = o.person_id
        WHERE o.user_id = ? AND c.changed_by = 'ai' AND c.from_stage IS NOT NULL AND c.created_at > ? ORDER BY c.created_at`,
      [user, since],
    );
    for (const m of moves) {
      // One row per deal: later moves update it ("2 updates").
      notes.push({ kind: "stage", key: `move:${m.id}`, group: `deal:${m.opp_id}:stage`, merge: "replace", item: { kind: "stage", text: `${m.from_stage} → ${m.to_stage}`, sub: "from a call", link: `/opportunities/${m.opp_id}` }, title: `${m.person} moved to ${m.to_stage}`, body: `${m.title}: ${m.from_stage} → ${m.to_stage}, from a call.`, link: `/opportunities/${m.opp_id}`, avatar: m.person, at: m.created_at });
    }
    // Keep connectors warm: a deal of someone they introduced moved forward (by a call or by the owner).
    const [forward] = await db.query(
      `SELECT c.id, c.from_stage, c.to_stage, c.created_at, o.id AS opp_id, o.title, p.name AS person, i.id AS intro_id, i.name AS intro
         FROM opportunity_stage_changes c JOIN opportunities o ON o.id = c.opportunity_id
         JOIN people p ON p.id = o.person_id JOIN people i ON i.id = p.introduced_by_id AND i.user_id = p.user_id
        WHERE o.user_id = ? AND c.from_stage IS NOT NULL AND c.created_at > ? AND o.stage = c.to_stage ORDER BY c.created_at`,
      [user, since],
    );
    for (const m of forward) {
      if (!(m.to_stage === "Won" || stageIndex(m.to_stage) > stageIndex(m.from_stage))) continue;
      notes.push({
        kind: "thanks",
        key: `thank:${m.id}`,
        group: `deal:${m.opp_id}:thanks`, // the same deal moving on again updates this row
        merge: "replace",
        item: { kind: "thanks", text: `${m.person} moved to ${m.to_stage}`, sub: m.title, link: `/opportunities/${m.opp_id}` },
        avatar: m.intro,
        title: `Say thank you to ${m.intro}`,
        body: `${m.person} (introduced by ${m.intro}) moved to ${m.to_stage} on ${m.title}. A good moment to update ${m.intro} and thank them.`,
        link: `/people/${m.intro_id}`,
        at: m.created_at,
      });
    }
  } catch (exc) {
    if (!missingTable(exc)) throw exc;
  }

  // Inbox: new people found in a call (one note per call), and new department ideas.
  const [waiting] = await db.query(
    `SELECT s.job_id, GROUP_CONCAT(s.name ORDER BY s.id SEPARATOR ', ') AS names, COUNT(*) AS n, MAX(s.created_at) AS at, MAX(f.original_name) AS file
       FROM person_suggestions s JOIN processing_jobs j ON j.id = s.job_id JOIN audio_files f ON f.id = j.audio_file_id
      WHERE s.user_id = ? AND s.status = 'pending' AND s.created_at > ? GROUP BY s.job_id`,
    [user, since],
  );
  for (const w of waiting) {
    const n = Number(w.n);
    const first = String(w.names).split(", ")[0];
    notes.push({
      kind: "inbox",
      key: `inbox:${w.job_id}:people`,
      group: `call:${w.job_id}`,
      merge: "append",
      item: { kind: "inbox", text: `${plural(n, "new person", "new people")}: ${clip(w.names, 120)}`, sub: null, link: "/inbox", action: "Add person" },
      title: `${plural(n, "new person", "new people")} to add`,
      body: `${clip(w.names, 200)}, found in ${w.file}. Add or ignore in the Inbox.`,
      link: "/inbox",
      avatar: first,
      at: w.at,
    });
  }
  try {
    const [ideas] = await db.query("SELECT id, job_id, name, said_by, reason, created_at FROM department_suggestions WHERE user_id = ? AND status = 'pending' AND created_at > ?", [user, since]);
    for (const d of ideas) {
      notes.push({ kind: "inbox", key: `idea:${d.id}`, group: `call:${d.job_id}`, merge: "append", item: { kind: "inbox", text: `Department idea: ${d.name}`, sub: d.said_by ? `Suggested by ${d.said_by}` : null, link: "/inbox", action: "Review" }, title: `Department idea: ${d.name}`, body: [d.said_by ? `Suggested by ${d.said_by}` : null, d.reason].filter(Boolean).join(". "), link: "/inbox", avatar: d.said_by ?? null, at: d.created_at });
    }
  } catch (exc) {
    if (!missingTable(exc)) throw exc;
  }

  // Deals: next step due today, or overdue (once per date), and the panel's nudges (once a week).
  const today = localYmd(now);
  const board = await opportunityBoard({ now });
  for (const o of board.opportunities) {
    if (o.stage === "Won" || o.stage === "Lost" || !o.due_date) continue;
    const step = o.next_step ? `“${o.next_step}”` : "The next step";
    // One row per deal: "due today" becomes "overdue" in the same row the next day.
    const grp = { group: `deal:${o.id}:due`, merge: "replace", avatar: o.person.name };
    if (o.due_date === today) {
      const body = `${step} on ${o.title}${o.value_inr ? ` (${fmtInr(o.value_inr)})` : ""}.`;
      notes.push({ kind: "due", key: `due:${o.id}:${o.due_date}`, ...grp, item: { kind: "due", text: `Due today: ${o.title}`, sub: o.person.name, link: `/opportunities/${o.id}` }, title: `Due today: ${o.person.name}`, body, link: `/opportunities/${o.id}` });
    } else if (o.due_date < today) {
      notes.push({ kind: "overdue", key: `overdue:${o.id}:${o.due_date}`, ...grp, item: { kind: "overdue", text: `Overdue since ${o.due_date}: ${o.title}`, sub: o.person.name, link: `/opportunities/${o.id}` }, title: `Overdue: ${o.person.name}`, body: `${step} on ${o.title} was due ${o.due_date}. Do it, or move the date.`, link: `/opportunities/${o.id}` });
    }
  }
  const week = Math.floor(now / (7 * DAY));
  const personOf = new Map(board.opportunities.map((o) => [o.id, o.person.name]));
  for (const n of board.nudges) {
    if (n.kind === "overdue") continue; // announced above, with its date
    const title = n.kind === "quiet" ? "Gone quiet" : n.kind === "committed" ? "Committed, not won yet" : "Stalled deal";
    notes.push({ kind: "quiet", key: `nudge:${n.kind}:${n.opportunity_id}:${week}`, group: `deal:${n.opportunity_id}:nudge`, merge: "replace", item: { kind: "quiet", text: title, sub: n.text, link: `/opportunities/${n.opportunity_id}` }, avatar: personOf.get(n.opportunity_id) ?? null, title, body: n.text, link: `/opportunities/${n.opportunity_id}` });
  }

  // Day-end digest: once a day, after the chosen hour.
  if (prefs.digest && new Date(now).getHours() >= prefs.digest_hour) {
    const digest = await digestNote(now);
    if (digest) notes.push(digest);
  }

  const added = await add(notes, prefs, now);
  await cleanup(now);
  return added;
}

/** Read notifications older than 30 days are removed (each user at most once an hour); unread ones stay. */
const lastCleanup = new Map(); // user id -> ms
async function cleanup(now) {
  const user = uid();
  if (now - (lastCleanup.get(user) ?? 0) < 3600_000) return;
  lastCleanup.set(user, now);
  await getPool().query("DELETE FROM notifications WHERE user_id = ? AND kind <> 'system' AND read_at IS NOT NULL AND read_at < ?", [user, new Date(now - 30 * DAY)]);
}

/** Today in one line: calls, new opportunities, follow-ups, the inbox. */
async function digestNote(now) {
  const db = getPool();
  const user = uid();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const [[calls]] = await db.query("SELECT COUNT(*) AS n FROM processing_jobs WHERE user_id = ? AND status = 'completed' AND finished_at >= ?", [user, start]);
  const [opps] = await db.query("SELECT value_inr FROM opportunities WHERE user_id = ? AND created_at >= ?", [user, start]);
  const [[open]] = await db.query(
    "SELECT COUNT(*) AS n FROM action_items a JOIN summaries s ON s.id = a.summary_id JOIN processing_jobs j ON j.id = s.job_id WHERE j.user_id = ? AND a.status = 'open'",
    [user],
  );
  const [[waiting]] = await db.query("SELECT COUNT(*) AS n FROM person_suggestions WHERE user_id = ? AND status = 'pending'", [user]);
  const value = opps.reduce((s, o) => s + Number(o.value_inr ?? 0), 0);
  const parts = [
    plural(Number(calls.n), "call analysed", "calls analysed"),
    `${plural(opps.length, "new opportunity", "new opportunities")}${value ? ` (${fmtInr(value)})` : ""}`,
    `${plural(Number(open.n), "follow-up")} open`,
  ];
  if (Number(waiting.n)) parts.push(`${Number(waiting.n)} waiting in the Inbox`);
  return { kind: "digest", key: `digest:${localYmd(now)}`, title: "Your day in the room", body: parts.join(" · "), link: "/today" };
}

// -------------------------------------------------------------------- when to sweep

// Per user: when their last sweep started, and the sweep running now (one at a time per user).
const last = new Map(); // user id -> ms
const running = new Map(); // user id -> Promise

/** Sweep the current user's notifications at most every few seconds (the bell asks often); errors are logged, never thrown. */
export function sweepSoon({ now = Date.now(), force = false, doneJobs = [] } = {}) {
  const user = uid();
  if (running.has(user)) return running.get(user);
  if (!force && now - (last.get(user) ?? 0) < SWEEP_EVERY_MS) return Promise.resolve(0);
  last.set(user, now);
  const p = sweep({ now, doneJobs })
    .catch((exc) => {
      logger.warning(`Notifications: could not be updated for user ${user} (${exc?.message ?? "error"})`);
      return 0;
    })
    .finally(() => {
      running.delete(user);
    });
  running.set(user, p);
  return p;
}

/** After a conversation's people are found: announce it now to its owner (and anything else due). */
export async function conversationDone(jobId) {
  const user = uid();
  if (running.has(user)) await running.get(user); // a sweep in progress would skip this job's note
  return sweepSoon({ force: true, doneJobs: [jobId] });
}

/** Tests: forget the sweep throttle. */
export const resetForTests = () => {
  last.clear();
  running.clear();
  lastCleanup.clear();
};
