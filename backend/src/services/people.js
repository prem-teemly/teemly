// People in a conversation: who took part (other than the owner) and who was talked about.
//
// After a call or chat is analysed, Gemini (GEMINI_TEXT_MODEL) reads the named transcript and lists
// each real person with what the conversation says about them: category (Investor, HNI, Business
// partner, Expert, Govt official, Vendor), role, organisation, city, departments, interest, who
// introduced them and a short context, citing the transcript lines.
//
// The model is never trusted blindly. A person is kept only if their name really occurs in the
// transcript; a city only if it is really said; categories and departments only from the fixed lists;
// evidence only as real line numbers; the owner is never added. Everything else is dropped.

import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";
import { norm } from "./pulse.js";
import { listDepartments } from "../db/departments.js";
import { AI_STAGES } from "../stages.js";
import { getPool } from "../db/pool.js";
import { ownerName as currentOwnerName, uid } from "../tenant.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.people");

export const CATEGORIES = ["Investor", "HNI", "Business partner", "Expert", "Govt official", "Vendor"];
export const DEPARTMENTS = ["Investment", "Sales", "Channel partners", "Accounts", "Marketing", "Tech & AI", "Govt tenders", "Vendors"];
export const INTEREST = ["high", "medium", "low", "none", "unknown"];
/** Stages the AI may give a captured opportunity (Won / Lost are only set by the owner). */
export { AI_STAGES };
const MAX_OPPORTUNITIES = 3; // per person per conversation

/** People could not be extracted; the message is safe to log. */
export class PeopleUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "PeopleUnavailable";
  }
}

/**
 * The answer schema for the owner's current departments (built-in + the ones added in Settings), so
 * the model can only pick departments that exist.
 */
export function peopleSchema(departments = DEPARTMENTS) {
  const depts = departments.length ? departments : DEPARTMENTS;
  const OpportunityOut = z.object({
    title: z.string().describe("Short name of the opportunity, 3-8 words, e.g. 'South TN distribution of Teemly', 'Seed investment in Teemly'"),
    stage: z
      .enum(AI_STAGES)
      .describe(
        "Identified = it just came up; First contact = first call or meeting with them done or fixed; In discussion = both sides are actively discussing it; " +
          "Pitch / bid shared = a deck, quote, proposal or tender bid was sent or asked for; Negotiation = amount or terms are being bargained; " +
          "Committed = they said yes and only signing or payment is left",
      ),
    department: z.enum([...depts, "unclear"]).describe("Which of the owner's departments it belongs to"),
    value_inr: z.int().nullable().describe("Amount in whole rupees ONLY if an amount is said for this opportunity (1 lakh = 100000, 1 crore = 10000000); else null"),
    next_step: z.string().nullable().describe("The next concrete step if said, e.g. 'Demo on Monday'; else null"),
    // default(null): an answer without the field (older test fakes) still reads as "no date said".
    due_date: z
      .string()
      .nullable()
      .default(null)
      .describe("YYYY-MM-DD ONLY if a specific day is said for the next step or deadline (a tender's last date, 'deliver by Friday', 'within 10 days'), worked out from CALL DATE; else null. Never guess a day that was not said."),
    evidence_ids: z.array(z.int()).describe("IDs of the 1-4 lines that show this opportunity"),
  });
  const DepartmentWhy = z.object({
    department: z.enum(depts).describe("One of the departments in `departments`"),
    reason: z.string().describe("Why, in one short sentence (max ~20 words) based on what was said, e.g. 'Runs a print shop and quoted for flyers'"),
    confidence: z.enum(["high", "medium", "low"]).describe("high = said plainly; medium = clear from context; low = a guess from a hint"),
    evidence_ids: z.array(z.int()).describe("IDs of the 1-3 lines that show it"),
  });
  const PersonOut = personOut(depts, OpportunityOut).extend({
    // default([]): an answer without the field (test fakes) still reads as "no reasons given".
    department_reasons: z.array(DepartmentWhy).default([]).describe("For each department in `departments`: why this person belongs there"),
  });
  const DepartmentIdea = z.object({
    name: z.string().describe("Short department name, 1-3 words, e.g. 'Customer Success', 'Legal'"),
    description: z.string().describe("Who would belong there, one sentence, e.g. 'Support staff and partners who keep customers happy after they buy'"),
    reason: z.string().describe("Why it was suggested, in one short sentence based on what was said"),
    said_by: z.string().nullable().describe("Name of who suggested it, as said; null if unclear"),
    evidence_ids: z.array(z.int()).describe("IDs of the 1-3 lines where it is suggested"),
  });
  return gemini.defineSchema(
    "_PeopleInConversation",
    z.object({
      people: z.array(PersonOut),
      // default([]): an answer without the field (test fakes) reads as "no new departments".
      department_ideas: z.array(DepartmentIdea).default([]).describe("New departments or teams someone says the owner should create; empty if none"),
    }),
  );
}

