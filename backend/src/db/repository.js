// Persistence of uploads, jobs and their results in MySQL. All statements are parameterized.
//
// Writes are best-effort: a database problem is logged and never changes an API response or stops
// AI processing. A job's results are saved in one transaction (all or nothing) when it finishes, and
// can be rebuilt in exactly the API's response shape after a backend restart.
//
// Files and jobs belong to the user who uploaded them (user_id, migration 023): reads by stored name
// or job id return only the current user's rows. Housekeeping that is not about one user (restart
// recovery, retention, the OCI migration tool) is marked "system" below.

import { createHash, createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";

import { describeError, getPool, withTransaction } from "./pool.js";
import { maybeUser, uid } from "../tenant.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.db.repository");

const STAGE_LABELS = {
  queued: "Waiting to start",
  decoding: "Reading audio file",
  parsing: "Reading chat messages",
  transcribing: "Transcribing speech",
  translating: "Translating to English",
  diarizing: "Identifying who spoke",
  analyzing: "Analysing meeting content and Pulse signals",
  done: "Completed",
};

export const enabled = () => getPool() !== null;

/** Run a best-effort database write; failures are logged, never thrown. */
async function safely(what, fn) {
  if (!enabled()) return null;
  try {
    return await fn();
  } catch (exc) {
    logger.warning(`Database ${what} failed: ${describeError(exc)}`);
    return null;
  }
}

/**
 * System, at startup: jobs left "queued" or "processing" by a previous run were lost with it (jobs run
 * in this process), so they are marked failed with a clear message instead of showing "processing"
 * forever. Each owner's bell then says the upload could not be analysed. Returns how many.
 */
export async function failInterruptedJobs(now = new Date()) {
  const r = await safely("interrupted jobs", () =>
    getPool().execute(
      "UPDATE processing_jobs SET status = 'failed', stage = 'failed', error_message = ?, finished_at = ? WHERE status IN ('queued', 'processing')",
      ["The server restarted before this finished. Please upload it again.", now],
    ),
  );
  return r ? r[0].affectedRows : 0;
}

/** Keyed hash of a client address, so raw IPs are never stored. */
export function clientHash(ip) {
  if (!ip) return null;
  const key = process.env.AUDIT_HASH_KEY;
  return key ? createHmac("sha256", key).update(ip).digest("hex") : createHash("sha256").update(`teemly:${ip}`).digest("hex");
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

const toDate = (seconds) => (seconds ? new Date(seconds * 1000) : null);
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parseJson = (v) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);

// ----------------------------------------------------------------------------- audit

/** Record an event; `userId` defaults to the signed-in user (NULL = the system). */
export function audit(event, { entityType = null, entityId = null, outcome = "success", ip = null, detail = null, userId = maybeUser()?.id ?? null } = {}) {
  return safely(`audit (${event})`, () =>
    getPool().execute(
      "INSERT INTO audit_logs (user_id, event, entity_type, entity_id, outcome, client_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, event, entityType, entityId, outcome, clientHash(ip), json(detail)],
    ),
  );
}

// ---------------------------------------------------------------------------- uploads

// Audio metadata columns (migration 002). Checked once per process, so this code also runs against a
// database where 002 has not been applied yet: it then stores only the original columns.
let metadataColumns = null;
async function hasMetadataColumns(conn) {
  if (metadataColumns === null) {
    const [[row]] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_files' AND COLUMN_NAME IN ('mime_type','container_format','audio_codec','sample_rate_hz','channels','bitrate_bps','storage_provider','storage_path','metadata_status','metadata_error')",
    );
    metadataColumns = Number(row.n) === 10;
    if (!metadataColumns) logger.warning("Audio metadata columns are missing (run npm run db:migrate); storing basic file details only.");
  }
  return metadataColumns;
}

/** Tests: forget the cached schema check (after altering the test schema). */
export function resetSchemaCacheForTests() {
  metadataColumns = null;
}

