// Speaker diarization ("who spoke when") with sherpa-onnx, and speaker labelling.
//
// Uses the pyannote segmentation 3.0 model (ONNX) and a 3D-Speaker embedding model, both stored in
// backend/models/. Speakers get anonymous labels (Speaker 1, Speaker 2, ...); no names are ever
// inferred. The computation runs in a persistent worker thread (see diarizationWorker.js).

import { Worker } from "node:worker_threads";

import * as config from "../config.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.services.diarization");

/** Diarization cannot run (missing models or library). */
export class DiarizationUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "DiarizationUnavailable";
  }
}

/** The diarization worker stopped unexpectedly (crash); a fresh one is started next time. */
export class DiarizationWorkerCrashed extends Error {
  constructor(message) {
    super(message);
    this.name = "DiarizationWorkerCrashed";
  }
}

// One worker per concurrent job (JOB_CONCURRENCY), so jobs never wait for each other's diarization.
// Workers start lazily; a crashed worker is replaced on the next request.
const slots = Array.from({ length: config.JOB_CONCURRENCY }, () => ({ worker: null, pending: new Map() }));
let nextId = 0;

function startWorker(slot) {
  // execArgv: [] so the worker never inherits flags meant for the main process (e.g. --input-type).
  const w = new Worker(new URL("./diarizationWorker.js", import.meta.url), { execArgv: [] });
  w.unref(); // never keep the process alive on its own
  w.on("message", ({ id, turns, error }) => {
    const p = slot.pending.get(id);
    if (!p) return;
    if (!error) p.resolve(turns);
    else if (error.name === "DiarizationUnavailable") p.reject(new DiarizationUnavailable(error.message));
    else p.reject(Object.assign(new Error(error.message), { name: error.name }));
  });
  const crash = (reason) => {
    if (slot.worker === w) slot.worker = null;
    for (const p of [...slot.pending.values()]) p.reject(new DiarizationWorkerCrashed(reason));
  };
  w.on("error", (err) => {
    logger.error("Diarization worker failed", err);
    crash(String(err?.message ?? err));
  });
  w.on("exit", (code) => crash(`worker exited with code ${code}`));
  slot.worker = w;
  return w;
}

/** Decode and diarize a file in the least busy worker thread. */
export function diarizeFile(filePath, numSpeakers = null) {
  const slot = slots.reduce((best, s) => (s.pending.size < best.pending.size ? s : best));
  const w = slot.worker ?? startWorker(slot);
  const id = nextId++;
  w.ref(); // keep the worker alive while work is pending
  const settled = () => {
    if (!slot.pending.size) w.unref();
  };
  return new Promise((resolve, reject) => {
    slot.pending.set(id, {
      resolve: (turns) => (slot.pending.delete(id), settled(), resolve(turns)),
      reject: (err) => (slot.pending.delete(id), settled(), reject(err)),
    });
    w.postMessage({ id, filePath, numSpeakers });
  });
}

/**
 * Combine Gemini's per-chunk speaker labels with whole-recording diarization.
 *
 * Gemini sees turn-taking well inside a chunk but its labels restart in every chunk; local
 * diarization keeps one identity per voice across the recording but merges quick back-to-back
 * turns. Within each chunk, Gemini's labels are mapped one-to-one onto the diarization speakers
 * they overlap most. A Gemini speaker left without a match (diarization merged two voices) gets its
 * own new label rather than being folded into someone else. Segments without a Gemini label fall
 * back to plain overlap.
 */
