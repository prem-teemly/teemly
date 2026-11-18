// One opportunity's page (design: "One opportunity, everything in one place"): the deal and its
// chance, the person, where it stands (stage tracker + every move), the AI's view ("Will it work
// out?"), the evidence from calls, the next step, the deal details and how the person came to the
// owner (the introduction path). All from the database; nothing is shown that was not said or set.

import * as config from "../config.js";
import { getPool } from "./pool.js";
import { OPP_SELECT, WorkError, publicOpportunity } from "./personWork.js";
import { listDepartments } from "./departments.js";
import * as repo from "./repository.js";
import { STAGES, STAGE_CHANCE } from "../stages.js";
import { jobLines } from "../services/peopleJob.js";
import { analyzeOpportunity } from "../services/opportunityInsight.js";

const INSIGHT_CONVERSATIONS = 3; // the latest calls or chats with the person that the AI reads
const dateIso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const isoOf = (epoch) => (epoch === null || epoch === undefined ? null : new Date(Math.round(Number(epoch) * 1000)).toISOString());
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const initialsOf = (name) => {
  const w = String(name ?? "").split(/\s+/).filter(Boolean);
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0]?.[0] ?? "") + (w.at(-1)?.[0] ?? "")).toUpperCase() || "?";
};

/** The person's calls and chats, newest first (upload time). */
async function conversationsOf(personId, limit = 10) {
  const [rows] = await getPool().query(
    `SELECT m.job_id, m.relation, m.context, m.quote, j.kind, f.original_name, f.duration_seconds, UNIX_TIMESTAMP(f.created_at) AS epoch
       FROM person_mentions m JOIN processing_jobs j ON j.id = m.job_id JOIN audio_files f ON f.id = j.audio_file_id
      WHERE m.person_id = ? ORDER BY f.created_at DESC, m.id DESC LIMIT ?`,
    [personId, limit],
  );
  return rows.map((r) => ({ job_id: r.job_id, kind: r.kind, file_name: r.original_name, duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds), at: isoOf(r.epoch), relation: r.relation, context: r.context, quote: r.quote }));
}

/** The conversations the AI reads for the insight (latest few), as sorted job ids. */
const insightJobs = (conversations) => conversations.slice(0, INSIGHT_CONVERSATIONS).map((c) => c.job_id).sort();

/** You -> (introducers, oldest first) -> the person; at most 4 steps, never looping. */
async function introductionPath(person) {
  const chain = [];
  const seen = new Set([person.id]);
  let next = person.introduced_by_id;
  while (next && !seen.has(next) && chain.length < 4) {
    seen.add(next);
    const [[p]] = await getPool().execute("SELECT id, name, introduced_by_id FROM people WHERE id = ?", [next]);
    if (!p) break;
    chain.unshift({ id: p.id, name: p.name, initials: initialsOf(p.name) });
    next = p.introduced_by_id;
  }
  const owner = config.AUTH.ownerName ?? "You";
  return [{ id: null, name: owner, initials: initialsOf(owner), owner: true }, ...chain, { id: person.id, name: person.name, initials: initialsOf(person.name) }];
}

async function loadInsight(id) {
  try {
    const [[r]] = await getPool().execute("SELECT data, based_on, model, created_at FROM opportunity_insights WHERE opportunity_id = ?", [id]);
    return r ? { data: parseJson(r.data), based_on: parseJson(r.based_on) ?? [], model: r.model, created_at: dateIso(r.created_at) } : null;
  } catch (exc) {
    if (exc?.code === "ER_NO_SUCH_TABLE") return null; // migration 015 not applied yet
    throw exc;
  }
}

