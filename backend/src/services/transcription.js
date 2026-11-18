// Gemini transcription and English translation.
//
// Transcription: the recording is decoded to 16 kHz mono and sent to Gemini in chunks
// (TRANSCRIBE_CHUNK_SECONDS, default 5 min) because gemini-3.5-transcribe processes at most 15 minutes
// per request with diarization/timestamps. Chunks run concurrently (GEMINI_CONCURRENCY). With
// gemini-3.5-transcribe, a chunk that fails or comes back empty is re-transcribed by the text model,
// which understands Tamil, English and Tamil-English code-mixing directly from audio.
//
// Translation: the original-language segments are translated into professional English by the text
// model, one English line per original segment, so timestamps and speakers stay aligned.

import path from "node:path";
import { z } from "zod";

import * as config from "../config.js";
import * as gemini from "./gemini.js";
import { GeminiUnavailable } from "./gemini.js";
import { SAMPLE_RATE, encodeOpus, loadAudio, wavBytes } from "./audio.js";
import { getLogger, mapLimit, perf, round, sortStrings } from "../util.js";

export { AudioDecodeError, SAMPLE_RATE, loadAudio, wavBytes } from "./audio.js";

const logger = getLogger("app.services.transcription");

export const SOURCE_LANGUAGE = "ta"; // primary expected language; actual languages are detected per recording
const TRANSLATE_BATCH = 120; // segments per translation request

/** Transcription could not run (credentials, permissions, model). Message is safe to show. */
export class TranscriptionUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscriptionUnavailable";
  }
}

/** Emotions the transcriber may report per segment ("neutral" when nothing is clearly audible). */
export const EMOTIONS = [
  "neutral", "friendly", "happy", "excited", "interested", "calm",
  "hesitant", "concerned", "confused", "frustrated", "angry", "sad",
];

/** A transcript segment (start, end, text, warning, speaker, emotion). */
export const segment = (start, end, text, { warning = null, speaker = null, emotion = null } = {}) => ({
  start, end, text, warning, speaker, emotion,
});

/**
 * Pulls complete segment objects out of the "segments" array of a JSON answer that is still being
 * streamed, so each transcript line can be shown as soon as Gemini has written it.
 */
export class SegmentStream {
  constructor() {
    this.pos = -1;
  }

  feed(text) {
    const out = [];
    if (this.pos < 0) {
      const key = text.indexOf('"segments"');
      const open = key < 0 ? -1 : text.indexOf("[", key);
      if (open < 0) return out;
      this.pos = open + 1;
    }
    let i = this.pos;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length || text[i] !== "{") break;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) break; // object not finished yet
      try {
        out.push(JSON.parse(text.slice(i, end + 1)));
      } catch {
        break;
      }
      i = end + 1;
      this.pos = i;
    }
    return out;
  }
}

/** Audio for Gemini: compressed Ogg/Opus (about 8x smaller than WAV); WAV if encoding is unavailable. */
async function audioPart(samples) {
  try {
    return { inlineData: { data: (await encodeOpus(samples)).toString("base64"), mimeType: "audio/ogg" } };
  } catch (exc) {
    logger.warning(`Opus encoding unavailable, sending WAV: ${exc.message}`);
    return { inlineData: { data: wavBytes(samples).toString("base64"), mimeType: "audio/wav" } };
  }
}

export function chunks(audio) {
  const size = Math.max(30, config.settings.TRANSCRIBE_CHUNK_SECONDS) * SAMPLE_RATE;
  const out = [];
  let i = 0;
  while (i < audio.length) {
    // Cut at the quietest moment near the nominal boundary, so no word is split between two chunks
    // (a word cut in half is lost or garbled in both).
    const end = i + size >= audio.length ? audio.length : quietPoint(audio, i + size);
    const piece = audio.subarray(i, end);
    if (piece.length >= SAMPLE_RATE / 2 || out.length === 0) out.push([i / SAMPLE_RATE, piece]); // drop a < 0.5 s tail
    i = end;
  }
  return out;
}