const personOut = (depts, OpportunityOut) => z.object({
  name: z.string().describe("The person's name as spoken, in English letters, without honorifics (e.g. 'Deepan', not 'Deepan sir')"),
  relation: z.enum(["participant", "mentioned"]).describe("participant = speaks in this conversation; mentioned = only talked about"),
  category: z.enum([...CATEGORIES, "unclear"]).describe("What this person is to the owner's business, only if the conversation makes it clear"),
  role_title: z.string().nullable().describe("Short role as said, e.g. 'Angel investor', 'Chartered accountant', 'Joint director, industries'; null if not said"),
  organisation: z.string().nullable().describe("Company, fund or office they belong to, only if said; else null"),
  city: z.string().nullable().describe("City they are based in, only if said in the conversation; else null"),
  departments: z.array(z.enum(depts)).describe("Which of the owner's departments this person is relevant to"),
  interest: z.enum(INTEREST).describe("Their interest in working with the owner, as shown in the conversation"),
  introduced_by: z.string().nullable().describe("Name of the person who introduced or referred them, if said; else null"),
  context: z.string().describe("1-3 sentences: who they are and what was said about them (numbers, plans, next steps)"),
  quote: z.string().nullable().describe("Short English quote (max ~20 words) from the conversation about them; else null"),
  evidence_ids: z.array(z.int()).describe("IDs of the 1-5 lines this comes from"),
  // default([]): an answer without the field (older prompt, test fakes) still reads as "none".
  opportunities: z.array(OpportunityOut).default([]).describe("Concrete business opportunities for the owner WITH this person; empty if none"),
});

