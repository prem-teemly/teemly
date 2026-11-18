// Conversation context: who is who, and what was discussed when.
//
// Gemini (GEMINI_TEXT_MODEL) reads the numbered transcript (people labelled "Person 1", "Person 2")
// and returns
// - real names for those labels, ONLY when the conversation itself shows them ("Hi Prem", "naan
//   Krishna pesuren"), each citing the transcript lines that prove it,
// - an overview and topical sections (with first/last line), sized to the length of the call, and
// - the key moments (the lines that carry the conversation).
// The backend never trusts the model's times or names blindly: times come from the real transcript
// lines, and a name is accepted only if it actually occurs in the cited lines, is unique, and is
// consistent with who spoke those lines. Otherwise the person stays "Person N".

import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";
import { norm } from "./pulse.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.context");

/** Context could not be produced; the message is safe to show to users. */
export class ContextUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextUnavailable";
  }
}

const SpeakerName = z.object({
  label: z.string().describe("Person label exactly as shown, e.g. 'Person 1'"),
  name: z.string().describe("The person's name as spoken, written in English letters, e.g. 'Prem'"),
  how: z.enum(["self_introduction", "addressed_by_name", "same_voice"]),
  evidence_ids: z.array(z.int()).describe("IDs of 1-3 lines where the name is said (empty for same_voice)"),
  same_as_label: z.string().nullable().describe("same_voice only: the label already named for this person, else null"),
});

export const MOMENT_TAGS = ["commitment", "hedging", "new_person", "interest", "concern", "decision", "question", "none"];

const KeyMoment = z.object({
  line_id: z.int().describe("ID of the transcript line this moment is"),
  text: z.string().describe("The person's own words as a clean first-person English quote (max ~25 words), keeping names, numbers and dates"),
  tag: z.enum(MOMENT_TAGS).describe("Kind of moment; 'none' for plain context"),
});

const Section = z.object({
  title: z.string().describe("Short English title of what was discussed (3-8 words)"),
  summary: z.string().describe("What was said in this part and by whom: points, numbers, decisions, commitments"),
  start_id: z.int().describe("ID of the first line of this section"),
  end_id: z.int().describe("ID of the last line of this section"),
});

const ContextSchema = gemini.defineSchema(
  "_ConversationContext",
  z.object({
    main_topic: z.string().describe("One English sentence: what this conversation is mainly about"),
    overview: z.string().describe("What the people discussed: important points, interests, decisions, commitments and next steps"),
    speaker_names: z.array(SpeakerName),
    sections: z.array(Section),
    key_moments: z.array(KeyMoment),
  }),
);

const PROMPT = `You read a call or meeting transcript (Tamil, English, Tanglish, Hindi or Telugu; an
English translation is given under lines) and describe its context.

People are labelled "Person 1", "Person 2", ... Refer to them by these labels (or a name you map
below). Never use the word "speaker".

1. speaker_names — map a Person label to a real name ONLY with clear proof in the transcript:
   - self_introduction: the person says their own name ("I'm Krishna", "naan Prem pesuren").
   - addressed_by_name: another person greets or calls them by name ("Hi Prem", "Krishna, sollunga")
     and THIS person is clearly the one who answers or is being spoken to.
   Cite the line(s) where the name is said. Write the name in English letters exactly as spoken
   (e.g. "Prem", "Krishna"). Never guess, never use a company or product name.
   - same_voice: labels come from automatic voice separation, which can split ONE person into two
     labels (often at a 5-minute mark or after the call drops; see PEOPLE below). If a label
     is clearly the same person as a label you named — same role in the conversation, the two labels
     never talk to each other, one stops where the other starts — give it the same name with how
     "same_voice" and same_as_label = the named label. Never merge two people who talk to each other.
   If unsure, leave that label out. An empty list is a valid answer.
2. sections — split the whole conversation, in order, into consecutive topical parts, one per real
   change of topic (see SIZE below). Each section cites its first and last line ID; sections must
   not overlap and together cover the whole conversation. Title = what was discussed; summary = who
   said what: their points, numbers, decisions and commitments, in professional English, with the
   labels shown.
3. main_topic — one sentence on what the conversation is mainly about.
   overview — what the people actually discussed: the important points each person made, their
   interests, the decisions, the commitments (who will do what, by when) and the next steps. Only
   what was said; no generic statements, no assumptions, no padding.
4. key_moments — the lines someone must read to understand the whole conversation, in time order:
   the main points, requests, answers, numbers, names, decisions and promises. Skip greetings,
   fillers and repeats, but keep every point that carries the discussion forward. About 1 per 20-30
   seconds of talk (at least 5, at most 40; e.g. 20-30 for a 10-minute call). For each, give its
   line ID and the speaker's OWN words as a clean first-person English quote — what they said, not a
   description of it. Right: "Let's move the DPDP timeline to Q4 2026." Wrong: "Deepan agrees to
   change the DPDP timeline." Right: "I'll send TD's free slots by Friday." Tag it:
   commitment (a promise or agreed next step), hedging (a non-committal or conditional answer, e.g.
   "Let's see after TD"), new_person (a new person or company is introduced), interest (interest or
   buying intent), concern (a doubt, objection or problem), decision, question (an important
   question), or none.
Use only what was said. Never invent facts. Use they/them for people.
`;

