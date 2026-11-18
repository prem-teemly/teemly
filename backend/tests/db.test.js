// MySQL integration tests. They run against a separate database (teemly_db_test by default), never
// against teemly_db, and rebuild its schema from the migrations on every run.
//
// Run from backend/:  npm run test:db
// Needs the users from db/setup/create_users.template.sql and the DB_* settings in backend/.env.

import "./helpers/no-login.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as config from "../src/config.js";

process.env.DB_NAME = "teemly_db_test";
process.env.DB_ENABLED = "true";
process.env.UPLOAD_RETENTION_HOURS = "0";

const { createApp } = await import("../src/app.js");
const gemini = await import("../src/services/gemini.js");
const transcription = await import("../src/services/transcription.js");
const pipeline = await import("../src/services/pipeline.js");
const db = await import("../src/db/pool.js");
const repo = await import("../src/db/repository.js");
const { migrate, listMigrations, splitStatements } = await import("../src/db/migrate.js");

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SR = transcription.SAMPLE_RATE;
const TABLES = [
  "audio_files", "audio_uploads", "processing_jobs", "transcripts", "transcript_segments", "speakers", "translations",
  "summaries", "decisions", "action_items", "follow_ups", "emotion_analysis", "pulse_insights", "exports", "audit_logs",
  "sessions", "otp_challenges", "users", "person_notes", "opportunities", "person_suggestions", "person_mentions", "people",
  "department_suggestions", "departments", "opportunity_stage_changes", "opportunity_insights", "notification_facts", "notifications", "app_settings",
];

// ------------------------------------------------------------------------- fake Gemini

const jsonResponse = (body) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] }, finishReason: "STOP" }], text: JSON.stringify(body) });
const TAMIL = "நாளைக்கு client meeting இருக்கு 🙂";
const fake = {
  models: {
    async generateContent({ contents, config: cfg = {} }) {
      const props = Object.keys(cfg.responseJsonSchema?.properties ?? {});
      if (props.includes("segments")) {
        return jsonResponse({ languages: ["ta", "en"], unclear: null, segments: [
          { start: "00:01", end: "00:03", speaker: "Speaker 1", text: TAMIL, english: "There is a client meeting tomorrow.", emotion: "friendly" },
          { start: "00:04", end: "00:06", speaker: "Speaker 2", text: "Pricing konjam adhigam", english: "The pricing is a bit high.", emotion: "concerned" },
        ] });
      }
      if (props.includes("lines")) {
        const ids = (typeof contents === "string" ? contents : "").split("\n").filter((l) => /^\d+\t/.test(l)).map((l) => parseInt(l, 10));
        return jsonResponse({ lines: ids.map((i) => ({ id: i, english: `EN line ${i}` })) });
      }
      if (props.includes("signals")) {
        return jsonResponse({ overall_interest: "high", overview: "Clear interest.", recommended_actions: [{ action: "Send pricing", reason: "Asked", evidence_ids: [1] }],
          signals: [{ category: "question_concern", person: "Speaker 2", subject: "Pricing", level: "medium", basis: "explicit", context: "Pricing concern.", evidence_ids: [1], quote: "Pricing konjam adhigam" }] });
      }
      if (props.includes("summary")) {
        return jsonResponse({ purpose: "Budget review", summary: "Discussed pricing.", key_context: ["ctx"], topics: ["Pricing"], important_points: ["High price"],
          problems_discussed: ["Price"], decisions: [{ decision: "Meet tomorrow", made_by: "Speaker 1", evidence: "naalaikku" }],
          action_items: [{ task: "Send invoice", responsible_person: "Divya", date: "tomorrow", time: null, deadline: "by Friday", speaker: "Speaker 1", evidence: "invoice", uncertain: null }],
          follow_ups: ["Confirm demo"], final_summary: "Pricing discussed.", key_takeaways: ["Price is high"], transcript_quality_note: null });
      }
      if (props.includes("people")) return jsonResponse({ people: [] });
      return jsonResponse({});
    },
    async generateContentStream(req) {
      const text = (await this.generateContent(req)).text;
      return (async function* () {
        for (const piece of text.match(/[\s\S]{1,50}/g)) yield { text: piece };
      })();
    },
  },
};

