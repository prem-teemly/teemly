// Departments (migration 009): the eight built-in ones and any the owner adds in Settings, the
// department panel (one card per department) and one department's page (its people and
// opportunities). All statements are parameterized.
//
// A person belongs to a department when the department is on the person (people.departments, set by
// the AI from what their calls say, or by the owner) or when the person has an opportunity in it.
// Money is only what was said in a conversation or typed by the owner: opportunity values in rupees.

import { STAGES, STAGE_CHANCE } from "../stages.js";
import { getPool, withTransaction } from "./pool.js";
import { ownerName, uid } from "../tenant.js";
import { WorkError, chanceOf } from "./personWork.js";
import { hexId } from "../util.js";

/** The eight departments every new room starts with (as first added by migration 009). */
export const BUILT_IN_DEFS = Object.freeze([
  { slug: "investment", name: "Investment", color: "#6c63f6", description: "Investors and HNIs who invest or may invest money in the owner's company: angels, VCs, funds, wealthy individuals" },
  { slug: "sales", name: "Sales", color: "#2fae6a", description: "Customers and buyers, and partners who bring direct sales" },
  { slug: "channel-partners", name: "Channel partners", color: "#18a7b5", description: "Distributors, resellers and partners who sell or refer the owner's product" },
  { slug: "accounts", name: "Accounts", color: "#64748b", description: "Chartered accountants, auditors, tax and finance people" },
  { slug: "marketing", name: "Marketing", color: "#e2507a", description: "Marketing and advertising agencies, PR, designers, influencers" },
  { slug: "tech-ai", name: "Tech & AI", color: "#3b82f6", description: "Developers, AI and tech experts, technical advisors" },
  { slug: "govt-tenders", name: "Govt tenders", color: "#d4891b", description: "Government officials and contacts for government tenders and bids" },
  { slug: "vendors", name: "Vendors", color: "#9a6b4b", description: "Suppliers of goods or services to the owner: hardware, printing, contractors" },
]);
/** The built-in eight's names (used when the database is not reachable, and by tests). */
export const BUILT_IN = BUILT_IN_DEFS.map((d) => d.name);

/** Give a new room its built-in departments (inside the caller's transaction; existing ones are kept). */
export async function seedDepartments(conn, userId) {
  const rows = BUILT_IN_DEFS.map((d, i) => [hexId(), userId, d.slug, d.name, d.color, d.description, 1, (i + 1) * 10]);
  await conn.query("INSERT IGNORE INTO departments (id, user_id, slug, name, color, description, built_in, sort_order) VALUES ?", [rows]);
  clearDepartmentCache(userId);
}
export const MAX_DEPARTMENTS = 30;
/** Colours the owner can pick for a new department. */
export const PALETTE = ["#6c63f6", "#2fae6a", "#18a7b5", "#64748b", "#e2507a", "#3b82f6", "#d4891b", "#9a6b4b", "#0f8b8d", "#c2410c", "#7c3aed", "#be123c", "#15803d", "#0369a1"];

const splitSet = (s) => (s ? String(s).split(",").filter(Boolean) : []);
const isoOf = (epoch) => (epoch === null || epoch === undefined ? null : new Date(Math.round(Number(epoch) * 1000)).toISOString());

// ------------------------------------------------------------------------------ the list

const cache = new Map(); // user id -> { at, list }
const CACHE_MS = 30_000;

/** Dashboards a department's page can use (migration 020). */
export const VIEW_TYPES = ["investors", "sales", "partners", "suppliers", "tenders", "standard"];
/** The dashboard that fits a department's name, when the owner has not chosen one. */
export function guessView(name) {
  const n = String(name ?? "").toLowerCase();
  if (/invest|investor|fund|capital|angel/.test(n)) return "investors";
  if (/tender|govt|government|public sector|bid/.test(n)) return "tenders";
  if (/vendor|supplier|procure|purchase|sourcing/.test(n)) return "suppliers";
  if (/partner|channel|distribut|dealer|reseller|franchise/.test(n)) return "partners";
  if (/sale|customer|client|business development|\bbd\b/.test(n)) return "sales";
  return "standard";
}

