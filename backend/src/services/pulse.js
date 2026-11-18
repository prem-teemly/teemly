// Teemly Pulse: evidence-backed interest, intent and engagement signals from a conversation.
//
// Gemini (GEMINI_TEXT_MODEL) reads the numbered transcript and returns signals that must cite the IDs
// of the transcript lines supporting them, plus the exact supporting words. The backend never trusts
// the model's copy of the evidence: it attaches the real transcript lines (original text, English
// translation, timestamp, speaker) and verifies the quote against them. Signals that cite no valid
// line are dropped, and an inferred signal can never be rated "high".

import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.pulse");

const Category = z.enum([
  "product_interest",
  "purchase_intent",
  "feature_preference",
  "pain_point",
  "question_concern",
  "positive_feedback",
  "negative_feedback",
  "follow_up_interest",
  "competitor_mention",
  "commitment",
]);
const Level = z.enum(["high", "medium", "low"]);
const Basis = z.enum(["explicit", "inferred"]);
const Overall = z.enum(["high", "medium", "low", "none", "not_enough_evidence"]);

export const NOT_ENOUGH_EVIDENCE = "Not enough evidence";

/** Pulse could not run; the message is safe to show to users. */
export class PulseUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "PulseUnavailable";
  }
}

// ----------------------------------------------------------------- model output schema

const Signal = z.object({
  category: Category,
  person: z.string().describe("Person label (e.g. 'Person 1') or sender exactly as shown in the transcript, or a name stated in it"),
  subject: z.string().describe("What the signal is about, in English, e.g. 'Teemly product', 'pricing'"),
  level: Level.describe("Strength of the signal as supported by the words used"),
  basis: Basis.describe("'explicit' if the person said it directly; 'inferred' if it is implied"),
  context: z
    .string()
    .describe("One short English sentence naming the person and what they said or want, with any numbers, e.g. 'Person 2 wants to buy 10 units of Teemly.'"),
  evidence_ids: z.array(z.int()).describe("IDs of 1-3 transcript lines that directly support this signal"),
  quote: z.string().describe("The exact supporting words copied verbatim from the ORIGINAL text of those lines"),
});

const Recommendation = z.object({
  action: z.string().describe("A concrete follow-up action for the user's team, in English"),
  reason: z.string().describe("Why, in one short sentence"),
  evidence_ids: z.array(z.int()).describe("IDs of transcript lines that motivate this action"),
});

const PulseSchema = gemini.defineSchema(
  "_Pulse",
  z.object({
    overall_interest: Overall,
    overview: z.string().describe("2-3 English sentences on interest and engagement, or 'Not enough evidence'"),
    signals: z.array(Signal),
    recommended_actions: z.array(Recommendation),
  }),
);

const PROMPT = `You are Teemly Pulse. Read the conversation and identify evidence-backed signals about EACH
participant's interests, preferences, intent and engagement — cover every person who shows any
(e.g. both people on a call can be interested). The conversation may be in Tamil, English or
Tanglish; an English translation is given under each line.

Signal categories:
- product_interest: interest in a product or service.
- purchase_intent: intent to buy, subscribe, sign or adopt.
- feature_preference: features they like, want or ask for.
- pain_point: problems or frustrations they describe.
- question_concern: questions, doubts or objections (price, security, fit...).
- positive_feedback / negative_feedback: opinions about a product, service or experience.
- follow_up_interest: wanting a demo, proposal, call or more information.
- competitor_mention: another vendor or tool they use or compare with.
- commitment: an explicit promise or agreed next step by any participant.

Strict rules:
- Every signal MUST cite the IDs of the transcript lines that support it, and "quote" MUST be
  copied word for word from the ORIGINAL text of those lines (not the translation).
- Use only what was said. Never invent interest, emotions, budget, buying intent or commitments.
- basis "explicit" only when the person said it directly. Anything implied is "inferred".
- Politeness is not intent: "nice", "sounds good", "I'll think about it" is at most low interest,
  never purchase_intent. purchase_intent needs a clear statement of wanting to buy/sign/adopt.
- Asking for a contract, quote, proposal or pricing to review is a buying step, not a decision:
  rate it at most "medium". purchase_intent is "high" only when the person states they will buy,
  sign, subscribe or roll it out.
- level "high" only for explicit, unambiguous statements.
- Never assume gender: refer to people by label or name, or use they/them.
- If the conversation shows no product or service interest at all, set overall_interest to "none".
  If there is too little to judge, set it to "not_enough_evidence" and overview to
  "Not enough evidence". Return an empty signals list when nothing qualifies — that is valid.
- recommended_actions: only actions directly motivated by cited lines (e.g. send the proposal they
  asked for, address the concern they raised). Empty list if nothing is motivated.
- Refer to people by the Person label or sender shown, or a name explicitly used for them. Never
  use the word "speaker".
- Write subject, context, overview and actions in professional English. Keep quantities, products
  and prices exactly as said (e.g. "Person 2 plans to buy 10 units of Teemly").
`;

