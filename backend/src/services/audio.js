// Audio decoding to 16 kHz mono float32, and WAV encoding.
//
// Decoding uses FFmpeg (ffmpeg-static) — the same libavcodec/libswresample stack the previous
// backend used through PyAV — so the decoded samples are identical.

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export const SAMPLE_RATE = 16000;

/** The file could not be decoded as audio. */
export class AudioDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "AudioDecodeError";
  }
}

/** Decode any supported file to 16 kHz mono float32 in [-1, 1]. */
export function loadAudio(filePath) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(
        ffmpegPath,
        ["-nostdin", "-hide_banner", "-v", "error", "-i", filePath, "-map", "0:a:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
        { windowsHide: true },
      );
    } catch (exc) {
      reject(new AudioDecodeError(`Could not open audio file: ${exc.message}`));
      return;
    }
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", (exc) => reject(new AudioDecodeError(`Could not open audio file: ${exc.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        if (/matches no streams|does not contain any stream/i.test(stderr)) {
          reject(new AudioDecodeError("Audio file contains no audio stream."));
        } else {
          reject(new AudioDecodeError(`Could not decode audio file: ${stderr.trim().split("\n").pop() || `ffmpeg exit ${code}`}`));
        }
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) {
        reject(new AudioDecodeError("Audio file contains no audio samples."));
        return;
      }
      // Copy into a fresh, 4-byte aligned buffer for the Float32Array view.
      const out = new Float32Array(Math.floor(buf.length / 4));
      Buffer.from(out.buffer).set(buf.subarray(0, out.length * 4));
      resolve(out);
    });
  });
}

/**
 * Compress 16 kHz mono float32 audio to Ogg/Opus (32 kbit/s, speech-tuned) for sending to Gemini.
 * A 5-minute chunk is ~1.2 MB instead of ~9.6 MB as WAV; the large WAV uploads made long recordings
 * slow and caused "fetch failed" errors on slower connections.
 */
export function encodeOpus(audio) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ["-nostdin", "-hide_banner", "-v", "error", "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
        "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"],
      { windowsHide: true },
    );
    const out = [];
    let stderr = "";
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`opus encoding failed: ${stderr.trim()}`))));
    proc.stdin.on("error", () => {}); // reported through "close"
    proc.stdin.end(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  });
}

/** Encode 16 kHz mono float32 audio as a 16-bit PCM WAV file. */
export function wavBytes(audio) {
  const n = audio.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, audio[i]));
    buf.writeInt16LE(Math.trunc(v * 32767), 44 + i * 2); // truncation, like numpy astype
  }
  return buf;
}
