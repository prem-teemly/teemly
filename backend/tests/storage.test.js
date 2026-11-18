// OCI Object Storage tests (no database, no real cloud). The official OCI SDK talks to a local fake
// Object Storage server (tests/helpers/fake-oci.js); Gemini is replaced by a fake client.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startFakeOci } from "./helpers/fake-oci.js";

const fake = await startFakeOci();
Object.assign(process.env, fake.env(), { DB_ENABLED: "false", UPLOAD_RETENTION_HOURS: "0", OWNER_PHONE: "", OWNER_EMAIL: "" });

const config = await import("../src/config.js");
const oci = await import("../src/storage/oci.js");
const storage = await import("../src/storage/index.js");
const gemini = await import("../src/services/gemini.js");
const transcription = await import("../src/services/transcription.js");
const { createApp } = await import("../src/app.js");

const SR = transcription.SAMPLE_RATE;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = (name, data) => {
  const p = path.join(os.tmpdir(), `teemly-oci-${process.pid}-${name}`);
  writeFileSync(p, data);
  return p;
};
function speech(seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

// Minimal fake Gemini: transcript, analysis, Pulse and context answers.
const jsonResponse = (body) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] }, finishReason: "STOP" }], text: JSON.stringify(body) });
const fakeGemini = {
  models: {
    async generateContent({ config: cfg = {} }) {
      const props = Object.keys(cfg.responseJsonSchema?.properties ?? {});
      if (props.includes("segments")) {
        return jsonResponse({ languages: ["ta", "en"], unclear: null, segments: [
          { start: "00:00", end: "00:02", speaker: "Speaker 1", text: "Vanakkam, demo pathi pesalaam", english: "Hello, let's talk about the demo.", emotion: "friendly" },
          { start: "00:02", end: "00:04", speaker: "Speaker 2", text: "Sari, naalaikku anuppuren", english: "Okay, I will send it tomorrow.", emotion: "neutral" },
        ] });
      }
      if (props.includes("signals")) return jsonResponse({ overall_interest: "medium", overview: "Some interest.", signals: [], recommended_actions: [] });
      if (props.includes("key_moments")) {
        return jsonResponse({ main_topic: "A demo.", overview: "They plan a demo.", speaker_names: [], sections: [], key_moments: [{ line_id: 1, text: "I will send it tomorrow.", tag: "commitment" }] });
      }
      if (props.includes("summary")) {
        return jsonResponse({ purpose: null, summary: "Demo planned.", key_context: [], topics: [], important_points: [], problems_discussed: [], decisions: [],
          action_items: [], follow_ups: [], final_summary: "Demo planned.", key_takeaways: [], transcript_quality_note: null });
      }
      return jsonResponse({});
    },
    async generateContentStream(req) {
      const text = (await this.generateContent(req)).text;
      return (async function* () {
        yield { text };
      })();
    },
  },
};

let server;
let base;
const localUploads = [];
before(async () => {
  gemini.setClientForTests(fakeGemini);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  gemini.setClientForTests(null);
  for (const f of localUploads) await unlink(path.join(config.UPLOAD_DIR, f)).catch(() => {});
  await fake.close();
  await unlink(fake.keyPath).catch(() => {});
});