const publicDepartment = (r) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  color: r.color,
  description: r.description,
  built_in: Boolean(r.built_in),
  // Migration 010 (optional goal): null until the owner sets one.
  goal_label: r.goal_label ?? null,
  target_inr: r.target_inr === null || r.target_inr === undefined ? null : Number(r.target_inr),
  // Migration 020: the owner's choice (null = from the name), and the dashboard used.
  view_type: VIEW_TYPES.includes(r.view_type) ? r.view_type : null,
  view: VIEW_TYPES.includes(r.view_type) ? r.view_type : guessView(r.name),
});

/** All departments in display order (cached briefly; changes here clear the cache). */
export async function listDepartments({ fresh = false } = {}) {
  const user = uid();
  const hit = cache.get(user);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const [rows] = await getPool().query("SELECT * FROM departments WHERE user_id = ? ORDER BY sort_order, created_at, name", [user]);
  const list = rows.map(publicDepartment);
  cache.set(user, { at: Date.now(), list });
  return list;
}

/** Department names, falling back to the built-in eight when the table is not there (yet). */
export async function departmentNames() {
  try {
    return (await listDepartments()).map((d) => d.name);
  } catch {
    return BUILT_IN;
  }
}

/** Forget the cached departments of one user (the current user by default), or of everyone (null). */
export const clearDepartmentCache = (userId = undefined) => {
  if (userId === null) cache.clear();
  else cache.delete(userId ?? uid());
};

export function slugOf(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Validate a new department's fields: { name, color, description } (422 messages name the field). */
export function parseDepartment(raw, { partial = false } = {}) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bad = (f, m) => {
    throw new WorkError(422, `${f}: ${m}`);
  };
  const out = {};
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim()) bad("name", "is required");
    const name = b.name.replace(/\s+/g, " ").trim();
    if ([...name].length < 2 || [...name].length > 40) bad("name", "should be 2 to 40 characters");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} &/'.-]*$/u.test(name)) bad("name", "use letters, numbers, spaces and & / ' . - only");
    if (!slugOf(name)) bad("name", "should contain letters or numbers");
    out.name = name;
  }
  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) bad("color", "should be a colour like #6c63f6");
    out.color = b.color.toLowerCase();
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") bad("description", "should be text");
    const d = (b.description ?? "").replace(/\s+/g, " ").trim();
    if ([...d].length > 300) bad("description", "should be at most 300 characters");
    out.description = d || null;
  }
  if (b.goal_label !== undefined) {
    if (b.goal_label !== null && typeof b.goal_label !== "string") bad("goal_label", "should be text");
    const g = (b.goal_label ?? "").replace(/\s+/g, " ").trim();
    if ([...g].length > 60) bad("goal_label", "should be at most 60 characters");
    out.goal_label = g || null;
  }
  if (b.target_inr !== undefined) {
    let v = b.target_inr;
    if (typeof v === "string") v = v.replace(/[,\s₹]/g, "") === "" ? null : Number(v.replace(/[,\s₹]/g, ""));
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e13)) bad("target_inr", "should be a whole number of rupees");
    out.target_inr = v;
  }
  if (b.view_type !== undefined) {
    if (b.view_type !== null && !VIEW_TYPES.includes(b.view_type)) bad("view_type", `should be one of ${VIEW_TYPES.join(", ")}, or null to choose from the name`);
    out.view_type = b.view_type;
  }
  if (partial && !Object.keys(out).length) bad("name", "nothing to change");
  return out;
}

export async function createDepartment(data) {
  const user = uid();
  const d = await withTransaction(async (conn) => {
    const [[{ n, last }]] = await conn.query("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS last FROM departments WHERE user_id = ? FOR UPDATE", [user]);
    if (Number(n) >= MAX_DEPARTMENTS) throw new WorkError(409, `You can have at most ${MAX_DEPARTMENTS} departments.`);
    const slug = slugOf(data.name);
    const [[dup]] = await conn.execute("SELECT name FROM departments WHERE user_id = ? AND (name = ? OR slug = ?) LIMIT 1", [user, data.name, slug]);
    if (dup) throw new WorkError(409, `A department called "${dup.name}" already exists.`);
    const id = hexId();
    const color = data.color ?? PALETTE[Number(n) % PALETTE.length];
    await conn.execute("INSERT INTO departments (id, user_id, slug, name, color, description, built_in, sort_order) VALUES (?, ?, ?, ?, ?, ?, 0, ?)", [id, user, slug, data.name, color, data.description ?? null, Number(last) + 10]);
    if (data.view_type) await conn.execute("UPDATE departments SET view_type = ? WHERE id = ? AND user_id = ?", [data.view_type, id, user]);
    return publicDepartment({ id, slug, name: data.name, color, description: data.description ?? null, built_in: 0, goal_label: null, target_inr: null, view_type: data.view_type ?? null });
  });
  clearDepartmentCache();
  return d;
}

