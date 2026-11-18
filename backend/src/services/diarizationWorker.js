// Worker thread that runs speaker diarization with sherpa-onnx.
//
// sherpa-onnx's process() is synchronous native code; in the main thread it would block the event
// loop (and every API request) for the whole computation, so it runs here instead.

import { existsSync } from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import * as config from "../config.js";
import { loadAudio } from "./audio.js";
import { round } from "../util.js";

const SEGMENTATION_MODEL = path.join(config.MODELS_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.int8.onnx");
const EMBEDDING_MODEL = path.join(config.MODELS_DIR, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx");

class DiarizationUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "DiarizationUnavailable";
  }
}

let sherpa = null;
const cache = new Map();

async function getDiarizer(numSpeakers) {
  if (!sherpa) {
    try {
      sherpa = (await import("sherpa-onnx-node")).default;
    } catch {
      throw new DiarizationUnavailable("sherpa-onnx is not installed");
    }
  }
  const missing = [SEGMENTATION_MODEL, EMBEDDING_MODEL].filter((p) => !existsSync(p)).map((p) => path.basename(p));
  if (missing.length) {
    throw new DiarizationUnavailable(`Diarization model files missing in ${config.MODELS_DIR}: ${missing.join(", ")}`);
  }
  const key = numSpeakers || -1;
  if (!cache.has(key)) {
    try {
      cache.set(
        key,
        new sherpa.OfflineSpeakerDiarization({
          segmentation: { pyannote: { model: SEGMENTATION_MODEL }, numThreads: config.DIARIZATION_THREADS },
          embedding: { model: EMBEDDING_MODEL, numThreads: config.DIARIZATION_THREADS },
          clustering: { numClusters: key, threshold: config.DIARIZATION_THRESHOLD },
          minDurationOn: 0.3,
          minDurationOff: 0.5,
        }),
      );
    } catch {
      throw new DiarizationUnavailable("Invalid diarization configuration");
    }
  }
  return cache.get(key);
}

/** Speaker turns for a file, labelled "Speaker N" in order of first appearance. */
async function diarizeFile(filePath, numSpeakers) {
  const audio = await loadAudio(filePath);
  const diarizer = await getDiarizer(numSpeakers);
  const turns = diarizer.process(audio).sort((a, b) => a.start - b.start);
  const labels = new Map();
  return turns.map((t) => {
    if (!labels.has(t.speaker)) labels.set(t.speaker, `Speaker ${labels.size + 1}`);
    return { start: round(t.start, 2), end: round(t.end, 2), speaker: labels.get(t.speaker) };
  });
}

parentPort.on("message", async ({ id, filePath, numSpeakers }) => {
  try {
    parentPort.postMessage({ id, turns: await diarizeFile(filePath, numSpeakers) });
  } catch (err) {
    parentPort.postMessage({ id, error: { name: err?.name ?? "Error", message: String(err?.message ?? err) } });
  }
});