// ---------------------------------------------------------------------------- helpers

/** Case-fold and collapse everything that is not a letter or digit (Python's [\W_]+ with re.UNICODE). */
export function norm(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function formatLine(line) {
  const when = line.time_label || "";
  const english = line.english || "";
  let out = `[${line.id}] ${when} ${line.speaker || "Unknown"}: ${line.original}`;
  if (english && norm(english) !== norm(line.original)) out += `\n      (English: ${english})`;
  return out;
}

const pad2 = (n) => String(n).padStart(2, "0");
function fmtTime(t) {
  const total = Math.trunc(t);
  const h = Math.floor(total / 3600);
  const rem = total % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** Numbered evidence lines for an audio transcript (timestamps are audio positions). */
export function linesFromSegments(original, english) {
  const out = [];
  original.forEach((o, i) => {
    if (!o.text) return;
    out.push({
      id: i,
      speaker: o.speaker ?? null,
      start: o.start,
      end: o.end,
      time_label: fmtTime(o.start),
      original: o.text,
      english: i < english.length ? english[i].text : null,
    });
  });
  return out;
}

/** Numbered evidence lines for a WhatsApp chat (timestamps are message times, not audio). */
export function linesFromMessages(messages) {
  return messages
    .filter((m) => m.kind === "text")
    .map((m) => ({
      id: m.index,
      speaker: m.sender ?? null,
      start: null,
      end: null,
      time_label: m.timestamp.replace("T", " ").slice(0, 16),
      original: m.text,
      english: m.english ?? null,
    }));
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const unique = (xs) => [...new Set(xs)];

// ------------------------------------------------------------------------------- main

/** Run Pulse over numbered lines and return validated, evidence-attached results. */
export async function analyze(lines) {
  if (!lines.length) throw new PulseUnavailable("The transcript is empty, so there is nothing to analyse.");
  const byId = new Map(lines.map((l) => [l.id, l]));
  const prompt = PROMPT + "\n=== CONVERSATION ===\n" + lines.map(formatLine).join("\n");
  let raw;
  try {
    raw = await gemini.generateJson(prompt, PulseSchema, {
      model: config.settings.GEMINI_TEXT_MODEL,
      temperature: 0.1,
      thinkingLevel: config.settings.PULSE_THINKING_LEVEL,
      timeoutSeconds: config.settings.GEMINI_TEXT_TIMEOUT_SECONDS,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
  } catch (exc) {
    if (exc instanceof gemini.GeminiUnavailable) throw new PulseUnavailable(exc.message);
    throw exc;
  }

  const signals = [];
  let dropped = 0;
  for (const s of raw.signals) {
    const evidence = unique(s.evidence_ids).filter((i) => byId.has(i)).map((i) => byId.get(i));
    if (!evidence.length) {
      dropped += 1;
      logger.info(`Pulse dropped unsupported signal: ${s.category} / ${s.subject}`);
      continue;
    }
    // Verify the quote really occurs in the cited original (or translated) lines.
    const quote = s.quote.trim();
    const haystacks = [...evidence.map((e) => norm(e.original)), ...evidence.map((e) => norm(e.english || ""))];
    const nq = norm(quote);
    const verified = Boolean(quote) && haystacks.some((h) => Boolean(nq) && h.includes(nq));
    const level = s.basis === "inferred" && s.level === "high" ? "medium" : s.level;
    signals.push({
      category: s.category,
      person: s.person,
      subject: s.subject,
      level,
      basis: s.basis,
      context: s.context,
      quote: verified ? quote : null,
      quote_verified: verified,
      evidence: evidence.map((e) => pick(e, ["id", "speaker", "start", "end", "time_label", "original", "english"])),
    });
  }

  const actions = [];
  for (const a of raw.recommended_actions) {
    const evidence = unique(a.evidence_ids).filter((i) => byId.has(i)).map((i) => byId.get(i));
    if (!evidence.length) {
      dropped += 1;
      continue;
    }
    actions.push({
      action: a.action,
      reason: a.reason,
      evidence: evidence.map((e) => pick(e, ["id", "speaker", "start", "time_label"])),
    });
  }

  let overall = raw.overall_interest;
  let overview = raw.overview.trim();
  if (!signals.length && ["high", "medium", "low"].includes(overall)) {
    // The model claimed interest but none of it survived validation.
    overall = "not_enough_evidence";
    overview = NOT_ENOUGH_EVIDENCE;
  }
  if (overall === "not_enough_evidence" && !overview) overview = NOT_ENOUGH_EVIDENCE;

  return {
    overall_interest: overall,
    overview,
    signals,
    recommended_actions: actions,
    dropped_unsupported: dropped,
  };
}
