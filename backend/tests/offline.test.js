// Offline tests: no Google Cloud credentials or network needed (port of the previous test_offline.py).
//
// Gemini is replaced by a fake client so response parsing and the job pipeline can be checked end to
// end. These tests do NOT prove model quality or IAM access — use GET /api/ai/status and
// tests/live-check.js for that once ADC is configured.
//
// Run from backend/:  npm test

import "./helpers/no-login.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

import * as config from "../src/config.js";
import { createApp } from "../src/app.js";
import * as gemini from "../src/services/gemini.js";
import * as transcription from "../src/services/transcription.js";
import * as diarization from "../src/services/diarization.js";
import * as pulse from "../src/services/pulse.js";
import * as pipeline from "../src/services/pipeline.js";

// These tests never touch MySQL (database tests are in tests/db.test.js, on a separate test database).
process.env.DB_ENABLED = "false";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SR = transcription.SAMPLE_RATE;

// ------------------------------------------------------------------------------ fakes

const DEFAULT_PULSE = {
  overall_interest: "high",
  overview: "The speaker showed clear interest.",
  signals: [
    { category: "product_interest", person: "Speaker 1", subject: "Teemly product", level: "high", basis: "explicit",
      context: "Asked to discuss the budget.", evidence_ids: [0], quote: "budget பத்தி பேசலாம்" },
    { category: "purchase_intent", person: "Speaker 1", subject: "Licence", level: "high", basis: "explicit",
      context: "Invented.", evidence_ids: [99], quote: "I will buy" },
    { category: "follow_up_interest", person: "Speaker 2", subject: "Invoice", level: "high", basis: "inferred",
      context: "Will send the invoice.", evidence_ids: [1], quote: "words that were never said" },
  ],
  recommended_actions: [
    { action: "Send the invoice", reason: "Promised", evidence_ids: [1] },
    { action: "Unsupported action", reason: "None", evidence_ids: [] },
  ],
};
let pulseBody = DEFAULT_PULSE;

const response = (parts) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  get text() {
    return parts.map((p) => p.text ?? "").join("");
  },
});
const jsonResponse = (body) => response([{ text: JSON.stringify(body) }]);

class FakeModels {
  /** Streams the same answer as generateContent, in small pieces. */
  async generateContentStream(req) {
    const full = (await this.generateContent(req)).text;
    const pieces = full.match(/[\s\S]{1,40}/g) ?? [""];
    return (async function* () {
      for (const piece of pieces) yield { text: piece };
    })();
  }

  constructor({ transcribeFails = false } = {}) {
    this.transcribeFails = transcribeFails;
    this.calls = [];
  }
  async generateContent({ model, contents, config: cfg = {} }) {
    this.calls.push(model);
    if (cfg.audioTranscriptionConfig) {
      if (this.transcribeFails) {
        const { ApiError } = await import("@google/genai");
        throw new ApiError({ status: 400, message: JSON.stringify({ error: { code: 400, message: "Unsupported language", status: "INVALID_ARGUMENT" } }) });
      }
      return response([
        { text: "வணக்கம், இன்னைக்கு budget பத்தி பேசலாம்.",
          audioTranscription: { text: "வணக்கம், இன்னைக்கு budget பத்தி பேசலாம்.", speakerLabel: "A", languageCode: "ta-IN", startOffset: "0.5s", endOffset: "3.2s" } },
        { text: "Okay, I will send the invoice by Friday.",
          audioTranscription: { text: "Okay, I will send the invoice by Friday.", speakerLabel: "B", languageCode: "en-IN", startOffset: "3.6s", endOffset: "6.0s" } },
      ]);
    }
    const props = Object.keys(cfg.responseJsonSchema?.properties ?? {});
    if (props.includes("segments")) {
      return jsonResponse({ languages: ["ta", "en"], unclear: null, segments: [
        { start: "00:01", end: "00:03", speaker: "Speaker 1", text: "நாளைக்கு client meeting இருக்கு", english: "There is a client meeting tomorrow.", emotion: "friendly" },
        { start: "00:04", end: "00:06", speaker: "Speaker 2", text: "Sari, naan ready pannuren", english: "Okay, I will get it ready.", emotion: "neutral" },
      ] });
    }
    if (props.includes("lines")) {
      const prompt = typeof contents === "string" ? contents : "";
      const ids = prompt.split("\n").filter((l) => /^\d+\t/.test(l)).map((l) => parseInt(l, 10));
      return jsonResponse({ lines: ids.map((i) => ({ id: i, english: `EN line ${i}` })) });
    }
    if (props.includes("translation")) return jsonResponse({ detected_language: "ta-en", translation: "There is a client meeting tomorrow." });
    if (props.includes("signals")) return jsonResponse(pulseBody);
    if (props.includes("key_moments")) {
      return jsonResponse({
        main_topic: "Speaker 1 plans a client meeting with Person 2.",
        overview: "The speaker says there is a client meeting tomorrow; Person 2 will get it ready.",
        // Not proven by the transcript (the name is never said): must be rejected.
        speaker_names: [{ label: "Person 1", name: "Divya", how: "self_introduction", evidence_ids: [0], same_as_label: null }],
        sections: [{ title: "Meeting prep", summary: "Person 1 mentions the meeting; Person 2 agrees.", start_id: 0, end_id: 1 }],
        key_moments: [{ line_id: 1, text: "I'll get it ready.", tag: "commitment" }],
      });
    }
    if (props.includes("summary")) {
      return jsonResponse({
        purpose: "Budget review", summary: "The team discussed the budget.", key_context: [], topics: ["Budget"],
        important_points: ["Budget approved"], problems_discussed: [],
        decisions: [{ decision: "Budget approved", made_by: null, evidence: "Budget approve aagiduchu" }],
        action_items: [{ task: "Send invoice", responsible_person: "Divya", date: null, time: null, deadline: "Friday",
          speaker: null, evidence: "invoice by Friday", uncertain: null }],
        follow_ups: ["Confirm demo date"], final_summary: "Budget approved; invoice due Friday.",
        key_takeaways: ["Budget approved"], transcript_quality_note: null,
      });
    }
    return response([{ text: "ok" }]);
  }
}