// ---------------------------------------------------------------------------- helpers

let server;
let base;
const uploaded = [];

async function resetTestSchema() {
  const conn = await db.migrationConnection();
  try {
    const [[{ name }]] = await conn.query("SELECT DATABASE() AS name");
    // Verified on the live connection before anything is written: stop unless this is teemly_db_test.
    if (name !== "teemly_db_test") throw new Error(`refusing to run: connected to ${name}, not teemly_db_test`);
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [...TABLES, "schema_migrations"]) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
}

function speech(seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function upload(p, name, data) {
  const form = new FormData();
  form.append("file", new Blob([data]), name);
  const r = await fetch(base + p, { method: "POST", body: form });
  const body = await r.json();
  if (body.filename) uploaded.push(body.filename);
  return { status: r.status, body };
}
async function poll(url) {
  for (let i = 0; i < 600; i++) {
    const body = await (await fetch(base + url)).json();
    if (body.status !== "queued" && body.status !== "processing") return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}
const q = async (sql, params = []) => (await db.getPool().query(sql, params))[0];

before(async () => {
  await resetTestSchema();
  gemini.setClientForTests(fake);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  gemini.setClientForTests(null);
  for (const f of uploaded) await unlink(path.join(config.UPLOAD_DIR, f)).catch(() => {});
  await db.closePool();
});

// ------------------------------------------------------------------------------ tests

test("connection: app user connects to the test database", async () => {
  const st = await db.status();
  assert.equal(st.connected, true, st.error);
  assert.equal(st.database, process.env.DB_NAME);
  assert.match(st.server_version, /^8\.0\./);
  assert.notEqual(st.user, "root", "the application must not use root");
  const [[grants]] = await db.getPool().query("SELECT CURRENT_USER() AS u");
  assert.match(grants.u, /^teemly_app@/);
});

test("migrations: create every table with utf8mb4, foreign keys and indexes; re-run is a no-op", async () => {
  const first = await migrate({ log: () => {} });
  assert.deepEqual(first.pending, []);
  const tables = (await q("SELECT TABLE_NAME AS t, TABLE_COLLATION AS c, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")).map((r) => r);
  for (const t of TABLES) {
    const row = tables.find((x) => x.t === t);
    assert.ok(row, `table ${t} exists`);
    assert.equal(row.c, "utf8mb4_0900_ai_ci", `${t} collation`);
    assert.equal(row.e, "InnoDB");
  }
  const [{ n: fks }] = await q("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()");
  assert.ok(fks >= 14, `foreign keys: ${fks}`);
  const uniques = (await q("SELECT DISTINCT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME")).map((r) => r.i);
  assert.deepEqual(uniques, [
    "uq_action_items_summary_seq", "uq_audio_files_stored_name", "uq_decisions_summary_seq", "uq_department_suggestions_job_name", "uq_departments_name", "uq_departments_slug", "uq_emotion_analysis_job",
    "uq_follow_ups_summary_seq", "uq_notifications_dedupe", "uq_people_phone", "uq_person_mentions_person_job", "uq_person_suggestions_job_name", "uq_pulse_job_type_seq", "uq_segments_transcript_seq", "uq_sessions_token_hash", "uq_speakers_transcript_label",
    "uq_summaries_job", "uq_transcripts_job", "uq_translations_segment_language", "uq_users_email", "uq_users_phone_hash",
  ]);
  const second = await migrate({ log: () => {} });
  assert.deepEqual(second.pending, []);
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM schema_migrations");
  assert.equal(n, listMigrations().length);
});

test("migrations: an edited migration is detected (checksum) and nothing runs", async () => {
  const conn = await db.migrationConnection();
  try {
    const [[orig]] = await conn.query("SELECT checksum FROM schema_migrations WHERE version = 1");
    await conn.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1", ["0".repeat(64)]);
    await assert.rejects(() => migrate({ log: () => {} }), /checksum mismatch/);
    await conn.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1", [orig.checksum]);
  } finally {
    await conn.end();
  }
});

let audioJobId;
let audioResult;

test("insert + retrieve: upload, job and all results are stored (Tamil text and emoji intact)", async () => {
  const up = await upload("/api/audio/upload", "call.wav", transcription.wavBytes(speech(8)));
  assert.equal(up.status, 201);
  const [file] = await q("SELECT * FROM audio_files WHERE stored_name = ?", [up.body.filename]);
  assert.equal(file.original_name, "call.wav");
  assert.equal(file.kind, "audio");
  assert.equal(file.size_bytes, up.body.file_size);
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  const [upl] = await q("SELECT * FROM audio_uploads WHERE audio_file_id = ?", [file.id]);
  assert.equal(upl.status, "accepted");
  assert.notEqual(upl.client_hash, "127.0.0.1", "no raw client address");

  const job = await (await post("/api/analysis", { filename: up.body.filename })).json();
  const done = await poll(`/api/analysis/${job.job_id}`);
  assert.equal(done.status, "completed", done.error);
  await pipeline.persisted(job.job_id);
  audioJobId = job.job_id;
  audioResult = done.result;

  const [j] = await q("SELECT * FROM processing_jobs WHERE id = ?", [audioJobId]);
  assert.equal(j.status, "completed");
  assert.equal(j.audio_file_id, file.id);
  assert.ok(j.started_at && j.finished_at);
  const segs = await q(
    "SELECT s.seq, s.text, s.emotion, sp.label, t.text AS english FROM transcript_segments s JOIN transcripts tr ON tr.id = s.transcript_id LEFT JOIN speakers sp ON sp.id = s.speaker_id LEFT JOIN translations t ON t.segment_id = s.id WHERE tr.job_id = ? ORDER BY s.seq",
    [audioJobId],
  );
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, TAMIL, "Tamil + emoji stored exactly (utf8mb4)");
  assert.equal(segs[0].english, "There is a client meeting tomorrow.");
  assert.equal(segs[1].emotion, "concerned");
  assert.deepEqual(segs.map((s) => s.label), ["Person 1", "Person 2"]);
  const counts = await q(
    `SELECT (SELECT COUNT(*) FROM decisions d JOIN summaries s ON s.id = d.summary_id WHERE s.job_id = ?) AS decisions,
            (SELECT COUNT(*) FROM action_items a JOIN summaries s ON s.id = a.summary_id WHERE s.job_id = ?) AS actions,
            (SELECT COUNT(*) FROM follow_ups f JOIN summaries s ON s.id = f.summary_id WHERE s.job_id = ?) AS follow_ups,
            (SELECT COUNT(*) FROM emotion_analysis WHERE job_id = ?) AS emotions,
            (SELECT COUNT(*) FROM pulse_insights WHERE job_id = ?) AS pulse`,
    [audioJobId, audioJobId, audioJobId, audioJobId, audioJobId],
  );
  assert.deepEqual({ ...counts[0] }, { decisions: 1, actions: 1, follow_ups: 1, emotions: 1, pulse: 3 });
});

test("persistence: after a restart (memory cleared) the API returns the same job from MySQL", async () => {
  pipeline.forgetAllJobsForTests(); // what a backend restart does to in-memory jobs
  assert.equal(pipeline.get(audioJobId), null);
  const r = await (await fetch(`${base}/api/analysis/${audioJobId}`)).json();
  assert.equal(r.status, "completed");
  assert.deepEqual(r.result, audioResult, "rebuilt result is identical to the original response");
});

test("persistence: export works after a restart and is recorded", async () => {
  const r = await post("/api/export/pdf", { job_id: audioJobId, title: "Restart check" });
  assert.equal(r.status, 200);
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const [e] = await q("SELECT * FROM exports WHERE job_id = ?", [audioJobId]);
  assert.equal(e.title, "Restart check");
  assert.equal(e.size_bytes, pdf.length);
});

test("update: job progress and action item status", async () => {
  const [a] = await q("SELECT a.id FROM action_items a JOIN summaries s ON s.id = a.summary_id WHERE s.job_id = ?", [audioJobId]);
  await db.getPool().execute("UPDATE action_items SET status = 'done' WHERE id = ?", [a.id]);
  const [after] = await q("SELECT status, updated_at, created_at FROM action_items WHERE id = ?", [a.id]);
  assert.equal(after.status, "done");
  assert.ok(after.updated_at >= after.created_at);
  await repo.updateJobProgress({ id: audioJobId, status: "completed", stage: "done", progress: 1, startedAt: null });
  const [j] = await q("SELECT stage, progress FROM processing_jobs WHERE id = ?", [audioJobId]);
  assert.equal(j.stage, "done");
  assert.equal(Number(j.progress), 1);
});

test("foreign keys: orphan rows are refused, referenced files cannot be deleted, results cascade", async () => {
  await assert.rejects(
    () => db.getPool().execute("INSERT INTO processing_jobs (id, audio_file_id, kind) VALUES (?, ?, 'audio')", ["f".repeat(32), 999999999]),
    (e) => /^ER_NO_REFERENCED_ROW(_2)?$/.test(e.code),
  );
  const [j] = await q("SELECT audio_file_id FROM processing_jobs WHERE id = ?", [audioJobId]);
  await assert.rejects(() => db.getPool().execute("DELETE FROM audio_files WHERE id = ?", [j.audio_file_id]), (e) => /^ER_ROW_IS_REFERENCED(_2)?$/.test(e.code));
  await assert.rejects(
    () => db.getPool().execute("INSERT INTO translations (segment_id, language, text) VALUES (?, 'en', 'x')", [999999999]),
    (e) => /^ER_NO_REFERENCED_ROW(_2)?$/.test(e.code),
  );
  // Deleting a job (test database only) removes all of its results through ON DELETE CASCADE.
  const temp = await upload("/api/audio/upload", "tmp.wav", transcription.wavBytes(speech(4)));
  const job = await (await post("/api/analysis", { filename: temp.body.filename })).json();
  await poll(`/api/analysis/${job.job_id}`);
  await pipeline.persisted(job.job_id);
  await db.getPool().execute("DELETE FROM processing_jobs WHERE id = ?", [job.job_id]);
  const [{ n }] = await q("SELECT (SELECT COUNT(*) FROM transcripts WHERE job_id = ?) + (SELECT COUNT(*) FROM summaries WHERE job_id = ?) + (SELECT COUNT(*) FROM pulse_insights WHERE job_id = ?) AS n", [job.job_id, job.job_id, job.job_id]);
  assert.equal(n, 0);
});

test("transactions: a failure rolls back everything written in the transaction", async () => {
  const before = (await q("SELECT COUNT(*) AS n FROM audio_files"))[0].n;
  await assert.rejects(() =>
    db.withTransaction(async (conn) => {
      await conn.execute("INSERT INTO audio_files (stored_name, original_name, kind, file_format, size_bytes, sha256) VALUES (?, 'x', 'audio', 'wav', 1, ?)", ["tx-test.wav", "0".repeat(64)]);
      throw new Error("boom");
    }),
  );
  assert.equal((await q("SELECT COUNT(*) AS n FROM audio_files"))[0].n, before);

  // A job result that cannot be stored (emotion too long for its column in strict mode) leaves no
  // partial transcript behind — and the API response is unaffected.
  const [j] = await q("SELECT audio_file_id FROM processing_jobs WHERE id = ?", [audioJobId]);
  const badId = "b".repeat(32);
  await db.getPool().execute("INSERT INTO processing_jobs (id, audio_file_id, kind, status) VALUES (?, ?, 'audio', 'processing')", [badId, j.audio_file_id]);
  const bad = structuredClone(audioResult);
  bad.tamil_segments[1].emotion = "x".repeat(50);
  await repo.saveJobOutcome({ id: badId, kind: "audio", status: "completed", stage: "done", progress: 1, error: null, result: bad, startedAt: Date.now() / 1000, finishedAt: Date.now() / 1000 });
  const [after] = await q("SELECT status FROM processing_jobs WHERE id = ?", [badId]);
  assert.equal(after.status, "processing", "status update rolled back with the failed result");
  assert.equal((await q("SELECT COUNT(*) AS n FROM transcripts WHERE job_id = ?", [badId]))[0].n, 0);
});

test("errors: wrong credentials and unknown database give clear messages", async () => {
  const mysql = (await import("mysql2/promise")).default;
  const s = db.dbSettings();
  await assert.rejects(
    () => mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: "wrong-password", database: s.database }),
    (e) => db.describeError(e).includes("rejected the user name or password"),
  );
  await assert.rejects(
    () => mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, database: "teemly_no_such_db" }),
    (e) => /does not exist|privilege/.test(db.describeError(e)),
  );
  await assert.rejects(
    () => mysql.createConnection({ host: s.host, port: 1, user: s.user, password: s.password, connectTimeout: 2000 }),
    (e) => db.describeError(e).includes("not reachable"),
  );
});