const PROMPT = `You read a call, meeting or chat transcript (Tamil, English, Tanglish, Hindi or Telugu;
an English translation is given under lines) for a business owner's contact book.

List every REAL PERSON, other than the owner, who either
- takes part in the conversation (relation "participant"), or
- is talked about in it (relation "mentioned"), e.g. "Deepan is an angel investor in Chennai".

Rules:
- The owner is OWNER (see below). Never list the owner.
- Only people with a name that is actually said or written in the conversation. Unnamed people
  ("Person 2", "his friend", "the CA") are left out. Never invent names.
- Companies, products, places and groups are not people.
- name: in English letters, as said, without honorifics (sir, madam, anna, ji, garu, Mr, Dr).
- category — what they are to the owner's business, ONLY if the conversation makes it clear:
  Investor (invests or may invest: angel, VC, fund), HNI (high-net-worth individual with money to put
  in, e.g. a wealthy businessman or landlord), Business partner (partners, resells, refers business,
  joint venture), Expert (advisor or specialist whose know-how is needed: tech, legal, AI, domain),
  Govt official (works in a government department, ministry or public body), Vendor (supplies goods
  or services to the owner: CA, agency, supplier, contractor). Otherwise "unclear".
- city: only a city said in the conversation for THIS person; else null. Never guess from language.
- KNOWN PEOPLE (below) are already in the owner's contact book. When someone here is clearly one of
  them (for example only the first name "Meena" is said and the known name is "Meena Iyer", and
  nothing suggests a different person), use the known name exactly, also in introduced_by.
  Otherwise use the name as said. Two people can share a first name: if a different surname or
  initial is said ("Vimal Raj" when the known name is "Vimal Kumar"), or the city, company or work
  clearly does not fit the known person, keep the name exactly as said; never merge them.
- departments: the owner's departments this person matters to, from DEPARTMENTS below (each says who
  belongs there), because of the work THIS person does or offers. Pick the best fitting ones; empty
  if unclear. Someone who only introduces or recommends other people does not go into those
  people's department. An opportunity's department is the department of that piece of work.
- department_reasons: for EACH department you put in departments, why: one short reason based on
  what was said about this person (their work, what they offer or want), how sure you are (high
  when it is said plainly, medium when it is clear from context, low when it is only a hint), and
  the line IDs that show it. This is shown to the owner to route the person to the right team.
- interest: how interested they are in working with the owner, from what they say and how:
  high = clearly keen (asks for the next step, a price, a meeting, says yes); medium = open or positive
  but not committing; low = hesitant, putting it off ("maybe later", "let me think"); none = says
  plainly they are not interested or say no; "unknown" if the conversation does not show it (e.g.
  they are only mentioned in passing). Never guess.
- introduced_by: the name of who introduced or referred them, if said ("Sanjay introduced Deepan").
- context: who they are and what was said about them: amounts, plans, conditions, next steps.
- evidence_ids: the line IDs where this is said.
- opportunities: real business opportunities for the owner with THIS person that the conversation
  clearly talks about: a sale or order, distribution or reselling, a partnership, an investment in
  the owner's company, a government tender, a vendor or supply contract, paid expert help. Not small
  talk, not a vague "let's keep in touch". At most 3 per person, each once (no near-duplicates).
  A referral lead is an opportunity too: when someone tells the owner to meet or contact a named
  person for business ("meet Divya, she is a director, it can be a good opportunity for your
  product"), add it to THAT person (Divya), not to the one who referred them: stage "Identified",
  a title naming what it could bring (e.g. "Product opportunity via Divya (Director)"), next_step
  "Contact <name>" unless another step is said, value_inr null unless an amount is said, and set
  introduced_by to the referrer.
  value_inr only when an amount is said for that opportunity; next_step only when it is said.
  due_date only when a day is said for it (a tender's last date, "send by Friday", "on the 25th",
  "within 10 days"): turn it into YYYY-MM-DD from CALL DATE below (the next such day after it; "25th"
  = the 25th of this month, or next month if already past). "Soon", "next month" or no day: null.
  An opportunity belongs to the person it is with (the distributor, the investor), not to the
  person who only told the owner about it.
Use only what was said. An empty list is a valid answer.

department_ideas (separate from people): only when someone in the conversation clearly says the owner
should create, start or set up a NEW team or department ("you need a customer success team", "set up
a legal department before the round"). Not a department in DEPARTMENTS below (those exist already),
not a vague remark, not a person's own company department. name: 1-3 words; description: who would
belong there; reason: why, from what was said; said_by: who said it; evidence_ids: the lines.
An empty list is the usual answer.
`;

// --------------------------------------------------------------------------------- names

const HONORIFICS = new Set(["sir", "madam", "mam", "maam", "anna", "akka", "bro", "ji", "garu", "mr", "mrs", "ms", "dr", "shri", "sri", "thiru", "thirumathi", "uncle", "aunty"]);

