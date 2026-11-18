// Structured meeting / conversation analysis with Gemini (GEMINI_TEXT_MODEL).
//
// The same schema is used for audio meetings and WhatsApp chats, so the frontend renders both the
// same way. The response is constrained to the schema below.

import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";

/** Analysis cannot run or failed; the message is safe to show to users. */
export class AnalysisUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "AnalysisUnavailable";
  }
}

const Decision = z.object({
  decision: z.string().describe("The decision, agreement or confirmation, in English"),
  made_by: z.string().nullable().describe("Person label (e.g. 'Person 1') or a name ONLY if explicit in the transcript, else null"),
  evidence: z.string().describe("Short quote or paraphrase from the transcript supporting this"),
});

const ActionItem = z.object({
  task: z.string().describe("What must be done, in English"),
  responsible_person: z
    .string()
    .nullable()
    .describe("Person explicitly named or addressed as responsible, else null. Never guess."),
  date: z.string().nullable().describe("Date exactly as mentioned (e.g. 'tomorrow', 'Monday'), else null"),
  time: z.string().nullable().describe("Time exactly as mentioned (e.g. 'after 5:00 PM'), else null"),
  deadline: z.string().nullable().describe("Deadline only if explicitly stated, else null"),
  speaker: z.string().nullable().describe("Person label (e.g. 'Person 1') or name of who assigned/mentioned the task, if known"),
  evidence: z.string().describe("Short quote or paraphrase from the transcript supporting this"),
  uncertain: z
    .string()
    .nullable()
    .describe("What is unclear or ambiguous about this item (e.g. owner not stated), else null"),
});

export const MeetingAnalysis = gemini.defineSchema(
  "MeetingAnalysis",
  z.object({
    // Meeting overview
    purpose: z.string().nullable().describe("Main purpose if it can be determined from the transcript, else null"),
    summary: z.string().describe("Discussion overview in English, 3-6 sentences"),
    key_context: z.array(z.string()).describe("Important background context needed to understand the discussion"),
    // Key discussion points
    topics: z.array(z.string()).describe("Main topics discussed"),
    important_points: z.array(z.string()).describe("Important points and explanations raised"),
    problems_discussed: z.array(z.string()).describe("Problems, issues or concerns discussed"),
    // Decisions / actions
    decisions: z.array(Decision),
    action_items: z.array(ActionItem),
    follow_ups: z
      .array(z.string())
      .describe("Pending items, future discussions and reminders that are not concrete assigned tasks"),
    // Final summary
    final_summary: z.string().describe("One or two sentence professional summary"),
    key_takeaways: z.array(z.string()).describe("The most important takeaways, 2-5 items"),
    transcript_quality_note: z
      .string()
      .nullable()
      .describe("If parts of the transcript are garbled or unintelligible, say so briefly, else null"),
  }),
);

const INSTRUCTIONS = (kind, sourceNote) => `You analyse ${kind}. The conversation may be in Tamil, English or mixed Tamil-English
(Tanglish). ${sourceNote}

Rules:
- Use ONLY information present in the input. Do not invent facts, names, roles, dates, times,
  owners or decisions. Missing information stays null or an empty list.
- Never invent real names or job titles for people. Refer to people by their labels ("Person 1")
  unless a name is explicitly used. Never use the word "speaker". Use gender-neutral language
  (they/them) for people.
- For action items, set responsible_person, date, time and deadline ONLY when explicitly stated;
  otherwise null. Write these values in English even when spoken in Tamil or Tanglish
  ("Friday kulla" -> "by Friday", "இன்னைக்கு" -> "today", "11 mani-ku" -> "11:00"), but keep
  relative dates relative (e.g. "tomorrow"); never convert them to calendar dates. Example: "Hi Prem, tomorrow after 5 o'clock, connect the meeting." -> task "Connect the
  meeting", responsible_person "Prem", date "tomorrow", time "after 5:00 PM".
- If something is ambiguous, record it in the item's "uncertain" field rather than guessing.
- Empty lists are valid answers when there are no decisions, action items or follow-ups.
- If parts are too garbled to understand, say so in transcript_quality_note and do not guess.
- Write all output in professional English.
`;

const AUDIO_NOTE =
  "The transcript was produced automatically by speech recognition and may contain errors. Person " +
  "labels (Person 1, Person 2, ...) come from automatic voice separation and may be imperfect. The original-language transcript is " +
  "the primary source; the English translation is a machine translation that helps interpretation.";
const CHAT_NOTE =
  "The input is an exported WhatsApp chat with sender names and timestamps. Senders are real chat " +
  "participants: refer to them by the sender name shown.";

const pad2 = (n) => String(n).padStart(2, "0");
function fmt(t) {
  const total = Math.trunc(t);
  let m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  m %= 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function buildPrompt(originalLines, englishLines) {
  const lines = (items) =>
    items
      .filter((i) => i.text)
      .map((i) => `[${fmt(i.start)}-${fmt(i.end)}] ${i.speaker || "Unknown"}: ${i.text}`)
      .join("\n") || "(empty)";
  return (
    INSTRUCTIONS("meeting and call transcripts", AUDIO_NOTE) +
    `\n=== ORIGINAL TRANSCRIPT (primary) ===\n${lines(originalLines)}\n\n` +
    `=== ENGLISH MACHINE TRANSLATION (secondary) ===\n${lines(englishLines)}\n`
  );
}

async function run(prompt) {
  try {
    return await gemini.generateJson(prompt, MeetingAnalysis, {
      model: config.settings.GEMINI_TEXT_MODEL,
      thinkingLevel: config.settings.ANALYSIS_THINKING_LEVEL,
      timeoutSeconds: config.settings.GEMINI_TEXT_TIMEOUT_SECONDS,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
  } catch (exc) {
    if (exc instanceof gemini.GeminiUnavailable) throw new AnalysisUnavailable(exc.message);
    throw exc;
  }
}

export async function analyze(originalLines, englishLines) {
  if (![...originalLines, ...englishLines].some((i) => i.text)) {
    throw new AnalysisUnavailable("The transcript is empty, so there is nothing to analyse.");
  }
  return run(buildPrompt(originalLines, englishLines));
}

/** Analyse free text (POST /api/ai/summarize). kind: 'meeting' or 'chat'. */
export async function analyzeText(text, kind = "meeting") {
  if (!text.trim()) throw new AnalysisUnavailable("The text is empty, so there is nothing to analyse.");
  const note = kind === "chat" ? CHAT_NOTE : "The input is a transcript or notes provided by the user.";
  const what = kind === "chat" ? "WhatsApp conversations" : "meeting and call transcripts";
  return run(INSTRUCTIONS(what, note) + `\n=== INPUT ===\n${text}\n`);
}

/** Analyse parsed WhatsApp messages (with their English translations). */
export async function analyzeChat(messages) {
  const body = messages
    .map(
      (m) =>
        `[${m.timestamp}] ${m.sender || "System"}: ${m.text}` +
        (m.english && m.english !== m.text ? `\n    (English: ${m.english})` : ""),
    )
    .join("\n");
  return run(INSTRUCTIONS("WhatsApp conversations", CHAT_NOTE) + `\n=== CHAT ===\n${body}\n`);
}