/** Change a department's colour or description (names stay: they are stored on people). */
export async function updateDepartment(id, data) {
  if (data.name !== undefined) throw new WorkError(422, "name: a department's name cannot be changed");
  const sets = [];
  const params = [];
  for (const f of ["color", "description", "goal_label", "target_inr", "view_type"]) {
    if (data[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(data[f]);
  }
  const db = getPool();
  const user = uid();
  if (sets.length) await db.execute(`UPDATE departments SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...params, id, user]);
  clearDepartmentCache();
  const [[row]] = await db.execute("SELECT * FROM departments WHERE id = ? AND user_id = ?", [id, user]);
  return row ? publicDepartment(row) : null;
}

/** Delete one of this room's departments (built-in or added): it is taken off every person and opportunity here. */
export async function deleteDepartment(id) {
  const user = uid();
  const done = await withTransaction(async (conn) => {
    const [[d]] = await conn.execute("SELECT name, built_in FROM departments WHERE id = ? AND user_id = ? FOR UPDATE", [id, user]);
    if (!d) return false;
    // Built-in ones too: every account has its own copy of the eight, so this changes only this room.
    const strip = (col) => `${col} = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', ${col}, ','), CONCAT(',', ?, ','), ','))`;
    await conn.execute(`UPDATE people SET ${strip("departments")} WHERE user_id = ? AND FIND_IN_SET(?, departments)`, [d.name, user, d.name]);
    await conn.execute(`UPDATE person_suggestions SET ${strip("departments")} WHERE user_id = ? AND FIND_IN_SET(?, departments)`, [d.name, user, d.name]);
    await conn.execute("UPDATE opportunities SET department = NULL WHERE user_id = ? AND department = ?", [user, d.name]);
    await conn.execute("DELETE FROM departments WHERE id = ? AND user_id = ?", [id, user]);
    return true;
  });
  clearDepartmentCache();
  return done;
}

// ------------------------------------------------------------------------- panel + pages

/** Everyone with their departments and score, plus every opportunity (small tables: one query each). */
async function loadAll() {
  const db = getPool();
  const user = uid();
  const [people] = await db.query(
    // people and opportunities times are written from JavaScript Dates (read back as Dates, like
    // db/people.js does); audio_files.created_at is written by MySQL, so it is read with UNIX_TIMESTAMP.
    `SELECT p.id, p.name, p.category, p.role_title, p.organisation, p.city, p.departments, p.score, p.consent,
            p.last_contact_at AS last_contact, p.last_contact_kind, i.id AS intro_id, i.name AS intro_name
       FROM people p LEFT JOIN people i ON i.id = p.introduced_by_id AND i.user_id = p.user_id
      WHERE p.user_id = ?`,
    [user],
  );
  const [opps] = await db.query(
    `SELECT o.id, o.person_id, o.title, o.stage, o.department, o.value_inr, o.chance_pct, o.next_step, o.due_date, o.origin, o.source_job_id,
            o.created_at AS created, o.updated_at AS updated,
            f.original_name AS source_name, j.kind AS source_kind, UNIX_TIMESTAMP(f.created_at) AS source_epoch
       FROM opportunities o
       LEFT JOIN processing_jobs j ON j.id = o.source_job_id AND j.user_id = o.user_id
       LEFT JOIN audio_files f ON f.id = j.audio_file_id
      WHERE o.user_id = ?`,
    [user],
  );
  const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
  return {
    people: people.map((p) => ({ ...p, departments: splitSet(p.departments), score: p.score === null ? null : Number(p.score), last_contact: dateIso(p.last_contact) })),
    opps: opps.map((o) => ({ ...o, created: dateIso(o.created), updated: dateIso(o.updated), value_inr: o.value_inr === null ? null : Number(o.value_inr), open: !["Won", "Lost"].includes(o.stage) })),
  };
}

const initialsOf = (name) => {
  const w = String(name).split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || "?";
};
const personCard = (p) => ({ id: p.id, name: p.name, initials: initialsOf(p.name), category: p.category, role_title: p.role_title, score: p.score });
const membersOf = (name, people, opps) => {
  const withOpp = new Set(opps.filter((o) => o.department === name).map((o) => o.person_id));
  return people.filter((p) => p.departments.includes(name) || withOpp.has(p.id));
};
const sum = (xs) => xs.reduce((s, o) => s + (o.value_inr ?? 0), 0);
const DAY = 86_400_000;

/** One card per department, who sits where, and plain facts about the last 7 days. */
export async function departmentOverview() {
  const [departments, { people, opps }] = await Promise.all([listDepartments(), loadAll()]);
  const weekAgo = Date.now() - 7 * DAY;
  const cards = departments.map((d) => {
    const members = membersOf(d.name, people, opps);
    const dOpps = opps.filter((o) => o.department === d.name);
    const open = dOpps.filter((o) => o.open);
    const key = [...members].sort((a, b) => b.score - a.score || String(b.last_contact).localeCompare(String(a.last_contact))).slice(0, 2);
    const lastContact = members.map((p) => p.last_contact).filter(Boolean).sort().at(-1) ?? null;
    return {
      ...d,
      people: members.length,
      // "Very interested" (75+) and "Interested" (55-74): the bands of services/people.js interestLevel().
      hot: members.filter((p) => p.score !== null && p.score >= 75).length,
      warm: members.filter((p) => p.score !== null && p.score >= 55 && p.score < 75).length,
      open_opportunities: open.length,
      open_value_inr: sum(open),
      won_value_inr: sum(dOpps.filter((o) => o.stage === "Won")),
      new_this_week: dOpps.filter((o) => o.created && Date.parse(o.created) >= weekAgo).length,
      key_people: key.map(personCard),
      last_contact_at: lastContact,
    };
  });

  // People in two or more departments first, then by score.
  const sits = people
    .filter((p) => p.departments.length)
    .sort((a, b) => b.departments.length - a.departments.length || b.score - a.score)
    .slice(0, 8)
    .map((p) => ({ ...personCard(p), departments: p.departments }));

  // Facts, not guesses: what moved, what is new, what has been quiet.
  const facts = [];
  const busiest = [...cards].sort((a, b) => b.open_value_inr - a.open_value_inr || b.open_opportunities - a.open_opportunities)[0];
  if (busiest?.open_opportunities) facts.push({ department: busiest.name, text: `${busiest.name} has the most open value: ${busiest.open_opportunities} open ${busiest.open_opportunities === 1 ? "opportunity" : "opportunities"}.`, value_inr: busiest.open_value_inr });
  for (const c of cards) if (c.new_this_week && c !== busiest) facts.push({ department: c.name, text: `${c.name}: ${c.new_this_week} new ${c.new_this_week === 1 ? "opportunity" : "opportunities"} this week.`, value_inr: null });
  const recentPeople = people.filter((p) => p.last_contact && Date.parse(p.last_contact) >= weekAgo);
  if (recentPeople.length) facts.push({ department: null, text: `${recentPeople.length} ${recentPeople.length === 1 ? "person was" : "people were"} in calls this week.`, value_inr: null });
  for (const c of cards) {
    if (c.people && c.last_contact_at && Date.now() - Date.parse(c.last_contact_at) > 14 * DAY) facts.push({ department: c.name, text: `${c.name} has been quiet for ${Math.floor((Date.now() - Date.parse(c.last_contact_at)) / DAY)} days.`, value_inr: null });
  }
  const unsorted = people.filter((p) => !p.departments.length).length;
  if (unsorted) facts.push({ department: null, text: `${unsorted} ${unsorted === 1 ? "person has" : "people have"} no department yet.`, value_inr: null });

  return { total_people: people.length, departments: cards, sits_where: sits, facts: facts.slice(0, 6) };
}

/** One department: its people (with their opportunities here) and opportunities, funnel and totals. */
export async function departmentDetail(slug) {
  const departments = await listDepartments();
  const d = departments.find((x) => x.slug === slug);
  if (!d) return null;
  const { people, opps } = await loadAll();
  const members = membersOf(d.name, people, opps);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const dOpps = opps
    .filter((o) => o.department === d.name)
    .map((o) => ({
      id: o.id,
      person: { id: o.person_id, name: names.get(o.person_id) ?? "—", initials: initialsOf(names.get(o.person_id) ?? "?") },
      title: o.title,
      stage: o.stage,
      value_inr: o.value_inr,
      next_step: o.next_step,
      due_date: o.due_date instanceof Date ? o.due_date.toISOString().slice(0, 10) : o.due_date ? String(o.due_date).slice(0, 10) : null,
      origin: o.origin ?? "manual",
      source: o.source_job_id ? { job_id: o.source_job_id, kind: o.source_kind, file_name: o.source_name, at: isoOf(o.source_epoch) } : null,
      chance: chanceOf(o),
      created_at: o.created,
      updated_at: o.updated,
    }))
    .sort((a, b) => Number(["Won", "Lost"].includes(a.stage)) - Number(["Won", "Lost"].includes(b.stage)) || (b.value_inr ?? 0) - (a.value_inr ?? 0));
  const STAGE_ORDER = STAGES; // Identified -> … -> Committed -> Won, Lost (stages.js)
  const funnel = STAGE_ORDER.map((stage) => {
    const xs = dOpps.filter((o) => o.stage === stage);
    return { stage, count: xs.length, value_inr: sum(xs) };
  });
  const open = dOpps.filter((o) => !["Won", "Lost"].includes(o.stage));

  // Interest in each conversation (oldest first) and who the latest one came through.
  const { history, viaByJob } = await conversationsOf(members.map((p) => p.id));
  const today = new Date().toISOString().slice(0, 10);

  const rows = members
    .map((p) => {
      const mine = dOpps.filter((o) => o.person.id === p.id);
      const mineOpen = mine.filter((o) => !["Won", "Lost"].includes(o.stage));
      const furthest = mine.map((o) => o.stage).sort((a, b) => STAGE_ORDER.indexOf(b === "Lost" ? "Identified" : b) - STAGE_ORDER.indexOf(a === "Lost" ? "Identified" : a))[0] ?? null;
      const nextOpp = mineOpen.find((o) => o.next_step) ?? mineOpen.find((o) => o.due_date) ?? null;
      const next = nextOpp?.next_step ?? null;
      const conv = history.get(p.id) ?? [];
      const trend = conv.map((m) => INTEREST_VALUE[m.interest]).filter((v) => v !== undefined).slice(-6);
      const latest = conv.at(-1);
      const via = latest?.relation === "mentioned" ? (viaByJob.get(latest.job_id) ?? []).filter((n) => n.toLowerCase() !== p.name.toLowerCase())[0] ?? null : null;
      return {
        id: p.id,
        name: p.name,
        initials: initialsOf(p.name),
        category: p.category,
        role_title: p.role_title,
        organisation: p.organisation,
        city: p.city,
        score: p.score,
        consent: p.consent,
        introduced_by: p.intro_id ? { id: p.intro_id, name: p.intro_name } : null,
        last_contact_at: p.last_contact,
        last_contact_kind: p.last_contact_kind,
        opportunities: mine.length,
        open_value_inr: sum(mineOpen),
        won_value_inr: sum(mine.filter((o) => o.stage === "Won")),
        stage: furthest,
        next_step: next,
        // Overdue: an open opportunity whose due date has passed.
        overdue: mineOpen.some((o) => o.due_date && o.due_date < today),
        due_date: nextOpp?.due_date ?? null,
        // Interest across their conversations (80 high, 60 some, 35 low), oldest first, and the change
        // from the one before the latest.
        interest_trend: trend,
        interest_change: trend.length >= 2 ? trend.at(-1) - trend.at(-2) : 0,
        conversations: conv.length,
        // The latest conversation only talked about them: who was talking (e.g. "via Sanjay").
        last_contact_via: via,
      };
    })
    .sort((a, b) => b.open_value_inr - a.open_value_inr || b.score - a.score);

  const weekAgo = Date.now() - 7 * DAY;
  const weighted = (xs) => Math.round(xs.reduce((s, o) => s + (o.value_inr ?? 0) * o.chance, 0));
  const won = dOpps.filter((o) => o.stage === "Won");
  const closest = [...open].sort((a, b) => STAGE_ORDER.indexOf(b.stage) - STAGE_ORDER.indexOf(a.stage) || (b.value_inr ?? 0) - (a.value_inr ?? 0))[0] ?? null;

  const extras = await dashboardExtras({ d, rows, dOpps, open, won, people, opps });

  return {
    department: d,
    extras,
    totals: {
      people: rows.length,
      hot: rows.filter((r) => r.score !== null && r.score >= 75).length, // "Very interested"
      open_opportunities: open.length,
      open_value_inr: sum(open),
      weighted_inr: weighted(open),
      weighted_added_this_week_inr: weighted(open.filter((o) => o.created_at && Date.parse(o.created_at) >= weekAgo)),
      won_value_inr: sum(won),
      won_people: new Set(won.map((o) => o.person.id)).size,
      closest: closest ? { person: closest.person, stage: closest.stage, value_inr: closest.value_inr } : null,
      people_with_value: rows.filter((r) => r.open_value_inr > 0).length,
    },
    stage_chance: STAGE_CHANCE,
    funnel,
    people: rows,
    opportunities: dOpps,
    insights: insightsFor(d, rows, sum(open), sum(won)),
  };
}

/** How likely a deal at each stage is to close (stages.js): weighted pipeline = value × chance. */
export { STAGE_CHANCE };

const localYmd = (ms = Date.now()) => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/**
 * What each department dashboard needs beyond the totals, all counted from the data: deals closing
 * soon and stalled (sales), how far deals got (conversion), win rate and average deal, cities
 * (partners' territories), who each person introduced and what that brought, open commitments from
 * their calls (supplier promises, tasks), and deadlines (tenders).
 */
async function dashboardExtras({ d, rows, dOpps, open, won, people, opps }) {
  const db = getPool();
  const today = localYmd();
  const daysTo = (ymd) => Math.round((Date.parse(ymd) - Date.parse(today)) / DAY);

  // Stage history of this department's deals: when each last moved, and the furthest it got.
  const ids = dOpps.map((o) => o.id);
  const lastMove = new Map();
  const furthest = new Map();
  if (ids.length) {
    try {
      const [log] = await db.query("SELECT opportunity_id, from_stage, to_stage, created_at FROM opportunity_stage_changes WHERE opportunity_id IN (?) ORDER BY created_at, id", [ids]);
      for (const r of log) {
        lastMove.set(r.opportunity_id, r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at));
        const at = (s) => (!s || s === "Lost" ? -1 : STAGES.indexOf(s)); // Lost is not a step forward
        const idx = Math.max(at(r.to_stage), at(r.from_stage));
        furthest.set(r.opportunity_id, Math.max(furthest.get(r.opportunity_id) ?? -1, idx));
      }
    } catch (exc) {
      if (exc?.code !== "ER_NO_SUCH_TABLE") throw exc;
    }
  }
  const WON = STAGES.indexOf("Won");
  const reachIdx = (o) => {
    const now = o.stage === "Lost" ? -1 : STAGES.indexOf(o.stage);
    return Math.max(now, Math.min(furthest.get(o.id) ?? -1, WON));
  };
  const lost = dOpps.filter((o) => o.stage === "Lost");
  const flow = STAGES.filter((s) => s !== "Lost");
  const reached = flow.map((stage, i) => ({ stage, count: dOpps.filter((o) => reachIdx(o) >= i).length }));

  const withValue = dOpps.filter((o) => o.stage !== "Lost" && o.value_inr);
  const deal = (o) => ({ id: o.id, title: o.title, person: o.person, stage: o.stage, value_inr: o.value_inr, next_step: o.next_step, due_date: o.due_date });
  const stageSince = (o) => lastMove.get(o.id) ?? o.created_at ?? null;
  const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY) : null);

  // Deadlines: open deals with a due date, soonest first (overdue first).
  const deadlines = open
    .filter((o) => o.due_date)
    .map((o) => ({ ...deal(o), days_left: daysTo(o.due_date) }))
    .sort((a, b) => a.days_left - b.days_left);
  const stalled = open
    .map((o) => ({ ...deal(o), days_in_stage: daysSince(stageSince(o)) }))
    .filter((o) => o.days_in_stage !== null && o.days_in_stage >= 21)
    .sort((a, b) => b.days_in_stage - a.days_in_stage);

  // Cities (territories), from the people here.
  const cityMap = new Map();
  for (const r of rows) {
    const c = r.city ?? "City not known";
    const e = cityMap.get(c) ?? { city: c, known: Boolean(r.city), people: 0, open_value_inr: 0 };
    e.people += 1;
    e.open_value_inr += r.open_value_inr;
    cityMap.set(c, e);
  }
  const cities = [...cityMap.values()].sort((a, b) => Number(b.known) - Number(a.known) || b.people - a.people || b.open_value_inr - a.open_value_inr);

  // Who each person here introduced (anywhere in the room), and the open value that brought.
  const memberIds = new Set(rows.map((r) => r.id));
  const openValueOf = (pid) => opps.filter((o) => o.person_id === pid && o.open).reduce((s, o) => s + (o.value_inr ?? 0), 0);
  const introduced = {};
  for (const p of people) {
    if (!p.intro_id || !memberIds.has(p.intro_id)) continue;
    const e = (introduced[p.intro_id] ??= { count: 0, open_value_inr: 0, names: [] });
    e.count += 1;
    e.open_value_inr += openValueOf(p.id);
    if (e.names.length < 4) e.names.push(p.name);
  }

  // Open commitments from the calls these people were in (promises, deliveries, tasks).
  let commitments = [];
  if (rows.length) {
    const owner = ownerName().trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const [acts] = await db.query(
      `SELECT a.id, a.task, a.responsible_person, a.deadline_text, a.date_text, s.job_id, m.person_id, UNIX_TIMESTAMP(f.created_at) AS epoch
         FROM action_items a JOIN summaries s ON s.id = a.summary_id
         JOIN person_mentions m ON m.job_id = s.job_id
         JOIN processing_jobs j ON j.id = s.job_id JOIN audio_files f ON f.id = j.audio_file_id
        WHERE j.user_id = ? AND a.status = 'open' AND m.person_id IN (?)
        ORDER BY f.created_at DESC, a.seq LIMIT 120`,
      [uid(), [...memberIds]],
    );
    const seen = new Set();
    const nameOf = new Map(rows.map((r) => [r.id, r.name]));
    for (const a of acts) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const by = String(a.responsible_person ?? "").trim();
      const mine = !by || by.split(/\s+/)[0].toLowerCase() === owner;
      commitments.push({
        id: Number(a.id),
        text: a.task,
        who: mine ? "you" : "them",
        by: mine ? null : by,
        person: { id: a.person_id, name: nameOf.get(a.person_id) },
        due_text: a.deadline_text || a.date_text || null,
        job_id: a.job_id,
        at: isoOf(a.epoch),
      });
      if (commitments.length >= 25) break;
    }
  }

  const closedCount = won.length + lost.length;
  return {
    view: d.view,
    win_rate: closedCount ? Math.round((won.length / closedCount) * 100) : null,
    won_count: won.length,
    lost_count: lost.length,
    avg_deal_inr: withValue.length ? Math.round(withValue.reduce((s, o) => s + o.value_inr, 0) / withValue.length) : null,
    reached,
    closing_soon: deadlines.filter((o) => o.days_left <= 14),
    deadlines,
    stalled,
    quiet: rows.filter((r) => daysSince(r.last_contact_at) >= 14).map((r) => ({ id: r.id, name: r.name, days: daysSince(r.last_contact_at), open_value_inr: r.open_value_inr })),
    cities,
    introduced,
    commitments,
    stage_since: Object.fromEntries(open.map((o) => [o.id, stageSince(o)])),
  };
}
// The points of services/people.js INTEREST_POINTS; "unknown" is left out of a trend.
const INTEREST_VALUE = { high: 90, medium: 65, low: 40, none: 10 };