test("security: app user cannot change the schema; queries are parameterized", async () => {
  await assert.rejects(() => db.getPool().query("DROP TABLE audit_logs"), (e) => /DENIED/.test(e.code));
  await assert.rejects(() => db.getPool().query("CREATE TABLE x (id INT)"), (e) => /DENIED/.test(e.code));
  // A hostile job id is treated as data, not SQL.
  const r = await fetch(`${base}/api/analysis/${encodeURIComponent("x' OR '1'='1")}`);
  assert.equal(r.status, 404);
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM audit_logs WHERE detail LIKE ?", [`%${TAMIL.slice(0, 6)}%`]);
  assert.equal(n, 0, "audit logs contain no conversation content");
});

test("audit + rejected uploads are recorded", async () => {
  const r = await upload("/api/audio/upload", "notes.pdf", Buffer.from("%PDF-1.4"));
  assert.equal(r.status, 415);
  const [rej] = await q("SELECT * FROM audio_uploads WHERE status = 'rejected' ORDER BY id DESC LIMIT 1");
  assert.equal(rej.http_status, 415);
  assert.equal(rej.original_name, "notes.pdf");
  const events = (await q("SELECT DISTINCT event FROM audit_logs ORDER BY event")).map((r) => r.event);
  for (const e of ["upload.accepted", "upload.rejected", "job.created", "job.completed", "export.created"]) assert.ok(events.includes(e), `${e} in ${events}`);
});

