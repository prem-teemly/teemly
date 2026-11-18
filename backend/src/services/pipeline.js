// Full meeting analysis pipeline, run as background jobs with progress reporting.
//
// Audio stages: decode -> transcription (Gemini) -> English translation -> analysis + Pulse.
// Local speaker diarization (CPU) runs in a worker thread alongside transcription (network), so
// long recordings don't pay for both one after the other, and the API stays responsive.
// (WhatsApp chat upload was removed; chats analysed before that are still read from MySQL.)
// Transcription failure fails the job. Diarization, analysis or Pulse failure does not: the job
// completes and the result states clearly which part is unavailable and why.
// Jobs are kept in memory (lost on restart). Up to JOB_CONCURRENCY jobs run at once.

import * as config from "../config.js";
import * as analysis from "./analysis.js";
import * as context from "./context.js";
import * as diarization from "./diarization.js";
import * as emotions from "./emotions.js";
import { afterJob as findPeople } from "./peopleJob.js";
import { setJobPerson } from "../db/people.js";
import * as pulse from "./pulse.js";
import * as transcription from "./transcription.js";
import * as repo from "../db/repository.js";
import { getLogger, hexId, now, perf, round } from "../util.js";

const logger = getLogger("app.services.pipeline");

const MAX_JOBS_KEPT = 50;

// Share of the overall progress bar given to each stage (sums to 1.0).
const STAGE_WEIGHTS = { queued: 0.0, decoding: 0.02, transcribing: 0.55, translating: 0.25, diarizing: 0.08, analyzing: 0.1 };
const STAGE_LABELS = {
  queued: "Waiting to start",
  decoding: "Reading audio file",
  transcribing: "Transcribing speech",
  translating: "Translating to English",
  diarizing: "Identifying who spoke",
  analyzing: "Analysing meeting content and Pulse signals",
  done: "Completed",
};

class Job {
  constructor({ id, filename, numSpeakers, kind = "audio", audio = null, probe = null, personId = null }) {
    this.id = id;
    this.personId = personId; // uploaded on this person's page (goes on their timeline)
    this.filename = filename;
    this.audio = audio; // public audio metadata (see repository.publicAudio)
    this.probe = probe; // ffprobe measurement, used if the file has to be registered in MySQL
    this.numSpeakers = numSpeakers;
    this.status = "queued"; // queued | processing | completed | failed
    this.stage = "queued";
    this.stageProgress = 0.0;
    this.error = null;
    this.result = null;
    this.createdAt = now();
    this.startedAt = null;
    this.finishedAt = null;
    this.kind = kind; // audio (older jobs in MySQL may be "whatsapp")
  }

  get progress() {
    if (this.status === "completed") return 1.0;
    const weights = STAGE_WEIGHTS;
    const order = Object.keys(weights);
    const idx = order.indexOf(this.stage);
    const done = idx >= 0 ? order.slice(0, idx).reduce((sum, s) => sum + weights[s], 0) : 0.0;
    return round(Math.min(0.99, done + (weights[this.stage] ?? 0) * this.stageProgress), 3);
  }

  toDict() {
    const t = this.finishedAt || now();
    return {
      job_id: this.id,
      kind: this.kind,
      filename: this.filename,
      status: this.status,
      stage: this.stage,
      stage_label: STAGE_LABELS[this.stage] ?? this.stage,
      progress: this.progress,
      elapsed_seconds: this.startedAt ? round(t - this.startedAt, 1) : 0.0,
      error: this.error,
      ...(this.audio ? { audio: this.audio } : {}),
      result: this.result,
    };
  }
}

const jobs = new Map();
// Up to JOB_CONCURRENCY jobs run at once (in submission order), so a short upload never waits
// behind a long recording.
const waiting = [];
let running = 0;

function enqueue(fn) {
  waiting.push(fn);
  pump();
}

function pump() {
  while (running < config.JOB_CONCURRENCY && waiting.length) {
    const fn = waiting.shift();
    running += 1;
    Promise.resolve()
      .then(fn)
      .catch((exc) => logger.error("Unexpected job runner error", exc))
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function register(job) {
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS_KEPT) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, jobs.size - MAX_JOBS_KEPT);
    for (const old of oldest) if (old.status === "completed" || old.status === "failed") jobs.delete(old.id);
  }
}

// --- Persistence (MySQL, best-effort). Each job's database writes run one after another, in order,
// so a late progress update can never overwrite the final status.
const persistChains = new Map();
function persist(job, fn) {
  if (!repo.enabled()) return;
  const chain = (persistChains.get(job.id) ?? Promise.resolve()).then(fn, fn);
  persistChains.set(job.id, chain);
  chain.finally(() => {
    if (persistChains.get(job.id) === chain) persistChains.delete(job.id);
  });
}