/** Sample index of the quietest 0.2 s frame within ±10 s of `at` (the nominal cut if none is clearly quieter). */
export function quietPoint(audio, at) {
  const frame = Math.round(0.2 * SAMPLE_RATE);
  const reach = 10 * SAMPLE_RATE;
  const rms = (s) => {
    let sum = 0;
    const e = Math.min(audio.length, s + frame);
    for (let k = s; k < e; k++) sum += audio[k] * audio[k];
    return Math.sqrt(sum / Math.max(1, e - s));
  };
  let best = at;
  let bestRms = rms(at - (frame >> 1));
  for (let d = frame; d <= reach; d += frame) {
    for (const c of [at - d, at + d]) {
      if (c - frame < 0 || c + frame > audio.length) continue;
      const r = rms(c - (frame >> 1));
      if (r < bestRms * 0.6) {
        best = c;
        bestRms = r;
      }
    }
  }
  return best;
}

function isSilent(audio) {
  if (audio.length === 0) return true;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / audio.length) < 1e-3;
}

// ------------------------------------------------------------ gemini-3.5-transcribe path

/** Parse protobuf Duration strings like '12.340s' (or bare numbers). */
function offset(value) {
  if (value === null || value === undefined) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)s?\s*$/.exec(String(value));
  return m ? parseFloat(m[1]) : null;
}

function speakerNamer() {
  const names = new Map();
  return (label) => {
    if (!label) return null;
    if (!names.has(label)) names.set(label, `Speaker ${names.size + 1}`);
    return names.get(label);
  };
}

/** Split one long diarized turn into readable segments using word timestamps. */
function splitWords(words, speaker, maxLen = 25.0) {
  const segs = [];
  let cur = [];
  let segStart = null;
  let lastEnd = 0.0;
  for (const w of words) {
    const ws = offset(w.startOffset);
    const we = offset(w.endOffset);
    if (ws === null || we === null || !w.word) continue;
    if (segStart === null) segStart = ws;
    cur.push(w.word);
    lastEnd = we;
    if ((we - segStart >= maxLen && /[.?!।]$/.test(w.word)) || we - segStart >= maxLen * 1.6) {
      segs.push(segment(segStart, we, cur.join(" ").trim(), { speaker }));
      cur = [];
      segStart = null;
    }
  }
  if (cur.length && segStart !== null) segs.push(segment(segStart, lastEnd, cur.join(" ").trim(), { speaker }));
  return segs;
}

async function transcribeChunkAsr(chunk, chunkOffset) {
  const model = config.settings.GEMINI_TRANSCRIBE_MODEL;
  let response;
  try {
    const client = await gemini.getClient();
    response = await client.models.generateContent({
      model,
      contents: [await audioPart(chunk)],
      config: {
        audioTranscriptionConfig: {
          diarization: true,
          wordTimestamp: true,
          // The API rejects languageAuto; Tamil works via languageCodes (tested 2026-11-12).
          languageCodes: config.settings.TRANSCRIBE_LANGUAGE_CODES,
          ...(config.settings.TRANSCRIBE_VOCABULARY.length ? { customVocabulary: config.settings.TRANSCRIBE_VOCABULARY } : {}),
        },
      },
    });
  } catch (exc) {
    throw gemini.explainError(exc, model);
  }

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const name = speakerNamer();
  const duration = chunk.length / SAMPLE_RATE;
  const segs = [];
  const langs = new Set();
  const untimed = [];
  for (const p of parts) {
    const tx = p.audioTranscription;
    const text = ((tx ? tx.text : null) || p.text || "").trim();
    if (!text) continue;
    const speaker = name(tx ? tx.speakerLabel : null);
    if (tx?.languageCode) langs.add(tx.languageCode);
    const words = (tx ? tx.words : null) || [];
    let start = tx ? offset(tx.startOffset) : null;
    let end = tx ? offset(tx.endOffset) : null;
    if (start === null && words.length) start = offset(words[0].startOffset);
    if (end === null && words.length) end = offset(words[words.length - 1].endOffset);
    if (start === null || end === null) {
      untimed.push([text, speaker]);
      continue;
    }
    if (end - start > 40 && words.length) segs.push(...splitWords(words, speaker));
    else segs.push(segment(start, end, text, { speaker }));
  }

  if (untimed.length) {
    // No timing returned: spread the text over the chunk in proportion to its length.
    const total = untimed.reduce((n, [t]) => n + t.length, 0) || 1;
    let pos = 0.0;
    for (const [text, speaker] of untimed) {
      const span = (duration * text.length) / total;
      segs.push(segment(pos, pos + span, text, { speaker, warning: "Approximate timestamp." }));
      pos += span;
    }
  }

  for (const s of segs) {
    s.start = round(s.start + chunkOffset, 2);
    s.end = round(s.end + chunkOffset, 2);
  }
  return [segs.sort((a, b) => a.start - b.start), langs];
}