/** Clean a spoken name: letters, spaces, dots, apostrophes and hyphens; at most 60 characters. */
export function cleanName(s) {
  const words = String(s ?? "")
    .replace(/[^\p{L}\p{M} .'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !HONORIFICS.has(w.toLowerCase().replace(/\./g, "")));
  const name = words.map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return name.length > 60 ? "" : name;
}

/** Matching key: lower case, honorifics removed (the same person across calls). */
export const nameKey = (name) => norm(cleanName(name));

export function initialsOf(name) {
  const w = cleanName(name).split(" ").filter(Boolean);
  if (!w.length) return "?";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------------- cities

const CITY_ALIASES = {
  chennai: "Chennai", madras: "Chennai",
  coimbatore: "Coimbatore", kovai: "Coimbatore",
  bengaluru: "Bengaluru", bangalore: "Bengaluru",
  madurai: "Madurai",
  trichy: "Trichy", tiruchirappalli: "Trichy", tiruchi: "Trichy",
  salem: "Salem", erode: "Erode", tirunelveli: "Tirunelveli", vellore: "Vellore", tiruppur: "Tiruppur",
  pondicherry: "Puducherry", puducherry: "Puducherry",
  hyderabad: "Hyderabad", mumbai: "Mumbai", bombay: "Mumbai", delhi: "Delhi", "new delhi": "Delhi",
  pune: "Pune", kochi: "Kochi", cochin: "Kochi", kolkata: "Kolkata", ahmedabad: "Ahmedabad",
};

/** "bangalore" -> "Bengaluru"; unknown cities keep their spoken form (title case). */
export function canonicalCity(city) {
  const key = norm(String(city ?? ""));
  if (!key) return null;
  return CITY_ALIASES[key] ?? key.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Words a city can appear as in the transcript (its aliases). */
function citySpellings(canonical) {
  const out = Object.entries(CITY_ALIASES).filter(([, v]) => v === canonical).map(([k]) => k);
  return out.length ? out : [norm(canonical)];
}

// ------------------------------------------------------------------------------ validation

const has = (haystack, needle) => !!needle && ` ${haystack} `.includes(` ${needle} `);

/**
 * Keep only what the transcript supports. lines: numbered lines (pulse.linesFromSegments /
 * linesFromMessages) with speaker names already applied. Returns clean people, one per name.
 */
export function validatePeople(raw, lines, ownerName = currentOwnerName(), deptNames = DEPARTMENTS, callDate = localYmd()) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const position = new Map(lines.map((l, i) => [l.id, i]));
  const allText = lines.map((l) => `${norm(l.original ?? "")} ${norm(l.english ?? "")}`).join(" ");
  const speakers = new Set(lines.map((l) => nameKey(l.speaker ?? "")).filter(Boolean));
  const owner = nameKey(ownerName);
  const ownerFirst = owner.split(" ")[0];

  const people = new Map();
  for (const p of raw) {
    const name = cleanName(p.name);
    const key = nameKey(name);
    const first = key.split(" ")[0];
    const reason =
      !key || /^(person|speaker|unknown)\b/.test(key) ? "no real name"
      : key === owner || (key === ownerFirst && owner !== "owner") ? "the owner"
      : !(has(allText, key) || has(allText, first) || speakers.has(key)) ? "name not in the conversation"
      : null;
    if (reason) {
      logger.info(`People: a name was not used (${reason})`);
      continue;
    }
    const evidence = [...new Set(p.evidence_ids)].filter((i) => byId.has(i)).sort((a, b) => a - b).slice(0, 10);
    if (!evidence.length && !speakers.has(key)) {
      logger.info("People: a name was not used (no valid evidence)");
      continue;
    }

    // A city counts only if it is said where this person is talked about: in the cited lines (or the
    // line just before or after), or in their own lines. "Ashok will come to the meeting in
    // Coimbatore" does not make Ashok from Coimbatore unless it is said about him.
    let city = canonicalCity(p.city);
    if (city) {
      const near = new Set();
      for (const id of evidence) for (const d of [-1, 0, 1]) near.add(lines[position.get(id) + d]);
      for (const l of lines) if (nameKey(l.speaker ?? "") === key) near.add(l);
      const nearText = [...near].filter(Boolean).map((l) => `${norm(l.original ?? "")} ${norm(l.english ?? "")}`).join(" ");
      if (!citySpellings(city).some((c) => has(nearText, c))) {
        logger.info("People: a city was dropped (not said about this person)");
        city = null;
      }
    }
    const category = CATEGORIES.includes(p.category) ? p.category : null;
    const departments = [...new Set((p.departments ?? []).filter((d) => deptNames.includes(d)))];
    const introducedBy = p.introduced_by ? cleanName(p.introduced_by) : "";
    const introKey = nameKey(introducedBy);
    const trim = (s, n) => {
      const t = String(s ?? "").replace(/\s+/g, " ").trim();
      return t ? t.slice(0, n) : null;
    };

    const opportunities = validateOpportunities(p.opportunities ?? [], byId, trim, deptNames, callDate);
    // A person with an opportunity in a department belongs to that department too.
    for (const o of opportunities) if (o.department && !departments.includes(o.department)) departments.push(o.department);
    const department_suggestions = validateDepartmentReasons(p.department_reasons ?? [], departments, opportunities, byId, trim);

    const person = {
      opportunities,
      department_suggestions,
      name,
      key,
      relation: p.relation === "participant" || speakers.has(key) ? "participant" : "mentioned",
      category,
      role_title: trim(p.role_title, 120),
      organisation: trim(p.organisation, 120),
      city,
      departments,
      interest: INTEREST.includes(p.interest) ? p.interest : "unknown",
      // Introduced by someone in this conversation (or the owner, which means "direct").
      introduced_by: introKey && introKey !== key && introKey !== owner && introKey !== ownerFirst && has(allText, introKey.split(" ")[0]) ? introducedBy : null,
      context: trim(p.context, 1000) ?? `${name} was mentioned in this conversation.`,
      quote: trim(p.quote, 500),
      evidence,
    };

    // The same person listed twice: keep one, merging what each entry knew.
    const seen = people.get(key);
    if (seen) {
      for (const f of ["category", "role_title", "organisation", "city", "introduced_by", "quote"]) seen[f] ??= person[f];
      seen.departments = [...new Set([...seen.departments, ...person.departments])];
      seen.department_suggestions = [...seen.department_suggestions, ...person.department_suggestions.filter((s) => !seen.department_suggestions.some((x) => x.department === s.department))];
      seen.evidence = [...new Set([...seen.evidence, ...person.evidence])].sort((a, b) => a - b);
      const titles = new Set(seen.opportunities.map((o) => norm(o.title)));
      seen.opportunities.push(...person.opportunities.filter((o) => !titles.has(norm(o.title))));
      seen.opportunities = seen.opportunities.slice(0, MAX_OPPORTUNITIES);
      if (person.relation === "participant") seen.relation = "participant";
    } else {
      people.set(key, person);
    }
  }
  return [...people.values()];
}

const CONFIDENCE = ["high", "medium", "low"];
const lineOf = (l) => ({ id: l.id, speaker: l.speaker ?? null, time_label: l.time_label ?? null, text: String(l.original ?? "").slice(0, 600), english: l.english ? String(l.english).slice(0, 600) : null });

/**
 * Why each of a person's departments (shown in the inbox to route them): the AI's reason, how sure
 * it is and the lines that show it. Only departments the person is in; cited lines must be real.
 * A department that only comes from an opportunity gets that opportunity as its reason; one the AI
 * gave no reason for is kept with confidence "low" and no reason. Most certain first.
 */
function validateDepartmentReasons(raw, departments, opportunities, byId, trim) {
  const out = [];
  for (const r of raw) {
    if (!departments.includes(r.department) || out.some((x) => x.department === r.department)) continue;
    const ids = [...new Set(r.evidence_ids ?? [])].filter((i) => byId.has(i)).sort((a, b) => a - b).slice(0, 3);
    out.push({ department: r.department, reason: trim(r.reason, 200), confidence: CONFIDENCE.includes(r.confidence) ? r.confidence : "low", evidence: ids.map((i) => lineOf(byId.get(i))) });
  }
  for (const d of departments) {
    if (out.some((x) => x.department === d)) continue;
    const o = opportunities.find((x) => x.department === d);
    out.push(o ? { department: d, reason: `Opportunity here: ${o.title}`, confidence: "medium", evidence: o.evidence.slice(0, 2).map(({ start, ...l }) => l) } : { department: d, reason: null, confidence: "low", evidence: [] });
  }
  return out.sort((a, b) => CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence));
}

/**
 * Keep only opportunities the transcript supports: a title, at least one real cited line, a known
 * department and stage, and a sane amount. The cited lines are kept with each opportunity
 * ({ id, speaker, time_label, start, text, english }) so its evidence survives with it.
 */
/**
 * A due date the model worked out ("YYYY-MM-DD"): kept only if it is a real day, not before the call
 * by more than a week (a date already past when it was said is a slip) and within two years of it.
 */
export function dueDateOf(raw, callDate) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== raw) return null; // e.g. 2026-02-30
  const base = Date.parse(`${callDate}T00:00:00Z`);
  if (!Number.isNaN(base) && (t < base - 7 * 86_400_000 || t > base + 730 * 86_400_000)) return null;
  return raw;
}