function withFake(opts) {
  const fake = { models: new FakeModels(opts) };
  gemini.setClientForTests(fake);
  return fake;
}
const noClient = () => gemini.setClientForTests(null);

function speech(seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}
const concat = (...xs) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) (out.set(x, o), (o += x.length));
  return out;
};

/** Temporarily override config.settings entries. */
async function withSettings(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, config.settings[k]]));
  Object.assign(config.settings, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(config.settings, saved);
  }
}

/** Simulate a machine without Application Default Credentials, whatever this machine has. */
async function withoutCredentials(fn) {
  const saved = gemini.adc.load;
  gemini.adc.load = async () => {
    throw new gemini.GeminiUnavailable(
      "Google Cloud credentials were not found. Run `gcloud auth application-default login` " +
        "(local development) or set GOOGLE_APPLICATION_CREDENTIALS / attach the " +
        "gemini-app-backend service account, then restart the backend.",
    );
  };
  noClient();
  try {
    return await fn();
  } finally {
    gemini.adc.load = saved;
    noClient();
  }
}

// ------------------------------------------------------------------------- HTTP client

let server;
let base;
before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const upload = (p, name, data) => {
  const form = new FormData();
  form.append("file", new Blob([data]), name);
  return fetch(base + p, { method: "POST", body: form });
};
async function poll(url) {
  for (let i = 0; i < 1200; i++) {
    const body = await (await fetch(base + url)).json(); // "status" here is the job status
    if (body.status !== "queued" && body.status !== "processing") return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}
const removeUpload = (name) => unlink(path.join(config.UPLOAD_DIR, name)).catch(() => {});

// ------------------------------------------------------------------------------ tests

test("load_audio decodes real uploaded files to their full length", async (t) => {
  const dir = path.join(config.BACKEND_DIR, "..", "backend", "uploads");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith(".txt")).sort().slice(0, 3) : [];
  if (!files.length) return t.skip("no real recordings available");
  for (const f of files) {
    const p = path.join(dir, f);
    const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", p], { encoding: "utf8" }).stderr;
    const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe);
    const expected = +h * 3600 + +m * 60 + +s;
    const got = (await transcription.loadAudio(p)).length / SR;
    assert.ok(Math.abs(got - expected) < 1.0, `${f}: ${got} vs ${expected}`);
    t.diagnostic(`${f}: decoded ${got.toFixed(1)}s (container ${expected.toFixed(1)}s)`);
  }
});

test("chunks and wav encoding", () => {
  const cs = config.settings.TRANSCRIBE_CHUNK_SECONDS;
  assert.deepEqual(transcription.chunks(speech(cs * 2.5)).map(([o]) => Math.round(o)), [0, cs, cs * 2]);
  const wav = transcription.wavBytes(speech(1));
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.length, 44 + 32000);
});

test("transcribe: gemini-3.5-transcribe response parsing", async () => {
  withFake();
  try {
    const r = await withSettings({ GEMINI_TRANSCRIBE_MODEL: "gemini-3.5-transcribe" }, () =>
      transcription.transcribeAudio("x.wav", speech(8)),
    );
    assert.equal(r.model, "gemini-3.5-transcribe");
    assert.deepEqual(r.tamil_segments.map((s) => [s.start, s.end, s.speaker]), [[0.5, 3.2, "Speaker 1"], [3.6, 6.0, "Speaker 2"]]);
    assert.equal(r.english_segments[1].text, "EN line 1");
    assert.deepEqual(new Set(r.languages), new Set(["ta-IN", "en-IN"]));
  } finally {
    noClient();
  }
});

test("transcribe: falls back to the text model when the ASR model fails", async () => {
  const fake = withFake({ transcribeFails: true });
  try {
    const r = await withSettings({ GEMINI_TRANSCRIBE_MODEL: "gemini-3.5-transcribe" }, () =>
      transcription.transcribeAudio("x.wav", concat(speech(400), speech(10))),
    );
    assert.equal(r.model, config.settings.GEMINI_TEXT_MODEL);
    const asrCalls = fake.models.calls.filter((m) => m === "gemini-3.5-transcribe").length;
    assert.ok(asrCalls >= 1 && asrCalls <= config.settings.GEMINI_CONCURRENCY);
    assert.equal(r.tamil_segments[2].start, config.settings.TRANSCRIBE_CHUNK_SECONDS + 1); // offset by chunk start
  } finally {
    noClient();
  }
});

