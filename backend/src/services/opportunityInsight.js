// "Will it work out?" — the AI's view of one opportunity, read from the calls and chats with that
// person (GEMINI_TEXT_MODEL). Two or three factors (each High / Medium / Low with a reason and the lines
// that show it), what would change the outlook, a suggested chance of closing, and — for investors —
// the details said in the conversations (instrument, who decides, when).
//
// Only what was said: a factor must cite real lines; details not said stay empty; the chance is a
// suggestion the owner accepts or ignores (never applied by itself).

import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";
import { norm } from "./pulse.js";
import { ownerName as currentOwnerName } from "../tenant.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.insight");
const LEVELS = ["high", "medium", "low"];

/** The insight could not be made (the message is safe to show). */
export class InsightUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "InsightUnavailable";
  }
}

const Schema = gemini.defineSchema(
  "_OpportunityOutlook",
  z.object({
    factors: z
      .array(
        z.object({
          label: z.string().describe("What this factor is about, 1-3 words, e.g. 'First meeting', 'Investment', 'Budget', 'Timing'"),
          level: z.enum(LEVELS).describe("How good it looks for the deal: high, medium or low"),
          reason: z.string().describe("Why, in one short sentence from what was said, e.g. 'Agreed to meet via Naveen; asked for the deck'"),
          evidence_ids: z.array(z.int()).describe("IDs of the 1-3 lines that show it"),
        }),
      )
      .describe("2 or 3 factors that decide whether this deal will close"),
    would_change: z.string().nullable().describe("What would make it more likely, one sentence, e.g. 'Would move to High if the traction note lands before Monday'; null if nothing is clear"),
    suggested_chance_pct: z.int().describe("Your estimate (0-100) that this deal closes, from what was said"),
    details: z
      .object({
        instrument: z.string().nullable().describe("For an investment: equity, SAFE, debt… only if said; else null"),
        decision_by: z.string().nullable().describe("Who decides, only if said, e.g. 'Himself + 1 partner'; else null"),
        expected: z.string().nullable().describe("When it may close, only if said, e.g. 'December'; else null"),
      })
      .describe("Deal details said in the conversations"),
  }),
);

const PROMPT = `You help a business owner judge one opportunity (a deal) with one person. Below are the
deal and the conversations (calls or chats; Tamil, English, Tanglish, Hindi or Telugu, with English
under lines) in which that person took part or was talked about.

Say, from what was said ONLY:
- factors: the 2 or 3 things that decide whether this deal will close (e.g. their interest, a first
  meeting, budget, timing, a condition they set). Each: high / medium / low for the deal, a short reason
  and the line IDs. Do not invent facts; if the conversations say little, say so with a low or medium.
- would_change: what would make it more likely to close, if the conversations make it clear.
- suggested_chance_pct: your honest estimate (0-100) that it closes. The current stage alone gives
  CURRENT_CHANCE; move away from it only for reasons in the conversations.
- details: instrument, who decides and when it may close — only if said; else null.
`;

function formatLine(l) {
  let out = `[${l.gid}] ${l.when} ${l.speaker || "Unknown"}: ${l.original}`;
  if (l.english && norm(l.english) !== norm(l.original)) out += `\n      (English: ${l.english})`;
  return out;
}

/**
 * Ask the model. `deal`: { title, stage, chance, value_inr, department, next_step }; `person`:
 * { name, role_title, organisation, city }; `conversations`: [{ job_id, label, lines: [{ id, speaker,
 * time_label, original, english, start }] }] (oldest first). Returns the validated insight.
 */
export async function analyzeOpportunity(deal, person, conversations, ownerName = currentOwnerName()) {
  const lines = [];
  conversations.forEach((c, ci) => {
    for (const l of c.lines) lines.push({ ...l, gid: (ci + 1) * 1000 + l.id, job_id: c.job_id, when: `${c.label}${l.time_label ? ` ${l.time_label}` : ""}` });
  });
  if (!lines.length) throw new InsightUnavailable("There is no conversation with this person to read yet.");
  const prompt =
    PROMPT.replace("CURRENT_CHANCE", `${Math.round(deal.chance * 100)}%`) +
    `\nOWNER: ${ownerName}\n` +
    `\nDEAL: "${deal.title}" with ${person.name}${person.role_title ? ` (${person.role_title}${person.organisation ? `, ${person.organisation}` : ""}${person.city ? `, ${person.city}` : ""})` : ""}` +
    ` · stage: ${deal.stage} · value: ${deal.value_inr ? `₹${deal.value_inr}` : "not said"} · department: ${deal.department ?? "—"} · next step: ${deal.next_step ?? "—"}\n` +
    "\n=== CONVERSATIONS (oldest first) ===\n" +
    lines.map(formatLine).join("\n");
  let raw;
  try {
    raw = await gemini.generateJson(prompt, Schema, {
      model: config.settings.GEMINI_TEXT_MODEL,
      temperature: 0.2,
      thinkingLevel: config.settings.ANALYSIS_THINKING_LEVEL,
      timeoutSeconds: config.settings.GEMINI_TEXT_TIMEOUT_SECONDS,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
  } catch (exc) {
    if (exc instanceof gemini.GeminiUnavailable) throw new InsightUnavailable(exc.message);
    throw exc;
  }
  return validateInsight(raw, lines);
}

/** Keep only what the conversations support; cited lines are kept with each factor. */
export function validateInsight(raw, lines) {
  const byId = new Map(lines.map((l) => [l.gid, l]));
  const trim = (s, n) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, n) : null;
  };
  const factors = [];
  for (const f of raw.factors ?? []) {
    const label = trim(f.label, 40);
    const reason = trim(f.reason, 240);
    const ids = [...new Set(f.evidence_ids ?? [])].filter((i) => byId.has(i)).slice(0, 3);
    if (!label || !reason || !LEVELS.includes(f.level)) continue;
    if (!ids.length) {
      logger.info("Insight: a factor was not used (no valid evidence)");
      continue;
    }
    factors.push({
      label,
      level: f.level,
      reason,
      evidence: ids.map((i) => {
        const l = byId.get(i);
        return { job_id: l.job_id, line_id: l.id, speaker: l.speaker ?? null, time_label: l.time_label ?? null, start: typeof l.start === "number" ? l.start : null, text: String(l.original ?? "").slice(0, 400), english: l.english ? String(l.english).slice(0, 400) : null };
      }),
    });
    if (factors.length >= 3) break;
  }
  const chance = Number.isInteger(raw.suggested_chance_pct) ? Math.max(0, Math.min(100, Math.round(raw.suggested_chance_pct / 5) * 5)) : null;
  const d = raw.details ?? {};
  return {
    factors,
    would_change: trim(raw.would_change, 300),
    suggested_chance_pct: factors.length ? chance : null, // no grounded factor: no number either
    details: { instrument: trim(d.instrument, 80), decision_by: trim(d.decision_by, 80), expected: trim(d.expected, 80) },
  };
}