/** Insert an audio_files row (owned by the current user) with every metadata field the schema supports. */
async function insertFile(conn, { storedName, originalName, kind, format, sizeBytes, sha, meta, uploadedAt = new Date(), storage = null }) {
  // created_at = the exact upload instant the API reported (FROM_UNIXTIME uses the session time zone,
  // like the column default, so UNIX_TIMESTAMP(created_at) reads it back exactly).
  const base = [uid(), storedName, originalName.slice(0, 255), kind, format, sizeBytes, sha, meta?.duration_seconds ?? null, uploadedAt.getTime() / 1000];
  if (!(await hasMetadataColumns(conn))) {
    const [r] = await conn.execute(
      "INSERT INTO audio_files (user_id, stored_name, original_name, kind, file_format, size_bytes, sha256, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))",
      base,
    );
    return r.insertId;
  }
  const [r] = await conn.execute(
    `INSERT INTO audio_files (user_id, stored_name, original_name, kind, file_format, size_bytes, sha256, duration_seconds, created_at,
       mime_type, container_format, audio_codec, sample_rate_hz, channels, bitrate_bps,
       storage_provider, storage_path, metadata_status, metadata_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...base, meta?.mime_type ?? null, meta?.container_format ?? null, meta?.audio_codec ?? null, meta?.sample_rate_hz ?? null,
      meta?.channels ?? null, meta?.bitrate_bps ?? null, storage?.provider ?? "local", storage?.path ?? `uploads/${storedName}`,
      meta?.status ?? null, meta?.error ?? null],
  );
  return r.insertId;
}

/**
 * An earlier upload by the current user of exactly these bytes (same SHA-256) that was analysed or is
 * being analysed, or null. A failed analysis does not count (that file may be uploaded again), nor does
 * another account's copy. Null without MySQL.
 */
export async function analysedCopy(sha, kind = "audio") {
  if (!enabled()) return null;
  const [[r]] = await getPool().query(
    `SELECT f.original_name, f.created_at, j.id AS job_id, j.status
       FROM audio_files f JOIN processing_jobs j ON j.audio_file_id = f.id
      WHERE f.user_id = ? AND f.sha256 = ? AND f.kind = ? AND f.deleted_at IS NULL AND j.status <> 'failed'
      ORDER BY f.id DESC LIMIT 1`,
    [uid(), sha, kind],
  );
  if (!r) return null;
  const at = r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString();
  return { job_id: r.job_id, original_name: r.original_name, uploaded_at: at, status: r.status };
}

/**
 * Record an accepted upload (file + upload event) in one transaction. `sha` is the SHA-256 of the
 * file as stored on disk; `meta` is the ffprobe measurement (mediaProbe.probe), or null for chats.
 */
export function recordUpload({ kind, storedName, originalName, format, data, sha = null, meta = null, uploadedAt = new Date(), storage = null, ip }) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid(); // outside safely(): an upload with no signed-in user is a bug, not a database problem
  return safely("upload record", async () => {
    const fileId = await withTransaction(async (conn) => {
      const file = { insertId: await insertFile(conn, { storedName, originalName, kind, format, sizeBytes: data.length, sha: sha ?? sha256(data), meta, uploadedAt, storage }) };
      await conn.execute(
        "INSERT INTO audio_uploads (user_id, audio_file_id, kind, original_name, size_bytes, status, http_status, client_hash) VALUES (?, ?, ?, ?, ?, 'accepted', 201, ?)",
        [user, file.insertId, kind, originalName.slice(0, 255), data.length, clientHash(ip)],
      );
      return file.insertId;
    });
    await audit("upload.accepted", { entityType: "audio_file", entityId: String(fileId), ip, detail: { kind, size_bytes: data.length } });
    return fileId;
  });
}

/** Record a rejected upload attempt (no file is stored). */
export function recordRejectedUpload({ kind, originalName, sizeBytes, httpStatus, message, ip }) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("rejected upload record", async () => {
    await getPool().execute(
      "INSERT INTO audio_uploads (user_id, audio_file_id, kind, original_name, size_bytes, status, http_status, error_message, client_hash) VALUES (?, NULL, ?, ?, ?, 'rejected', ?, ?, ?)",
      [user, kind, originalName ? originalName.slice(0, 255) : null, sizeBytes ?? null, httpStatus, String(message).slice(0, 500), clientHash(ip)],
    );
    await audit("upload.rejected", { outcome: "failure", ip, detail: { kind, http_status: httpStatus } });
  });
}

/** System: mark files removed by the retention policy (rows are kept; nothing is deleted). */
export function markFilesDeleted(storedNames) {
  if (!storedNames.length) return Promise.resolve(null);
  return safely("retention update", async () => {
    const db = getPool();
    // A file whose original is in OCI only lost its local working copy: it is not deleted.
    const onlyLocal = (await hasMetadataColumns(db)) ? " AND (storage_provider IS NULL OR storage_provider = 'local')" : "";
    return db.query(`UPDATE audio_files SET deleted_at = CURRENT_TIMESTAMP(3) WHERE deleted_at IS NULL AND stored_name IN (?)${onlyLocal}`, [storedNames]);
  });
}

// ---------------------------------------------------------------------------- storage

/** Where one of the current user's stored files is: { storage_provider, storage_path, sha256 } (null if unknown). */
export function fileStorage(storedName) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("file storage", async () => {
    const db = getPool();
    const cols = (await hasMetadataColumns(db)) ? "storage_provider, storage_path, sha256" : "'local' AS storage_provider, NULL AS storage_path, sha256";
    const [[row]] = await db.execute(`SELECT ${cols} FROM audio_files WHERE stored_name = ? AND user_id = ?`, [storedName, user]);
    return row ?? null;
  });
}

/**
 * Who uploaded a stored file: true = the current user, false = someone else, null = not recorded
 * (no database, or a file from before persistence). Throws when the database cannot answer, so an
 * unknown owner is never treated as "yours".
 */
export async function ownsFile(storedName) {
  if (!enabled()) return null;
  const [[row]] = await getPool().execute("SELECT user_id FROM audio_files WHERE stored_name = ?", [storedName]);
  if (!row) return null;
  return Number(row.user_id) === uid();
}

/**
 * System (OCI migration tool): local audio files still to move to OCI, in id order after `afterId`.
 * Throws if the storage columns (migration 002) are missing: the migration needs them.
 */
export async function localAudioBatch({ afterId = 0, limit = 20 } = {}) {
  const db = getPool();
  if (!db) throw new Error("MySQL is not configured.");
  if (!(await hasMetadataColumns(db))) throw new Error("audio_files has no storage columns: apply migration 002 first (npm run db:migrate).");
  const [rows] = await db.query(
    `SELECT id, stored_name, kind, file_format, size_bytes, sha256, storage_provider, storage_path, UNIX_TIMESTAMP(created_at) AS created_epoch
       FROM audio_files
      WHERE kind = 'audio' AND deleted_at IS NULL AND (storage_provider IS NULL OR storage_provider = 'local') AND id > ?
      ORDER BY id LIMIT ?`,
    [afterId, limit],
  );
  return rows;
}

/** System (OCI migration tool): record that a file's original is now in OCI (only after the upload was verified). */
export async function setStorage(id, { provider, path: storagePath, expectedSha }) {
  const [r] = await getPool().execute(
    "UPDATE audio_files SET storage_provider = ?, storage_path = ? WHERE id = ? AND sha256 = ? AND (storage_provider IS NULL OR storage_provider = 'local')",
    [provider, storagePath, id, expectedSha],
  );
  return r.affectedRows === 1;
}

// ------------------------------------------------------------------------------- jobs

/**
 * The current user's audio_files row for a stored name; files uploaded before persistence existed are
 * registered to them (the route has already checked nobody else owns the name).
 */
async function fileIdFor(conn, storedName, filePath, kind, meta) {
  const [rows] = await conn.execute("SELECT id FROM audio_files WHERE stored_name = ? AND user_id = ?", [storedName, uid()]);
  if (rows.length) return rows[0].id;
  return insertFile(conn, {
    storedName, originalName: storedName, kind, format: path.extname(storedName).slice(1),
    sizeBytes: statSync(filePath).size, sha: await sha256File(filePath), meta,
  });
}

/** SHA-256 recorded for one of the current user's stored files at upload (null if unknown or the database is off). */
export function recordedSha(storedName) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("file checksum", async () => {
    const [[row]] = await getPool().execute("SELECT sha256 FROM audio_files WHERE stored_name = ? AND user_id = ?", [storedName, user]);
    return row?.sha256 ?? null;
  });
}

/** Persisted metadata of one of the current user's stored files, in the API's `audio` shape (null if unknown). */
export function fileMetadata(storedName) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("file metadata", async () => {
    const db = getPool();
    const extra = (await hasMetadataColumns(db))
      ? ", f.mime_type, f.container_format, f.audio_codec, f.sample_rate_hz, f.channels, f.bitrate_bps, f.metadata_status"
      : "";
    const [[f]] = await db.execute(
      `SELECT f.original_name, f.file_format, f.size_bytes, f.duration_seconds, UNIX_TIMESTAMP(f.created_at) AS uploaded_epoch${extra}
         FROM audio_files f WHERE f.stored_name = ? AND f.user_id = ?`,
      [storedName, user],
    );
    return f ? publicAudio(f) : null;
  });
}

/** The audio metadata the API shows (no storage path, checksum or database ids). */
export function publicAudio(f) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    original_filename: f.original_name ?? null,
    file_format: f.file_format ?? null,
    mime_type: f.mime_type ?? null,
    container_format: f.container_format ?? null,
    codec: f.audio_codec ?? null,
    sample_rate_hz: n(f.sample_rate_hz),
    channels: n(f.channels),
    bitrate_bps: n(f.bitrate_bps),
    size_bytes: n(f.size_bytes),
    duration_seconds: n(f.duration_seconds),
    // UNIX_TIMESTAMP reads created_at in the session time zone it was written in, so this is exact.
    uploaded_at: f.uploaded_epoch ? new Date(Math.round(Number(f.uploaded_epoch) * 1000)).toISOString() : f.uploaded_at ?? null,
    metadata_status: f.metadata_status ?? (f.status ?? null),
  };
}

/** Store a new job for its owner (job.owner, the user who started it). */
export function createJob(job, filePath, ip) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("job create", async () => {
    await withTransaction(async (conn) => {
      const fileId = await fileIdFor(conn, job.filename, filePath, job.kind, job.probe ?? null);
      await conn.execute(
        "INSERT INTO processing_jobs (id, user_id, audio_file_id, kind, status, stage, progress, num_speakers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [job.id, user, fileId, job.kind, job.status, job.stage, job.progress, job.numSpeakers ?? null],
      );
    });
    await audit("job.created", { entityType: "processing_job", entityId: job.id, ip, detail: { kind: job.kind } });
  });
}

/** Status / stage / progress of a running job (called on stage changes, as the job's owner). */
export function updateJobProgress(job) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("job progress", () =>
    getPool().execute(
      "UPDATE processing_jobs SET status = ?, stage = ?, progress = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND user_id = ?",
      [job.status, job.stage, job.progress, toDate(job.startedAt), job.id, user],
    ),
  );
}

/** Save a finished job: status, and for completed jobs every result table, in one transaction. */
export function saveJobOutcome(job, models = {}) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("job result", async () => {
    await withTransaction(async (conn) => {
      const [[mine]] = await conn.execute("SELECT 1 AS ok FROM processing_jobs WHERE id = ? AND user_id = ? FOR UPDATE", [job.id, user]);
      if (!mine) return; // not this user's job (or never stored): nothing is written
      await conn.execute(
        `UPDATE processing_jobs SET status = ?, stage = ?, progress = ?, error_message = ?, transcription_model = ?,
           text_model = ?, timings = ?, started_at = ?, finished_at = ? WHERE id = ? AND user_id = ?`,
        [job.status, job.stage, job.progress, job.error ? String(job.error).slice(0, 1000) : null,
          job.result?.transcription_model ?? models.transcription ?? null, models.text ?? null,
          json(job.result?.timings_seconds ?? null), toDate(job.startedAt), toDate(job.finishedAt), job.id, user],
      );
      if (job.status === "completed" && job.result) await saveResult(conn, job);
    });
    await audit(job.status === "completed" ? "job.completed" : "job.failed", {
      entityType: "processing_job", entityId: job.id, outcome: job.status === "completed" ? "success" : "failure",
    });
  });
}

async function insertMany(conn, sql, rows, width) {
  // Multi-row insert with placeholders only; batches keep packets small.
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const placeholders = batch.map(() => `(${new Array(width).fill("?").join(", ")})`).join(", ");
    await conn.execute(`${sql} VALUES ${placeholders}`, batch.flat());
  }
}

async function saveResult(conn, job) {
  const r = job.result;
  // Re-saving a job replaces its previous results (children cascade from these rows).
  for (const table of ["transcripts", "summaries", "emotion_analysis", "pulse_insights"]) {
    await conn.execute(`DELETE FROM ${table} WHERE job_id = ?`, [job.id]);
  }
  const chat = job.kind === "whatsapp";

  // Transcript and its meta (everything needed to rebuild the API response exactly).
  const meta = chat
    ? { participants: r.participants, message_count: r.message_count, text_message_count: r.text_message_count,
        first_message_at: r.first_message_at, last_message_at: r.last_message_at }
    : { coverage: r.coverage, speakers: r.speakers, context: r.context };
  const lines = chat ? r.messages : r.tamil_segments;
  const [tr] = await conn.execute(
    "INSERT INTO transcripts (job_id, source, language, model, duration_seconds, segment_count, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [job.id, chat ? "whatsapp" : "audio", chat ? null : r.language, chat ? null : r.transcription_model,
      chat ? null : r.audio_duration_seconds, lines.length, json(meta)],
  );
  const transcriptId = tr.insertId;

  // Speakers / senders.
  const speakerStats = new Map();
  for (const l of lines) {
    const label = chat ? l.sender : l.speaker;
    if (!label) continue;
    const s = speakerStats.get(label) ?? { seconds: 0, count: 0 };
    s.count += 1;
    if (!chat) s.seconds += Math.max(0, (l.end ?? 0) - (l.start ?? 0));
    speakerStats.set(label, s);
  }
  const speakerIds = new Map();
  for (const [label, s] of speakerStats) {
    const [sp] = await conn.execute(
      "INSERT INTO speakers (transcript_id, label, total_seconds, segment_count) VALUES (?, ?, ?, ?)",
      [transcriptId, label.slice(0, 128), Math.round(s.seconds * 100) / 100, s.count],
    );
    speakerIds.set(label, sp.insertId);
  }

  // Segments, then their English translations.
  await insertMany(
    conn,
    "INSERT INTO transcript_segments (transcript_id, seq, speaker_id, start_seconds, end_seconds, occurred_at, message_kind, text, emotion, warning)",
    lines.map((l, seq) =>
      chat
        ? [transcriptId, seq, speakerIds.get(l.sender) ?? null, null, null, l.timestamp.replace("T", " "), l.kind, l.text, null, null]
        : [transcriptId, seq, speakerIds.get(l.speaker) ?? null, l.start, l.end, null, "speech", l.text, l.emotion ?? null, l.warning ?? null],
    ),
    10,
  );
  const [segRows] = await conn.execute("SELECT id, seq FROM transcript_segments WHERE transcript_id = ? ORDER BY seq", [transcriptId]);
  const english = chat ? lines.map((m) => ({ text: m.english, warning: null })) : r.english_segments;
  const translationRows = segRows
    .map((s) => [s.id, english[s.seq]?.text, english[s.seq]?.warning ?? null])
    .filter(([, text]) => typeof text === "string") // empty text kept: it carries the "Not translated." warning
    .map(([id, text, warning]) => [id, "en", text, warning]);
  await insertMany(conn, "INSERT INTO translations (segment_id, language, text, warning)", translationRows, 4);

  // Summary and its decisions / action items / follow-ups.
  const a = r.analysis ?? { available: false, reason: null, model: null, data: null };
  const d = a.data;
  const [sm] = await conn.execute(
    `INSERT INTO summaries (job_id, available, unavailable_reason, model, purpose, summary, final_summary, key_context,
       topics, important_points, problems_discussed, key_takeaways, transcript_quality_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, a.available ? 1 : 0, a.reason, a.model, d?.purpose ?? null, d?.summary ?? null, d?.final_summary ?? null,
      json(d?.key_context), json(d?.topics), json(d?.important_points), json(d?.problems_discussed), json(d?.key_takeaways),
      d?.transcript_quality_note ?? null],
  );
  if (d) {
    await insertMany(conn, "INSERT INTO decisions (summary_id, seq, decision, made_by, evidence)",
      d.decisions.map((x, i) => [sm.insertId, i, x.decision, x.made_by, x.evidence]), 5);
    await insertMany(conn, "INSERT INTO action_items (summary_id, seq, task, responsible_person, date_text, time_text, deadline_text, speaker_label, evidence, uncertain)",
      d.action_items.map((x, i) => [sm.insertId, i, x.task, x.responsible_person, x.date, x.time, x.deadline, x.speaker, x.evidence, x.uncertain]), 10);
    await insertMany(conn, "INSERT INTO follow_ups (summary_id, seq, text)", d.follow_ups.map((x, i) => [sm.insertId, i, x]), 3);
  }

  // Emotions (audio only).
  if (r.emotions) {
    const e = r.emotions;
    const dominant = e.overall?.find((o) => o.emotion !== "neutral")?.emotion ?? e.overall?.[0]?.emotion ?? null;
    await conn.execute(
      "INSERT INTO emotion_analysis (job_id, available, unavailable_reason, dominant_emotion, overall, by_speaker, timeline) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [job.id, e.available ? 1 : 0, e.reason, dominant, json(e.overall), json(e.by_speaker), json(e.timeline)],
    );
  }

  // Pulse: overview, signals and recommended actions.
  const p = r.pulse ?? { available: false, reason: null, model: null, data: null };
  const pd = p.data;
  await conn.execute(
    "INSERT INTO pulse_insights (job_id, row_type, seq, available, unavailable_reason, overall_interest, dropped_unsupported, model, text) VALUES (?, 'overview', 0, ?, ?, ?, ?, ?, ?)",
    [job.id, p.available ? 1 : 0, p.reason, pd?.overall_interest ?? null, pd?.dropped_unsupported ?? null, p.model ?? null, pd?.overview ?? null],
  );
  if (pd) {
    await insertMany(conn, "INSERT INTO pulse_insights (job_id, row_type, seq, category, person, subject, level, basis, text, quote, quote_verified, evidence)",
      pd.signals.map((s, i) => [job.id, "signal", i, s.category, s.person, s.subject, s.level, s.basis, s.context, s.quote, s.quote_verified ? 1 : 0, json(s.evidence)]), 12);
    await insertMany(conn, "INSERT INTO pulse_insights (job_id, row_type, seq, text, reason, evidence)",
      pd.recommended_actions.map((x, i) => [job.id, "recommendation", i, x.action, x.reason, json(x.evidence)]), 6);
  }

  if (!chat) {
    // Keep the duration measured at upload (ffprobe); fill it only if it was not available.
    await conn.execute("UPDATE audio_files f JOIN processing_jobs j ON j.audio_file_id = f.id SET f.duration_seconds = COALESCE(f.duration_seconds, ?) WHERE j.id = ? AND j.user_id = ?",
      [r.audio_duration_seconds, job.id, uid()]);
  }
}