// ------------------------------------------------------------------- audio metadata (002)

const META_COLUMNS = ["mime_type", "container_format", "audio_codec", "sample_rate_hz", "channels", "bitrate_bps", "storage_provider", "storage_path", "metadata_status", "metadata_error"];

test("audio metadata: migration 002 adds only new, nullable metadata columns", async () => {
  const [m] = await q("SELECT name FROM schema_migrations WHERE version = 2");
  assert.equal(m?.name, "002_audio_metadata.sql");
  const cols = await q("SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_files'");
  for (const c of META_COLUMNS) {
    const col = cols.find((x) => x.c === c);
    assert.ok(col, `${c} exists`);
    assert.ok(col.n === "YES" || col.d !== null, `${c} is nullable or has a default (existing rows stay valid)`);
  }
  assert.equal(cols.filter((x) => x.c === "sha256" || x.c === "duration_seconds").length, 2, "existing columns are reused, not duplicated");
});

test("audio metadata: upload stores ffprobe metadata in MySQL; job and restart show the same values", async () => {
  // The exact recording analysed in the first test: refused, nothing stored, nothing analysed again.
  const filesBefore = (await q("SELECT COUNT(*) AS n FROM audio_files"))[0].n;
  const again = await upload("/api/audio/upload", "call (copy).wav", transcription.wavBytes(speech(8)));
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already uploaded on .*\(call\.wav\), so it is not analysed again/);
  assert.equal((await q("SELECT COUNT(*) AS n FROM audio_files"))[0].n, filesBefore, "no second file");
  const [rej] = await q("SELECT status, http_status FROM audio_uploads ORDER BY id DESC LIMIT 1");
  assert.deepEqual([rej.status, rej.http_status], ["rejected", 409], "the refused attempt is logged");

  const other = speech(8);
  other[0] = 0.1; // a different recording of the same length
  const up = await upload("/api/audio/upload", "Team call.wav", transcription.wavBytes(other));
  assert.equal(up.status, 201);
  const [f] = await q("SELECT * FROM audio_files WHERE stored_name = ?", [up.body.filename]);
  assert.deepEqual(
    { name: f.original_name, ext: f.file_format, mime: f.mime_type, container: f.container_format, codec: f.audio_codec, rate: f.sample_rate_hz, ch: f.channels, provider: f.storage_provider, path: f.storage_path, status: f.metadata_status, err: f.metadata_error },
    { name: "Team call.wav", ext: "wav", mime: "audio/wav", container: "wav", codec: "pcm_s16le", rate: SR, ch: 1, provider: "local", path: `uploads/${up.body.filename}`, status: "extracted", err: null },
  );
  assert.equal(Number(f.duration_seconds), 8);
  assert.ok(Math.abs(f.bitrate_bps - SR * 16) / (SR * 16) < 0.01, `bitrate ${f.bitrate_bps}`); // 16-bit mono PCM (+ header)
  // The checksum is of the file actually stored on disk.
  assert.equal(f.sha256, await repo.sha256File(path.join(config.UPLOAD_DIR, up.body.filename)));
  assert.equal(f.size_bytes, up.body.file_size);

  const job = await (await post("/api/analysis", { filename: up.body.filename })).json();
  assert.deepEqual(job.audio, up.body.metadata);
  const done = await poll(`/api/analysis/${job.job_id}`);
  assert.equal(done.status, "completed", done.error);
  await pipeline.persisted(job.job_id);
  const [j] = await q("SELECT j.status, j.audio_file_id, f.duration_seconds FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id WHERE j.id = ?", [job.job_id]);
  assert.equal(j.audio_file_id, f.id, "job linked to the uploaded file");
  assert.equal(j.status, "completed");
  assert.equal(Number(j.duration_seconds), 8, "measured duration kept");

  pipeline.forgetAllJobsForTests(); // backend restart
  const after = await (await fetch(`${base}/api/analysis/${job.job_id}`)).json();
  assert.deepEqual(after.audio, up.body.metadata, "metadata after restart = metadata at upload (from MySQL)");
  assert.ok(Math.abs(Date.parse(after.audio.uploaded_at) - Date.now()) < 120_000, `upload time ${after.audio.uploaded_at}`);
});