// ------------------------------------------------------------- text-model (Flash) path

const AudioTranscript = gemini.defineSchema(
  "_AudioTranscript",
  // "segments" comes first so streamed lines start arriving immediately.
  z.object({
    segments: z.array(
      z.object({
        start: z.string().describe("Start time within this audio clip as MM:SS"),
        end: z.string().describe("End time within this audio clip as MM:SS"),
        speaker: z.string().describe("Speaker label: 'Speaker 1', 'Speaker 2', ... in order of first appearance"),
        text: z.string().describe("Exactly what was said, in the original language and script"),
        english: z.string().describe("Professional English translation of this segment"),
        emotion: z.enum(EMOTIONS).describe("Emotion clearly audible in this segment (tone of voice and words), else 'neutral'"),
      }),
    ),
    languages: z.array(z.string()).describe("BCP-47 codes of languages spoken, e.g. ['ta', 'en']"),
    unclear: z.string().nullable().describe("Short note if parts were inaudible, else null"),
  }),
);

// The English translation is produced in the same request as the transcript: a separate translation
// round trip added 7-67 s per recording.
const TRANSCRIBE_PROMPT = `Transcribe this audio recording verbatim. It may be a meeting, business discussion,
customer conversation or phone call recorded on Android or iPhone. Speech may be Tamil, English,
Hindi, Telugu, or a mix of them (e.g. Tamil-English "Tanglish").

Rules for "text":
- Preserve the ORIGINAL spoken language. Do NOT translate "text".
- Write Tamil, Hindi and Telugu words in their own script. Write every English word in English
  (Latin script) exactly as spoken, even inside other-language sentences (code-mixing). Do NOT
  transliterate English words. Example: "உங்க product எனக்கு பிடிச்சிருக்கு, pricing கொஞ்சம் அதிகம்" — not
  "உங்க ப்ராடக்ட் … ப்ரைசிங் …". Suffixes may attach to English words ("team-க்கு").
- Keep names, numbers, product and technical terms exactly as spoken.
- Split into segments at each change of speaker or every sentence or two (at most ~25 seconds).
- Label speakers 'Speaker 1', 'Speaker 2', ... by voice, in order of first appearance. Never guess
  real names for labels.
- Timestamps are relative to the start of THIS clip, format MM:SS.
- Cover the WHOLE clip from the first to the last second, in order. Never skip a part, never repeat
  a line, never merge two people's words into one segment. Short replies ("ok", "haan", "sari")
  are their own segment with the person who said them. The clip may start or end mid-sentence:
  transcribe those partial words too.
- Do not add, summarise or invent anything. Mark inaudible words as [inaudible].
- If there is no speech, return an empty segments list.

Rules for "english" (one per segment):
- A clear, professional English translation of that segment's "text". Preserve the meaning exactly;
  do not add, remove, summarise or invent information. Correct grammar and improve clarity.
- Keep names of people, companies, places, products, numbers, dates and technical terms unchanged.
- If the segment is already English, correct grammar and clarity only. Keep '[inaudible]' markers.

Rules for "emotion" (one per segment, from the allowed list):
- The emotion that is clearly audible in the speaker's tone of voice and words in that segment.
- Use "neutral" when no emotion is clearly audible. Do not guess and do not exaggerate: ordinary
  politeness is "friendly", not "happy" or "excited"; a polite doubt is "hesitant", not "frustrated".
- Judge each segment on its own; never assign an emotion to a speaker who did not speak in it.
`;

function transcribePrompt() {
  const vocab = config.settings.TRANSCRIBE_VOCABULARY;
  if (!vocab.length) return TRANSCRIBE_PROMPT;
  return TRANSCRIBE_PROMPT + "- Known names that may be spoken; when you hear one, spell it exactly like this: " + vocab.join(", ") + ".\n";
}

const FLOAT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

function mmss(value) {
  const parts = value.trim().split(":");
  if (!parts.every((p) => FLOAT.test(p))) return null;
  return parts.reduce((sec, p) => sec * 60 + parseFloat(p), 0.0);
}

/** English translations returned together with the transcript, keyed by segment object. */
const inlineEnglish = new WeakMap();

