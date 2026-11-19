// The Today page (design "Today: the first screen every time you open the room"): four numbers, the
// top opportunities ranked by value × chance × urgency, calls being analysed right now, investor heat,
// follow-ups and the pipeline by department. Everything is counted from the database (and the jobs
// running now); nothing is estimated except the stage chance, which is the panel's.

import { getPool } from "./pool.js";
import { ownerName, uid } from "../tenant.js";
import { departmentDetail, departmentOverview } from "./departments.js";
import { opportunityBoard } from "./opportunityBoard.js";
import { STAGE_CHANCE, stageIndex } from "../stages.js";
import { localYmd } from "../services/people.js";
import { dueFromWords } from "../dueWords.js";

const DAY = 86_400_000;
const INSIGHT_CONVERSATIONS = 3; // as in opportunityDetail: the AI reads the latest 3 conversations
/** A table added by a later migration may not exist yet: treat it as empty. */
const orEmpty = async (p, empty = []) => {
  try {
    return await p;
  } catch (exc) {
    if (exc?.code === "ER_NO_SUCH_TABLE") return empty;
    throw exc;
  }
};
const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const isoOf = (epoch) => (epoch === null || epoch === undefined ? null : new Date(Math.round(Number(epoch) * 1000)).toISOString());
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const initialsOf = (name) => {
  const w = String(name ?? "").split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || "?";
};
const firstName = (s) => String(s ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/** How pressing a deal is: overdue, due within 2 days, within a week, or not dated. */
function urgencyOf(o, todayYmd) {
  if (o.overdue) return { factor: 1.5, label: "Overdue" };
  if (!o.due_date) return { factor: 1, label: null };
  const days = Math.round((Date.parse(o.due_date) - Date.parse(todayYmd)) / DAY);
  if (days <= 2) return { factor: 1.3, label: days <= 0 ? "Today" : days === 1 ? "Tomorrow" : "In 2 days" };
  if (days <= 7) return { factor: 1.15, label: `In ${days} days` };
  return { factor: 1, label: null };
}

// ---------------------------------------------------------------------------- follow-ups

export const FOLLOW_UPS_FIRST = 5; // shown at first on Today
export const FOLLOW_UPS_MAX_PAGE = 50;

// When a promise from a call is due, from the words said: see ../dueWords.js (shared with a person's page).
export { dueFromWords };

/**
 * One page of follow-ups with the real totals: the next steps of open deals (their due date) and the
 * open promises from calls (due from the words said, counted from the call's day). Sorted by when
 * they are due: the latest-overdue first, then today, tomorrow …; those with no day last (deals first,
 * then the newest call). The order is worked out on the server for every open follow-up (a few
 * numbers each), and only the asked page is filled in. Each says who the person is (role, company,
 * city) and why (the deal, or the call it was said in). Returns { items, total, overdue, has_more, offset }.
 */
export async function followUpsPage({ offset = 0, limit = FOLLOW_UPS_FIRST, now = Date.now() } = {}) {
  const db = getPool();
  const user = uid();
  const todayYmd = localYmd(now); // the owner's day (APP_TIMEZONE)
  // DATE columns come back as UTC midnight (pool timezone "Z").
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const [dealKeys] = await db.query(
    "SELECT o.id, o.due_date, UNIX_TIMESTAMP(o.updated_at) AS at FROM opportunities o WHERE o.user_id = ? AND o.stage NOT IN ('Won','Lost') AND o.next_step IS NOT NULL AND o.next_step <> ''",
    [user],
  );
  const [promiseKeys] = await db.query(
    `SELECT a.id, a.date_text, a.deadline_text, a.seq, UNIX_TIMESTAMP(f.created_at) AS at
       FROM action_items a JOIN summaries s ON s.id = a.summary_id
       JOIN processing_jobs j ON j.id = s.job_id JOIN audio_files f ON f.id = j.audio_file_id
      WHERE j.user_id = ? AND a.status = 'open'`,
    [user],
  );
  const keyed = [
    ...dealKeys.map((r) => ({ kind: "deal", ref: r.id, due: ymd(r.due_date), at: Number(r.at), seq: 0 })),
    ...promiseKeys.map((r) => {
      const callYmd = localYmd(Number(r.at) * 1000);
      return { kind: "commitment", ref: String(r.id), due: dueFromWords(r.deadline_text || r.date_text, callYmd), at: Number(r.at), seq: Number(r.seq) };
    }),
  ];
  keyed.sort(
    (a, b) =>
      (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") ||
      (a.kind === b.kind ? 0 : a.kind === "deal" ? -1 : 1) ||
      b.at - a.at ||
      a.seq - b.seq ||
      a.ref.localeCompare(b.ref),
  );
  const total = keyed.length;
  const overdueCount = keyed.filter((k) => k.due && k.due < todayYmd).length;
  const rows = keyed.slice(offset, offset + limit);
  const dueOf = new Map(rows.map((r) => [`${r.kind}-${r.ref}`, r.due]));

  // The details of this page only.
  const personOf = (p) => ({ id: p.id, name: p.name, role_title: p.role_title ?? null, organisation: p.organisation ?? null, city: p.city ?? null, category: p.category ?? null });
  const dealIds = rows.filter((r) => r.kind === "deal").map((r) => r.ref);
  const promiseIds = rows.filter((r) => r.kind === "commitment").map((r) => Number(r.ref));
  const deals = new Map();
  if (dealIds.length) {
    const [d] = await db.query(
      `SELECT o.id, o.title, o.stage, o.department, o.value_inr, o.next_step, o.due_date,
              p.id AS person_id, p.name, p.role_title, p.organisation, p.city, p.category
         FROM opportunities o JOIN people p ON p.id = o.person_id AND p.user_id = o.user_id WHERE o.user_id = ? AND o.id IN (?)`,
      [user, dealIds],
    );
    for (const r of d) deals.set(r.id, r);
  }
  const promises = new Map();
  const jobPeople = new Map();
  if (promiseIds.length) {
    const [a] = await db.query(
      `SELECT a.id, a.task, a.responsible_person, a.date_text, a.deadline_text, s.job_id, f.original_name, UNIX_TIMESTAMP(f.created_at) AS epoch
         FROM action_items a JOIN summaries s ON s.id = a.summary_id
         JOIN processing_jobs j ON j.id = s.job_id JOIN audio_files f ON f.id = j.audio_file_id WHERE j.user_id = ? AND a.id IN (?)`,
      [user, promiseIds],
    );
    for (const r of a) promises.set(Number(r.id), r);
    if (a.length) {
      const [m] = await db.query(
        `SELECT m.job_id, p.id, p.name, p.role_title, p.organisation, p.city, p.category FROM person_mentions m JOIN people p ON p.id = m.person_id
          WHERE p.user_id = ? AND m.job_id IN (?) ORDER BY m.relation = 'participant' DESC, m.id`,
        [user, [...new Set(a.map((r) => r.job_id))]],
      );
      for (const r of m) if (!jobPeople.has(r.job_id)) jobPeople.set(r.job_id, personOf(r));
    }
  }

  const owner = firstName(ownerName());
  const items = rows
    .map((r) => {
      if (r.kind === "deal") {
        const o = deals.get(r.ref);
        if (!o) return null;
        const due = ymd(o.due_date);
        return {
          kind: "deal",
          id: o.id,
          text: o.next_step,
          who: "you",
          person: personOf({ ...o, id: o.person_id }),
          due_date: due,
          due_text: null,
          overdue: !!due && due < todayYmd,
          deal: o.title,
          deal_info: { title: o.title, value_inr: o.value_inr === null ? null : Number(o.value_inr), stage: o.stage, department: o.department },
        };
      }
      const a = promises.get(Number(r.ref));
      if (!a) return null;
      const mine = !a.responsible_person || firstName(a.responsible_person) === owner;
      const due = dueOf.get(`commitment-${r.ref}`) ?? null; // from the words, counted from the call's day
      return {
        kind: "commitment",
        id: Number(a.id),
        text: a.task,
        who: mine ? "you" : "them",
        by: mine ? null : a.responsible_person,
        person: jobPeople.get(a.job_id) ?? null,
        due_date: due,
        due_text: a.deadline_text || a.date_text || null,
        overdue: !!due && due < todayYmd,
        job_id: a.job_id,
        at: isoOf(a.epoch),
        // Why: said in this call.
        source: { file_name: a.original_name ? String(a.original_name).replace(/\.[^.]+$/, "") : null, at: isoOf(a.epoch) },
      };
    })
    .filter(Boolean);
  return { items, total, overdue: overdueCount, has_more: offset + rows.length < total, offset };
}

// ---------------------------------------------------------------------- top opportunities

export const TOP_FIRST = 5;
export const TOP_MAX_PAGE = 50;
// A deal's chance: the owner's own (chance_pct) or its stage's (the panel's chanceOf), in SQL. The
// stage names are this file's constants (not input).
const CHANCE_SQL = `COALESCE(o.chance_pct / 100, CASE o.stage ${Object.entries(STAGE_CHANCE)
  .map(([s, c]) => `WHEN '${s.replace(/'/g, "''")}' THEN ${Number(c)}`)
  .join(" ")} ELSE 0 END)`;
// How pressing it is (as urgencyOf): overdue 1.5, due within 2 days 1.3, within a week 1.15, else 1.
const URGENCY_SQL = `CASE WHEN o.due_date IS NULL THEN 1 WHEN o.due_date < ? THEN 1.5
  WHEN DATEDIFF(o.due_date, ?) <= 2 THEN 1.3 WHEN DATEDIFF(o.due_date, ?) <= 7 THEN 1.15 ELSE 1 END`;

/**
 * Open deals ranked by value × chance × urgency, a page at a time (ranked and paged in MySQL), with
 * the real total. Each has the latest thing the other side said about it (the amber line).
 * Returns { items, total, has_more, offset }.
 */
export async function topOpportunitiesPage({ offset = 0, limit = TOP_FIRST, now = Date.now() } = {}) {
  const db = getPool();
  const user = uid();
  const todayYmd = new Date(now).toISOString().slice(0, 10); // as the panel's "overdue"
  const OPEN = "o.user_id = ? AND o.stage NOT IN ('Won','Lost')";
  const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM opportunities o WHERE ${OPEN}`, [user]);
  const total = Number(n);
  const [rows] = await db.query(
    `SELECT o.id, o.title, o.stage, o.department, o.value_inr, o.chance_pct, o.next_step, o.due_date, o.evidence,
            p.id AS person_id, p.name AS person_name, p.score,
            ROUND(COALESCE(o.value_inr, 0) * ${CHANCE_SQL} * ${URGENCY_SQL}) AS rank_value
       FROM opportunities o JOIN people p ON p.id = o.person_id AND p.user_id = o.user_id
      WHERE ${OPEN}
      ORDER BY rank_value DESC, p.score DESC, o.updated_at DESC, o.id
      LIMIT ? OFFSET ?`,
    [todayYmd, todayYmd, todayYmd, user, limit, offset],
  );
  const ownerFirst = firstName(ownerName());
  const items = rows.map((r) => {
    const due = r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : r.due_date ? String(r.due_date).slice(0, 10) : null;
    const overdue = !!due && due < todayYmd;
    const u = urgencyOf({ overdue, due_date: due }, todayYmd);
    // What the other side said (not the owner's own line), latest first.
    const lines = parseJson(r.evidence) ?? [];
    const ev = [...lines].reverse().find((l) => l.speaker && firstName(l.speaker) !== ownerFirst) ?? lines[0];
    const chance = r.chance_pct === null || r.chance_pct === undefined ? (STAGE_CHANCE[r.stage] ?? 0) : Number(r.chance_pct) / 100;
    return {
      id: r.id,
      title: r.title,
      stage: r.stage,
      department: r.department,
      value_inr: r.value_inr === null ? null : Number(r.value_inr),
      chance,
      rank: Number(r.rank_value),
      urgency: u.label,
      overdue,
      due_date: due,
      next_step: r.next_step,
      reason: ev ? { speaker: ev.speaker, time_label: ev.time_label, text: ev.english || ev.text } : null,
      person: { id: r.person_id, name: r.person_name, initials: initialsOf(r.person_name), score: r.score === null ? null : Number(r.score) },
    };
  });
  return { items, total, has_more: offset + rows.length < total, offset };
}