// ------------------------------------------------------------------------------ exports

export function recordExport({ jobId, title, pdf, ip }) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("export record", async () => {
    const [ins] = await getPool().execute(
      "INSERT INTO exports (user_id, job_id, format, title, size_bytes, sha256, client_hash) VALUES (?, ?, 'pdf', ?, ?, ?, ?)",
      [user, jobId, title.slice(0, 200), pdf.length, sha256(pdf), clientHash(ip)],
    );
    await audit("export.created", { entityType: "processing_job", entityId: jobId, ip, detail: { format: "pdf", size_bytes: pdf.length } });
    return ins.insertId;
  });
}

// --------------------------------------------------------------------------------- load

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 19) : String(d).replace(" ", "T").slice(0, 19));

/**
 * Rebuild one of the current user's jobs from the database in the API's response shape (after a
 * backend restart). Returns null when the job is unknown, another user's, or the database is unavailable.
 */
export function loadJob(jobId) {
  if (!enabled()) return Promise.resolve(null);
  const user = uid();
  return safely("job load", async () => {
    const db = getPool();
    const [[j]] = await db.execute(
      "SELECT j.*, f.stored_name FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id WHERE j.id = ? AND j.user_id = ?",
      [jobId, user],
    );
    if (!j) return null;
    const audio = j.kind === "audio" ? await fileMetadata(j.stored_name) : null;
    const started = j.started_at ? j.started_at.getTime() / 1000 : null;
    const finished = j.finished_at ? j.finished_at.getTime() / 1000 : null;
    const stillRunning = j.status === "queued" || j.status === "processing";
    const dict = {
      job_id: j.id,
      kind: j.kind,
      filename: j.stored_name,
      // A job that was running when the backend stopped cannot continue: report it honestly.
      status: stillRunning ? "failed" : j.status,
      stage: j.stage,
      stage_label: STAGE_LABELS[j.stage] ?? j.stage,
      progress: j.status === "completed" ? 1.0 : Number(j.progress),
      elapsed_seconds: started ? Math.round(((finished ?? Date.now() / 1000) - started) * 10) / 10 : 0.0,
      error: stillRunning ? "The backend restarted while this job was running. Please upload the file again." : j.error_message,
      ...(audio ? { audio } : {}),
      result: null,
    };
    if (j.status === "completed") dict.result = await loadResult(db, j);
    return dict;
  });
}