export function assignSpeakers(segments, turns, chunkSeconds) {
  if (!turns.length) return segments.map((s) => s.speaker);
  const labels = new Array(segments.length).fill(null);
  const usedNames = new Set(turns.map((t) => t.speaker));
  let nextExtra = usedNames.size + 1;
  const byChunk = new Map();
  // chunkSeconds: a fixed chunk length, or the actual chunk start times (chunks are cut at quiet points).
  const chunkOf = Array.isArray(chunkSeconds)
    ? (t) => Math.max(0, chunkSeconds.findLastIndex((c) => c <= t + 0.01))
    : (t) => Math.floor(t / chunkSeconds);
  segments.forEach((s, i) => {
    const k = chunkOf(s.start);
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(i);
  });

  for (const idxs of byChunk.values()) {
    const overlap = new Map(); // "g\u0000d" -> seconds, in insertion order
    for (const i of idxs) {
      const g = segments[i].speaker;
      if (g === null || g === undefined) continue;
      for (const t of turns) {
        const o = Math.min(segments[i].end, t.end) - Math.max(segments[i].start, t.start);
        if (o > 0) {
          const key = `${g}\u0000${t.speaker}`;
          overlap.set(key, (overlap.get(key) ?? 0.0) + o);
        }
      }
    }
    const mapping = new Map();
    const taken = new Set();
    const ranked = [...overlap.entries()].sort((a, b) => b[1] - a[1]); // stable, like Python's sorted
    for (const [key] of ranked) {
      const [g, d] = key.split("\u0000");
      if (!mapping.has(g) && !taken.has(d)) {
        mapping.set(g, d);
        taken.add(d);
      }
    }
    for (const i of idxs) {
      const s = segments[i];
      if (s.speaker === null || s.speaker === undefined) {
        labels[i] = speakerFor(s.start, s.end, turns);
        continue;
      }
      if (!mapping.has(s.speaker)) mapping.set(s.speaker, `Speaker ${nextExtra++}`);
      labels[i] = mapping.get(s.speaker);
    }
  }
  return labels;
}

/** The speaker whose turns overlap [start, end] the most; nearest turn if none overlap. */
export function speakerFor(start, end, turns) {
  if (!turns.length) return null;
  const overlap = new Map();
  for (const t of turns) {
    const o = Math.min(end, t.end) - Math.max(start, t.start);
    if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0.0) + o);
  }
  if (overlap.size) {
    let best = null;
    for (const [sp, v] of overlap) if (best === null || v > overlap.get(best)) best = sp;
    return best;
  }
  const mid = (start + end) / 2;
  let nearest = turns[0];
  const dist = (t) => Math.min(Math.abs(mid - t.start), Math.abs(mid - t.end));
  for (const t of turns) if (dist(t) < dist(nearest)) nearest = t;
  return nearest.speaker;
}

/** How often two labels answer each other directly (consecutive lines). People in a dialogue do; one split voice does not. */
export function replies(labels, a, b) {
  let n = 0;
  for (let i = 1; i < labels.length; i++) {
    const x = labels[i - 1];
    const y = labels[i];
    if ((x === a && y === b) || (x === b && y === a)) n += 1;
  }
  return n;
}

/**
 * Re-join one voice that diarization split into two labels (typically at a chunk boundary or after
 * a call drop). Only used when more labels exist than Gemini ever heard at once in a single chunk
 * (e.g. 3 labels on a call where every chunk had 2 voices), and only for a pair of labels that
 * occupy different stretches of the call (one stops where the other starts, at most one line
 * interleaved) and answer each other at most once. Two people in a dialogue always answer each
 * other, so they are never merged.
 */
export function mergeSplitVoices(labels, segments, maxVoicesPerChunk) {
  const out = [...labels];
  for (;;) {
    const ids = [...new Set(out.filter(Boolean))];
    if (ids.length <= Math.max(1, maxVoicesPerChunk)) return out;
    const starts = (id) => segments.filter((_, i) => out[i] === id).map((s) => s.start);
    let best = null;
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const a = starts(ids[x]);
        const b = starts(ids[y]);
        const inside = (p, q) => p.filter((t) => t > Math.min(...q) && t < Math.max(...q)).length;
        if (inside(a, b) > 1 || inside(b, a) > 1 || replies(out, ids[x], ids[y]) > 1) continue;
        const gap = Math.abs(Math.min(...b) - Math.max(...a));
        if (!best || gap < best.gap) best = { keep: ids[x], drop: ids[y], gap };
      }
    }
    if (!best) return out;
    for (let i = 0; i < out.length; i++) if (out[i] === best.drop) out[i] = best.keep;
  }
}

/** Most distinct Gemini voices heard within any one chunk. */
export function maxVoicesPerChunk(segments, chunkStarts) {
  const per = new Map();
  for (const s of segments) {
    if (!s.speaker) continue;
    const k = Math.max(0, chunkStarts.findLastIndex((c) => c <= s.start + 0.01));
    if (!per.has(k)) per.set(k, new Set());
    per.get(k).add(s.speaker);
  }
  return Math.max(0, ...[...per.values()].map((v) => v.size));
}

/** Display labels: "Person 1", "Person 2", ... in order of first appearance (never "Speaker"). */
export function toPersons(labels) {
  const map = new Map();
  return labels.map((l) => {
    if (!l) return null;
    if (!map.has(l)) map.set(l, `Person ${map.size + 1}`);
    return map.get(l);
  });
}