/** How much context to write, from the length of the talk (never padded beyond what was said). */
export function sizeGuide(talkSeconds) {
  const min = talkSeconds / 60;
  const moments = Math.max(5, Math.min(40, Math.round(talkSeconds / 25)));
  if (min < 3) return { moments, text: `Short call (${Math.max(1, Math.round(min))} min): overview 2-3 sentences; 1-2 sections, 1-2 sentences each; about ${moments} key_moments.` };
  if (min < 15) return { moments, text: `Medium call (${Math.round(min)} min): overview 4-6 sentences; 3-5 sections, 2-3 sentences each; about ${moments} key_moments.` };
  if (min < 30) return { moments, text: `Long call (${Math.round(min)} min): overview 6-8 sentences; 5-8 sections, 2-4 sentences each; about ${moments} key_moments.` };
  return { moments, text: `Very long call (${Math.round(min)} min): overview 8-12 sentences covering every topic; about one section per 4-5 minutes (each change of topic), 3-4 sentences each; about ${moments} key_moments spread over the whole call.` };
}

function formatLine(l) {
  let out = `[${l.id}] ${l.time_label} ${l.speaker || "Unknown"}: ${l.original}`;
  if (l.english && norm(l.english) !== norm(l.original)) out += `\n      (English: ${l.english})`;
  return out;
}

const cleanName = (s) =>
  String(s ?? "")
    .replace(/[^\p{L}\p{M} .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Validate the model's speaker names against the transcript; returns Map(label -> name). */
export function validateNames(raw, lines) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const labels = new Set(lines.map((l) => l.speaker).filter(Boolean));
  const accepted = [];
  for (const s of raw.filter((x) => x.how !== "same_voice")) {
    const name = cleanName(s.name);
    const evidence = [...new Set(s.evidence_ids)].filter((i) => byId.has(i)).map((i) => byId.get(i));
    const n = norm(name);
    const reason =
      !labels.has(s.label) ? "unknown label"
      : !name || name.length > 40 || /^(speaker|person)\b/i.test(name) || labels.has(name) ? "invalid name"
      : !evidence.length ? "no valid evidence"
      : !evidence.some((e) => ` ${norm(e.original)} `.includes(` ${n} `) || ` ${norm(e.english || "")} `.includes(` ${n} `)) ? "name not in evidence"
      : s.how === "self_introduction" && !evidence.some((e) => e.speaker === s.label) ? "introduction not spoken by this speaker"
      : s.how === "addressed_by_name" && evidence.every((e) => e.speaker === s.label) ? "speaker cannot be addressed by themself"
      : null;
    if (reason) {
      logger.info(`Context: speaker name not used (${reason})`);
      continue;
    }
    accepted.push({ label: s.label, name, how: s.how, evidence });
  }
  // One name per label and one label per name; any conflict keeps the plain labels.
  const count = (key) => accepted.reduce((m, a) => m.set(key(a), (m.get(key(a)) ?? 0) + 1), new Map());
  const perLabel = count((a) => a.label);
  const perName = count((a) => norm(a.name));
  const proven = accepted.filter((a) => perLabel.get(a.label) === 1 && perName.get(norm(a.name)) === 1);

  // One voice split into two labels: accepted only if the label never overlaps in time with the
  // named label (a person cannot be both sides of the conversation) and never says the name itself.
  const merged = [];
  for (const s of raw.filter((x) => x.how === "same_voice")) {
    const target = proven.find((p) => p.label === s.same_as_label && norm(p.name) === norm(cleanName(s.name)));
    const mine = lines.filter((l) => l.speaker === s.label);
    const theirs = lines.filter((l) => l.speaker === target?.label);
    const n = norm(target?.name ?? "");
    const reason =
      !target ? "no proven name to join"
      : !labels.has(s.label) || proven.some((p) => p.label === s.label) || merged.some((m) => m.label === s.label) ? "label already named"
      : !separateInTime(mine, theirs) || replies(lines, s.label, target.label) > 1 ? "both labels talk in the same part of the call"
      : mine.some((l) => ` ${norm(l.original)} `.includes(` ${n} `) || ` ${norm(l.english || "")} `.includes(` ${n} `)) ? "this label says the name to someone else"
      : null;
    if (reason) {
      logger.info(`Context: same-voice merge not used (${reason})`);
      continue;
    }
    merged.push({ label: s.label, name: target.name, how: "same_voice", evidence: [] });
  }
  return [...proven, ...merged];
}

/** True when two speakers' lines occupy different stretches of the call (at most 1 line interleaved). */
export function separateInTime(a, b) {
  if (!a.length || !b.length) return false;
  const inside = (xs, ys) => {
    const lo = Math.min(...ys.map((y) => y.start));
    const hi = Math.max(...ys.map((y) => y.start));
    return xs.filter((x) => x.start > lo && x.start < hi).length;
  };
  return inside(a, b) <= 1 && inside(b, a) <= 1;
}

/** How often one label answers the other directly (consecutive lines). People in a dialogue do; one split voice does not. */
export function replies(lines, a, b) {
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const x = lines[i - 1].speaker;
    const y = lines[i].speaker;
    if ((x === a && y === b) || (x === b && y === a)) n += 1;
  }
  return n;
}