async function loadResult(db, j) {
  const [[t]] = await db.execute("SELECT * FROM transcripts WHERE job_id = ?", [j.id]);
  if (!t) return null;
  const meta = parseJson(t.meta) ?? {};
  const [segs] = await db.execute(
    `SELECT s.seq, s.start_seconds, s.end_seconds, s.occurred_at, s.message_kind, s.text, s.emotion, s.warning,
            sp.label AS speaker, tr.text AS english, tr.warning AS english_warning
       FROM transcript_segments s
       LEFT JOIN speakers sp ON sp.id = s.speaker_id
       LEFT JOIN translations tr ON tr.segment_id = s.id AND tr.language = 'en'
      WHERE s.transcript_id = ? ORDER BY s.seq`,
    [t.id],
  );
  const analysis = await loadSummary(db, j.id);
  const pulse = await loadPulse(db, j.id);

  if (j.kind === "whatsapp") {
    return {
      source: "whatsapp",
      message_count: meta.message_count,
      text_message_count: meta.text_message_count,
      participants: meta.participants,
      first_message_at: meta.first_message_at,
      last_message_at: meta.last_message_at,
      messages: segs.map((s) => ({ index: s.seq, timestamp: iso(s.occurred_at), sender: s.speaker, text: s.text, kind: s.message_kind, english: s.english })),
      analysis,
      pulse,
    };
  }

  const tamil = segs.map((s) => ({ start: num(s.start_seconds), end: num(s.end_seconds), text: s.text, warning: s.warning, speaker: s.speaker, emotion: s.emotion }));
  const english = segs.map((s) => ({ start: num(s.start_seconds), end: num(s.end_seconds), text: s.english ?? "", warning: s.english_warning, speaker: s.speaker, emotion: s.emotion }));
  const [[e]] = await db.execute("SELECT * FROM emotion_analysis WHERE job_id = ?", [j.id]);
  return {
    audio_duration_seconds: num(t.duration_seconds),
    transcription_model: t.model,
    language: t.language,
    coverage: meta.coverage,
    tamil_transcript: tamil.map((s) => s.text).join("\n"),
    english_translation: english.filter((s) => s.text).map((s) => s.text).join("\n"),
    tamil_segments: tamil,
    english_segments: english,
    speakers: meta.speakers,
    ...(meta.context ? { context: meta.context } : {}),
    emotions: e
      ? { available: !!e.available, reason: e.unavailable_reason, overall: parseJson(e.overall) ?? [], by_speaker: parseJson(e.by_speaker) ?? {}, timeline: parseJson(e.timeline) ?? [] }
      : undefined,
    analysis,
    pulse,
    timings_seconds: parseJson(j.timings) ?? {},
  };
}

