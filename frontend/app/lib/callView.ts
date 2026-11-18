import { pulseByPerson } from "../components/PulsePeople";
import type { ActionItem, AnalysisBlock, AnalysisResult, ChatResult, ContextData, EmotionsBlock, KeyMoment, PulseBlock, PulseData, PulseSignal } from "./api";

/**
 * UI-facing shape of one analysed call or chat. Components render only this, so the backend response can
 * evolve (e.g. signals, people, outcome, per-item timestamps) by changing the mappers alone.
 */
export type TranscriptLine = {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  /** Professional English translation, when it differs from `text`. */
  translation?: string | null;
  /** Shown instead of a seekable time (WhatsApp messages have dates, not audio positions). */
  timeLabel?: string | null;
  warning?: string | null;
  /** Emotion audible in this line; null or "neutral" when none is clear. */
  emotion?: string | null;
};

export type Item = { text: string; timestamp?: number | null; meta?: string | null };

export type PersonItem = {
  name: string;
  role?: string | null;
  company?: string | null;
  context?: string | null;
  timestamp?: number | null;
};

export type OutcomeItem = {
  status: "positive" | "neutral" | "negative" | "unresolved";
  label: string;
  description?: string | null;
  timestamp?: number | null;
};

/** Talk time of one person (computed from the transcript). */
export type TalkItem = { name: string; seconds: number; share: number; lines: number; first: number };

export type CallView = {
  source: "audio" | "whatsapp";
  /** Recording length in seconds (0 for chats). */
  duration: number;
  /** Everyone who spoke, in order of first line. */
  talk: TalkItem[];
  /** Names, overview and timed sections; null while pending or unavailable. */
  context: ContextData | null;
  contextReason: string | null;
  transcript: TranscriptLine[];
  analysisAvailable: boolean;
  analysisReason: string | null;
  purpose: string | null;
  summary: string | null;
  finalSummary: string | null;
  keyPoints: Item[];
  problems: Item[];
  takeaways: Item[];
  decisions: Item[];
  actionItems: Item[];
  followUps: Item[];
  positiveSignals: Item[];
  negativeSignals: Item[];
  people: PersonItem[];
  companies: string[];
  outcome: OutcomeItem | null;
  qualityNote: string | null;
  /** Promises and agreed next steps, with the moment they were said (key moments, else action items). */
  commitments: Item[];
  /** Each person's interest from Pulse (e.g. "Ravi: High interest"). */
  interest: { person: string; label: string; level: number }[];
  /** "Tamil + English" etc., from the detected languages. */
  languages: string | null;
  pulse: PulseData | null;
  pulseReason: string | null;
  /** Emotion overview (audio only); null while not yet available. */
  emotions: EmotionsBlock | null;
};

const POSITIVE: PulseSignal["category"][] = ["product_interest", "purchase_intent", "feature_preference", "follow_up_interest", "positive_feedback", "commitment"];
const LANGUAGE_NAMES: Record<string, string> = { ta: "Tamil", en: "English", hi: "Hindi", te: "Telugu", ml: "Malayalam", kn: "Kannada" };

/** "en, ta" -> "Tamil + English" (regional language first, as spoken). */
function languageLabel(codes: string | undefined): string | null {
  const names = [...new Set((codes ?? "").split(/[,\s]+/).map((c) => c.toLowerCase().split("-")[0]).filter(Boolean))].map(
    (c) => LANGUAGE_NAMES[c] ?? c.toUpperCase(),
  );
  names.sort((a, b) => (a === "English" ? 1 : 0) - (b === "English" ? 1 : 0));
  return names.length ? names.join(" + ") : null;
}

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);

/**
 * Commitments as short "Who: what · when" items (the analysis's action items). The time chip is the
 * key moment that clearly matches the item (2+ shared words, commitment/decision moments first); no
 * match, no chip — a time is never guessed.
 */
function commitmentItems(actions: ActionItem[], moments: KeyMoment[]): Item[] {
  const ranked = [...moments].sort((a, b) => Number(b.tag === "commitment" || b.tag === "decision") - Number(a.tag === "commitment" || a.tag === "decision"));
  const items = actions.map((t) => {
    const w = words(`${t.task} ${t.evidence ?? ""}`);
    let best: { at: number; score: number } | null = null;
    for (const m of ranked) {
      const mw = words(`${m.text} ${m.original}`);
      const score = [...w].filter((x) => mw.has(x)).length;
      if (score >= 2 && (!best || score > best.score)) best = { at: m.start, score };
    }
    const when = t.deadline ?? ([t.date, t.time].filter(Boolean).join(" ") || null);
    return { text: `${t.responsible_person ? t.responsible_person + ": " : ""}${t.task}`, meta: when, timestamp: best?.at ?? null };
  });
  return items.sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));
}