/** Where each label speaks, so the model can spot one voice split into two labels. */
function labelSummary(lines) {
  const by = new Map();
  for (const l of lines) {
    if (!l.speaker) continue;
    const s = by.get(l.speaker) ?? { first: l.time_label, last: l.time_label, n: 0 };
    s.last = l.time_label;
    s.n += 1;
    by.set(l.speaker, s);
  }
  return [...by].map(([label, s]) => `- ${label}: ${s.n} lines, from ${s.first} to ${s.last}`).join("\n");
}

/** Validate sections: real line IDs, in order, no overlap; times come from the transcript lines. */
export function validateSections(raw, lines) {
  const index = new Map(lines.map((l, i) => [l.id, i]));
  const out = [];
  let lastEnd = -1;
  for (const s of [...raw].sort((a, b) => a.start_id - b.start_id)) {
    if (!index.has(s.start_id) || !index.has(s.end_id)) continue;
    let a = index.get(s.start_id);
    const b = index.get(s.end_id);
    if (a <= lastEnd) a = lastEnd + 1;
    if (a > b || !s.title.trim()) continue;
    // first/last are segment indices (line IDs), for slicing the transcript.
    out.push({ title: s.title.trim(), summary: s.summary.trim(), first: lines[a].id, last: lines[b].id });
    lastEnd = b;
  }
  return out;
}

/** Key moments must point at real lines; one per line, in time order, at most 30. */
export function validateMoments(raw, lines) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set();
  return raw
    .filter((m) => byId.has(m.line_id) && m.text.trim() && !seen.has(m.line_id) && seen.add(m.line_id))
    .sort((a, b) => a.line_id - b.line_id)
    .slice(0, 40)
    .map((m) => ({ line: m.line_id, text: m.text.trim(), tag: MOMENT_TAGS.includes(m.tag) && m.tag !== "none" ? m.tag : null }));
}