test("transcribe: Flash path uses the configured transcribe model and keeps chunk order", async () => {
  const fake = withFake();
  try {
    const r = await withSettings({ GEMINI_TRANSCRIBE_MODEL: "audio-model-x", GEMINI_TEXT_MODEL: "text-model-y" }, () =>
      transcription.transcribeAudio("x.wav", concat(speech(310), speech(10))),
    );
    assert.equal(r.model, "audio-model-x");
    assert.equal(fake.models.calls.filter((m) => m === "audio-model-x").length, 2); // 2 chunks
    const starts = r.tamil_segments.map((s) => s.start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  } finally {
    noClient();
  }
});

test("assign speakers: Gemini turns mapped onto diarization identities", () => {
  const seg = (start, end, speaker) => transcription.segment(start, end, "x", { speaker });
  const turns = [
    { start: 0, end: 4, speaker: "Speaker 1" }, { start: 4, end: 20, speaker: "Speaker 2" },
    { start: 300, end: 310, speaker: "Speaker 2" }, { start: 310, end: 320, speaker: "Speaker 1" },
  ];
  const segs = [seg(0, 4, "Speaker 1"), seg(4, 8, "Speaker 2"), seg(8, 11, "Speaker 1"), seg(11, 20, "Speaker 2"),
    seg(300, 310, "Speaker 1"), seg(310, 320, "Speaker 2")];
  assert.deepEqual(diarization.assignSpeakers(segs, turns, 300),
    ["Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2", "Speaker 2", "Speaker 1"]);
  const [a, b, c, e] = diarization.assignSpeakers(segs.slice(0, 4), [{ start: 0, end: 20, speaker: "Speaker 1" }], 300);
  assert.ok(a === c && b === e && a !== b);
  assert.deepEqual(diarization.assignSpeakers(segs.slice(0, 2), [], 300), ["Speaker 1", "Speaker 2"]);
});

const pulseLines = () =>
  pulse.linesFromSegments(
    [{ start: 0.5, end: 3.2, speaker: "Speaker 1", text: "வணக்கம், இன்னைக்கு budget பத்தி பேசலாம்." },
     { start: 3.6, end: 6.0, speaker: "Speaker 2", text: "Okay, I will send the invoice by Friday." }],
    [{ text: "Hello, let's discuss the budget today." }, { text: "Okay, I will send the invoice by Friday." }],
  );

test("Pulse evidence validation", async () => {
  withFake();
  try {
    const r = await pulse.analyze(pulseLines());
    assert.deepEqual(r.signals.map((s) => s.category), ["product_interest", "follow_up_interest"]); // id 99 dropped
    const [first, second] = r.signals;
    assert.ok(first.quote_verified);
    assert.equal(first.quote, "budget பத்தி பேசலாம்");
    assert.ok(first.evidence[0].original.startsWith("வணக்கம்"));
    assert.equal(first.evidence[0].start, 0.5);
    assert.equal(first.evidence[0].english, "Hello, let's discuss the budget today.");
    assert.equal(second.level, "medium", "inferred signals may not be high");
    assert.equal(second.quote, null);
    assert.equal(second.quote_verified, false);
    assert.deepEqual(r.recommended_actions.map((a) => a.action), ["Send the invoice"]);
    assert.equal(r.dropped_unsupported, 2);
  } finally {
    noClient();
  }
});

test("Pulse: nothing supported means 'Not enough evidence'", async () => {
  pulseBody = { ...DEFAULT_PULSE, signals: [DEFAULT_PULSE.signals[1]], recommended_actions: [] };
  withFake();
  try {
    const r = await pulse.analyze(pulseLines());
    assert.deepEqual(r.signals, []);
    assert.equal(r.overall_interest, "not_enough_evidence");
    assert.equal(r.overview, "Not enough evidence");
  } finally {
    pulseBody = DEFAULT_PULSE;
    noClient();
  }
});

test("API: clear errors without credentials", async () => {
  await withoutCredentials(async () => {
    const r = await post("/api/ai/translate", { text: "நாளைக்கு meeting" });
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.ok(body.message.toLowerCase().includes("credentials"), body.message);
    const s = await (await fetch(base + "/api/ai/status")).json();
    assert.equal(s.status, "error");
    assert.equal(s.credentials.ok, false);
  });
});

test("API: translate and summarize (fake Gemini)", async () => {
  withFake();
  try {
    const t = await (await post("/api/ai/translate", { text: "நாளைக்கு client meeting இருக்கு" })).json();
    const s = await (await post("/api/ai/summarize", { text: "Prem: budget ok", kind: "meeting" })).json();
    assert.equal(t.translation, "There is a client meeting tomorrow.");
    assert.equal(s.analysis.action_items[0].deadline, "Friday");
    assert.ok(s.analysis.follow_ups.length);
  } finally {
    noClient();
  }
});

test("API: WhatsApp chat upload is removed (a chat file is not accepted anywhere)", async () => {
  const chat = Buffer.from("12/03/2024, 10:15 - Prem: hello\n");
  // Only GET /api/whatsapp/:job_id (reading an older chat) is left, so a POST there is 405.
  assert.ok([404, 405].includes((await upload("/api/whatsapp/upload", "chat.txt", chat)).status));
  assert.ok([404, 405].includes((await post("/api/whatsapp/process", { filename: "0".repeat(32) + ".txt" })).status));
  assert.equal((await upload("/api/audio/upload", "chat.txt", chat)).status, 415); // not an audio format
  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal("max_chat_mb" in settings.upload, false);
});

test("API: audio job end to end (fake Gemini, real diarization worker)", async () => {
  withFake();
  let stored;
  try {
    const up = await (await upload("/api/audio/upload", "call.wav", transcription.wavBytes(speech(8)))).json();
    stored = up.filename;
    const job = await (await post("/api/analysis", { filename: stored })).json();
    const done = await poll(`/api/analysis/${job.job_id}`);
    assert.equal(done.error, null);
    const res = done.result;
    assert.ok(res.analysis.available);
    assert.ok(res.pulse.available && res.pulse.data.signals.length);
    assert.ok(res.tamil_segments[0].speaker);
    assert.equal(res.english_segments[0].text, "There is a client meeting tomorrow."); // translated in the same call
    assert.deepEqual(Object.keys(res.tamil_segments[0]), ["start", "end", "text", "warning", "speaker", "emotion"]);
    assert.equal(res.emotions.available, true);
    // People are "Person 1", "Person 2" (no proven name); the word "speaker" appears in no value at all.
    assert.deepEqual([...new Set(res.tamil_segments.map((s) => s.speaker))], ["Person 1", "Person 2"]);
    assert.equal(res.context.available, true);
    assert.equal(res.context.data.speaker_names.length, 0); // "Divya" was never said
    assert.equal(res.context.data.main_topic, "Person 1 plans a client meeting with Person 2.");
    assert.deepEqual(res.context.data.key_moments.map((m) => [m.speaker, m.text, m.tag]), [["Person 2", "I'll get it ready.", "commitment"]]);
    const values = [];
    (function walk(v) {
      if (typeof v === "string") values.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    })(res);
    assert.deepEqual(values.filter((v) => /speaker/i.test(v)), []);
    // The PDF is built from the same result: no "Speaker" there either.
    const { buildReportHtml } = await import("../src/services/exportPdf.js");
    const html = buildReportHtml({ kind: "audio", result: res }, "Call");
    assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), /speaker/i);
    assert.match(html, /What was discussed/);
  } finally {
    noClient();
    if (stored) await removeUpload(stored);
  }
});