/** Everything for one opportunity's page, or null when it does not exist. */
export async function opportunityDetail(id) {
  const db = getPool();
  const [[row]] = await db.execute(`${OPP_SELECT} WHERE o.id = ?`, [id]);
  if (!row) return null;
  const opportunity = publicOpportunity(row);
  const [[p]] = await db.execute(
    `SELECT p.id, p.name, p.category, p.role_title, p.organisation, p.city, p.score, p.first_seen_at, p.last_contact_at, p.introduced_by_id, i.name AS intro_name
       FROM people p LEFT JOIN people i ON i.id = p.introduced_by_id WHERE p.id = ?`,
    [row.person_id],
  );
  const person = {
    id: p.id,
    name: p.name,
    initials: initialsOf(p.name),
    category: p.category,
    role_title: p.role_title,
    organisation: p.organisation,
    city: p.city,
    score: p.score === null ? null : Number(p.score), // null = interest not clear yet
    first_seen_at: dateIso(p.first_seen_at),
    last_contact_at: dateIso(p.last_contact_at),
    introduced_by: p.introduced_by_id ? { id: p.introduced_by_id, name: p.intro_name } : null,
  };

  let history = [];
  try {
    const [h] = await db.execute("SELECT from_stage, to_stage, changed_by, source_job_id, created_at FROM opportunity_stage_changes WHERE opportunity_id = ? ORDER BY created_at, id", [id]);
    history = h.map((r) => ({ from: r.from_stage, to: r.to_stage, by: r.changed_by, source_job_id: r.source_job_id, at: dateIso(r.created_at) }));
  } catch (exc) {
    if (exc?.code !== "ER_NO_SUCH_TABLE") throw exc;
  }

  const conversations = await conversationsOf(person.id);
  const insight = await loadInsight(id);
  const department = opportunity.department ? ((await listDepartments().catch(() => [])).find((d) => d.name === opportunity.department) ?? null) : null;
  return {
    opportunity: { ...opportunity, stage_chance: STAGE_CHANCE[opportunity.stage] ?? 0 },
    person,
    department: department ? { name: department.name, slug: department.slug, color: department.color } : null,
    stages: STAGES.map((s) => ({ stage: s, chance: STAGE_CHANCE[s] })),
    history,
    conversations,
    path: await introductionPath({ id: person.id, name: person.name, introduced_by_id: p.introduced_by_id }),
    insight: insight
      ? { ...insight, stale: JSON.stringify([...insight.based_on].sort()) !== JSON.stringify(insightJobs(conversations)) }
      : null,
    can_analyse: conversations.length > 0,
  };
}

/**
 * Make (or remake) the AI's view of an opportunity from the latest calls and chats with the person,
 * and save it. Returns the saved insight.
 */
export async function refreshInsight(id) {
  const detail = await opportunityDetail(id);
  if (!detail) throw new WorkError(404, "Opportunity not found.");
  const jobs = detail.conversations.slice(0, INSIGHT_CONVERSATIONS).reverse(); // oldest first
  const conversations = [];
  for (const c of jobs) {
    const dict = await repo.loadJob(c.job_id).catch(() => null);
    if (!dict?.result) continue;
    const label = `${c.kind === "whatsapp" ? "Chat" : "Call"} ${c.at ? c.at.slice(0, 10) : ""}`.trim();
    conversations.push({ job_id: c.job_id, label, lines: jobLines({ kind: dict.kind, result: dict.result }) });
  }
  const o = detail.opportunity;
  const data = await analyzeOpportunity(
    { title: o.title, stage: o.stage, chance: o.chance, value_inr: o.value_inr, department: o.department, next_step: o.next_step },
    detail.person,
    conversations,
  );
  const basedOn = insightJobs(detail.conversations);
  await getPool().execute(
    `INSERT INTO opportunity_insights (opportunity_id, data, based_on, model, created_at) VALUES (?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE data = new.data, based_on = new.based_on, model = new.model, created_at = new.created_at`,
    [id, JSON.stringify(data), JSON.stringify(basedOn), config.settings.GEMINI_TEXT_MODEL, new Date()],
  );
  return { data, based_on: basedOn, model: config.settings.GEMINI_TEXT_MODEL, created_at: new Date().toISOString(), stale: false };
}
