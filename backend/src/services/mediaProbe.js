// Technical audio metadata, measured with ffprobe (never guessed).
//
// probe(file) runs ffprobe once per uploaded file (results are cached by stored name), with a
// timeout, a bounded output size, and no shell. Every value is validated; a value ffprobe does not
// report, or reports out of range, stays null. Three outcomes:
//   extracted   - ffprobe read the file and found an audio stream
//   failed      - ffprobe could not read the file as media, or it has no audio stream (the upload
//                 is rejected: the file is corrupted or not audio)
//   unavailable - ffprobe itself could not run (missing binary, timeout); the upload is kept and the
//                 metadata stays null, so an infrastructure problem never loses a user's recording.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { getLogger } from "../util.js";

const logger = getLogger("app.services.probe");

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CACHE_LIMIT = 500;

let ffprobePath;
/** FFPROBE_PATH, or the binary installed by @ffprobe-installer/ffprobe (CommonJS); null if neither. */
function binary() {
  if (ffprobePath !== undefined) return ffprobePath;
  try {
    ffprobePath = process.env.FFPROBE_PATH || createRequire(import.meta.url)("@ffprobe-installer/ffprobe").path;
  } catch {
    ffprobePath = null;
  }
  return ffprobePath;
}

/** Server-side media type, from the extension already verified by its file signature. */
const MIME = {
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
  amr: "audio/amr", "3gp": "audio/3gpp", ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", mp4: "audio/mp4",
};
const VIDEO_MIME = { mp4: "video/mp4", webm: "video/webm", "3gp": "video/3gpp" };

const num = (v, { min, max, int = false }) => {
  if (v === null || v === undefined || v === "" || v === "N/A") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
};
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Turn ffprobe's JSON into validated metadata. Exported for tests. */
export function parse(json, ext) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const audio = streams.find((s) => s?.codec_type === "audio");
  if (!json?.format || !audio) return { status: "failed", error: "The file contains no readable audio stream." };
  const hasVideo = streams.some((s) => s?.codec_type === "video" && s?.disposition?.attached_pic !== 1);
  const f = json.format;
  return {
    status: "extracted",
    error: null,
    container_format: text(f.format_name, 100),
    mime_type: (hasVideo && VIDEO_MIME[ext]) || MIME[ext] || null,
    audio_codec: text(audio.codec_name, 32),
    sample_rate_hz: num(audio.sample_rate, { min: 1000, max: 768000, int: true }),
    channels: num(audio.channels, { min: 1, max: 64, int: true }),
    bitrate_bps: num(f.bit_rate ?? audio.bit_rate, { min: 1, max: 100_000_000, int: true }),
    duration_seconds: num(f.duration ?? audio.duration, { min: 0, max: 7 * 24 * 3600 }),
  };
}

const EMPTY = { container_format: null, mime_type: null, audio_codec: null, sample_rate_hz: null, channels: null, bitrate_bps: null, duration_seconds: null };

const cache = new Map();

/** Cached metadata for a stored upload, if it was probed in this process. */
export const cached = (storedName) => cache.get(storedName) ?? null;

/** Measure a stored file. Never throws; see the outcomes at the top of this file. */
export function probe(filePath) {
  const storedName = path.basename(filePath);
  if (cache.has(storedName)) return Promise.resolve(cache.get(storedName));
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const bin = binary();
  if (!bin) return Promise.resolve(remember(storedName, { ...EMPTY, status: "unavailable", error: "ffprobe is not installed on the server." }));
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout) => {
        let meta;
        if (err && (err.killed || err.code === "ENOENT" || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
          // The tool could not do its job: keep the upload, record why (no paths, no output).
          meta = { ...EMPTY, status: "unavailable", error: err.killed ? "Metadata extraction timed out." : "Metadata extraction could not run." };
          logger.warning(`ffprobe unavailable for ${storedName}: ${err.killed ? "timeout" : err.code}`);
        } else if (err) {
          meta = { ...EMPTY, status: "failed", error: "The file could not be read as audio." };
        } else {
          try {
            meta = { ...EMPTY, ...parse(JSON.parse(stdout), ext) };
          } catch {
            meta = { ...EMPTY, status: "failed", error: "The file could not be read as audio." };
          }
        }
        resolve(remember(storedName, meta));
      },
    );
  });
}

function remember(storedName, value) {
  cache.set(storedName, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** Forget a file (it was rejected and deleted). */
export const forget = (storedName) => cache.delete(storedName);