test("API: a short job is not blocked by a long running job (JOB_CONCURRENCY)", async () => {
  assert.ok(config.JOB_CONCURRENCY >= 2);
  // The first transcription call blocks until released, simulating a long recording.
  let release;
  const gate = new Promise((r) => (release = r));
  const fake = withFake();
  const original = fake.models.generateContent.bind(fake.models);
  let first = true;
  fake.models.generateContent = async (req) => {
    if (first && Object.keys(req.config?.responseJsonSchema?.properties ?? {}).includes("segments")) {
      first = false;
      await gate;
    }
    return original(req);
  };
  const stored = [];
  try {
    const start = async (seconds) => {
      const up = await (await upload("/api/audio/upload", "call.wav", transcription.wavBytes(speech(seconds)))).json();
      stored.push(up.filename);
      return (await (await post("/api/analysis", { filename: up.filename })).json()).job_id;
    };
    const longJob = await start(8);
    await new Promise((r) => setTimeout(r, 300)); // let the long job reach transcription
    const shortJob = await start(4);
    const shortDone = await poll(`/api/analysis/${shortJob}`);
    assert.equal(shortDone.status, "completed");
    const longNow = await (await fetch(`${base}/api/analysis/${longJob}`)).json();
    assert.equal(longNow.status, "processing", "the long job is still running while the short one finished");
    release();
    assert.equal((await poll(`/api/analysis/${longJob}`)).status, "completed");
  } finally {
    release();
    noClient();
    for (const f of stored) await removeUpload(f);
  }
});

test("API: audio job fails clearly without credentials", async () => {
  const up = await (await upload("/api/audio/upload", "call.wav", transcription.wavBytes(speech(3)))).json();
  try {
    await withoutCredentials(async () => {
      const job = await (await post("/api/analysis", { filename: up.filename })).json();
      const done = await poll(`/api/analysis/${job.job_id}`);
      assert.equal(done.status, "failed");
      assert.ok((done.error ?? "").toLowerCase().includes("credentials"), done.error);
    });
  } finally {
    await removeUpload(up.filename);
  }
});

test("API: upload accepts real phone-format audio with measured metadata; rejects corrupt content", async () => {
  // Real recordings, encoded with the bundled ffmpeg: accepted, with ffprobe metadata in the response.
  const wav = path.join(FIXTURES, "..", "..", "uploads", `probe-src-${process.pid}.wav`);
  const { writeFile, readFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(wav), { recursive: true });
  await writeFile(wav, transcription.wavBytes(speech(3)));
  try {
    for (const [name, args, codec] of [
      ["a.ogg", ["-c:a", "libopus", "-b:a", "32k"], "opus"],
      ["a.m4a", ["-c:a", "aac", "-b:a", "48k"], "aac"],
      ["a.mp3", ["-c:a", "libmp3lame", "-b:a", "64k"], "mp3"],
    ]) {
      const out = wav.replace(/\.wav$/, path.extname(name));
      const enc = spawnSync(ffmpegPath, ["-v", "error", "-y", "-i", wav, ...args, out]);
      assert.equal(enc.status, 0, `${name}: ${enc.stderr}`);
      const r = await upload("/api/audio/upload", name, await readFile(out));
      await unlink(out).catch(() => {});
      assert.equal(r.status, 201, name);
      const body = await r.json();
      assert.equal(body.metadata.codec, codec, name);
      assert.equal(body.metadata.sample_rate_hz > 0 && body.metadata.channels, 1, name);
      assert.ok(Math.abs(body.metadata.duration_seconds - 3) < 0.2, `${name} duration ${body.metadata.duration_seconds}`);
      assert.equal(body.metadata.metadata_status, "extracted");
      assert.equal(body.metadata.original_filename, name);
      assert.equal("storage_path" in body.metadata || "sha256" in body.metadata, false); // nothing internal exposed
      await removeUpload(body.filename);
    }
  } finally {
    await unlink(wav).catch(() => {});
  }
  // A correct signature with corrupt content is rejected (and not kept on disk); a wrong signature is 415.
  const before = readdirSync(config.UPLOAD_DIR).length;
  const corrupt = await upload("/api/audio/upload", "a.ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20)]));
  assert.equal(corrupt.status, 422);
  assert.match((await corrupt.json()).message, /could not be read as audio/);
  assert.equal(readdirSync(config.UPLOAD_DIR).length, before);
  assert.equal((await upload("/api/audio/upload", "a.amr", Buffer.from("RIFFxxxx"))).status, 415);
});

test("Gemini client retries a request that times out (stalled-request protection)", async () => {
  const { GoogleGenAI } = await import("@google/genai");
  let calls = 0;
  const fetchStub = (url, init) => {
    calls += 1;
    if (calls === 1) {
      // First attempt stalls until the per-attempt timeout aborts it.
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }
    const body = JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] });
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  };
  const client = new GoogleGenAI({ apiKey: "test-only-not-used", httpOptions: { fetch: fetchStub } });
  const r = await client.models.generateContent({
    model: "m",
    contents: "hi",
    config: { httpOptions: { timeout: 200, retryOptions: { attempts: 4, initialDelay: 0.05, maxDelay: 0.1 }, fetch: fetchStub } },
  });
  assert.equal(r.text, "ok");
  assert.equal(calls, 2);
});

test("security: headers on every response", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
});

test("security: oversized JSON body is rejected (413)", async () => {
  const r = await fetch(base + "/api/ai/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(config.MAX_JSON_BYTES + 10) }),
  });
  assert.equal(r.status, 413);
});