async function loadSummary(db, jobId) {
  const [[s]] = await db.execute("SELECT * FROM summaries WHERE job_id = ?", [jobId]);
  if (!s) return { available: false, reason: null, model: null, data: null };
  if (!s.available) return { available: false, reason: s.unavailable_reason, model: s.model, data: null };
  const [decisions] = await db.execute("SELECT decision, made_by, evidence FROM decisions WHERE summary_id = ? ORDER BY seq", [s.id]);
  const [actions] = await db.execute(
    "SELECT task, responsible_person, date_text, time_text, deadline_text, speaker_label, evidence, uncertain FROM action_items WHERE summary_id = ? ORDER BY seq",
    [s.id],
  );
  const [follow] = await db.execute("SELECT text FROM follow_ups WHERE summary_id = ? ORDER BY seq", [s.id]);
  return {
    available: true,
    reason: null,
    model: s.model,
    data: {
      purpose: s.purpose,
      summary: s.summary,
      key_context: parseJson(s.key_context) ?? [],
      topics: parseJson(s.topics) ?? [],
      important_points: parseJson(s.important_points) ?? [],
      problems_discussed: parseJson(s.problems_discussed) ?? [],
      decisions: decisions.map((x) => ({ decision: x.decision, made_by: x.made_by, evidence: x.evidence })),
      action_items: actions.map((x) => ({
        task: x.task, responsible_person: x.responsible_person, date: x.date_text, time: x.time_text,
        deadline: x.deadline_text, speaker: x.speaker_label, evidence: x.evidence, uncertain: x.uncertain,
      })),
      follow_ups: follow.map((x) => x.text),
      final_summary: s.final_summary,
      key_takeaways: parseJson(s.key_takeaways) ?? [],
      transcript_quality_note: s.transcript_quality_note,
    },
  };
}

async function loadPulse(db, jobId) {
  const [rows] = await db.execute("SELECT * FROM pulse_insights WHERE job_id = ? ORDER BY row_type, seq", [jobId]);
  const overview = rows.find((x) => x.row_type === "overview");
  if (!overview) return { available: false, reason: null, model: null, data: null };
  if (!overview.available) return { available: false, reason: overview.unavailable_reason, model: overview.model, data: null };
  return {
    available: true,
    reason: null,
    model: overview.model,
    data: {
      overall_interest: overview.overall_interest,
      overview: overview.text,
      signals: rows.filter((x) => x.row_type === "signal").map((x) => ({
        category: x.category, person: x.person, subject: x.subject, level: x.level, basis: x.basis, context: x.text,
        quote: x.quote, quote_verified: !!x.quote_verified, evidence: parseJson(x.evidence) ?? [],
      })),
      recommended_actions: rows.filter((x) => x.row_type === "recommendation").map((x) => ({
        action: x.text, reason: x.reason, evidence: parseJson(x.evidence) ?? [],
      })),
      dropped_unsupported: overview.dropped_unsupported ?? 0,
    },
  };
}