function validateOpportunities(raw, byId, trim, deptNames = DEPARTMENTS, callDate = localYmd()) {
  const out = [];
  const titles = new Set();
  for (const o of raw) {
    const title = trim(o.title, 160);
    if (!title || titles.has(norm(title))) continue;
    const ids = [...new Set(o.evidence_ids ?? [])].filter((i) => byId.has(i)).sort((a, b) => a - b).slice(0, 4);
    if (!ids.length) {
      logger.info("People: an opportunity was not used (no valid evidence)");
      continue;
    }
    const value = Number.isInteger(o.value_inr) && o.value_inr > 0 && o.value_inr <= 1e13 ? o.value_inr : null;
    titles.add(norm(title));
    out.push({
      title,
      stage: AI_STAGES.includes(o.stage) ? o.stage : "Identified",
      department: deptNames.includes(o.department) ? o.department : null,
      value_inr: value,
      next_step: trim(o.next_step, 300),
      due_date: dueDateOf(o.due_date, callDate),
      evidence: ids.map((i) => {
        const l = byId.get(i);
        return { id: l.id, speaker: l.speaker ?? null, time_label: l.time_label ?? null, start: typeof l.start === "number" ? l.start : null, text: String(l.original ?? "").slice(0, 600), english: l.english ? String(l.english).slice(0, 600) : null };
      }),
    });
    if (out.length >= MAX_OPPORTUNITIES) break;
  }
  return out;
}