/**
 * Everything on the Today page. `since`: start of the period ("today" or "this week") in the owner's
 * time zone, from the browser. `live`: the pipeline's recent jobs (services/pipeline.recentJobs).
 */
// --- AI insights: what the AI said on opportunity pages (never made here: reading a deal is a Gemini
// call the owner starts on the deal's page). Ordered by what needs you first:
//   1. fresh before stale ("stale" = the person has had a newer call or chat than the AI read);
//   2. at risk first: the AI's chance is below the stage's (money slipping), biggest rupee drop first;
//   3. then the biggest rupee rise (a deal ready to move up); then deals the AI said no number for.
// The rupee impact is (AI chance − current chance) × value, e.g. ₹20 L at 30% → 75% = +₹9 L.
export const INSIGHTS_FIRST = 4;
export const INSIGHTS_MAX_PAGE = 20;

async function insightsOf(open) {
  const db = getPool();
  const byId = new Map(open.map((o) => [o.id, o]));
  const ids = open.map((o) => o.id);
  const insightRows = ids.length ? await orEmpty(db.query("SELECT opportunity_id, data, based_on, created_at FROM opportunity_insights WHERE opportunity_id IN (?)", [ids]).then(([r]) => r)) : [];
  const latestJobs = new Map();
  const insightPeople = [...new Set(insightRows.map((r) => byId.get(r.opportunity_id)?.person.id).filter(Boolean))];
  if (insightPeople.length) {
    const [m] = await db.query(
      `SELECT m.person_id, m.job_id FROM person_mentions m JOIN processing_jobs j ON j.id = m.job_id JOIN audio_files f ON f.id = j.audio_file_id
        WHERE j.user_id = ? AND m.person_id IN (?) ORDER BY f.created_at DESC, m.id DESC`,
      [uid(), insightPeople],
    );
    for (const r of m) {
      const list = latestJobs.get(r.person_id) ?? [];
      if (list.length < INSIGHT_CONVERSATIONS) list.push(r.job_id);
      latestJobs.set(r.person_id, list);
    }
  }
  const insights = insightRows
    .map((r) => {
      const o = byId.get(r.opportunity_id);
      const d = parseJson(r.data) ?? {};
      const basedOn = [...(parseJson(r.based_on) ?? [])].sort();
      const latest = [...(latestJobs.get(o.person.id) ?? [])].sort();
      const factor = (d.factors ?? [])[0] ?? null;
      const suggested = d.suggested_chance_pct ?? null;
      return {
        id: o.id,
        title: o.title,
        stage: o.stage,
        value_inr: o.value_inr,
        person: { id: o.person.id, name: o.person.name },
        chance: o.chance,
        suggested_chance_pct: suggested,
        // What the AI's chance would change in expected rupees (negative = at risk); null without a number.
        impact_inr: suggested !== null && o.value_inr ? Math.round((suggested / 100 - o.chance) * o.value_inr) : null,
        would_change: d.would_change ?? null,
        factor: factor ? { label: factor.label, level: factor.level, reason: factor.reason } : null,
        at: dateIso(r.created_at),
        stale: JSON.stringify(basedOn) !== JSON.stringify(latest),
      };
    })
    .filter((x) => x.suggested_chance_pct !== null || x.would_change || x.factor);
  const band = (x) => (x.impact_inr === null ? 2 : x.impact_inr < 0 ? 0 : 1); // at risk, rising, no number
  insights.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) ||
      band(a) - band(b) ||
      Math.abs(b.impact_inr ?? 0) - Math.abs(a.impact_inr ?? 0) ||
      (b.value_inr ?? 0) - (a.value_inr ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const notRead = open.filter((o) => !insightRows.some((r) => r.opportunity_id === o.id)).sort((a, b) => (b.value_inr ?? 0) - (a.value_inr ?? 0));
  return { insights, notRead };
}