const upload = async (name, data) => {
  const form = new FormData();
  form.append("file", new Blob([data]), name);
  const r = await fetch(`${base}/api/audio/upload`, { method: "POST", body: form });
  const body = await r.json();
  if (body.filename) localUploads.push(body.filename);
  return { status: r.status, body };
};
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function poll(id) {
  for (let i = 0; i < 400; i++) {
    const j = await (await fetch(`${base}/api/analysis/${id}`)).json();
    if (j.status === "completed" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}

test("OCI: settings are read from the environment; connectivity and private bucket are checked", async () => {
  assert.deepEqual(oci.missingSettings(), []);
  assert.deepEqual(oci.missingSettings({ ...config.OCI, bucket: "", fingerprint: "" }), ["OCI_BUCKET", "OCI_FINGERPRINT"]);
  assert.deepEqual(oci.missingSettings({ auth: "instance_principal", namespace: "n", bucket: "b", region: "ap-mumbai-1" }), []);
  const c = await oci.checkConnection();
  assert.deepEqual(c, { namespace_matches: true, bucket: fake.bucket, public_access: "NoPublicAccess", private: true });
  assert.match(storage.describe(), /OCI Object Storage \(bucket teemly-audio-test, auth api_key\)/);
  assert.doesNotMatch(storage.describe(), /ocid1|PRIVATE|\.pem/i, "no secrets in the startup line");
});

test("OCI: upload is verified (MD5 + SHA-256 + size); repeated request is idempotent; a different object is never overwritten", async () => {
  const data = Buffer.from("audio-bytes-".repeat(5000));
  const file = tmp("a.bin", data);
  const name = oci.objectNameFor("0123456789abcdef0123456789abcdef.wav");
  assert.match(name, /^audio\/\d{4}\/\d{2}\/0123456789abcdef0123456789abcdef\.wav$/);
  const up = await oci.uploadFile(file, name, { sha256: sha(data), contentType: "audio/wav" });
  assert.equal(up.existed, false);
  assert.equal(up.path, `oci://${fake.namespace}/${fake.bucket}/${name}`);
  const stored = fake.objects.get(name);
  assert.ok(stored.body.equals(data));
  assert.equal(stored.meta.sha256, sha(data));
  assert.equal(stored.contentType, "audio/wav");

  const again = await oci.uploadFile(file, name, { sha256: sha(data) }); // duplicate request
  assert.equal(again.existed, true);

  const other = tmp("b.bin", Buffer.from("different"));
  await assert.rejects(() => oci.uploadFile(other, name), /different object with this name already exists/);
  assert.ok(fake.objects.get(name).body.equals(data), "original object untouched");

  await assert.rejects(() => oci.uploadFile(file, oci.objectNameFor("x.wav"), { sha256: "0".repeat(64) }), /does not match its recorded SHA-256/);
});

test("OCI: damaged transfers and temporary errors are retried; permanent errors are not", async () => {
  const data = Buffer.from("retry-me-".repeat(3000));
  const file = tmp("c.bin", data);
  fake.corruptNextUpload(1); // bytes damaged in transit once -> OCI rejects by Content-MD5 -> sent again
  assert.equal((await oci.uploadFile(file, "audio/retry/corrupt-once.wav")).existed, false);
  assert.ok(fake.objects.get("audio/retry/corrupt-once.wav").body.equals(data));

  fake.fail("put", 503, 2); // service unavailable twice, then fine
  await oci.uploadFile(file, "audio/retry/503-twice.wav");
  assert.ok(fake.objects.has("audio/retry/503-twice.wav"));

  fake.fail("put", 503, 10); // never recovers within OCI_MAX_ATTEMPTS
  await assert.rejects(() => oci.uploadFile(file, "audio/retry/503-always.wav"), (e) => e instanceof oci.StorageError && e.status === 503);
  fake.clearFailures();
  assert.equal(fake.objects.has("audio/retry/503-always.wav"), false);

  const before403 = fake.calls.length;
  fake.fail("put", 403, 1, "NotAuthorizedOrNotFound");
  await assert.rejects(() => oci.uploadFile(file, "audio/retry/403.wav"), /access denied/);
  assert.equal(fake.calls.filter((c, i) => i >= before403 && c.op === "put").length, 1, "403 is not retried");
  fake.clearFailures();
});

test("OCI: downloads are SHA-256-verified; a damaged object never reaches the processing folder", async () => {
  const data = Buffer.from("download-check-".repeat(4000));
  const file = tmp("d.bin", data);
  const up = await oci.uploadFile(file, "audio/dl/ok.wav");
  const dest = path.join(os.tmpdir(), `teemly-oci-dl-${process.pid}.wav`);
  fake.fail("get", 500, 1); // retried
  const got = await oci.downloadFile("audio/dl/ok.wav", dest, { sha256: up.sha256 });
  assert.equal(got.sha256, sha(data));
  assert.ok(readFileSync(dest).equals(data));
  await unlink(dest);

  fake.objects.get("audio/dl/ok.wav").body = Buffer.from("tampered"); // bucket content changed behind our back
  await assert.rejects(() => oci.downloadFile("audio/dl/ok.wav", dest, { sha256: up.sha256 }), /does not match its recorded SHA-256/);
  assert.equal(existsSync(dest), false);
  assert.equal(readdirSync(os.tmpdir()).some((f) => f.startsWith(path.basename(dest) + ".part")), false, "no partial file left");
  await assert.rejects(() => oci.downloadFile("audio/dl/missing.wav", dest), /not found/);
});

test("API with STORAGE_PROVIDER=oci: upload -> OCI -> verified -> analysis (re-downloaded if needed) -> PDF", async () => {
  const wav = transcription.wavBytes(speech(4));
  const up = await upload("meeting.wav", wav);
  assert.equal(up.status, 201);
  const objectName = oci.objectNameFor(up.body.filename);
  const obj = fake.objects.get(objectName);
  assert.ok(obj, "original stored in OCI");
  assert.ok(obj.body.equals(wav), "byte-identical");
  assert.equal(obj.meta.sha256, sha(wav));
  assert.equal(obj.contentType, "audio/wav");
  assert.equal("storage_path" in up.body.metadata, false, "storage details are not exposed to the frontend");

  // The local working copy is gone (e.g. another server, or cleaned up): it is fetched from OCI.
  await unlink(path.join(config.UPLOAD_DIR, up.body.filename));
  const gets = fake.calls.filter((c) => c.op === "get").length;
  const job = await (await post("/api/analysis", { filename: up.body.filename })).json();
  assert.equal(fake.calls.filter((c) => c.op === "get").length, gets + 1, "downloaded once from OCI");
  assert.ok(readFileSync(path.join(config.UPLOAD_DIR, up.body.filename)).equals(wav));
  const done = await poll(job.job_id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.result.tamil_segments.length, 2);
  assert.equal(done.result.analysis.available, true);

  const pdf = await post("/api/export/pdf", { job_id: job.job_id, title: "OCI check" });
  if (pdf.status === 200) assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  else assert.equal(pdf.status, 503, "PDF export needs Edge/Chrome; anything else is a failure");
});

test("API: OCI unavailable at upload -> the recording is kept locally and still analysed; cloud fetch failure is a clear 503", async () => {
  fake.fail("put", 503, 10);
  const wav = transcription.wavBytes(speech(3));
  const up = await upload("offline.wav", wav);
  fake.clearFailures();
  assert.equal(up.status, 201, "the user's upload is not lost because of a cloud problem");
  assert.equal(fake.objects.has(oci.objectNameFor(up.body.filename)), false);
  const job = await (await post("/api/analysis", { filename: up.body.filename })).json();
  assert.equal((await poll(job.job_id)).status, "completed");

  // In OCI but the bucket is unreachable when the local copy is missing.
  const up2 = await upload("remote.wav", transcription.wavBytes(speech(2)));
  await unlink(path.join(config.UPLOAD_DIR, up2.body.filename));
  fake.fail("get", 503, 10);
  const r = await post("/api/analysis", { filename: up2.body.filename });
  fake.clearFailures();
  assert.equal(r.status, 503);
  assert.match((await r.json()).message, /could not be retrieved right now/);
});

test("local storage stays exactly as before (STORAGE_PROVIDER=local): no OCI calls", async () => {
  config.STORAGE.provider = "local";
  try {
    const calls = fake.calls.length;
    const up = await upload("local.wav", transcription.wavBytes(speech(2)));
    assert.equal(up.status, 201);
    assert.ok(existsSync(path.join(config.UPLOAD_DIR, up.body.filename)));
    const job = await (await post("/api/analysis", { filename: up.body.filename })).json();
    assert.equal((await poll(job.job_id)).status, "completed");
    assert.equal(fake.calls.length, calls, "no OCI request at all");
    assert.equal(storage.describe(), "Audio storage: local (backend/uploads)");
    assert.deepEqual(await storage.storeUpload("x", "y.wav", {}), { provider: "local", path: "uploads/y.wav", error: null });
  } finally {
    config.STORAGE.provider = "oci";
  }
});