// --- Interest: how interested a person is, from what the AI heard in each call (high / medium / low /
// none; "unknown" calls do not count). The score is 0-100: the latest call weighs half, all earlier
// calls together the other half, so a cooling or warming person shows it. No known call: null, shown
// as "Not clear yet" (never a guess). The labels are the same on every page (frontend lib/people.ts).
export const INTEREST_POINTS = { high: 90, medium: 65, low: 40, none: 10 };
/** Score from a person's calls, oldest to newest: e.g. ["high", "unknown", "low"] -> 65; none known -> null. */
export function interestScore(levels) {
  const pts = levels.map((l) => INTEREST_POINTS[l]).filter((p) => p !== undefined);
  if (!pts.length) return null;
  const latest = pts.at(-1);
  if (pts.length === 1) return latest;
  const earlier = pts.slice(0, -1);
  return Math.round(latest * 0.5 + (earlier.reduce((s, p) => s + p, 0) / earlier.length) * 0.5);
}
/** very (Very interested) >= 75 > interested >= 55 > slight (Slightly interested) >= 30 > not; null = unclear. */
export const INTEREST_BANDS = { very: 75, interested: 55, slight: 30 };
export function interestLevel(score) {
  if (score === null || score === undefined) return "unclear";
  return score >= INTEREST_BANDS.very ? "very" : score >= INTEREST_BANDS.interested ? "interested" : score >= INTEREST_BANDS.slight ? "slight" : "not";
}
/** A score column as a number, keeping "not clear yet" (NULL) as null. */
export const scoreValue = (v) => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------------------------------ main

function formatLine(l) {
  let out = `[${l.id}] ${l.time_label ?? ""} ${l.speaker || "Unknown"}: ${l.original}`;
  if (l.english && norm(l.english) !== norm(l.original)) out += `\n      (English: ${l.english})`;
  return out;
}

/** The owner's departments with who belongs in each (built-in eight if the table is not reachable). */
async function currentDepartments() {
  try {
    const list = await listDepartments();
    if (list.length) return list.map((d) => ({ name: d.name, slug: d.slug, description: d.description }));
  } catch {
    /* database not reachable or migration 009 not applied */
  }
  return DEPARTMENTS.map((name) => ({ name, description: null }));
}

/**
 * Names already in People whose first name is said in this conversation (so "Meena" can be matched
 * to "Meena Iyer"). Only names, at most 50; empty when the database is not reachable.
 */
async function knownPeople(lines) {
  try {
    const db = getPool();
    if (!db) return [];
    const said = new Set(
      lines
        .flatMap((l) => [l.speaker ?? "", l.original ?? "", l.english ?? ""])
        .join(" ")
        .split(/[^\p{L}\p{N}]+/u)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1),
    );
    const [rows] = await db.query("SELECT name, name_key FROM people WHERE user_id = ? ORDER BY last_contact_at DESC LIMIT 2000", [uid()]);
    return rows.filter((r) => said.has(String(r.name_key).split(" ")[0])).slice(0, 50).map((r) => r.name);
  } catch {
    return [];
  }
}