/** Convert the model's clip-relative segments into recording-relative transcript segments. */
function toSegments(rawSegments, duration, chunkOffset) {
  const segs = [];
  for (const r of rawSegments) {
    if (typeof r?.text !== "string" || !r.text.trim()) continue;
    const start = Math.min(mmss(String(r.start ?? "")) || 0.0, duration);
    const end = Math.min(Math.max(mmss(String(r.end ?? "")) || start, start), duration);
    const seg = segment(round(start + chunkOffset, 2), round(end + chunkOffset, 2), r.text.trim(), {
      speaker: r.speaker || null,
      emotion: EMOTIONS.includes(r.emotion) ? r.emotion : null,
    });
    if (typeof r.english === "string" && r.english.trim()) inlineEnglish.set(seg, r.english.trim());
    segs.push(seg);
  }
  return segs;
}

/**
 * Transcribe one chunk with the text model, streaming: onPartial(segments) receives the lines written
 * so far (with their English and emotion), so the UI can show them within seconds.
 */
async function transcribeChunkLlm(chunk, chunkOffset, model, onPartial = () => {}) {
  const duration = chunk.length / SAMPLE_RATE;
  const parser = new SegmentStream();
  const partial = [];
  const result = await gemini.streamJson([await audioPart(chunk), transcribePrompt()], AudioTranscript, {
    model,
    temperature: 0.0,
    hedgeSeconds: config.settings.TRANSCRIBE_HEDGE_SECONDS ? config.settings.TRANSCRIBE_HEDGE_SECONDS + 0.15 * duration : null,
    onText: (text) => {
      const fresh = parser.feed(text);
      if (!fresh.length) return;
      partial.push(...toSegments(fresh, duration, chunkOffset));
      onPartial(partial.slice());
    },
  });
  return [toSegments(result.segments, duration, chunkOffset), new Set(result.languages)];
}

// ------------------------------------------------------------------------- translation

const Translation = gemini.defineSchema(
  "_Translation",
  z.object({
    lines: z.array(
      z.object({
        id: z.int(),
        english: z.string().describe("Professional English translation of this line"),
      }),
    ),
  }),
);

export const TextTranslation = gemini.defineSchema(
  "TextTranslation",
  z.object({
    detected_language: z.string().describe("'ta', 'en', or 'ta-en' for mixed Tamil-English"),
    translation: z.string().describe("Professional English translation"),
  }),
);

const TRANSLATE_RULES = `Translate into clear, professional English.
- The source may be Tamil (Tamil script), Tanglish (Tamil written in Latin letters), mixed
  Tamil-English, Hindi or Telugu. Lines already in English: correct grammar and clarity only.
- Preserve the original meaning exactly. Do not add, remove, summarise or invent information.
- Correct grammar and improve sentence clarity.
- Keep names of people, companies, places, products, numbers, dates and technical terms unchanged.
- Keep '[inaudible]' markers. If a line is unintelligible, write '[unclear]'.
`;

/** Translate many short lines (batches run in parallel), keeping a 1:1 mapping to the inputs. */
export async function translateLines(texts, context = "conversation") {
  const out = new Array(texts.length).fill("");
  const starts = [];
  for (let s = 0; s < texts.length; s += TRANSLATE_BATCH) starts.push(s);
  await mapLimit(starts, config.settings.GEMINI_CONCURRENCY, async (start) => {
    const batch = texts
      .slice(start, start + TRANSLATE_BATCH)
      .map((t, k) => [start + k, t])
      .filter(([, t]) => t.trim());
    if (!batch.length) return;
    const numbered = batch.map(([i, t]) => `${i}\t${t}`).join("\n");
    const prompt =
      `${TRANSLATE_RULES}\nBelow are numbered lines from a ${context}, one per line as ` +
      `'<id><TAB><text>'. Return one translation for EVERY id, using the surrounding lines as ` +
      `context.\n\n${numbered}`;
    const result = await gemini.generateJson(prompt, Translation, {
      temperature: 0.1,
      hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
    });
    const ids = new Set(batch.map(([i]) => i));
    for (const line of result.lines) if (ids.has(line.id)) out[line.id] = line.english.trim();
  });
  return out;
}

export function translateText(text) {
  return gemini.generateJson(`${TRANSLATE_RULES}\nText:\n${text}`, TextTranslation, {
    temperature: 0.1,
    hedgeSeconds: config.settings.TEXT_HEDGE_SECONDS,
  });
}

// ---------------------------------------------------------------------------- pipeline