/** Wait until every database write queued for a job has finished (tests, export after restart). */
export const persisted = (jobId) => persistChains.get(jobId) ?? Promise.resolve();

/** Store the job; a job uploaded on a person's page also records the person. */
async function createJob(job, filePath, ip) {
  await repo.createJob(job, filePath, ip);
  if (job.personId) await setJobPerson(job.id, job.personId).catch((exc) => logger.warning(`Could not link job ${job.id} to its person: ${exc.message}`));
}

export function submit(filename, filePath, numSpeakers, { ip = null, audio = null, probe = null, personId = null } = {}) {
  const job = new Job({ id: hexId(), filename, numSpeakers, audio, probe, personId });
  register(job);
  persist(job, () => createJob(job, filePath, ip));
  enqueue(() => run(job, filePath));
  return job;
}

export const get = (jobId) => jobs.get(jobId) ?? null;

/**
 * Jobs for the Today page's "Live" card: everything queued or processing, and what finished in the
 * last `withinSeconds` (so a call is seen to complete). Newest first; no results, only progress.
 */
export function recentJobs(withinSeconds = 900) {
  const t = now();
  return [...jobs.values()]
    .filter((j) => j.status === "queued" || j.status === "processing" || (j.finishedAt && t - j.finishedAt < withinSeconds))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6)
    .map((j) => {
      const { result, ...d } = j.toDict();
      return { ...d, person_id: j.personId ?? null, finished_seconds_ago: j.finishedAt ? Math.round(t - j.finishedAt) : null };
    });
}

/** Stored upload names that a queued or processing job still reads (retention must keep these). */
export function filesInUse() {
  const names = new Set();
  for (const job of jobs.values()) if (job.status === "queued" || job.status === "processing") names.add(job.filename);
  return names;
}

/** A job from memory, or rebuilt from the database (e.g. after a backend restart). */
export async function find(jobId) {
  const live = jobs.get(jobId);
  if (live) return { live: true, job: live, dict: live.toDict() };
  const dict = await repo.loadJob(jobId);
  return dict ? { live: false, job: null, dict } : null;
}

/** Drop in-memory jobs (tests use this to simulate a backend restart). */
export function forgetAllJobsForTests() {
  jobs.clear();
}

function setStage(job, stage, fraction = 0.0) {
  const changed = job.stage !== stage;
  job.stage = stage;
  job.stageProgress = Math.max(0.0, Math.min(1.0, fraction));
  if (changed && stage !== "done") persist(job, () => repo.updateJobProgress(job));
}

function persistOutcome(job) {
  persist(job, () => repo.saveJobOutcome(job, { text: config.settings.GEMINI_TEXT_MODEL }));
}

/** Streaming lines carry Gemini's per-chunk labels; show them as "Person N" like the final result. */
function asPersons(segments, english) {
  const persons = diarization.toPersons(segments.map((x) => x.speaker));
  return [segments.map((x, i) => ({ ...x, speaker: persons[i] })), english.map((x, i) => ({ ...x, speaker: persons[i] ?? x.speaker }))];
}

/** Analysis block while it is still being computed (the UI keeps showing its loading state). */
const pendingBlock = () => ({ available: false, reason: null, model: config.settings.GEMINI_TEXT_MODEL, data: null });

function buildResult(duration, tr, tamilSegments, englishSegments, speakers, meeting, pulseBlock, timings, contextBlock = pendingBlock()) {
  const lastEnd = tr.tamil_segments.reduce((m, s) => Math.max(m, s.end), 0.0);
  return {
    audio_duration_seconds: duration,
    transcription_model: tr.model,
    language: tr.languages.join(", ") || transcription.SOURCE_LANGUAGE,
    coverage: {
      last_segment_end_seconds: lastEnd,
      segments: tr.tamil_segments.length,
      note: "Silent or non-speech parts are skipped by voice-activity detection.",
    },
    tamil_transcript: tr.tamil_text,
    english_translation: tr.english_text,
    tamil_segments: tamilSegments,
    english_segments: englishSegments,
    speakers,
    context: contextBlock,
    emotions: emotions.summarize(tamilSegments),
    analysis: meeting,
    pulse: pulseBlock,
    timings_seconds: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, round(v, 1)])),
  };
}

