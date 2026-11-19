// Referral network (design: "see where every relationship came from"). Everyone in People, who
// introduced whom (people.introduced_by_id, from the calls or set by the owner), each person's
// department, stage and score, the top connectors, and "say thank you" moments: a deal of someone a
// connector introduced moved forward. All counted from the database; nothing is estimated.

import { getPool } from "./pool.js";
import { chanceOf } from "./personWork.js";
import { stageIndex } from "../stages.js";
import { ownerName, uid } from "../tenant.js";

const DAY = 86_400_000;
const THANKS_DAYS = 21; // a forward move this recent is a good moment to thank the connector
const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const splitSet = (s) => (s ? String(s).split(",").filter(Boolean) : []);
const initialsOf = (name) => {
  const w = String(name ?? "").split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || "?";
};
const OPEN = (s) => s !== "Won" && s !== "Lost";

/** The whole network: nodes, links, top connectors and thank-you moments. */
export async function networkData({ now = Date.now() } = {}) {
  const db = getPool();
  const user = uid();
  const [people] = await db.query(
    `SELECT id, name, category, role_title, organisation, city, departments, score, introduced_by_id, first_seen_at, last_contact_at
       FROM people WHERE user_id = ? ORDER BY first_seen_at, id`,
    [user],
  );
  const [opps] = await db.query("SELECT id, person_id, title, stage, value_inr, chance_pct FROM opportunities WHERE user_id = ?", [user]);

  const byId = new Map(people.map((p) => [p.id, p]));
  const dealsOf = new Map();
  for (const o of opps) {
    const list = dealsOf.get(o.person_id) ?? [];
    list.push(o);
    dealsOf.set(o.person_id, list);
  }
  // The introducer, only if they are in People (never a loop).
  const parentOf = (p) => (p.introduced_by_id && p.introduced_by_id !== p.id && byId.has(p.introduced_by_id) ? p.introduced_by_id : null);
  const children = new Map();
  for (const p of people) {
    const parent = parentOf(p);
    if (!parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), p.id]);
  }
  // Level: 1 = known to the owner directly, 2 = introduced by a level-1 person, … (cycles stop at 6).
  const levelOf = new Map();
  const level = (id, seen = new Set()) => {
    if (levelOf.has(id)) return levelOf.get(id);
    const parent = parentOf(byId.get(id));
    const l = !parent || seen.has(parent) || seen.size > 6 ? 1 : level(parent, new Set([...seen, id])) + 1;
    levelOf.set(id, l);
    return l;
  };

  const openValue = (id) => (dealsOf.get(id) ?? []).filter((o) => OPEN(o.stage)).reduce((s, o) => s + Number(o.value_inr ?? 0), 0);
  const nodes = people.map((p) => {
    const deals = dealsOf.get(p.id) ?? [];
    const open = deals.filter((o) => OPEN(o.stage));
    const lead = [...open].sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage) || Number(b.value_inr ?? 0) - Number(a.value_inr ?? 0))[0] ?? deals.find((o) => o.stage === "Won") ?? null;
    return {
      id: p.id,
      name: p.name,
      initials: initialsOf(p.name),
      category: p.category,
      role_title: p.role_title,
      organisation: p.organisation,
      city: p.city,
      departments: splitSet(p.departments),
      score: p.score === null ? null : Number(p.score), // null = interest not clear yet
      introduced_by: parentOf(p),
      level: level(p.id),
      introduced: (children.get(p.id) ?? []).length,
      stage: lead?.stage ?? null,
      deal: lead ? { id: lead.id, title: lead.title, value_inr: lead.value_inr === null ? null : Number(lead.value_inr) } : null,
      open_value_inr: openValue(p.id),
      weighted_inr: Math.round(open.reduce((s, o) => s + Number(o.value_inr ?? 0) * chanceOf(o), 0)),
      first_seen_at: dateIso(p.first_seen_at),
    };
  });

  // Top connectors: who brought the most (direct and second-level introductions, and their open deals).
  const connectors = people
    .filter((p) => children.has(p.id))
    .map((p) => {
      const direct = children.get(p.id);
      const second = direct.flatMap((c) => children.get(c) ?? []);
      const all = [...direct, ...second];
      const active = all.filter((id) => (dealsOf.get(id) ?? []).some((o) => OPEN(o.stage))).length;
      return {
        id: p.id,
        name: p.name,
        initials: initialsOf(p.name),
        departments: splitSet(p.departments),
        direct: direct.length,
        second_level: second.length,
        active,
        value_inr: all.reduce((s, id) => s + openValue(id), 0),
        introduced: direct.map((id) => ({ id, name: byId.get(id).name })),
      };
    })
    .sort((a, b) => b.value_inr - a.value_inr || b.direct + b.second_level - (a.direct + a.second_level))
    .slice(0, 6);

  return { owner: ownerName(), nodes, connectors, thanks: await thanksMoments({ now, byId, parentOf }) };
}

/** Deals of introduced people that moved forward recently: a good moment to update and thank the connector. */
async function thanksMoments({ now, byId, parentOf }) {
  let rows = [];
  try {
    [rows] = await getPool().query(
      `SELECT c.id, c.from_stage, c.to_stage, c.changed_by, c.created_at, o.id AS opp_id, o.title, o.person_id
         FROM opportunity_stage_changes c JOIN opportunities o ON o.id = c.opportunity_id
        WHERE o.user_id = ? AND c.from_stage IS NOT NULL AND c.created_at >= ? ORDER BY c.created_at DESC, c.id DESC LIMIT 200`,
      [uid(), new Date(now - THANKS_DAYS * DAY)],
    );
  } catch (exc) {
    if (exc?.code !== "ER_NO_SUCH_TABLE") throw exc;
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    // Only each deal's latest move counts: moved on and then back is not a moment to thank anyone.
    if (seen.has(r.opp_id)) continue;
    seen.add(r.opp_id);
    const forward = r.to_stage === "Won" || stageIndex(r.to_stage) > stageIndex(r.from_stage);
    const person = byId.get(r.person_id);
    const intro = person ? parentOf(person) : null;
    if (!forward || !intro) continue;
    out.push({
      id: Number(r.id),
      person: { id: person.id, name: person.name },
      connector: { id: intro, name: byId.get(intro).name },
      opportunity: { id: r.opp_id, title: r.title },
      from: r.from_stage,
      to: r.to_stage,
      by: r.changed_by,
      at: dateIso(r.created_at),
    });
    if (out.length >= 3) break;
  }
  return out;
}