/**
 * For each person: their conversations (oldest first) with the interest shown and whether they took
 * part; and for each conversation, its speakers (to say "via Sanjay" when someone was talked about).
 */
async function conversationsOf(personIds) {
  const history = new Map();
  const viaByJob = new Map();
  if (!personIds.length) return { history, viaByJob };
  const db = getPool();
  const [rows] = await db.query(
    `SELECT m.person_id, m.job_id, m.interest, m.relation FROM person_mentions m
       JOIN processing_jobs j ON j.id = m.job_id JOIN audio_files f ON f.id = j.audio_file_id
      WHERE j.user_id = ? AND m.person_id IN (?) ORDER BY f.created_at, m.id`,
    [uid(), personIds],
  );
  for (const r of rows) {
    if (!history.has(r.person_id)) history.set(r.person_id, []);
    history.get(r.person_id).push(r);
  }
  const jobs = [...new Set(rows.filter((r) => r.relation === "mentioned").map((r) => r.job_id))];
  if (jobs.length) {
    const owner = ownerName().toLowerCase();
    const [speakers] = await db.query(
      "SELECT t.job_id, s.label FROM speakers s JOIN transcripts t ON t.id = s.transcript_id WHERE t.job_id IN (?) ORDER BY s.total_seconds DESC",
      [jobs],
    );
    for (const s of speakers) {
      const label = String(s.label);
      if (!label || /^(person|speaker)\s*\d*$/i.test(label) || label.toLowerCase() === owner || label.toLowerCase().split(" ")[0] === owner.split(" ")[0]) continue;
      if (!viaByJob.has(s.job_id)) viaByJob.set(s.job_id, []);
      viaByJob.get(s.job_id).push(label);
    }
  }
  return { history, viaByJob };
}