/** Ask the model for the people in numbered lines and return the validated list. */
export async function extract(lines, ownerName = currentOwnerName()) {
  return (await extractAll(lines, ownerName)).people;
}

const ideaKey = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(department|dept|team|division|cell|wing)\b/g, " ").replace(/\s+/g, " ").trim();

/**
 * Keep only new-department ideas the conversation supports: a valid name that is not an existing
 * department (by name, slug or the name without "team/department"), at least one real cited line.
 * One per name. `existing`: the owner's departments ({ name, slug }).
 */
export function validateDepartmentIdeas(raw, lines, existing) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const taken = new Set(existing.flatMap((d) => [ideaKey(d.name), ideaKey(String(d.slug ?? "").replace(/-/g, " "))]).filter(Boolean));
  const trim = (s, n) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, n) : null;
  };
  const out = [];
  for (const idea of raw ?? []) {
    const name = trim(String(idea.name ?? "").replace(/\b(department|dept)\b/gi, "").replace(/\bteam$/i, ""), 40)?.replace(/^\w/, (c) => c.toUpperCase());
    const key = ideaKey(name);
    if (!name || [...name].length < 2 || !/^[\p{L}\p{N}][\p{L}\p{N} &/'.-]*$/u.test(name) || !key) continue;
    if (taken.has(key) || out.some((o) => o.key === key)) {
      logger.info("People: a department idea was not used (it exists already)");
      continue;
    }
    const ids = [...new Set(idea.evidence_ids ?? [])].filter((i) => byId.has(i)).sort((a, b) => a - b).slice(0, 3);
    if (!ids.length) {
      logger.info("People: a department idea was not used (no valid evidence)");
      continue;
    }
    out.push({ name, key, description: trim(idea.description, 300), reason: trim(idea.reason, 300), said_by: trim(cleanName(idea.said_by ?? ""), 80), evidence: ids.map((i) => lineOf(byId.get(i))) });
    if (out.length >= 3) break;
  }
  return out;
}

/** YYYY-MM-DD of a moment in the server's local day (the owner's machine). */
export const localYmd = (ms = Date.now()) => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/**
 * People (validated) and new-department ideas from one conversation, in one model call.
 * `callAt`: when the conversation was uploaded (ms), so "by Friday" or "the 25th" become real dates.
 */
export async function extractAll(lines, ownerName = currentOwnerName(), { callAt = Date.now() } = {}) {
  if (!lines.length) return { people: [], departmentIdeas: [] };
  const [departments, known] = await Promise.all([currentDepartments(), knownPeople(lines)]);
  const names = departments.map((d) => d.name);
  const callDate = localYmd(callAt);
  const weekday = new Date(callAt).toLocaleDateString("en-IN", { weekday: "long" });
  const prompt =
    PROMPT +
    `\nCALL DATE: ${callDate} (${weekday})\n` +
    `\nOWNER: ${ownerName === "Owner" ? "the person who recorded or uploaded this conversation (name not known)" : ownerName}\n` +
    `\nKNOWN PEOPLE: ${known.length ? known.join(", ") : "(none with a name said here)"}\n` +
    "\nDEPARTMENTS (name: who belongs there):\n" +
    departments.map((d) => `- ${d.name}${d.description ? `: ${d.description}` : ""}`).join("\n") +
    "\n\n=== CONVERSATION ===\n" +
    lines.map(formatLine).join("\n");
  let raw;
  try {
    raw = await gemini.generateJson(prompt, peopleSchema(names), {
      model: config.settings.GEMINI_TEXT_MODEL,
      temperature: 0.1,
      thinkingLevel: config.settings.ANALYSIS_THINKING_LEVEL,
      timeoutSeconds: config.settings.GEMINI_TEXT_TIMEOUT_SECONDS,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
  } catch (exc) {
    if (exc instanceof gemini.GeminiUnavailable) throw new PeopleUnavailable(exc.message);
    throw exc;
  }
  return {
    people: validatePeople(raw.people, lines, ownerName, names, callDate),
    departmentIdeas: validateDepartmentIdeas(raw.department_ideas, lines, departments),
  };
}