test("audio metadata: corrupt audio is rejected, recorded as rejected, and leaves no file or audio_files row", async () => {
  const [{ n: before }] = await q("SELECT COUNT(*) AS n FROM audio_files");
  const r = await upload("/api/audio/upload", "broken.mp3", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4000, 7)]));
  assert.equal(r.status, 422);
  const [{ n: afterCount }] = await q("SELECT COUNT(*) AS n FROM audio_files");
  assert.equal(afterCount, before);
  const [rej] = await q("SELECT status, http_status, audio_file_id FROM audio_uploads WHERE original_name = 'broken.mp3' ORDER BY id DESC LIMIT 1");
  assert.deepEqual({ ...rej }, { status: "rejected", http_status: 422, audio_file_id: null });
});

// Last: alters the test schema (rebuilt on the next run).
test("audio metadata: backward compatible with a database where 002 has not been applied", async () => {
  const conn = await db.migrationConnection();
  try {
    const [[{ name }]] = await conn.query("SELECT DATABASE() AS name");
    if (name !== "teemly_db_test") throw new Error(`refusing to alter ${name}`);
    await conn.query(`ALTER TABLE audio_files ${META_COLUMNS.map((c) => `DROP COLUMN ${c}`).join(", ")}`);
  } finally {
    await conn.end();
  }
  repo.resetSchemaCacheForTests();
  try {
    const up = await upload("/api/audio/upload", "old-schema.wav", transcription.wavBytes(speech(2)));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const [f] = await q("SELECT original_name, file_format, duration_seconds FROM audio_files WHERE stored_name = ?", [up.body.filename]);
    assert.deepEqual({ ...f, duration_seconds: Number(f.duration_seconds) }, { original_name: "old-schema.wav", file_format: "wav", duration_seconds: 2 });
    const meta = await repo.fileMetadata(up.body.filename);
    assert.equal(meta.original_filename, "old-schema.wav");
    assert.equal(meta.codec, null); // not stored without 002; never invented
  } finally {
    // Put the columns back with migration 002's own SQL, so teemly_db_test ends fully migrated.
    const conn = await db.migrationConnection();
    try {
      const [[{ name }]] = await conn.query("SELECT DATABASE() AS name");
      if (name !== "teemly_db_test") throw new Error(`refusing to alter ${name}`);
      const sql = readFileSync(path.join(FIXTURES, "..", "..", "db", "migrations", "002_audio_metadata.sql"), "utf8");
      for (const stmt of splitStatements(sql)) await conn.query(stmt);
    } finally {
      await conn.end();
    }
    repo.resetSchemaCacheForTests();
  }
  const [{ n }] = await q(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_files' AND COLUMN_NAME IN (${META_COLUMNS.map(() => "?").join(",")})`, META_COLUMNS);
  assert.equal(n, META_COLUMNS.length, "test schema restored");
});

// ------------------------------------------------------------------- OCI Object Storage

test("OCI: an upload with STORAGE_PROVIDER=oci records the OCI location in MySQL (teemly_db_test)", async () => {
  const { startFakeOci } = await import("./helpers/fake-oci.js");
  const ociSvc = await import("../src/storage/oci.js");
  const fakeOci = await startFakeOci();
  const saved = { ...config.OCI, provider: config.STORAGE.provider };
  const e = fakeOci.env();
  Object.assign(config.OCI, { auth: "api_key", tenancy: e.OCI_TENANCY_OCID, user: e.OCI_USER_OCID, fingerprint: e.OCI_FINGERPRINT, privateKeyPath: e.OCI_PRIVATE_KEY_PATH,
    region: e.OCI_REGION, namespace: e.OCI_NAMESPACE, bucket: e.OCI_BUCKET, endpoint: e.OCI_ENDPOINT, retryDelayMs: 10 });
  config.STORAGE.provider = "oci";
  try {
    const wav = transcription.wavBytes(speech(3));
    const up = await upload("/api/audio/upload", "cloud.wav", wav);
    assert.equal(up.status, 201);
    const [f] = await q("SELECT storage_provider, storage_path, sha256 FROM audio_files WHERE stored_name = ?", [up.body.filename]);
    assert.equal(f.storage_provider, "oci");
    assert.equal(f.storage_path, `oci://${fakeOci.namespace}/${fakeOci.bucket}/${ociSvc.objectNameFor(up.body.filename)}`);
    assert.equal(fakeOci.objects.get(ociSvc.objectNameFor(up.body.filename)).meta.sha256, f.sha256);
    assert.deepEqual({ ...(await repo.fileStorage(up.body.filename)) }, { storage_provider: "oci", storage_path: f.storage_path, sha256: f.sha256 });

    // Restart + missing local copy: the location comes from MySQL and the audio from OCI.
    await unlink(path.join(config.UPLOAD_DIR, up.body.filename));
    const restarted = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => restarted.once("listening", r));
    const job = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/analysis`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: up.body.filename }) })).json();
    assert.ok(job.job_id, JSON.stringify(job));
    const done = await poll(`/api/analysis/${job.job_id}`);
    restarted.close();
    assert.equal(done.status, "completed", done.error);
  } finally {
    Object.assign(config.OCI, saved);
    config.STORAGE.provider = saved.provider;
    await fakeOci.close();
  }
});

test("OCI migration (teemly_db_test): dry run, verified batch move, resume, checksum and missing-file safety; local files kept", async () => {
  const { startFakeOci } = await import("./helpers/fake-oci.js");
  const ociSvc = await import("../src/storage/oci.js");
  const { migrateLocalToOci, assertMigrationAllowed } = await import("../src/storage/migrate-audio.js");
  const { appendFile } = await import("node:fs/promises");
  const { existsSync: exists } = await import("node:fs");

  assert.throws(() => assertMigrationAllowed("teemly_db", false), /Refusing to migrate audio for database 'teemly_db'/);
  assert.doesNotThrow(() => assertMigrationAllowed("teemly_db_test", false));

  // Five local uploads (local storage), one with a changed file, one with its file missing.
  const names = [];
  for (let i = 0; i < 5; i++) names.push((await upload("/api/audio/upload", `old-${i}.wav`, transcription.wavBytes(speech(1 + i * 0.1)))).body.filename);
  await appendFile(path.join(config.UPLOAD_DIR, names[3]), Buffer.alloc(4)); // changed after upload
  const missing = path.join(config.UPLOAD_DIR, names[4]);
  const missingBytes = readFileSync(missing);
  await unlink(missing);

  const fakeOci = await startFakeOci();
  const saved = { ...config.OCI };
  const e = fakeOci.env();
  Object.assign(config.OCI, { auth: "api_key", tenancy: e.OCI_TENANCY_OCID, user: e.OCI_USER_OCID, fingerprint: e.OCI_FINGERPRINT, privateKeyPath: e.OCI_PRIVATE_KEY_PATH,
    region: e.OCI_REGION, namespace: e.OCI_NAMESPACE, bucket: e.OCI_BUCKET, endpoint: e.OCI_ENDPOINT, retryDelayMs: 10 });
  const providerOf = async (n) => (await q("SELECT storage_provider FROM audio_files WHERE stored_name = ?", [n]))[0].storage_provider;
  const statusOf = (report, n) => report.files.find((f) => f.stored_name === n)?.status;
  try {
    // 1. Dry run: nothing uploaded, nothing changed.
    const dry = await migrateLocalToOci({ dryRun: true, batchSize: 2, writeReport: false, log: () => {} });
    assert.equal(dry.database, "teemly_db_test");
    assert.equal(fakeOci.objects.size, 0);
    assert.equal(statusOf(dry, names[0]), "would_migrate");
    assert.equal(statusOf(dry, names[3]), "checksum_mismatch");
    assert.equal(statusOf(dry, names[4]), "missing_local");
    assert.equal(await providerOf(names[0]), "local");

    // 2. An interrupted earlier run already put names[1] in OCI (MySQL not updated yet).
    await ociSvc.uploadFile(path.join(config.UPLOAD_DIR, names[1]), ociSvc.objectNameFor(names[1], new Date(Number((await q("SELECT UNIX_TIMESTAMP(created_at) AS t FROM audio_files WHERE stored_name = ?", [names[1]]))[0].t) * 1000)));
    // 3. Real run in batches of 2, with one temporary OCI failure along the way.
    fakeOci.fail("put", 503, 1);
    const run = await migrateLocalToOci({ batchSize: 2, writeReport: false, log: () => {} });
    assert.equal(statusOf(run, names[0]), "migrated");
    assert.equal(statusOf(run, names[1]), "already_in_oci", "resumed: identical object recognised");
    assert.equal(statusOf(run, names[2]), "migrated");
    assert.equal(statusOf(run, names[3]), "checksum_mismatch");
    assert.equal(statusOf(run, names[4]), "missing_local");
    for (const n of names.slice(0, 3)) {
      assert.equal(await providerOf(n), "oci");
      assert.ok(exists(path.join(config.UPLOAD_DIR, n)), "local file is never deleted");
      const [row] = await q("SELECT sha256, storage_path FROM audio_files WHERE stored_name = ?", [n]);
      const objectName = ociSvc.parseStoragePath(row.storage_path).objectName;
      assert.equal(fakeOci.objects.get(objectName).meta.sha256, row.sha256, "verified object matches MySQL");
    }
    assert.equal(await providerOf(names[3]), "local");

    // 4. Re-run: already-moved files are skipped (only the two problem files are checked again).
    const again = await migrateLocalToOci({ batchSize: 10, writeReport: false, log: () => {} });
    assert.equal(again.totals.migrated + again.totals.already_in_oci, 0);
    assert.deepEqual(again.files.map((f) => f.stored_name).sort(), [names[3], names[4]].sort());
  } finally {
    Object.assign(config.OCI, saved);
    writeFileSync(missing, missingBytes);
    await fakeOci.close();
  }
});