test("security: retention is off by default and never deletes a file a job is using", async () => {
  const { purgeOldUploads } = await import("../src/security.js");
  const { utimes, writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  assert.equal(config.UPLOAD_RETENTION_HOURS, 0);
  // A throwaway folder: the sweep must never run over the real uploads folder in a test.
  const dir = await mkdtemp(path.join(os.tmpdir(), "teemly-retention-"));
  const name = "0".repeat(32) + ".txt";
  const old = path.join(dir, name);
  await writeFile(old, "old");
  const past = new Date(Date.now() - 48 * 3600_000);
  await utimes(old, past, past);

  assert.equal(await purgeOldUploads(undefined, undefined, dir), 0); // default: keep forever
  assert.equal(existsSync(old), true);

  // Opt-in retention keeps files that a queued/processing job still reads.
  const job = pipeline.submit(name, path.join(config.UPLOAD_DIR, "missing-" + name), null);
  const inUse = pipeline.filesInUse(); // the job is queued right after submit
  assert.equal(inUse.has(name), true);
  assert.equal(await purgeOldUploads(24, inUse, dir), 0);
  assert.equal(existsSync(old), true);

  while (job.status === "queued" || job.status === "processing") await new Promise((r) => setTimeout(r, 20));
  assert.equal(pipeline.filesInUse().has(name), false);
  assert.equal(await purgeOldUploads(24, undefined, dir), 1);
  assert.equal(existsSync(old), false);
  await rm(dir, { recursive: true, force: true });
});

test("audio metadata: job carries measured metadata; tampered file is refused; ffprobe output is validated", async () => {
  const mediaProbe = await import("../src/services/mediaProbe.js");
  // Validation: out-of-range or missing values stay null, nothing is invented.
  const parsed = mediaProbe.parse(
    { format: { format_name: "wav", bit_rate: "N/A", duration: "-5" }, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "16000", channels: 99 }] },
    "wav",
  );
  assert.deepEqual(parsed, { status: "extracted", error: null, container_format: "wav", mime_type: "audio/wav", audio_codec: "pcm_s16le", sample_rate_hz: 16000, channels: null, bitrate_bps: null, duration_seconds: null });
  assert.equal(mediaProbe.parse({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video" }] }, "mp4").status, "failed");
  assert.equal(mediaProbe.parse({ format: {}, streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio" }] }, "mp4").mime_type, "video/mp4");

  withFake();
  const { appendFile } = await import("node:fs/promises");
  const stored = [];
  try {
    const up = await (await upload("/api/audio/upload", "meeting.wav", transcription.wavBytes(speech(4)))).json();
    stored.push(up.filename);
    assert.equal(up.metadata.duration_seconds, 4);
    assert.equal(up.metadata.sample_rate_hz, SR);
    assert.ok(Date.now() - Date.parse(up.metadata.uploaded_at) < 60_000);
    const job = await (await post("/api/analysis", { filename: up.filename })).json();
    assert.deepEqual(job.audio, up.metadata); // the job shows the same measured metadata
    const done = await poll(`/api/analysis/${job.job_id}`);
    assert.deepEqual(done.audio, up.metadata);

    // A file changed after upload no longer matches its checksum: the job is refused.
    const up2 = await (await upload("/api/audio/upload", "b.wav", transcription.wavBytes(speech(2)))).json();
    stored.push(up2.filename);
    await appendFile(path.join(config.UPLOAD_DIR, up2.filename), Buffer.alloc(10));
    const r = await post("/api/analysis", { filename: up2.filename });
    assert.equal(r.status, 409);
    assert.match((await r.json()).message, /checksum mismatch/);
  } finally {
    noClient();
    for (const f of stored) await removeUpload(f);
  }
});


// Last: uses up this client's request quota.
test("security: POST requests are rate limited per client (429), GET polling is not", async () => {
  let status = 0;
  for (let i = 0; i <= config.RATE_LIMIT_PER_MINUTE + 1 && status !== 429; i++) {
    status = (await post("/api/ai/translate", {})).status;
  }
  assert.equal(status, 429);
  assert.equal((await fetch(base + "/health")).status, 200);
});

test("transcribe: English comes with the transcript (no separate translation call)", async () => {
  const fake = withFake();
  try {
    const r = await transcription.transcribeAudio("x.wav", speech(8));
    assert.deepEqual(r.english_segments.map((s) => s.text), ["There is a client meeting tomorrow.", "Okay, I will get it ready."]);
    assert.equal(fake.models.calls.length, 1, "one Gemini call for transcript + translation");
  } finally {
    noClient();
  }
});

test("Gemini: a slow request is hedged and the first answer wins", async () => {
  let calls = 0;
  const slowThenFast = {
    models: {
      async generateContent({ config: cfg }) {
        calls += 1;
        if (calls === 1) {
          // First attempt never answers until cancelled by the winner.
          await new Promise((_, reject) => cfg.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        return jsonResponse({ detected_language: "ta", translation: "hedged answer" });
      },
    },
  };
  gemini.setClientForTests(slowThenFast);
  try {
    const t0 = Date.now();
    const r = await gemini.generateJson("x", transcription.TextTranslation, { hedgeSeconds: 0.2 });
    assert.equal(r.translation, "hedged answer");
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    noClient();
  }
});

test("Gemini: an unreadable answer is retried once", async () => {
  let calls = 0;
  gemini.setClientForTests({
    models: {
      async generateContent() {
        calls += 1;
        return calls === 1 ? response([{ text: "{not json" }]) : jsonResponse({ detected_language: "ta", translation: "ok" });
      },
    },
  });
  try {
    assert.equal((await gemini.generateJson("x", transcription.TextTranslation)).translation, "ok");
    assert.equal(calls, 2);
  } finally {
    noClient();
  }
});

test("streaming: complete segments are extracted while the JSON is still being written", () => {
  const full = JSON.stringify({ segments: [{ text: "a {b}", n: 1 }, { text: 'say "hi"', n: 2 }], languages: ["ta"] });
  const parser = new transcription.SegmentStream();
  const seen = [];
  for (let i = 1; i <= full.length; i++) seen.push(...parser.feed(full.slice(0, i)));
  assert.deepEqual(seen.map((x) => x.n), [1, 2]);
  assert.equal(seen[1].text, 'say "hi"');
});

test("streaming: transcript lines are published before the job finishes", async () => {
  withFake();
  const partials = [];
  try {
    const r = await transcription.transcribeAudio("x.wav", speech(8), null, (p) => partials.push(p.segments.length));
    assert.ok(partials.length >= 2, `partial updates: ${partials}`);
    assert.equal(partials[0], 1, "first line published on its own");
    assert.equal(r.tamil_segments[0].emotion, "friendly");
    assert.equal(r.english_segments[0].emotion, "friendly");
  } finally {
    noClient();
  }
});

test("emotions: overview by share, speaker and timeline", async () => {
  const { summarize } = await import("../src/services/emotions.js");
  const seg = (start, end, speaker, emotion) => ({ start, end, speaker, emotion, text: "x" });
  const e = summarize([
    seg(0, 10, "Speaker 1", "friendly"), seg(10, 12, "Speaker 2", "neutral"),
    seg(12, 20, "Speaker 2", "concerned"), seg(21, 25, "Speaker 2", "concerned"), seg(25, 30, "Speaker 1", "friendly"),
  ]);
  assert.equal(e.available, true);
  assert.deepEqual(e.overall.map((o) => [o.emotion, o.seconds]), [["friendly", 15], ["concerned", 12], ["neutral", 2]]);
  assert.deepEqual(e.timeline.map((m) => [m.emotion, m.start, m.end]), [["friendly", 0, 10], ["concerned", 12, 25], ["friendly", 25, 30]]);
  assert.equal(e.by_speaker["Speaker 1"][0].emotion, "friendly");
  assert.equal(summarize([seg(0, 1, "S", null)]).available, false);
});

test("export: report HTML escapes all content", async () => {
  const { buildReportHtml } = await import("../src/services/exportPdf.js");
  const job = { kind: "audio", result: {
    audio_duration_seconds: 10, language: "ta", speakers: { count: 1 },
    tamil_segments: [{ start: 0, end: 2, speaker: "Speaker 1", text: "<script>alert(1)</script>", emotion: "friendly" }],
    english_segments: [{ text: "hello" }],
    emotions: { available: false, reason: "n/a" }, analysis: { available: false, reason: "n/a" }, pulse: { available: false, reason: "n/a" },
  } };
  const html = buildReportHtml(job, '<img src=x onerror="x">');
  assert.ok(!html.includes("<script>alert"), "transcript text is escaped");
  assert.ok(!html.includes("<img src=x"), "title is escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Teemly"));
});

test("Gemini: a temporary failure (e.g. broken connection) is retried; a permission error is not", async () => {
  const { ApiError } = await import("@google/genai");
  let calls = 0;
  gemini.setClientForTests({
    models: {
      async generateContent() {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse({ detected_language: "ta", translation: "ok" });
      },
    },
  });
  try {
    assert.equal((await gemini.generateJson("x", transcription.TextTranslation)).translation, "ok");
    assert.equal(calls, 2);
    calls = 0;
    gemini.setClientForTests({
      models: {
        async generateContent() {
          calls += 1;
          throw new ApiError({ status: 403, message: JSON.stringify({ error: { code: 403, message: "denied" } }) });
        },
      },
    });
    await assert.rejects(() => gemini.generateJson("x", transcription.TextTranslation), /Permission denied/);
    assert.equal(calls, 1, "permission errors are not retried");
  } finally {
    noClient();
  }
});

test("context: speaker names only when the conversation proves them; sections use real times", async () => {
  const context = await import("../src/services/context.js");
  const lines = [
    { id: 0, speaker: "Person 1", start: 0, end: 3, time_label: "00:00", original: "Hi Prem, eppadi irukeenga?", english: "Hi Prem, how are you?" },
    { id: 1, speaker: "Person 2", start: 3, end: 6, time_label: "00:03", original: "Nalla irukken Krishna.", english: "I'm fine, Krishna." },
    { id: 2, speaker: "Person 2", start: 6, end: 20, time_label: "00:06", original: "Teemly 10 units vaanganum.", english: "I want to buy 10 units of Teemly." },
  ];
  const names = context.validateNames(
    [
      { label: "Person 2", name: "Prem", how: "addressed_by_name", evidence_ids: [0] },
      { label: "Person 1", name: "Krishna", how: "addressed_by_name", evidence_ids: [1] },
      { label: "Person 1", name: "Ravi", how: "self_introduction", evidence_ids: [0] }, // not in the line
      { label: "Person 3", name: "Arun", how: "self_introduction", evidence_ids: [2] }, // no such speaker
    ],
    lines,
  );
  // Krishna and Ravi conflict on Person 1 only if both were accepted; Ravi is rejected (not said).
  assert.deepEqual(names.map((n) => [n.label, n.name]), [["Person 2", "Prem"], ["Person 1", "Krishna"]]);
  // A speaker cannot be "addressed" by their own line.
  assert.equal(context.validateNames([{ label: "Person 1", name: "Prem", how: "addressed_by_name", evidence_ids: [0] }], lines).length, 0);

  const sections = context.validateSections(
    [{ title: "Purchase", summary: "Person 2 wants 10 units.", start_id: 1, end_id: 2 }, { title: "Greeting", summary: "x", start_id: 0, end_id: 1 }, { title: "Bad", summary: "", start_id: 7, end_id: 9 }],
    lines,
  );
  assert.deepEqual(sections.map((s) => [s.title, s.first, s.last]), [["Greeting", 0, 1], ["Purchase", 2, 2]]); // overlap trimmed

  const map = new Map(names.map((n) => [n.label, n.name]));
  const segments = lines.map((l) => ({ start: l.start, end: l.end, text: l.original, speaker: map.get(l.speaker) }));
  const data = context.buildData({ main_topic: "Person 2 buys Teemly.", names, sections }, segments, map);
  assert.equal(data.main_topic, "Prem buys Teemly.");
  assert.deepEqual(data.sections[1], { title: "Purchase", summary: "Prem wants 10 units.", start: 6, end: 20, time_label: "0:06–0:20", first_line: 2, last_line: 2, speakers: ["Prem"] });
  // Spoken words and quotes are never rewritten; labels in model text are.
  const renamed = context.renameDeep({ person: "Person 2", context: "Person 2 wants it", quote: "Person 2", evidence: [{ speaker: "Person 1", original: "Person 1" }] }, map);
  assert.deepEqual(renamed, { person: "Prem", context: "Prem wants it", quote: "Person 2", evidence: [{ speaker: "Krishna", original: "Person 1" }] });
});

test("pulse by person + short PDF: what each person is interested in, no long sections", async () => {
  const { pulseByPerson } = await import("../src/services/pulseWave.js");
  const { buildReportHtml } = await import("../src/services/exportPdf.js");
  const ev = (id, start, speaker) => ({ id, speaker, start, end: start + 2, time_label: "", original: "x", english: null });
  const pulseData = {
    overall_interest: "high", overview: "Both are interested.", recommended_actions: [], dropped_unsupported: 0,
    signals: [
      { category: "purchase_intent", person: "Prem", subject: "Teemly", level: "high", basis: "explicit", context: "Prem wants to buy 10 units of Teemly.", quote: null, quote_verified: false, evidence: [ev(2, 6, "Prem")] },
      { category: "product_interest", person: "Krishna", subject: "Teemly", level: "medium", basis: "explicit", context: "Krishna is interested in Teemly.", quote: null, quote_verified: false, evidence: [ev(0, 0, "Krishna")] },
      { category: "question_concern", person: "Prem", subject: "price", level: "low", basis: "explicit", context: "Prem asked about the price.", quote: null, quote_verified: false, evidence: [ev(1, 3, "Prem")] },
    ],
  };
  const wave = pulseByPerson(pulseData, { speakers: ["Krishna", "Prem"], duration: 20 });
  assert.deepEqual(wave.people.map((p) => [p.person, p.interest, p.interests]), [["Krishna", "Medium interest", ["Teemly"]], ["Prem", "High interest", ["Teemly"]]]);
  assert.deepEqual(wave.beats.map((b) => [b.n, b.person, b.amp > 0]), [[1, "Krishna", true], [2, "Prem", false], [3, "Prem", true]]);

  const segs = [
    { start: 0, end: 3, text: "Hi Prem", speaker: "Krishna", emotion: "neutral" },
    { start: 3, end: 20, text: "Teemly 10 units", speaker: "Prem", emotion: "interested" },
  ];
  const result = {
    audio_duration_seconds: 20, language: "Tamil", tamil_segments: segs, english_segments: segs.map((s) => ({ ...s, text: "Hello" })),
    speakers: { available: true, count: 2, turns: [] },
    context: { available: true, data: { main_topic: "Prem buys Teemly <b>", speaker_names: [], sections: [{ title: "Purchase", summary: "Prem wants 10 units.", start: 3, end: 20, time_label: "0:03–0:20", speakers: ["Prem"] }] } },
    emotions: { available: false, reason: "n/a" }, analysis: { available: false, reason: "n/a" },
    pulse: { available: true, data: pulseData },
  };
  const html = buildReportHtml({ kind: "audio", result }, "Call");
  assert.match(html, /What this conversation is about:<\/strong> Prem buys Teemly &lt;b&gt;/); // escaped
  assert.match(html, /<b>Interested in:<\/b> Teemly/);
  assert.match(html, /Prem wants to buy 10 units of Teemly\./);
  assert.match(html, /<b>Concerns:<\/b> Prem asked about the price\./);
  assert.doesNotMatch(html, /<svg|Emotions|Conversation context/);
  // Without key moments (older calls) the transcript is the context.
  assert.match(html, /<strong>Krishna:<\/strong> Hi Prem/);
});

test("key moments: real lines only, time/speaker/original from the transcript, shown first in the PDF", async () => {
  const context = await import("../src/services/context.js");
  const { buildReportHtml } = await import("../src/services/exportPdf.js");
  const lines = [
    { id: 0, speaker: "Person 1", start: 42, end: 48, time_label: "00:42", original: "TD meet panna ok.", english: "TD is open to meet." },
    { id: 1, speaker: "Person 2", start: 1195, end: 1199, time_label: "19:55", original: "Friday kulla slots anuppuren.", english: "I'll send slots by Friday." },
  ];
  const moments = context.validateMoments(
    [
      { line_id: 1, text: "I'll send TD's free slots by Friday.", tag: "commitment" },
      { line_id: 0, text: "Person 1: TD is open to meet.", tag: "none" },
      { line_id: 0, text: "duplicate", tag: "hedging" },
      { line_id: 99, text: "not a line", tag: "interest" },
    ],
    lines,
  );
  assert.deepEqual(moments, [{ line: 0, text: "Person 1: TD is open to meet.", tag: null }, { line: 1, text: "I'll send TD's free slots by Friday.", tag: "commitment" }]);
  const names = new Map([["Person 1", "Naveen"]]);
  const segs = lines.map((l) => ({ start: l.start, end: l.end, text: l.original, speaker: names.get(l.speaker) ?? l.speaker }));
  const data = context.buildData({ main_topic: "x", names: [], sections: [], moments }, segs, names);
  assert.deepEqual(data.key_moments[1], { line: 1, start: 1195, end: 1199, speaker: "Person 2", text: "I'll send TD's free slots by Friday.", original: "Friday kulla slots anuppuren.", tag: "commitment" });
  assert.equal(data.key_moments[0].text, "Naveen: TD is open to meet.");

  const result = {
    audio_duration_seconds: 1200, language: "Tamil", tamil_segments: segs, english_segments: segs,
    speakers: { available: true }, context: { available: true, data }, emotions: { available: false }, analysis: { available: false }, pulse: { available: false },
  };
  const html = buildReportHtml({ kind: "audio", result }, "Call");
  assert.match(html, /Showing 2 key moments · 2 lines/);
  assert.match(html, /19:55<\/td><td class="nowrap km-who">Person 2/);
  assert.match(html, /km-hl km-commitment">I&#39;ll send TD&#39;s free slots by Friday\./);
  assert.doesNotMatch(html, />Transcript</); // key moments replace the full transcript
  // "Person 1 (Prem)" in model text becomes "Prem", not "Prem (Prem)".
  assert.equal(context.renameDeep("Person 1 (Naveen) agreed.", names), "Naveen agreed.");
});

test("speaker names: one voice split into two labels is merged only when the labels never overlap", async () => {
  const context = await import("../src/services/context.js");
  // Person 1 = Naveen before 5:00, Person 20 = Naveen after 5:00 (diarization split); Person 3 = Deepan throughout.
  const L = (id, speaker, start, original, english = null) => ({ id, speaker, start, end: start + 5, time_label: "", original, english });
  const lines = [
    L(0, "Person 1", 0, "Deck ready-aa?"), L(1, "Person 3", 10, "Ready, appendix add pannuren."),
    L(2, "Person 1", 200, "Pricing paarunga."), L(3, "Person 3", 250, "Sari."),
    L(4, "Person 3", 365, "Hello Naveen, kekkudha?", "Hello Naveen, can you hear me?"), L(5, "Person 20", 370, "Kekkudhu Deepan.", "I can hear you, Deepan."),
    L(6, "Person 3", 400, "USD-la maathidren."), L(7, "Person 20", 450, "Ok."),
  ];
  const raw = [
    { label: "Person 3", name: "Deepan", how: "addressed_by_name", evidence_ids: [5], same_as_label: null },
    { label: "Person 20", name: "Naveen", how: "addressed_by_name", evidence_ids: [4], same_as_label: null },
    { label: "Person 1", name: "Naveen", how: "same_voice", evidence_ids: [], same_as_label: "Person 20" },
  ];
  assert.deepEqual(context.validateNames(raw, lines).map((n) => [n.label, n.name, n.how]), [
    ["Person 3", "Deepan", "addressed_by_name"], ["Person 20", "Naveen", "addressed_by_name"], ["Person 1", "Naveen", "same_voice"],
  ]);
  // Never merge two people who talk to each other (Person 1 and Person 3 alternate).
  const wrong = [raw[0], raw[1], { label: "Person 1", name: "Deepan", how: "same_voice", evidence_ids: [], same_as_label: "Person 3" }];
  assert.equal(context.validateNames(wrong, lines).some((n) => n.label === "Person 1"), false);
  // A same_voice claim without a proven name to join is ignored.
  assert.equal(context.validateNames([raw[2]], lines).length, 0);
});

test("people: split voices re-joined, Person numbering, names, no 'speaker' wording, chunk cuts at quiet points", async () => {
  const context = await import("../src/services/context.js");
  // Diarization split one voice (A before 5:00, C after) on a call where every chunk had 2 voices.
  const seg = (start, speaker) => ({ start, end: start + 4, speaker, text: "x" });
  const segs = [seg(0, "A"), seg(5, "B"), seg(10, "A"), seg(15, "B"), seg(310, "C"), seg(315, "B"), seg(320, "C"), seg(325, "B")];
  const labels = segs.map((s) => s.speaker);
  assert.equal(diarization.maxVoicesPerChunk(segs, [0, 300]), 2);
  assert.deepEqual(diarization.mergeSplitVoices(labels, segs, 2), ["A", "B", "A", "B", "A", "B", "A", "B"]);
  // Two people who answer each other are never merged, even if the voice count says so.
  assert.deepEqual(diarization.mergeSplitVoices(["A", "B", "A", "B"], segs.slice(0, 4), 1), ["A", "B", "A", "B"]);
  // A real third person (talks with both) stays separate.
  const three = ["A", "B", "C", "A", "C", "B", "C", "A"];
  assert.deepEqual(diarization.mergeSplitVoices(three, segs, 2), three);
  assert.deepEqual(diarization.toPersons(["X", "Y", null, "X", "Z"]), ["Person 1", "Person 2", null, "Person 1", "Person 3"]);

  // Display names: proven names, others renumbered from Person 1.
  const people = [{ speaker: "Person 1" }, { speaker: "Person 2" }, { speaker: "Person 3" }];
  const names = context.displayNames(people, [{ label: "Person 2", name: "Naveen" }]);
  assert.deepEqual([...names], [["Person 1", "Person 1"], ["Person 2", "Naveen"], ["Person 3", "Person 2"]]);
  assert.equal(context.renameDeep("Person 3 asked Person 2; Speaker 2 agreed. The speaker left.", names), "Person 2 asked Naveen; Naveen agreed. The person left.");
  assert.equal(context.renameDeep({ quote: "Speaker 2 said" }, names).quote, "Speaker 2 said"); // spoken words untouched

  // Context size follows the length of the call.
  assert.match(context.sizeGuide(90).text, /^Short call/);
  assert.match(context.sizeGuide(10 * 60).text, /^Medium call/);
  assert.match(context.sizeGuide(40 * 60).text, /^Very long call.*one section per 4-5 minutes/);
  assert.equal(context.sizeGuide(40 * 60).moments, 40);

  // Chunks are cut in a pause near the 5-minute mark, not in the middle of a word.
  const cs = config.settings.TRANSCRIBE_CHUNK_SECONDS;
  const audio = speech(cs + 60);
  audio.fill(0, Math.round((cs - 4) * SR), Math.round((cs - 3) * SR)); // a 1 s pause 4 s before the mark
  const [first, second] = transcription.chunks(audio);
  assert.ok(second[0] > cs - 4 && second[0] < cs - 3, `cut at ${second[0]}`);
  assert.equal(first[1].length + second[1].length, audio.length); // nothing lost or duplicated
});

test("client address: read from the right past trusted proxies; a client cannot fake it; load-balancer ranges can be trusted", async () => {
  const { clientAddress, isTrustedProxy } = await import("../src/http.js");
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  // Straight from the internet: the socket peer, whatever the header says.
  assert.equal(clientAddress(req("203.0.113.9", "1.2.3.4")), "203.0.113.9");
  // Through this machine's proxy (Next.js / Nginx): the address it saw, not the client's own claim.
  assert.equal(clientAddress(req("127.0.0.1", "1.2.3.4, 198.51.100.7")), "198.51.100.7", "a faked first entry is ignored");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", "198.51.100.7")), "198.51.100.7");
  assert.equal(clientAddress(req("127.0.0.1")), "127.0.0.1", "no header: the proxy itself");
  // Behind a load balancer whose subnet is trusted: past it to the real client.
  assert.equal(isTrustedProxy("10.0.3.17", ["10.0.0.0/16"]), true);
  assert.equal(isTrustedProxy("10.1.3.17", ["10.0.0.0/16"]), false);
  assert.equal(isTrustedProxy("172.31.5.5", ["172.31.5.5"]), true);
  assert.equal(isTrustedProxy("8.8.8.8", ["0.0.0.0/0"]), true, "a /0 range trusts everything (do not use it)");
  assert.equal(isTrustedProxy("8.8.8.8", ["bad/99"]), false, "a broken entry trusts nothing");
  const before = [...config.TRUSTED_PROXIES];
  config.TRUSTED_PROXIES.splice(0, Infinity, "10.0.0.0/16");
  try {
    assert.equal(clientAddress(req("10.0.1.5", "1.2.3.4, 198.51.100.7, 127.0.0.1")), "198.51.100.7");
  } finally {
    config.TRUSTED_PROXIES.splice(0, Infinity, ...before);
  }
});

test("production defaults: the app runs in the owner's time zone; API docs only when switched on", () => {
  assert.equal(process.env.TZ, config.APP_TIMEZONE);
  assert.ok(config.APP_TIMEZONE.length > 0);
  assert.equal(typeof config.API_DOCS, "boolean");
});