const fmtInr = (v) => (v >= 1e7 ? `₹${+(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString("en-IN")}`);

/** Plain facts about a department's people (counted, never guessed): who brings them, who is quiet. */
function insightsFor(d, rows, openValue, wonValue) {
  const out = [];
  const withValue = rows.filter((r) => r.open_value_inr > 0 || r.won_value_inr > 0);
  const label = d.slug === "investment" ? "investors" : "people";
  // Who brings them in.
  const byIntro = new Map();
  for (const r of rows) if (r.introduced_by) byIntro.set(r.introduced_by.name, [...(byIntro.get(r.introduced_by.name) ?? []), r]);
  const top = [...byIntro.entries()].sort((a, b) => b[1].length - a[1].length || sumOf(b[1]) - sumOf(a[1]))[0];
  if (top) {
    const value = sumOf(top[1]);
    out.push(`${top[1].length} of ${rows.length} ${label} came through ${top[0]}${value ? `, ${fmtInr(value)} of the pipeline` : ""}.`);
  }
  // The biggest ticket.
  const biggest = [...withValue].sort((a, b) => b.open_value_inr - a.open_value_inr)[0];
  if (biggest?.open_value_inr && withValue.length > 1) out.push(`${biggest.name} is the largest ticket (${fmtInr(biggest.open_value_inr)}, ${Math.round((biggest.open_value_inr / Math.max(1, openValue)) * 100)}% of the open pipeline).`);
  // Who has gone quiet, and who is warming up or cooling down.
  for (const r of rows) {
    const days = r.last_contact_at ? Math.floor((Date.now() - Date.parse(r.last_contact_at)) / DAY) : null;
    if (days !== null && days >= 14) out.push(`${r.name} has been quiet for ${days} days${r.open_value_inr ? ` with ${fmtInr(r.open_value_inr)} open` : ""}.`);
    if (r.interest_change <= -20) out.push(`${r.name}'s interest dropped in the last conversation.`);
    if (r.overdue) out.push(`${r.name}: the next step is overdue.`);
  }
  // Against the goal.
  if (d.target_inr) {
    out.push(`Pipeline is ${Math.round((openValue / d.target_inr) * 100)}% of the ${fmtInr(d.target_inr)} target${wonValue ? `; ${fmtInr(wonValue)} committed` : "; nothing committed yet"}.`);
  }
  const noAmount = rows.filter((r) => !r.open_value_inr && !r.won_value_inr).length;
  if (noAmount) out.push(`${noAmount} ${noAmount === 1 ? "person has" : "people have"} no amount said yet.`);
  return out.slice(0, 4);
}
const sumOf = (rs) => rs.reduce((s, r) => s + r.open_value_inr + r.won_value_inr, 0);

/** For the sidebar: each department with its member count. */
export async function departmentCounts() {
  const [departments, { people, opps }] = await Promise.all([listDepartments(), loadAll()]);
  return departments.map((d) => ({ ...d, people: membersOf(d.name, people, opps).length }));
}