/** Signals, commitments, new people and per-person interest, from data the backend already returns. */
function derived(pulse: PulseData | null, moments: KeyMoment[], actions: ActionItem[]) {
  const signals = [...(pulse?.signals ?? [])].sort((a, b) => (a.evidence[0]?.start ?? a.evidence[0]?.id ?? 0) - (b.evidence[0]?.start ?? b.evidence[0]?.id ?? 0));
  const asItem = (sig: PulseSignal): Item => ({ text: sig.context, timestamp: sig.evidence[0]?.start ?? null, meta: sig.person });
  return {
    positiveSignals: signals.filter((x) => POSITIVE.includes(x.category)).map(asItem),
    negativeSignals: signals.filter((x) => !POSITIVE.includes(x.category)).map(asItem),
    people: moments
      .filter((m) => m.tag === "new_person")
      .map((m) => ({ name: m.text, context: m.speaker ? `introduced by ${m.speaker}` : null, timestamp: m.start })),
    commitments: commitmentItems(actions, moments),
    interest: pulse ? pulseByPerson(pulse, []).people.filter((p) => p.level > 0 || p.label !== "No clear interest").map(({ person, label, level }) => ({ person, label, level })) : [],
  };
}

function pulseFields(block: PulseBlock | undefined) {
  if (!block) return { pulse: null, pulseReason: "Pulse was not run for this result." };
  return { pulse: block.available ? block.data : null, pulseReason: block.available ? null : block.reason };
}

function joinMeta(parts: (string | null | undefined)[]): string | null {
  const s = parts.filter(Boolean).join(" · ");
  return s || null;
}

const same = (a: string, b: string | null | undefined) => !b || a.trim().toLowerCase() === b.trim().toLowerCase();

function analysisFields(block: AnalysisBlock) {
  const a = block.available ? block.data : null;
  const texts = (xs: string[] | undefined) => (xs ?? []).map((text) => ({ text }));
  return {
    analysisAvailable: !!a,
    analysisReason: a ? null : block.reason,
    purpose: a?.purpose ?? null,
    summary: a?.summary ?? null,
    finalSummary: a?.final_summary ?? null,
    keyPoints: texts([...(a?.topics ?? []), ...(a?.important_points ?? [])]),
    problems: texts(a?.problems_discussed),
    takeaways: texts(a?.key_takeaways),
    decisions: (a?.decisions ?? []).map((d) => ({ text: d.decision, meta: d.made_by })),
    actionItems: (a?.action_items ?? []).map((t) => ({
      text: t.task,
      meta: joinMeta([t.responsible_person, t.deadline ?? joinMeta([t.date, t.time]), t.uncertain && `Unclear: ${t.uncertain}`]),
    })),
    followUps: texts(a?.follow_ups),
    qualityNote: a?.transcript_quality_note ?? null,
    companies: [],
    outcome: null,
  };
}

export function talkTime(lines: { speaker: string | null; start: number; end: number; text: string }[]): TalkItem[] {
  const people = new Map<string, TalkItem>();
  for (const l of lines) {
    if (!l.speaker || !l.text) continue;
    const p = people.get(l.speaker) ?? { name: l.speaker, seconds: 0, share: 0, lines: 0, first: l.start };
    p.seconds += Math.max(0, l.end - l.start);
    p.lines += 1;
    people.set(l.speaker, p);
  }
  const total = [...people.values()].reduce((a, p) => a + p.seconds, 0) || 1;
  return [...people.values()].map((p) => ({ ...p, share: p.seconds / total }));
}

/** Maps the audio job result (POST /api/analysis) to the view model. */
export function toCallView(result: AnalysisResult): CallView {
  return {
    source: "audio",
    duration: result.audio_duration_seconds,
    talk: talkTime(result.tamil_segments),
    context: result.context?.available ? result.context.data : null,
    contextReason: result.context && !result.context.available ? result.context.reason : null,
    transcript: result.tamil_segments.map((s, i) => {
      const en = result.english_segments[i]?.text;
      return {
        start: s.start,
        end: s.end,
        speaker: s.speaker,
        text: s.text,
        translation: same(s.text, en) ? null : en,
        warning: s.warning,
        emotion: s.emotion ?? null,
      };
    }),
    ...analysisFields(result.analysis),
    ...pulseFields(result.pulse),
    ...derived(result.pulse?.available ? result.pulse.data : null, result.context?.available ? (result.context.data?.key_moments ?? []) : [], result.analysis.available ? (result.analysis.data?.action_items ?? []) : []),
    languages: languageLabel(result.language),
    emotions: result.emotions?.available ? result.emotions : null,
  };
}

const chatTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Maps the WhatsApp job result (POST /api/whatsapp/process) to the view model. */
export function toChatView(result: ChatResult): CallView {
  return {
    source: "whatsapp",
    duration: 0,
    talk: [],
    context: null,
    contextReason: null,
    transcript: result.messages
      .filter((m) => m.kind !== "system")
      .map((m) => ({
        start: 0,
        end: 0,
        speaker: m.sender,
        text: m.kind === "media" ? "(media)" : m.text,
        translation: m.kind === "text" && !same(m.text, m.english) ? m.english : null,
        timeLabel: chatTime.format(new Date(m.timestamp)),
      })),
    ...analysisFields(result.analysis),
    ...pulseFields(result.pulse),
    ...derived(result.pulse?.available ? result.pulse.data : null, [], result.analysis.available ? (result.analysis.data?.action_items ?? []) : []),
    languages: null,
    emotions: null,
  };
}