/** One page of AI insights (same order as on Today). Returns { items, total, has_more, offset }. */
export async function insightsPage({ offset = 0, limit = INSIGHTS_FIRST, now = Date.now() } = {}) {
  const board = await opportunityBoard({ now });
  const open = board.opportunities.filter((o) => o.stage !== "Won" && o.stage !== "Lost");
  const { insights } = await insightsOf(open);
  const items = insights.slice(offset, offset + limit);
  return { items, total: insights.length, has_more: offset + items.length < insights.length, offset };
}

export async function todayData({ since, live = [], now = Date.now() } = {}) {
  const db = getPool();
  const user = uid();
  const sinceMs = Date.parse(since);

  // Calls and chats analysed in the period (processing_jobs.created_at is written by MySQL).
  const [analysed] = await db.query("SELECT kind, COUNT(*) AS n FROM processing_jobs WHERE user_id = ? AND status = 'completed' AND UNIX_TIMESTAMP(created_at) >= ? GROUP BY kind", [user, Math.floor(sinceMs / 1000)]);
  const count = (k) => Number(analysed.find((r) => r.kind === k)?.n ?? 0);

  // Opportunities (the panel's data: person, chance, due date, overdue).
  const board = await opportunityBoard({ now });
  const open = board.opportunities.filter((o) => o.stage !== "Won" && o.stage !== "Lost");
  const hot = open.filter((o) => o.person.score !== null && o.person.score >= 75).length; // with someone "Very interested"
  const fresh = open.filter((o) => o.created_at && Date.parse(o.created_at) >= sinceMs).length;

  // Top opportunities: the first page, ranked in MySQL (more with GET /api/top-opportunities).
  const ids = open.map((o) => o.id);
  const top = await topOpportunitiesPage({ offset: 0, limit: TOP_FIRST, now });

  // Investor pipeline and heat (Investment department, if it exists).
  let investment = null;
  try {
    const inv = await departmentDetail("investment");
    if (inv) {
      investment = {
        open_value_inr: inv.totals.open_value_inr,
        weighted_inr: inv.totals.weighted_inr,
        investors: inv.totals.people,
        with_amount: inv.totals.people_with_value,
        heat: [...inv.people]
          .sort((a, b) => b.score - a.score || b.open_value_inr - a.open_value_inr)
          .slice(0, 5)
          .map((p) => ({ id: p.id, name: p.name, initials: p.initials, score: p.score, change: p.interest_change ?? 0, open_value_inr: p.open_value_inr })),
      };
    }
  } catch {
    investment = null;
  }

  // Follow-ups: the first page only (the page asks GET /api/follow-ups for more), and the real totals.
  const followUps = await followUpsPage({ offset: 0, limit: FOLLOW_UPS_FIRST, now });

  // New referrals: people who came in during the period through someone the owner knows.
  const [refs] = await db.query(
    `SELECT p.id, p.name, p.first_seen_at, i.id AS intro_id, i.name AS intro_name
       FROM people p JOIN people i ON i.id = p.introduced_by_id AND i.user_id = p.user_id
      WHERE p.user_id = ?`,
    [user],
  );
  const referrals = refs.filter((r) => Date.parse(dateIso(r.first_seen_at)) >= sinceMs).map((r) => ({ id: r.id, name: r.name, via: { id: r.intro_id, name: r.intro_name } }));
  const via = new Map();
  for (const r of referrals) via.set(r.via.name, (via.get(r.via.name) ?? 0) + 1);
  const topVia = [...via.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  // Pipeline by department (open value), and department goals (target vs open, weighted and won).
  let pipeline = [];
  let goals = [];
  let deptFacts = [];
  try {
    const ov = await departmentOverview();
    pipeline = ov.departments
      .filter((d) => d.open_value_inr > 0)
      .sort((a, b) => b.open_value_inr - a.open_value_inr)
      .map((d) => ({ name: d.name, slug: d.slug, color: d.color, open_value_inr: d.open_value_inr, open: d.open_opportunities }));
    const weightedOf = (name) => Math.round(open.filter((o) => o.department === name).reduce((s, o) => s + (o.value_inr ?? 0) * o.chance, 0));
    goals = ov.departments
      .filter((d) => d.target_inr)
      .map((d) => ({
        name: d.name,
        slug: d.slug,
        color: d.color,
        goal_label: d.goal_label,
        target_inr: d.target_inr,
        open_value_inr: d.open_value_inr,
        weighted_inr: weightedOf(d.name),
        won_value_inr: d.won_value_inr,
        open: d.open_opportunities,
      }))
      .sort((a, b) => b.target_inr - a.target_inr);
    deptFacts = ov.facts.map((f) => ({ department: f.department, text: f.text }));
  } catch {
    pipeline = [];
  }

  // Needs attention: the panel's nudges (overdue, quiet, committed but not won, stalled), with the person.
  const byId = new Map(board.opportunities.map((o) => [o.id, o]));
  const attention = board.nudges.map((n) => {
    const o = byId.get(n.opportunity_id);
    return { ...n, title: o?.title ?? null, person: o ? { id: o.person.id, name: o.person.name } : null };
  });

  const { insights, notRead } = await insightsOf(open);

  // Stage movement in the period, net per deal: the stage it was in at the start of the period -> the
  // stage it is in now (a deal moved and moved back shows no change). A deal being created is "new".
  const moveRows = await orEmpty(
    db
      .query(
        `SELECT c.opportunity_id, c.from_stage, c.to_stage, c.changed_by, c.created_at
           FROM opportunity_stage_changes c JOIN opportunities o ON o.id = c.opportunity_id
          WHERE o.user_id = ? AND c.from_stage IS NOT NULL AND c.created_at >= ? ORDER BY c.created_at, c.id`,
        [user, new Date(sinceMs)],
      )
      .then(([r]) => r),
  );
  const perDeal = new Map();
  for (const r of moveRows) {
    if (Date.parse(dateIso(r.created_at)) < sinceMs || !byId.has(r.opportunity_id)) continue;
    const m = perDeal.get(r.opportunity_id) ?? { from: r.from_stage, to: r.to_stage, by: new Set(), steps: 0, at: null };
    m.to = r.to_stage;
    m.by.add(r.changed_by);
    m.steps += 1;
    m.at = dateIso(r.created_at);
    perDeal.set(r.opportunity_id, m);
  }
  const net = [...perDeal.entries()].map(([id, m]) => {
    const o = byId.get(id);
    const dir = m.from === m.to ? "same" : m.to === "Lost" ? "lost" : stageIndex(m.to) > stageIndex(m.from) ? "forward" : "back";
    return { id, title: o.title, value_inr: o.value_inr, person: { id: o.person.id, name: o.person.name }, from: m.from, to: m.to, by: m.by.has("ai") ? "ai" : "owner", steps: m.steps, direction: dir, at: m.at };
  });
  const moves = net.filter((m) => m.direction !== "same").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const movedBack = net.filter((m) => m.direction === "same").length;

  // Inbox: people found in calls waiting to be added, and new departments suggested in calls.
  const [peopleWaiting] = await db.query("SELECT id, name FROM person_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC, id LIMIT 200", [user]);
  const deptIdeas = await orEmpty(db.query("SELECT id, name FROM department_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 50", [user]).then(([r]) => r));

  // Live: calls and chats being analysed now (and just finished), with their uploaded names.
  const stored = live.map((j) => j.filename).filter(Boolean);
  const names = new Map();
  if (stored.length) {
    const [rows] = await db.query("SELECT stored_name, original_name FROM audio_files WHERE user_id = ? AND stored_name IN (?)", [user, stored]);
    for (const r of rows) names.set(r.stored_name, r.original_name);
  }
  const liveOut = live.map((j) => ({
    job_id: j.job_id,
    kind: j.kind,
    file_name: names.get(j.filename) ?? j.audio?.original_name ?? "Upload",
    status: j.status,
    stage_label: j.stage_label,
    progress: j.progress,
    error: j.error,
    person_id: j.person_id,
    finished_seconds_ago: j.finished_seconds_ago,
  }));

  return {
    owner: ownerName(),
    since: new Date(sinceMs).toISOString(),
    analysed: { calls: count("audio"), chats: count("whatsapp") },
    numbers: {
      open_opportunities: open.length,
      hot,
      new_opportunities: fresh,
      investor_pipeline_inr: investment?.open_value_inr ?? 0,
      investor_weighted_inr: investment?.weighted_inr ?? 0,
      investors: investment?.investors ?? 0,
      follow_ups: followUps.total,
      overdue: followUps.overdue,
      referrals: referrals.length,
      referrals_top_via: topVia ? { name: topVia[0], count: topVia[1] } : null,
    },
    top: top.items, // the first page; more with GET /api/top-opportunities?offset=…
    top_total: top.total,
    top_has_more: top.has_more,
    live: liveOut,
    investor_heat: investment?.heat ?? [],
    follow_ups: followUps.items, // the first page; more with GET /api/follow-ups?offset=…
    follow_ups_has_more: followUps.has_more,
    referrals,
    pipeline,
    attention,
    insights: {
      items: insights.slice(0, INSIGHTS_FIRST), // the first page; more with GET /api/insights?offset=…
      total: insights.length,
      has_more: insights.length > INSIGHTS_FIRST,
      not_read: notRead.length,
      // Every open deal the AI has not read yet (a short list: one per open deal), biggest first.
      not_read_top: notRead.map((o) => ({ id: o.id, title: o.title, person: { id: o.person.id, name: o.person.name }, value_inr: o.value_inr })),
    },
    goals,
    department_facts: deptFacts,
    moves: {
      items: moves.slice(0, 8),
      total: moves.length,
      forward: moves.filter((m) => m.direction === "forward").length,
      back: moves.filter((m) => m.direction === "back" || m.direction === "lost").length,
      unchanged: movedBack, // moved during the period but ended where they started
    },
    inbox: {
      people: peopleWaiting.length,
      people_names: peopleWaiting.slice(0, 4).map((r) => r.name),
      departments: deptIdeas.length,
      department_names: deptIdeas.slice(0, 3).map((r) => r.name),
    },
  };
}