/** Run the context model over numbered audio lines (pulse.linesFromSegments). */
export async function analyze(lines) {
  if (!lines.length) throw new ContextUnavailable("The transcript is empty, so there is no context to describe.");
  let raw;
  try {
    // A concrete size makes the model cover the whole call without padding a short one.
    const talk = lines.reduce((t, l) => t + Math.max(0, (l.end ?? 0) - (l.start ?? 0)), 0);
    const prompt =
      PROMPT +
      `\nSIZE: ${sizeGuide(talk).text}\n` +
      "\n=== PEOPLE ===\n" +
      labelSummary(lines) + "\n\n=== TRANSCRIPT ===\n" + lines.map(formatLine).join("\n");
    raw = await gemini.generateJson(prompt, ContextSchema, {
      model: config.settings.GEMINI_TEXT_MODEL,
      temperature: 0.1,
      thinkingLevel: config.settings.ANALYSIS_THINKING_LEVEL,
      timeoutSeconds: config.settings.GEMINI_TEXT_TIMEOUT_SECONDS,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
  } catch (exc) {
    if (exc instanceof gemini.GeminiUnavailable) throw new ContextUnavailable(exc.message);
    throw exc;
  }
  return {
    main_topic: raw.main_topic.trim(),
    overview: raw.overview.trim(),
    names: validateNames(raw.speaker_names, lines),
    sections: validateSections(raw.sections, lines),
    moments: validateMoments(raw.key_moments, lines),
  };
}

// ------------------------------------------------------------------ applying the names

const LABEL = /\b(?:Person|Speaker) (\d+)\b/g;
const KEEP_VERBATIM = new Set(["original", "english", "quote", "text"]); // spoken words are never rewritten

/**
 * Display name for every Person label, in order of first appearance: the proven name, or
 * "Person 1", "Person 2", ... (renumbered so unnamed people are always numbered from 1).
 */
export function displayNames(segments, accepted) {
  const proven = new Map(accepted.map((n) => [n.label, n.name]));
  const out = new Map();
  let k = 0;
  for (const s of segments) {
    if (!s.speaker || out.has(s.speaker)) continue;
    out.set(s.speaker, proven.get(s.speaker) ?? `Person ${++k}`);
  }
  return out;
}

/**
 * Model-written text with every label replaced by the display name ("Person 3" -> "Naveen") and no
 * leftover "speaker" wording. Spoken words (original, english, quote, text keys) are never changed.
 */
export function renameDeep(value, names, key = null) {
  if (typeof value === "string") {
    if (KEEP_VERBATIM.has(key)) return value;
    let out = value.replace(LABEL, (_, n) => names.get(`Person ${n}`) ?? `Person ${n}`);
    for (const name of new Set(names.values())) out = out.split(`${name} (${name})`).join(name); // "Person 1 (Prem)" -> "Prem"
    return out
      .replace(/\bSpeakers\b/g, "People")
      .replace(/\bspeakers\b/g, "people")
      .replace(/\bSpeaker\b/g, "Person")
      .replace(/\bspeaker\b/g, "person");
  }
  if (Array.isArray(value)) return value.map((v) => renameDeep(v, names, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameDeep(v, names, k)]));
  }
  return value;
}

/** Final context block data: names, sections with real times and speakers (after renaming). */
export function buildData(ctx, segments, names) {
  const fmt = (t) => {
    const s = Math.max(0, Math.round(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return {
    main_topic: renameDeep(ctx.main_topic, names),
    overview: renameDeep(ctx.overview ?? "", names),
    speaker_names: ctx.names.map((n) => ({
      label: n.label,
      name: n.name,
      how: n.how,
      evidence: n.evidence.map((e) => ({ id: e.id, start: e.start, time_label: e.time_label, speaker: names.get(e.speaker) ?? e.speaker, original: e.original, english: e.english })),
    })),
    // Time, speaker and original words come from the real transcript line, never from the model.
    key_moments: (ctx.moments ?? []).map((m) => ({
      line: m.line,
      start: segments[m.line].start,
      end: segments[m.line].end,
      speaker: segments[m.line].speaker ?? null,
      text: renameDeep(m.text, names),
      original: segments[m.line].text,
      tag: m.tag,
    })),
    sections: ctx.sections.map((s) => {
      const part = segments.slice(s.first, s.last + 1).filter((x) => x.text);
      return {
        title: renameDeep(s.title, names),
        summary: renameDeep(s.summary, names),
        start: part[0].start,
        end: part[part.length - 1].end,
        time_label: `${fmt(part[0].start)}–${fmt(part[part.length - 1].end)}`,
        first_line: s.first,
        last_line: s.last,
        speakers: [...new Set(part.map((x) => x.speaker).filter(Boolean))],
      };
    }),
  };
}