async function run(job, filePath) {
  job.status = "processing";
  job.startedAt = now();
  const timings = {};
  try {
    let t = perf();
    setStage(job, "decoding");
    const audio = await transcription.loadAudio(filePath);
    const duration = round(audio.length / transcription.SAMPLE_RATE, 2);
    timings.decoding = perf() - t;

    // --- Speakers. A recording that fits in one transcription chunk (<= TRANSCRIBE_CHUNK_SECONDS) gets
    // its speaker turns from Gemini directly: within one chunk the hybrid labelling below gives exactly
    // Gemini's grouping, so local diarization would only add 40-100 s of waiting. Longer recordings
    // need it to keep one identity per voice across chunks; it runs in a worker thread, concurrently
    // with Gemini transcription, so the API stays responsive.
    const chunkStarts = transcription.chunks(audio).map(([offset]) => offset);
    const singleChunk = chunkStarts.length <= 1;
    const diarizationStarted = perf();
    const diarizationPromise = singleChunk ? null : diarization.diarizeFile(filePath, job.numSpeakers);
    diarizationPromise?.catch(() => {}); // handled below; avoid an unhandled rejection meanwhile

    t = perf();
    setStage(job, "transcribing");
    // Lines are published to the job as Gemini streams them, so the UI shows them within seconds.
    const noSpeakersYet = { available: false, reason: null, count: 0, turns: [] };
    const onPartial = ({ segments, english }) => {
      if (job.status !== "processing" || (job.stage !== "transcribing" && job.stage !== "translating")) return;
      const partialTr = {
        model: config.settings.GEMINI_TRANSCRIBE_MODEL,
        languages: [],
        tamil_text: segments.map((x) => x.text).join("\n"),
        english_text: english.filter((x) => x.text).map((x) => x.text).join("\n"),
        tamil_segments: segments,
      };
      const [shown, shownEnglish] = asPersons(segments, english);
      job.result = buildResult(duration, partialTr, shown, shownEnglish, noSpeakersYet, pendingBlock(), pendingBlock(), timings);
    };
    const tr = await transcription.transcribeAudio(filePath, audio, (s, f) => setStage(job, s, f), onPartial);
    timings.transcription_and_translation = perf() - t;

    // Show the transcript right away; speakers (long recordings), summary and Pulse follow.
    job.result = buildResult(duration, tr, ...asPersons(tr.tamil_segments, tr.english_segments),
      { available: false, reason: null, count: 0, turns: [] }, pendingBlock(), pendingBlock(), timings);

    t = perf();
    setStage(job, "diarizing");
    const speakers = { available: false, reason: null, count: 0, turns: [] };
    let turns = [];
    if (singleChunk) {
      turns = [];
      const labelled = tr.tamil_segments.filter((x) => x.speaker);
      speakers.available = labelled.length > 0;
      speakers.reason = labelled.length ? null : "No speech turns were detected.";
      speakers.count = new Set(labelled.map((x) => x.speaker)).size;
      speakers.turns = labelled.map((x) => ({ start: x.start, end: x.end, speaker: x.speaker }));
    } else {
      try {
        turns = await diarizationPromise;
        timings.diarization_elapsed = perf() - diarizationStarted;
        speakers.available = turns.length > 0;
        speakers.reason = turns.length ? null : "No speech turns were detected.";
        speakers.count = new Set(turns.map((x) => x.speaker)).size;
        speakers.turns = turns.map((x) => ({ start: x.start, end: x.end, speaker: x.speaker }));
      } catch (exc) {
        turns = [];
        if (exc instanceof diarization.DiarizationUnavailable) {
          speakers.reason = exc.message;
        } else if (exc instanceof diarization.DiarizationWorkerCrashed) {
          logger.error(`Diarization process crashed for ${job.filename}`, exc);
          speakers.reason = "Identifying who spoke failed (the voice separation process stopped unexpectedly).";
        } else {
          logger.error(`Diarization failed for ${job.filename}`, exc);
          speakers.reason = `Identifying who spoke failed (${exc?.name ?? "Error"}).`;
        }
      }
    }
    timings.waiting_for_diarization = perf() - t;

    // Gemini's turn-taking within each chunk, mapped onto diarization's whole-recording voice
    // identities (see diarization.assignSpeakers). On 4 test recordings with known speakers this
    // labelled 33/33 lines correctly vs 28/33 for diarization alone. Without diarization, Gemini's
    // per-chunk labels are used as they are.
    let speakerLabels = diarization.assignSpeakers(tr.tamil_segments, turns, chunkStarts);
    // One voice split into two identities (chunk boundary, call drop) is joined again, so a two-person
    // call stays two people for its whole length.
    if (turns.length) speakerLabels = diarization.mergeSplitVoices(speakerLabels, tr.tamil_segments, diarization.maxVoicesPerChunk(tr.tamil_segments, chunkStarts));
    // People are shown as "Person 1", "Person 2", ... (in order of first appearance) until a name is proven.
    const personLabels = diarization.toPersons(speakerLabels);
    const tamilSegments = tr.tamil_segments.map((x, i) => ({ ...x, speaker: personLabels[i] }));
    const englishSegments = tr.english_segments.map((x, i) => ({ ...x, speaker: personLabels[i] }));
    speakers.count = new Set(personLabels.filter(Boolean)).size;
    speakers.turns = tamilSegments.filter((x) => x.speaker).map((x) => ({ start: x.start, end: x.end, speaker: x.speaker }));
    job.result = buildResult(duration, tr, tamilSegments, englishSegments, speakers, pendingBlock(), pendingBlock(), timings);

    // --- Meeting analysis and Pulse (optional, run in parallel: failure is reported, not fatal)
    t = perf();
    setStage(job, "analyzing");
    // Context (speaker names + timed sections) runs alongside, so it adds no waiting time.
    const lines = pulse.linesFromSegments(tamilSegments, englishSegments);
    const [[meetingRaw, pulseRaw], contextRaw] = await Promise.all([
      analyzeBoth(() => analysis.analyze(tamilSegments, englishSegments), () => pulse.analyze(lines), job.filename),
      wrapBlock(() => context.analyze(lines), context.ContextUnavailable, "Conversation context", job.filename),
    ]);
    timings.analysis_and_pulse = perf() - t;

    // Names proven by the conversation ("Hi Prem") replace the Person labels everywhere; people without
    // a proven name stay "Person 1", "Person 2", ... (renumbered). Spoken words are never changed.
    const names = context.displayNames(tamilSegments, contextRaw.data?.names ?? []);
    const named = (x) => ({ ...x, speaker: names.get(x.speaker) ?? x.speaker });
    const tamilNamed = tamilSegments.map(named);
    const englishNamed = englishSegments.map(named);
    const speakersNamed = {
      ...speakers,
      // One voice that was split into two labels is one person again.
      count: new Set(tamilNamed.map((x) => x.speaker).filter(Boolean)).size,
      turns: speakers.turns.map(named),
    };
    const meeting = { ...meetingRaw, data: context.renameDeep(meetingRaw.data, names) };
    const pulseBlock = { ...pulseRaw, data: context.renameDeep(pulseRaw.data, names) };
    const contextBlock = { ...contextRaw, data: contextRaw.data ? context.buildData(contextRaw.data, tamilNamed, names) : null };

    job.result = buildResult(duration, tr, tamilNamed, englishNamed, speakersNamed, meeting, pulseBlock, timings, contextBlock);
    setStage(job, "done", 1.0);
    job.status = "completed";
  } catch (exc) {
    job.status = "failed";
    job.result = null;
    if (exc instanceof transcription.AudioDecodeError) {
      job.error = "The file could not be decoded as audio. It may be corrupted.";
    } else if (exc instanceof transcription.TranscriptionUnavailable) {
      job.error = exc.message;
    } else {
      logger.error(`Analysis job ${job.id} failed`, exc);
      job.error = `Processing failed during '${job.stage}' (${exc?.name ?? "Error"}).`;
    }
  } finally {
    job.finishedAt = now();
    persistOutcome(job);
    findPeople(job, persisted(job.id)); // after the results are saved; never changes them
  }
}

/** Run meeting analysis and Pulse concurrently; each reports its own failure without failing the job. */
export async function analyzeBoth(runAnalysis, runPulse, name) {
  return Promise.all([
    wrapBlock(runAnalysis, analysis.AnalysisUnavailable, "Meeting analysis", name),
    wrapBlock(runPulse, pulse.PulseUnavailable, "Pulse", name),
  ]);
}

/** Run one optional AI step; a failure becomes { available: false, reason } instead of failing the job. */
async function wrapBlock(fn, Unavailable, what, name) {
  const block = { available: false, reason: null, model: config.settings.GEMINI_TEXT_MODEL, data: null };
  try {
    block.data = await fn();
    block.available = true;
  } catch (exc) {
    if (exc instanceof Unavailable) {
      block.reason = exc.message;
    } else {
      logger.error(`${what} failed for ${name}`, exc);
      block.reason = `${what} failed (${exc?.name ?? "Error"}).`;
    }
  }
  return block;
}