/** Transcribe (original language) and translate (English) already-decoded audio. */
export async function transcribeAudio(filePath, audio, onStage = null, onPartial = null) {
  const t0 = perf();
  const stage = onStage || (() => {});
  const transcribeModel = config.settings.GEMINI_TRANSCRIBE_MODEL;
  const useAsr = transcribeModel.includes("transcribe");
  // Without the ASR model, the configured transcribe model does the audio-understanding path itself.
  const llmModel = useAsr ? config.settings.GEMINI_TEXT_MODEL : transcribeModel;
  const parts = chunks(audio);
  const languages = new Set();
  const modelsUsed = new Set();
  const state = { asrError: null, done: 0 };
  // Lines written so far, per chunk, reported in time order as they stream in.
  const partialByChunk = new Array(parts.length).fill(null).map(() => []);
  const reportPartial = () => {
    if (!onPartial) return;
    const lines = partialByChunk.flat().sort((a, b) => a.start - b.start);
    onPartial({
      segments: lines,
      english: lines.map((x) => segment(x.start, x.end, inlineEnglish.get(x) ?? "", { speaker: x.speaker, emotion: x.emotion })),
    });
  };

  stage("transcribing", 0.0);
  // Chunks are independent network calls, so they run concurrently; results keep chunk order.
  const perChunk = await mapLimit(parts, config.settings.GEMINI_CONCURRENCY, async ([chunkOffset, chunk], n) => {
    let segs = [];
    if (!isSilent(chunk)) {
      if (useAsr && state.asrError === null) {
        try {
          const [s, langs] = await transcribeChunkAsr(chunk, chunkOffset);
          segs = s;
          langs.forEach((l) => languages.add(l));
          if (segs.length) modelsUsed.add(transcribeModel);
        } catch (exc) {
          if (!(exc instanceof GeminiUnavailable)) throw exc;
          logger.warning(`${transcribeModel} failed for ${path.basename(filePath)} chunk ${n}: ${exc.message}`);
          state.asrError = exc.message; // stop trying a failing model for later chunks
        }
      }
      if (!segs.length && (!useAsr || config.settings.TRANSCRIBE_FALLBACK)) {
        let langs;
        try {
          [segs, langs] = await transcribeChunkLlm(chunk, chunkOffset, llmModel, (lines) => {
            partialByChunk[n] = lines;
            reportPartial();
          });
        } catch (exc) {
          if (exc instanceof GeminiUnavailable) throw new TranscriptionUnavailable(exc.message);
          throw exc;
        }
        langs.forEach((l) => languages.add(l));
        modelsUsed.add(llmModel);
      } else if (!segs.length && state.asrError) {
        throw new TranscriptionUnavailable(state.asrError);
      }
    }
    partialByChunk[n] = segs;
    reportPartial();
    state.done += 1;
    stage("transcribing", state.done / parts.length);
    return segs;
  });
  const segments = perChunk.flat();

  stage("translating", 0.0);
  // Most segments already carry their English from the transcription request; only the rest (the
  // gemini-3.5-transcribe path, or a segment the model left untranslated) need a translation call.
  const english = segments.map((s) => inlineEnglish.get(s) ?? "");
  const missing = english.map((e, i) => (e ? -1 : i)).filter((i) => i >= 0);
  try {
    if (missing.length) {
      const translated = await translateLines(missing.map((i) => segments[i].text), "recorded meeting or phone call");
      missing.forEach((i, k) => (english[i] = translated[k]));
    }
  } catch (exc) {
    if (exc instanceof GeminiUnavailable) {
      throw new TranscriptionUnavailable(`Transcription succeeded but translation failed: ${exc.message}`);
    }
    throw exc;
  }
  const englishSegments = segments.map((s, i) =>
    segment(s.start, s.end, english[i], { warning: english[i] ? null : "Not translated.", speaker: s.speaker, emotion: s.emotion }),
  );
  stage("translating", 1.0);

  return {
    tamil_text: segments.map((s) => s.text).join("\n"),
    tamil_segments: segments,
    english_text: englishSegments.filter((s) => s.text).map((s) => s.text).join("\n"),
    english_segments: englishSegments,
    duration_seconds: round(audio.length / SAMPLE_RATE, 2),
    processing_seconds: round(perf() - t0, 1),
    model: sortStrings(modelsUsed).join(" + ") || transcribeModel,
    languages: sortStrings(languages),
  };
}

/** Decode, transcribe and translate a file (used by POST /api/audio/transcribe). */
export async function transcribeFile(filePath) {
  return transcribeAudio(filePath, await loadAudio(filePath));
}
