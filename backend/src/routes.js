// API routes. Paths, status codes, validation and response bodies match the previous backend.

import { existsSync, statSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

import * as config from "./config.js";
import { basename, clientAddress, jsonBody, parseBody, readUpload, sendJson } from "./http.js";
import { registerAuthRoutes } from "./auth/index.js";
import * as analysis from "./services/analysis.js";
import * as exportPdf from "./services/exportPdf.js";
import * as gemini from "./services/gemini.js";
import * as mediaProbe from "./services/mediaProbe.js";
import * as storage from "./storage/index.js";
import { StorageError } from "./storage/oci.js";
import * as pipeline from "./services/pipeline.js";
import { jobLines } from "./services/peopleJob.js";
import { canonicalCity } from "./services/people.js";
import * as transcription from "./services/transcription.js";
import * as db from "./db/pool.js";
import * as repo from "./db/repository.js";
import * as peopleDb from "./db/people.js";
import * as workDb from "./db/personWork.js";
import * as deptDb from "./db/departments.js";
import * as ideaDb from "./db/departmentIdeas.js";
import * as boardDb from "./db/opportunityBoard.js";
import * as detailDb from "./db/opportunityDetail.js";
import * as todayDb from "./db/today.js";
import * as notesDb from "./db/notifications.js";
import * as networkDb from "./db/network.js";
import * as searchDb from "./db/search.js";
import { InsightUnavailable } from "./services/opportunityInsight.js";
import { BUILT_IN as BUILT_IN_DEPARTMENTS, departmentNames } from "./db/departments.js";
import { STAGES, normalizeStage } from "./stages.js";
import { ownerName, runAs, uid } from "./tenant.js";
import { HttpError, getLogger, hexId } from "./util.js";

const loggers = {
  audio: getLogger("app.api.audio"),
  transcription: getLogger("app.api.transcription"),
};

const UPLOAD_DIR = config.UPLOAD_DIR;
const MAX_UPLOAD_SIZE_MB = 100;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
// Includes the formats produced by Android (m4a/aac/amr/3gp/ogg) and iPhone (m4a) call recorders.
export const SUPPORTED_FORMATS = ["wav", "mp3", "m4a", "flac", "aac", "amr", "3gp", "ogg", "opus", "mp4", "webm"];
// Only names produced by the upload endpoint (<32 hex chars>.<ext>) are accepted,
// so a request can never reach a file outside backend/uploads/.
const STORED_FILENAME_PATTERN = new RegExp(`^[0-9a-f]{32}\\.(${SUPPORTED_FORMATS.join("|")})$`);
const MAX_TEXT_CHARS = 200_000;

const isFile = (p) => existsSync(p) && statSync(p).isFile();

// Uploads accepted by this process: who uploaded it, the checksum of the stored file and its public
// metadata, so a job start needs no second ffprobe run (after a restart the database copy is used instead).
const uploaded = new Map();
function rememberUpload(storedName, info) {
  uploaded.set(storedName, { ...info, owner: uid() });
  if (uploaded.size > 500) uploaded.delete(uploaded.keys().next().value);
}

/**
 * A stored upload may only be transcribed or analysed by the user who uploaded it. Someone else's
 * file is "not found", exactly like a file that does not exist.
 */
async function assertOwnUpload(filename) {
  const known = uploaded.get(filename);
  const mine = known ? known.owner === uid() : await repo.ownsFile(filename);
  // null = no owner on record: only possible without MySQL (tests), where there is one user.
  if (mine === false || (mine === null && repo.enabled())) throw new HttpError(404, `Uploaded file '${filename}' was not found.`);
}
const startsWith = (buf, sig) => buf.length >= sig.length && buf.subarray(0, sig.length).equals(Buffer.from(sig));

/** Check the file's leading bytes against the expected audio container signature. */
function matchesSignature(fmt, header) {
  switch (fmt) {
    case "wav":
      return header.subarray(0, 4).toString("latin1") === "RIFF" && header.subarray(8, 12).toString("latin1") === "WAVE";
    case "flac":
      return startsWith(header, "fLaC");
    case "mp3": // ID3v2 tag, or a raw MPEG audio frame sync (11 set bits).
      return startsWith(header, "ID3") || (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
    case "m4a":
    case "3gp":
    case "mp4":
      return header.subarray(4, 8).toString("latin1") === "ftyp";
    case "aac": // ADTS frame sync (12 set bits) or an ID3 tag in front of it.
      return startsWith(header, "ID3") || (header.length >= 2 && header[0] === 0xff && (header[1] & 0xf6) === 0xf0);
    case "amr":
      return startsWith(header, "#!AMR");
    case "ogg":
    case "opus":
      return startsWith(header, "OggS");
    case "webm":
      return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML magic
    default:
      return false;
  }
}

function getExtension(filename) {
  if (!filename || !filename.includes(".")) {
    throw new HttpError(415, `File has no extension. Supported formats: ${SUPPORTED_FORMATS.join(", ")}.`);
  }
  // Only the extension of the client-supplied name is used; the name itself never
  // touches the filesystem, which rules out path traversal.
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (!SUPPORTED_FORMATS.includes(ext)) {
    throw new HttpError(415, `Unsupported file format '.${ext}'. Supported formats: ${SUPPORTED_FORMATS.join(", ")}.`);
  }
  return ext;
}

const MISSING_FILE = { detail: [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }] };
const FILENAME_RULE = { filename: { type: "string", required: true } };

const clientIp = (req) => clientAddress(req);

// "Add file" on a person's page: the job goes on that person's timeline.
const PERSON_RULE = { type: "string", nullable: true, default: null };
async function uploadPerson(id) {
  if (id === null || id === undefined) return null;
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(422, "person_id: should be a person id");
  if (!repo.enabled()) throw new HttpError(503, "People need the database (MySQL), which is not connected.");
  if (!(await peopleDb.personRef(id))) throw new HttpError(404, "Person not found.");
  return id;
}

/** Record rejected upload attempts (validation errors) without changing the response. */
async function trackRejection(kind, req, file, fn) {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof HttpError && exc.status < 500) {
      await repo.recordRejectedUpload({ kind, originalName: file?.filename ? basename(file.filename) : null, sizeBytes: file?.size ?? null, httpStatus: exc.status, message: exc.message, ip: clientIp(req) });
    }
    throw exc;
  }
}

/**
 * Wrap async handlers so rejections reach the error middleware, and run them as the signed-in user
 * (req.user, set by requireAuth): every query they make is limited to that user's room.
 */
const h = (fn) => (req, res, next) => {
  const run = () => Promise.resolve(fn(req, res, next));
  return (req.user ? runAs(req.user, run) : run()).catch(next);
};

export const router = Router();

/** Every route, for 404 vs 405 decisions. */
export const ROUTES = [];
function route(method, pathSpec, ...handlers) {
  router[method.toLowerCase()](pathSpec, ...handlers);
  ROUTES.push({ method, pattern: new RegExp("^" + pathSpec.replace(/:[a-z_]+/gi, "[^/]+") + "$") });
}

registerAuthRoutes(route);

// ----------------------------------------------------------------------------- health

route("GET", "/health", (req, res) => sendJson(res, 200, { status: "success", message: "Backend is running" }));

// ------------------------------------------------------------------------------ audio

route(
  "POST",
  "/api/audio/upload",
  h(async (req, res) => {
    const file = await readUpload(req, MAX_UPLOAD_SIZE_BYTES);
    if (!file) return sendJson(res, 422, MISSING_FILE);
    return trackRejection("audio", req, file, async () => {
      const ext = getExtension(file.filename);

      await mkdir(UPLOAD_DIR, { recursive: true });
      const storedName = `${hexId()}.${ext}`;
      const destination = path.join(UPLOAD_DIR, storedName);

      if (!file.data.length) throw new HttpError(400, "Uploaded file is empty.");
      if (!matchesSignature(ext, file.data.subarray(0, 16))) throw new HttpError(415, `File content is not a valid .${ext} audio file.`);
      if (file.size > MAX_UPLOAD_SIZE_BYTES) throw new HttpError(413, `File exceeds the maximum upload size of ${MAX_UPLOAD_SIZE_MB} MB.`);
      // The same recording twice would add every promise, person and deal again: not stored, not analysed.
      const copy = await repo.analysedCopy(repo.sha256(file.data), "audio");
      if (copy) {
        const day = new Date(copy.uploaded_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: config.APP_TIMEZONE });
        throw new HttpError(409, `This recording was already uploaded on ${day} (${copy.original_name}), so it is not analysed again.`);
      }
      try {
        // "wx" fails rather than overwriting if the name somehow already exists.
        await writeFile(destination, file.data, { flag: "wx" });
      } catch (exc) {
        await unlink(destination).catch(() => {});
        loggers.audio.error("Failed to save uploaded file", exc);
        throw new HttpError(500, "Could not save the uploaded file.");
      }
      // Integrity: the stored file must be byte-for-byte what was received.
      const sha = repo.sha256(file.data);
      if ((await repo.sha256File(destination)) !== sha) {
        await unlink(destination).catch(() => {});
        loggers.audio.error(`Stored file checksum mismatch for ${storedName}`);
        throw new HttpError(500, "Could not save the uploaded file intact. Please try again.");
      }
      // Technical metadata from the real file (ffprobe). Corrupted or non-audio content is rejected;
      // if ffprobe itself cannot run, the upload is kept and the metadata stays empty.
      const meta = await mediaProbe.probe(destination);
      if (meta.status === "failed") {
        await unlink(destination).catch(() => {});
        mediaProbe.forget(storedName);
        throw new HttpError(422, "The file could not be read as audio. It may be corrupted or not an audio recording.");
      }
      const originalName = basename(file.filename);
      const uploadedAt = new Date();
      const audio = repo.publicAudio({
        ...meta, original_name: originalName, file_format: ext, size_bytes: file.size, uploaded_at: uploadedAt.toISOString(),
      });
      rememberUpload(storedName, { sha, audio });
      // Original to OCI (when STORAGE_PROVIDER=oci), verified there, before its metadata goes to MySQL.
      const stored = await storage.storeUpload(destination, storedName, { sha256: sha, contentType: meta.mime_type ?? "application/octet-stream" });
      uploaded.get(storedName).storage = { storage_provider: stored.provider, storage_path: stored.path, sha256: sha };
      await repo.recordUpload({ kind: "audio", storedName, originalName, format: ext, data: file.data, sha, meta, uploadedAt, storage: stored, ip: clientIp(req) });
      return sendJson(res, 201, {
        status: "success",
        message: "File uploaded successfully",
        filename: storedName,
        original_filename: originalName,
        file_size: file.size,
        file_format: ext,
        metadata: audio,
    });
    });
  }),
);

route(
  "POST",
  "/api/audio/transcribe",
  jsonBody,
  h(async (req, res) => {
    const filename = parseBody(req, FILENAME_RULE).filename.trim();
    if (!STORED_FILENAME_PATTERN.test(filename)) {
      throw new HttpError(400, "Invalid filename. Use the 'filename' value returned by POST /api/audio/upload.");
    }
    await assertOwnUpload(filename);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!isFile(filePath)) throw new HttpError(404, `Uploaded file '${filename}' was not found.`);

    let result;
    try {
      result = await transcription.transcribeFile(filePath);
    } catch (exc) {
      if (exc instanceof transcription.AudioDecodeError) {
        loggers.transcription.warning(`Decode failed for ${filename}: ${exc.message}`);
        throw new HttpError(422, "The file could not be decoded as audio. It may be corrupted.");
      }
      if (exc instanceof transcription.TranscriptionUnavailable) {
        loggers.transcription.warning(`Transcription is unavailable for ${filename}: ${exc.message}`);
        throw new HttpError(503, exc.message);
      }
      loggers.transcription.error(`Transcription failed for ${filename}`, exc);
      throw new HttpError(500, "Transcription failed due to an internal error.");
    }
    return sendJson(res, 200, {
      status: "success",
      message: "Transcription completed",
      filename,
      language: result.languages.join(", ") || transcription.SOURCE_LANGUAGE,
      model: result.model,
      audio_duration_seconds: result.duration_seconds,
      processing_seconds: result.processing_seconds,
      tamil_transcript: result.tamil_text,
      english_translation: result.english_text,
      tamil_segments: result.tamil_segments,
      english_segments: result.english_segments,
    });
  }),
);

// --------------------------------------------------------------------------- analysis

route(
  "POST",
  "/api/analysis",
  jsonBody,
  h(async (req, res) => {
    const body = parseBody(req, { ...FILENAME_RULE, num_speakers: { type: "int", nullable: true, min: 1, max: 20, default: null }, person_id: PERSON_RULE });
    const forPerson = await uploadPerson(body.person_id);
    const filename = body.filename.trim();
    if (!STORED_FILENAME_PATTERN.test(filename)) {
      throw new HttpError(400, "Invalid filename. Use the 'filename' value returned by POST /api/audio/upload.");
    }
    await assertOwnUpload(filename);
    let filePath = path.join(UPLOAD_DIR, filename);
    if (!isFile(filePath)) {
      // Not on this server (e.g. only in OCI): fetch a checksum-verified working copy.
      try {
        filePath = await storage.ensureLocal(filename, uploaded.get(filename)?.storage ?? (await repo.fileStorage(filename)));
      } catch (exc) {
        if (!(exc instanceof StorageError)) throw exc;
        loggers.audio.warning(`Could not fetch ${filename} from OCI: ${exc.message}`);
        throw new HttpError(503, "The recording is in cloud storage but could not be retrieved right now. Please try again.");
      }
      if (!filePath) throw new HttpError(404, `Uploaded file '${filename}' was not found.`);
    }
    // Integrity: the file must still be exactly what was uploaded (checksum from this process or MySQL).
    const known = uploaded.get(filename);
    const expected = known?.sha ?? (await repo.recordedSha(filename));
    if (expected && (await repo.sha256File(filePath)) !== expected) {
      throw new HttpError(409, "The stored file no longer matches the uploaded file (checksum mismatch). Please upload it again.");
    }
    const meta = await mediaProbe.probe(filePath); // cached: ffprobe already ran at upload in this process
    if (meta.status === "failed") throw new HttpError(422, "The file could not be decoded as audio. It may be corrupted.");
    const audio =
      known?.audio ??
      (await repo.fileMetadata(filename)) ??
      repo.publicAudio({ ...meta, original_name: null, file_format: path.extname(filename).slice(1), size_bytes: statSync(filePath).size });
    const job = pipeline.submit(filename, filePath, body.num_speakers, { ip: clientIp(req), audio, probe: meta, personId: forPerson });
    return sendJson(res, 202, { status: "success", message: "Analysis started", ...job.toDict() });
  }),
);

route(
  "GET",
  "/api/analysis/:job_id",
  h(async (req, res) => {
    // From memory while running; from the database after a backend restart.
    const found = await pipeline.find(req.params.job_id);
    if (!found) throw new HttpError(404, "Analysis job not found. Jobs are kept in memory and are lost when the server restarts.");
    return sendJson(res, 200, { status: "success", ...found.dict });
  }),
);

// --------------------------------------------------------------------------------- ai

route(
  "GET",
  "/api/ai/status",
  h(async (req, res) => {
    const result = await gemini.checkConnection();
    const ok = result.credentials.ok && Object.values(result.models).every((m) => m.ok);
    return sendJson(res, 200, { status: ok ? "success" : "error", ...result });
  }),
);

const TEXT_RULE = { type: "string", required: true, minLength: 1, maxLength: MAX_TEXT_CHARS };

route(
  "POST",
  "/api/ai/translate",
  jsonBody,
  h(async (req, res) => {
    const { text } = parseBody(req, { text: TEXT_RULE });
    let result;
    try {
      result = await transcription.translateText(text);
    } catch (exc) {
      if (exc instanceof gemini.GeminiUnavailable) throw new HttpError(503, exc.message);
      throw exc;
    }
    return sendJson(res, 200, { status: "success", model: config.settings.GEMINI_TEXT_MODEL, ...result });
  }),
);

route(
  "POST",
  "/api/ai/summarize",
  jsonBody,
  h(async (req, res) => {
    const { text, kind } = parseBody(req, {
      text: TEXT_RULE,
      kind: { type: "literal", values: ["meeting", "chat"], default: "meeting" },
    });
    let result;
    try {
      result = await analysis.analyzeText(text, kind);
    } catch (exc) {
      if (exc instanceof analysis.AnalysisUnavailable) throw new HttpError(503, exc.message);
      throw exc;
    }
    return sendJson(res, 200, { status: "success", model: config.settings.GEMINI_TEXT_MODEL, analysis: result });
  }),
);

// ----------------------------------------------------------------------------- export

route(
  "POST",
  "/api/export/pdf",
  jsonBody,
  h(async (req, res) => {
    const body = parseBody(req, {
      job_id: { type: "string", required: true, minLength: 1, maxLength: 64 },
      title: { type: "string", maxLength: 200, default: "Conversation" },
    });
    const found = await pipeline.find(body.job_id.trim());
    if (!found) throw new HttpError(404, "Job not found. Jobs are kept in memory and are lost when the server restarts.");
    const job = found.dict;
    if (job.status !== "completed" || !job.result) throw new HttpError(409, "The analysis is not finished yet.");
    const title = (body.title || "Conversation").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || "Conversation";
    let pdf;
    try {
      pdf = await exportPdf.renderPdf(exportPdf.buildReportHtml(job, title));
    } catch (exc) {
      if (exc instanceof exportPdf.ExportUnavailable) throw new HttpError(503, exc.message);
      throw exc;
    }
    await repo.recordExport({ jobId: job.job_id, title, pdf, ip: clientIp(req) });
    const safeName = title.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "conversation";
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader("Content-Disposition", `attachment; filename="teemly-report.pdf"; filename*=UTF-8''${encodeURIComponent(`${safeName} - Teemly report.pdf`)}`);
    res.end(pdf);
  }),
);

// --------------------------------------------------------------------------- whatsapp
// WhatsApp chat upload was removed: new chats cannot be uploaded or processed. Chats analysed before
// the removal stay readable here (people's timelines link to them); nothing is deleted.

route(
  "GET",
  "/api/whatsapp/:job_id",
  h(async (req, res) => {
    const found = await pipeline.find(req.params.job_id);
    if (!found || found.dict.kind !== "whatsapp") {
      throw new HttpError(404, "Chat job not found. Jobs are kept in memory and are lost when the server restarts.");
    }
    return sendJson(res, 200, { status: "success", ...found.dict });
  }),
);

// -------------------------------------------------------------------------------- people
// People found in calls and chats (see services/people.js). Ids are random 32-hex strings.

const PERSON_ID = /^[0-9a-f]{32}$/;
function peopleStore() {
  if (!repo.enabled()) throw new HttpError(503, "People need the database (MySQL), which is not connected.");
  return peopleDb;
}
function personId(req) {
  const id = req.params.person_id;
  if (!PERSON_ID.test(id)) throw new HttpError(404, "Person not found.");
  return id;
}

route(
  "GET",
  "/api/people",
  h(async (req, res) => sendJson(res, 200, { status: "success", people: await peopleStore().listPeople() })),
);

// Duplicates before "+ Add" saves (best practice: a phone number is one person, so it blocks; a name
// is not proof, so it warns). Asked while the owner types. The level of each same-name match:
//   strong = same name + same city + the chosen department · likely = same name + same city ·
//   weak = same name only (other or unknown city).
const sameCity = (a, b) => !!a && !!b && canonicalCity(a)?.toLowerCase() === canonicalCity(b)?.toLowerCase();
function duplicateLevel(p, { city, department }) {
  if (!sameCity(p.city, city)) return "weak";
  return department && p.departments.includes(department) ? "strong" : "likely";
}
const LEVEL_ORDER = { strong: 0, likely: 1, weak: 2 };
/** Same-name people with their level, the closest match first. */
const withLevels = (people, about) => people.map((p) => ({ ...p, level: duplicateLevel(p, about) })).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
route(
  "GET",
  "/api/people-check",
  h(async (req, res) => {
    const store = peopleStore();
    const str = (k, max) => (typeof req.query[k] === "string" ? req.query[k].replace(/\s+/g, " ").trim().slice(0, max) : "");
    const name = str("name", 80);
    const city = str("city", 60);
    const department = str("department", 40);
    let phone = null;
    try {
      phone = str("phone", 24) ? parseNewPerson({ name: "x", phone: str("phone", 24) }).phone : null;
    } catch {
      phone = null; // not a complete number yet: nothing to compare
    }
    const phoneOwner = phone ? await store.personByPhone(phone) : null;
    const nameMatches = /\p{L}/u.test(name) ? withLevels(await store.sameNamePeople(name), { city, department }) : [];
    return sendJson(res, 200, { status: "success", phone_match: phoneOwner, name_matches: nameMatches });
  }),
);

// The owner adds a person by hand ("+ Add"): name, city, phone, category, departments, who introduced
// them and why, consent, and optionally a first opportunity. A phone number saved for someone else is
// refused (409 with `phone_owner`); someone with the same name already in People is shown first (409
// with `existing`); { same_name_ok: true } adds them as a different person.
route(
  "POST",
  "/api/people",
  jsonBody,
  h(async (req, res) => {
    const store = peopleStore();
    const b = objectBody(req);
    const departments = await departmentNames();
    const form = parseNewPerson(b, { departments });
    let introducedBy = null;
    if (b.introduced_by_id !== undefined && b.introduced_by_id !== null) {
      if (typeof b.introduced_by_id !== "string" || !PERSON_ID.test(b.introduced_by_id)) bad("introduced_by_id", "should be a person id");
      introducedBy = b.introduced_by_id;
    }
    // A first opportunity (checked before anything is saved).
    let opportunity = null;
    if (b.opportunity !== undefined && b.opportunity !== null) {
      if (typeof b.opportunity !== "object" || Array.isArray(b.opportunity)) bad("opportunity", "should be an object");
      opportunity = parseOpportunity(b.opportunity, { departments });
      // Every deal added with a person belongs to a department (so it shows on that department's page).
      if (!opportunity.department) bad("opportunity.department", "is required: choose the department this deal belongs to");
    }
    // One number, one person: never saved twice, whatever the name.
    const phoneOwner = form.phone ? await store.personByPhone(form.phone) : null;
    if (phoneOwner) return sendJson(res, 409, { status: "error", code: "phone_taken", message: `This number is already saved for ${phoneOwner.name}.`, phone_owner: phoneOwner });
    if (b.same_name_ok !== true) {
      const existing = withLevels(await store.sameNamePeople(form.name), { city: form.city, department: form.departments?.[0] });
      if (existing.length) return sendJson(res, 409, { status: "error", message: `${existing[0].name} is already in People.`, existing });
    }
    const id = await workChange(() => store.createPerson(form, { introducedById: introducedBy }));
    let created = null;
    if (opportunity) created = await workChange(() => workDb.createOpportunity(id, opportunity));
    repo.audit("person.created", { entityType: "person", entityId: id, ip: clientIp(req), detail: { opportunity: Boolean(created), introduced: Boolean(introducedBy) } });
    return sendJson(res, 201, { status: "success", person_id: id, opportunity_id: created?.id ?? null });
  }),
);

route(
  "GET",
  "/api/people/:person_id",
  h(async (req, res) => {
    const id = personId(req);
    const found = await peopleStore().getPerson(id, { ownerName: ownerName() });
    if (!found) throw new HttpError(404, "Person not found.");
    const [notes, opportunities] = await Promise.all([workDb.listNotes(id), workDb.listOpportunities(id)]);
    return sendJson(res, 200, { status: "success", ...found, notes, opportunities });
  }),
);

route(
  "DELETE",
  "/api/people/:person_id",
  h(async (req, res) => {
    const id = personId(req);
    if (!(await peopleStore().deletePerson(id))) throw new HttpError(404, "Person not found.");
    repo.audit("person.deleted", { entityType: "person", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Person deleted" });
  }),
);

// A person's phone number (for Call / WhatsApp on their page): set, change or clear.
route(
  "POST",
  "/api/people/:person_id/phone",
  jsonBody,
  h(async (req, res) => {
    const id = personId(req);
    const raw = req.body?.phone;
    if (raw !== null && typeof raw !== "string") throw new HttpError(422, "phone: should be a phone number or null");
    const phone = raw === null ? null : parseNewPerson({ name: "x", phone: raw }).phone;
    const ok = await workChange(() => peopleStore().setPhone(id, phone));
    if (!ok) throw new HttpError(404, "Person not found.");
    repo.audit("person.phone", { entityType: "person", entityId: id, ip: clientIp(req), detail: { set: phone !== null } });
    return sendJson(res, 200, { status: "success", phone });
  }),
);

// A person's departments, set by the owner (replaces the list). Departments taken away are not added
// back by later calls. Only departments that exist are accepted.
route(
  "POST",
  "/api/people/:person_id/departments",
  jsonBody,
  h(async (req, res) => {
    const id = personId(req);
    const raw = objectBody(req).departments;
    if (!Array.isArray(raw) || raw.length > 30 || !raw.every((d) => typeof d === "string")) bad("departments", "should be a list of department names");
    const known = await departmentNames();
    const unknown = raw.filter((d) => !known.includes(d));
    if (unknown.length) bad("departments", `not a department: ${unknown.slice(0, 3).join(", ")}`);
    const departments = await workChange(() => peopleStore().setDepartments(id, raw));
    if (!departments) throw new HttpError(404, "Person not found.");
    repo.audit("person.departments", { entityType: "person", entityId: id, ip: clientIp(req), detail: { count: departments.length } });
    return sendJson(res, 200, { status: "success", departments });
  }),
);

// A conversation on the wrong person's timeline (two people with the same name): move it to another
// person in People, or send it to the inbox as someone new.
route(
  "POST",
  "/api/people/:person_id/mentions/:job_id/move",
  jsonBody,
  h(async (req, res) => {
    const id = personId(req);
    const jobId = req.params.job_id;
    if (!PERSON_ID.test(jobId)) throw new HttpError(404, "This conversation is not on this person's timeline.");
    const b = objectBody(req);
    let to = null;
    let toInbox = false;
    if (b.to === "inbox") toInbox = true;
    else if (typeof b.person_id === "string" && PERSON_ID.test(b.person_id)) to = b.person_id;
    else throw new HttpError(422, 'Send person_id (move to that person) or to: "inbox" (someone new).');
    // The job's lines give the inbox item its evidence (speaker, time, words).
    let lines = [];
    if (toInbox) {
      const dict = await repo.loadJob(jobId).catch(() => null);
      if (dict?.result) lines = jobLines({ kind: dict.kind, result: dict.result });
    }
    const r = await workChange(() => peopleStore().moveMention(id, jobId, { toPersonId: to, toInbox, lines }));
    repo.audit("mention.moved", { entityType: "person", entityId: id, ip: clientIp(req), detail: { job_id: jobId, to: r.person_id ?? "inbox" } });
    return sendJson(res, 200, { status: "success", ...r });
  }),
);

// Commitments (action items of a conversation): tick / untick from a person's page.
// A page of a person's commitments: ?view=open|theirs|yours|done&offset=…&limit=… (real totals per view).
route(
  "GET",
  "/api/people/:person_id/commitments",
  h(async (req, res) => {
    const id = personId(req);
    const q = req.query ?? {};
    const view = typeof q.view === "string" ? q.view : "open";
    if (!peopleDb.COMMITMENT_VIEWS.includes(view)) throw new HttpError(422, `view: should be one of ${peopleDb.COMMITMENT_VIEWS.join(", ")}`);
    const offset = q.offset === undefined ? 0 : Number(q.offset);
    const limit = q.limit === undefined ? peopleDb.COMMITMENTS_FIRST : Number(q.limit);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(422, "offset: should be a whole number, 0 or more");
    if (!Number.isInteger(limit) || limit < 1 || limit > peopleDb.COMMITMENTS_MAX_PAGE) throw new HttpError(422, `limit: should be 1 to ${peopleDb.COMMITMENTS_MAX_PAGE}`);
    const page = await peopleStore().personCommitments(id, { ownerName: ownerName(), view, offset, limit });
    if (!page) throw new HttpError(404, "Person not found.");
    return sendJson(res, 200, { status: "success", ...page });
  }),
);

route(
  "POST",
  "/api/commitments/:action_id",
  jsonBody,
  h(async (req, res) => {
    const id = req.params.action_id;
    if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "Commitment not found.");
    const done = req.body?.done;
    if (typeof done !== "boolean") throw new HttpError(422, "done: should be true or false");
    if (!(await peopleStore().setCommitmentDone(id, done))) throw new HttpError(404, "Commitment not found.");
    repo.audit(done ? "commitment.done" : "commitment.reopened", { entityType: "action_item", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", done });
  }),
);

// Play back a stored call recording (signed-in owner only; supports seeking with Range requests).
route(
  "GET",
  "/api/conversations/:job_id/audio",
  h(async (req, res) => {
    const id = req.params.job_id;
    if (!PERSON_ID.test(id)) throw new HttpError(404, "Recording not found.");
    const file = await peopleStore().jobFile(id);
    if (!file || file.kind !== "audio" || !STORED_FILENAME_PATTERN.test(file.stored_name)) throw new HttpError(404, "Recording not found.");
    let local;
    try {
      local = await storage.ensureLocal(file.stored_name, await repo.fileStorage(file.stored_name));
    } catch {
      local = null;
    }
    if (!local) throw new HttpError(404, "The recording file is no longer stored.");
    await new Promise((resolve, reject) =>
      res.sendFile(local, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }, dotfiles: "deny" }, (err) => (err && !res.headersSent ? reject(err) : resolve())),
    );
  }),
);

// ----------------------------------------------------------------- notes, opportunities
// The owner's notes about a person, and opportunities (deals) with them. Ids are random 32-hex.

// Opportunity stages (backend/src/stages.js): Identified -> … -> Committed -> Won, and Lost.
async function workChange(fn) {
  peopleStore(); // 503 without the database
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof workDb.WorkError) throw new HttpError(exc.status, exc.message);
    throw exc;
  }
}
function idParam(req, name, what) {
  const id = req.params[name];
  if (!PERSON_ID.test(id)) throw new HttpError(404, `${what} not found.`);
  return id;
}
const objectBody = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const bad = (field, msg) => {
  throw new HttpError(422, `${field}: ${msg}`);
};

/** { body, pinned } for a note; `partial` allows leaving fields out (update). */
export function parseNote(raw, { partial = false } = {}) {
  const out = {};
  if (raw.body !== undefined || !partial) {
    if (typeof raw.body !== "string" || !raw.body.trim()) bad("body", "should be some text");
    const body = raw.body.replace(/\r\n/g, "\n").trim();
    if ([...body].length > 4000) bad("body", "should be at most 4000 characters");
    out.body = body;
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== "boolean") bad("pinned", "should be true or false");
    out.pinned = raw.pinned;
  }
  if (partial && !Object.keys(out).length) bad("body", "nothing to change");
  return out;
}

/** Fields of an opportunity; `partial` allows leaving fields out (update). */
export function parseOpportunity(raw, { partial = false, departments = BUILT_IN_DEPARTMENTS } = {}) {
  // `departments`: the owner's current departments (built-in + the ones added in Settings).
  const out = {};
  const text = (field, max, required) => {
    const v = raw[field];
    if (v === undefined) {
      if (required && !partial) bad(field, "is required");
      return;
    }
    if (v === null || (typeof v === "string" && !v.trim())) {
      if (required) bad(field, "is required");
      out[field] = null;
      return;
    }
    if (typeof v !== "string") bad(field, "should be text");
    const t = v.replace(/\s+/g, " ").trim();
    if ([...t].length > max) bad(field, `should be at most ${max} characters`);
    out[field] = t;
  };
  text("title", 160, true);
  text("next_step", 300, false);
  if (raw.stage !== undefined) {
    const stage = normalizeStage(raw.stage); // "Proposal" (older clients) = "Pitch / bid shared"
    if (!STAGES.includes(stage)) bad("stage", `should be one of ${STAGES.join(", ")}`);
    out.stage = stage;
  }
  if (raw.department !== undefined) {
    if (raw.department !== null && !departments.includes(raw.department)) bad("department", `should be one of ${departments.join(", ")}`);
    out.department = raw.department;
  }
  if (raw.chance_pct !== undefined) {
    // The owner's chance for this deal (accepting the AI's suggestion, or their own); null = the stage's.
    const v = raw.chance_pct;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100)) bad("chance_pct", "should be a whole number from 0 to 100, or null");
    out.chance_pct = v;
  }
  if (raw.value_inr !== undefined) {
    let v = raw.value_inr;
    if (typeof v === "string") v = v.replace(/[,\s₹]/g, "") === "" ? null : Number(v.replace(/[,\s₹]/g, ""));
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e13)) bad("value_inr", "should be a whole number of rupees");
    out.value_inr = v;
  }
  if (raw.due_date !== undefined) {
    const v = raw.due_date;
    if (v !== null && v !== "") {
      const m = typeof v === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) bad("due_date", "should be a date like 2026-11-20");
      out.due_date = v;
    } else out.due_date = null;
  }
  if (raw.source_job_id !== undefined) {
    if (raw.source_job_id !== null && (typeof raw.source_job_id !== "string" || !PERSON_ID.test(raw.source_job_id))) bad("source_job_id", "should be a call or chat id");
    out.source_job_id = raw.source_job_id;
  }
  if (partial && !Object.keys(out).length) bad("title", "nothing to change");
  return out;
}

route(
  "POST",
  "/api/people/:person_id/notes",
  jsonBody,
  h(async (req, res) => {
    const pid = personId(req);
    const note = await workChange(() => workDb.createNote(pid, parseNote(objectBody(req))));
    repo.audit("note.created", { entityType: "person_note", entityId: note.id, ip: clientIp(req) });
    return sendJson(res, 201, { status: "success", note });
  }),
);
route(
  "POST",
  "/api/notes/:note_id",
  jsonBody,
  h(async (req, res) => {
    const id = idParam(req, "note_id", "Note");
    const note = await workChange(() => workDb.updateNote(id, parseNote(objectBody(req), { partial: true })));
    if (!note) throw new HttpError(404, "Note not found.");
    repo.audit("note.updated", { entityType: "person_note", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", note });
  }),
);
route(
  "DELETE",
  "/api/notes/:note_id",
  h(async (req, res) => {
    const id = idParam(req, "note_id", "Note");
    if (!(await workChange(() => workDb.deleteNote(id)))) throw new HttpError(404, "Note not found.");
    repo.audit("note.deleted", { entityType: "person_note", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Note deleted" });
  }),
);

route(
  "POST",
  "/api/people/:person_id/opportunities",
  jsonBody,
  h(async (req, res) => {
    const pid = personId(req);
    const data = parseOpportunity(objectBody(req), { departments: await departmentNames() });
    const opportunity = await workChange(() => workDb.createOpportunity(pid, data));
    repo.audit("opportunity.created", { entityType: "opportunity", entityId: opportunity.id, ip: clientIp(req), detail: { stage: opportunity.stage } });
    return sendJson(res, 201, { status: "success", opportunity });
  }),
);
route(
  "POST",
  "/api/opportunities/:opportunity_id",
  jsonBody,
  h(async (req, res) => {
    const id = idParam(req, "opportunity_id", "Opportunity");
    const data = parseOpportunity(objectBody(req), { partial: true, departments: await departmentNames() });
    const opportunity = await workChange(() => workDb.updateOpportunity(id, data));
    if (!opportunity) throw new HttpError(404, "Opportunity not found.");
    repo.audit("opportunity.updated", { entityType: "opportunity", entityId: id, ip: clientIp(req), detail: { fields: Object.keys(data) } });
    return sendJson(res, 200, { status: "success", opportunity });
  }),
);
route(
  "DELETE",
  "/api/opportunities/:opportunity_id",
  h(async (req, res) => {
    const id = idParam(req, "opportunity_id", "Opportunity");
    if (!(await workChange(() => workDb.deleteOpportunity(id)))) throw new HttpError(404, "Opportunity not found.");
    repo.audit("opportunity.deleted", { entityType: "opportunity", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Opportunity deleted" });
  }),
);

// --------------------------------------------------------------------------------- inbox
// New people found in calls and chats wait here until the owner adds or ignores them.

function suggestionId(req) {
  const id = req.params.suggestion_id;
  if (!PERSON_ID.test(id)) throw new HttpError(404, "This inbox item was not found.");
  return id;
}
async function inboxDecision(fn) {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof peopleDb.InboxError) throw new HttpError(exc.status, exc.message);
    throw exc;
  }
}

const CATEGORY_VALUES = ["Investor", "HNI", "Business partner", "Expert", "Govt official", "Vendor"];

/**
 * The owner's details for a new person; every field is checked (422 with the field on error).
 * `departments`: the owner's current department names.
 */
export function parseNewPerson(body, { departments: DEPARTMENT_VALUES = BUILT_IN_DEPARTMENTS } = {}) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const bad = (field, msg) => {
    throw new HttpError(422, `${field}: ${msg}`);
  };
  const text = (field, max, { required = false } = {}) => {
    const v = b[field];
    if (v === undefined) return undefined;
    if (v === null || (typeof v === "string" && !v.trim())) return required ? bad(field, "is required") : null;
    if (typeof v !== "string") return bad(field, "should be text");
    const t = v.replace(/\s+/g, " ").trim();
    if ([...t].length > max) bad(field, `should be at most ${max} characters`);
    return t;
  };
  const out = {
    name: text("name", 80, { required: true }),
    city: text("city", 60),
    role_title: text("role_title", 120),
    organisation: text("organisation", 120),
    context: text("context", 1000),
  };
  if (b.name === undefined) bad("name", "is required");
  if (out.name && !/\p{L}/u.test(out.name)) bad("name", "should be a name (letters)");
  if (b.category !== undefined) {
    if (b.category !== null && !CATEGORY_VALUES.includes(b.category)) bad("category", `should be one of ${CATEGORY_VALUES.join(", ")}`);
    out.category = b.category;
  }
  if (b.departments !== undefined) {
    if (!Array.isArray(b.departments) || b.departments.some((d) => !DEPARTMENT_VALUES.includes(d))) bad("departments", `should be a list of ${DEPARTMENT_VALUES.join(", ")}`);
    out.departments = [...new Set(b.departments)];
  }
  if (b.consent !== undefined) {
    if (!["Yes", "No", "Ask"].includes(b.consent)) bad("consent", "should be Yes, No or Ask");
    out.consent = b.consent;
  }
  const phone = text("phone", 24);
  if (phone) {
    let digits = phone.replace(/[\s\-().]/g, "");
    if (/^\d{10}$/.test(digits)) digits = `+91${digits}`; // an Indian mobile number without the code
    else if (/^0\d{10}$/.test(digits)) digits = `+91${digits.slice(1)}`;
    if (!/^\+\d{8,15}$/.test(digits)) bad("phone", "should be a phone number, e.g. +91 98765 43210");
    if (digits.startsWith("+91") && !/^\+91\d{10}$/.test(digits)) bad("phone", "an Indian number should have 10 digits after +91");
    out.phone = digits;
  } else out.phone = null;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

route(
  "GET",
  "/api/inbox",
  h(async (req, res) => {
    const status = ["pending", "added", "ignored"].includes(req.query.status) ? req.query.status : "pending";
    const store = peopleStore();
    // New people, and new departments someone said the owner should create (migration 013).
    const [items, people, departments, ideas] = await Promise.all([
      store.listSuggestions({ status }),
      store.pendingCount(),
      ideaDb.listDepartmentIdeas(status).catch(() => []),
      ideaDb.pendingIdeasCount(),
    ]);
    return sendJson(res, 200, { status: "success", pending: people + ideas, items, departments });
  }),
);

route(
  "GET",
  "/api/inbox/count",
  h(async (req, res) => sendJson(res, 200, { status: "success", pending: (await peopleStore().pendingCount()) + (await ideaDb.pendingIdeasCount()) })),
);

// A new department suggested in a conversation: create it (name, colour and description can be
// edited first) or ignore it.
const IDEA_ID = /^[0-9a-f]{32}$/;
const ideaId = (req) => {
  if (!IDEA_ID.test(req.params.idea_id)) throw new HttpError(404, "This suggestion was not found.");
  return req.params.idea_id;
};
route(
  "POST",
  "/api/department-ideas/:idea_id/create",
  jsonBody,
  h(async (req, res) => {
    const id = ideaId(req);
    const department = await deptChange(() => ideaDb.createFromIdea(id, objectBody(req)));
    repo.audit("department.created", { entityType: "department", entityId: department.id, ip: clientIp(req), detail: { from_suggestion: id } });
    return sendJson(res, 201, { status: "success", department });
  }),
);
route(
  "POST",
  "/api/department-ideas/:idea_id/ignore",
  h(async (req, res) => {
    const id = ideaId(req);
    await deptChange(() => ideaDb.ignoreIdea(id));
    repo.audit("department_idea.ignored", { entityType: "department_suggestion", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Ignored" });
  }),
);

route(
  "POST",
  "/api/inbox/:suggestion_id/add",
  jsonBody,
  h(async (req, res) => {
    const id = suggestionId(req);
    const store = peopleStore();
    const b = req.body && typeof req.body === "object" ? req.body : {};
    let personId = null;
    let form = {};
    if (b.person_id !== undefined && b.person_id !== null) {
      // Add this conversation to someone already in People (the owner chose them).
      if (typeof b.person_id !== "string" || !PERSON_ID.test(b.person_id)) throw new HttpError(422, "person_id: should be a person id");
      personId = b.person_id;
    } else {
      form = parseNewPerson(b, { departments: await departmentNames() });
      // Same rule as "+ Add": someone with this name is already in People, so a new person is only
      // created once the owner said it is someone else ({ same_name_ok: true }).
      if (b.same_name_ok !== true) {
        const existing = withLevels(await store.sameNamePeople(form.name), { city: form.city, department: form.departments?.[0] });
        if (existing.length) return sendJson(res, 409, { status: "error", code: "same_name", message: `${existing[0].name} is already in People. Confirm this is a different person first.`, existing });
      }
    }
    const added = await inboxDecision(() => store.approveSuggestion(id, { personId, form }));
    repo.audit("inbox.added", { entityType: "person_suggestion", entityId: id, ip: clientIp(req), detail: { person_id: added, existing: Boolean(personId) } });
    return sendJson(res, 200, { status: "success", person_id: added, message: personId ? "Added to their timeline" : "Person added" });
  }),
);

route(
  "POST",
  "/api/inbox/:suggestion_id/ignore",
  h(async (req, res) => {
    const id = suggestionId(req);
    await inboxDecision(() => peopleStore().ignoreSuggestion(id));
    repo.audit("inbox.ignored", { entityType: "person_suggestion", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Ignored" });
  }),
);

// --------------------------------------------------------------------- opportunity panel
// Every opportunity by stage, with its person and chance, and nudges (stalled, overdue, quiet).
// A card is moved with POST /api/opportunities/:id { stage } (logged, not rate limited).

// The Today page: four numbers, top opportunities, live analysis, investor heat, follow-ups and the
// pipeline by department. ?since= is the start of "today" (or "this week") in the owner's time zone.
route(
  "GET",
  "/api/today",
  h(async (req, res) => {
    const raw = typeof req.query.since === "string" ? req.query.since : "";
    let since = Date.parse(raw);
    if (!raw || Number.isNaN(since) || since > Date.now() + 86_400_000 || since < Date.now() - 400 * 86_400_000) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      since = d.getTime();
    }
    const data = await deptChange(() => todayDb.todayData({ since: new Date(since).toISOString(), live: pipeline.recentJobs() }));
    return sendJson(res, 200, { status: "success", ...data });
  }),
);

// Today's top opportunities, a page at a time (ranked by value × chance × urgency and paged in MySQL):
// ?offset= (default 0) &limit= (1-50, default 5). Returns { items, total, has_more, offset }.
route(
  "GET",
  "/api/top-opportunities",
  h(async (req, res) => {
    peopleStore(); // 503 without the database
    const int = (v, def) => {
      const n = Number.parseInt(String(v ?? def), 10);
      return Number.isFinite(n) ? n : def;
    };
    const limit = Math.min(todayDb.TOP_MAX_PAGE, Math.max(1, int(req.query.limit, todayDb.TOP_FIRST)));
    const offset = Math.min(100_000, Math.max(0, int(req.query.offset, 0)));
    return sendJson(res, 200, { status: "success", ...(await todayDb.topOpportunitiesPage({ offset, limit })) });
  }),
);

// Today's AI insights, a page at a time (at-risk deals first, then the biggest rupee change):
// ?offset= (default 0) &limit= (1-20, default 4). Returns { items, total, has_more, offset }.
route(
  "GET",
  "/api/insights",
  h(async (req, res) => {
    peopleStore(); // 503 without the database
    const int = (v, def) => {
      const n = Number.parseInt(String(v ?? def), 10);
      return Number.isFinite(n) ? n : def;
    };
    const limit = Math.min(todayDb.INSIGHTS_MAX_PAGE, Math.max(1, int(req.query.limit, todayDb.INSIGHTS_FIRST)));
    const offset = Math.min(100_000, Math.max(0, int(req.query.offset, 0)));
    return sendJson(res, 200, { status: "success", ...(await todayDb.insightsPage({ offset, limit })) });
  }),
);

// Today's follow-ups, a page at a time (paged in MySQL): ?offset= (default 0) &limit= (1-50, default 5).
// Returns { items, total, overdue, has_more, offset }.
route(
  "GET",
  "/api/follow-ups",
  h(async (req, res) => {
    peopleStore(); // 503 without the database
    const int = (v, def) => {
      const n = Number.parseInt(String(v ?? def), 10);
      return Number.isFinite(n) ? n : def;
    };
    const limit = Math.min(todayDb.FOLLOW_UPS_MAX_PAGE, Math.max(1, int(req.query.limit, todayDb.FOLLOW_UPS_FIRST)));
    const offset = Math.min(100_000, Math.max(0, int(req.query.offset, 0)));
    return sendJson(res, 200, { status: "success", ...(await todayDb.followUpsPage({ offset, limit })) });
  }),
);

// The top bar's search: the signed-in user's people, deals, calls and notes matching ?q= (2+ letters).
route(
  "GET",
  "/api/search",
  h(async (req, res) => {
    peopleStore(); // 503 without the database
    const q = typeof req.query.q === "string" ? req.query.q.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if ([...q].length < searchDb.MIN_QUERY) return sendJson(res, 200, { status: "success", q, people: [], opportunities: [], calls: [], notes: [] });
    return sendJson(res, 200, { status: "success", q, ...(await searchDb.searchRoom(q)) });
  }),
);

// The referral network: who introduced whom, top connectors and moments to thank them.
route(
  "GET",
  "/api/network",
  h(async (req, res) => {
    peopleStore();
    return sendJson(res, 200, { status: "success", ...(await networkDb.networkData()) });
  }),
);

// ------------------------------------------------------------------------- notifications
// The bell: facts from the room (db/notifications.js). Asking for them also makes any that are due
// (at most every few seconds). active_jobs: calls being analysed now, so the bell checks more often.
route(
  "GET",
  "/api/notifications",
  h(async (req, res) => {
    peopleStore(); // 503 without the database
    await notesDb.sweepSoon();
    const num = (v, def, max) => Math.min(max, Math.max(0, Number.parseInt(String(v ?? def), 10) || 0));
    const limit = Math.max(1, num(req.query.limit, 30, 50));
    const offset = num(req.query.offset, 0, 10_000);
    const filter = req.query.filter === "unread" ? "unread" : "all";
    const kind = typeof req.query.kind === "string" && /^[a-z]{3,12}$/.test(req.query.kind) ? req.query.kind : null;
    const list = await notesDb.listNotifications({ limit, offset, filter, kind });
    const active = pipeline.recentJobs().filter((j) => j.status === "queued" || j.status === "processing").length;
    return sendJson(res, 200, { status: "success", ...list, active_jobs: active });
  }),
);

route(
  "POST",
  "/api/notifications/read",
  jsonBody,
  h(async (req, res) => {
    peopleStore();
    const b = objectBody(req);
    if (b.all === true) return sendJson(res, 200, { status: "success", changed: await notesDb.markRead({ all: true }) });
    const ids = Array.isArray(b.ids) ? b.ids : null;
    if (!ids || !ids.length || ids.length > 200 || !ids.every((i) => Number.isInteger(i) && i > 0)) bad("ids", "should be a list of notification ids, or use { all: true }");
    return sendJson(res, 200, { status: "success", changed: await notesDb.markRead({ ids }) });
  }),
);

// Unread again (the owner wants to come back to it).
route(
  "POST",
  "/api/notifications/unread",
  jsonBody,
  h(async (req, res) => {
    peopleStore();
    const ids = objectBody(req).ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((i) => Number.isInteger(i) && i > 0)) bad("ids", "should be a list of notification ids");
    return sendJson(res, 200, { status: "success", changed: await notesDb.markUnread(ids) });
  }),
);

// "Clear all": the signed-in user's notifications are removed (they are not announced again).
route(
  "POST",
  "/api/notifications/clear",
  h(async (req, res) => {
    peopleStore();
    const cleared = await notesDb.clearAll();
    repo.audit("notifications.cleared", { entityType: "notifications", entityId: "all", ip: clientIp(req), detail: { cleared } });
    return sendJson(res, 200, { status: "success", cleared });
  }),
);

// The bell was opened: its number goes to 0 (the rows stay unread until opened).
route(
  "POST",
  "/api/notifications/seen",
  h(async (req, res) => {
    peopleStore();
    await notesDb.markSeen();
    return sendJson(res, 200, { status: "success" });
  }),
);

route(
  "GET",
  "/api/notification-settings",
  h(async (req, res) => {
    peopleStore();
    return sendJson(res, 200, { status: "success", settings: await notesDb.getPrefs() });
  }),
);

route(
  "POST",
  "/api/notification-settings",
  jsonBody,
  h(async (req, res) => {
    peopleStore();
    let change;
    try {
      change = notesDb.parsePrefs(objectBody(req));
    } catch (exc) {
      throw new HttpError(exc.status ?? 422, exc.message);
    }
    let settings;
    try {
      settings = await notesDb.savePrefs(change);
    } catch (exc) {
      if (exc?.code === "ER_NO_SUCH_TABLE") throw new HttpError(503, "Notifications need migration 016 (npm run db:migrate).");
      throw exc;
    }
    repo.audit("notifications.settings", { entityType: "settings", entityId: "notifications", ip: clientIp(req), detail: { fields: Object.keys(change) } });
    return sendJson(res, 200, { status: "success", settings });
  }),
);

// One opportunity's page, and the AI's view of it ("Will it work out?", made on demand and saved).
route(
  "GET",
  "/api/opportunities/:opportunity_id",
  h(async (req, res) => {
    const id = idParam(req, "opportunity_id", "Opportunity");
    const detail = await deptChange(() => detailDb.opportunityDetail(id));
    if (!detail) throw new HttpError(404, "Opportunity not found.");
    return sendJson(res, 200, { status: "success", ...detail });
  }),
);
route(
  "POST",
  "/api/opportunities/:opportunity_id/insight",
  h(async (req, res) => {
    const id = idParam(req, "opportunity_id", "Opportunity");
    let insight;
    try {
      insight = await deptChange(() => detailDb.refreshInsight(id));
    } catch (exc) {
      if (exc instanceof InsightUnavailable) throw new HttpError(503, exc.message);
      throw exc;
    }
    repo.audit("opportunity.insight", { entityType: "opportunity", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", insight });
  }),
);

route(
  "GET",
  "/api/opportunity-board",
  h(async (req, res) => sendJson(res, 200, { status: "success", ...(await deptChange(() => boardDb.opportunityBoard())) })),
);

// --------------------------------------------------------------------------- departments
// Built-in eight plus the ones the owner adds in Settings (migration 009). The panel and each
// department's page are computed from people and opportunities that came from real calls and chats.

const DEPT_ID = /^[0-9a-f]{32}$/;
async function deptChange(fn) {
  peopleStore(); // 503 without the database
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof workDb.WorkError) throw new HttpError(exc.status, exc.message);
    if (exc?.code === "ER_NO_SUCH_TABLE") throw new HttpError(503, "Departments need migration 009 (npm run db:migrate).");
    throw exc;
  }
}
const deptId = (req) => {
  if (!DEPT_ID.test(req.params.department_id)) throw new HttpError(404, "Department not found.");
  return req.params.department_id;
};

route(
  "GET",
  "/api/departments",
  h(async (req, res) => sendJson(res, 200, { status: "success", departments: await deptChange(() => deptDb.departmentCounts()), palette: deptDb.PALETTE })),
);

route(
  "POST",
  "/api/departments",
  jsonBody,
  h(async (req, res) => {
    const department = await deptChange(() => deptDb.createDepartment(deptDb.parseDepartment(objectBody(req))));
    repo.audit("department.created", { entityType: "department", entityId: department.id, ip: clientIp(req) });
    return sendJson(res, 201, { status: "success", department });
  }),
);

route(
  "POST",
  "/api/departments/:department_id",
  jsonBody,
  h(async (req, res) => {
    const id = deptId(req);
    const department = await deptChange(() => deptDb.updateDepartment(id, deptDb.parseDepartment(objectBody(req), { partial: true })));
    if (!department) throw new HttpError(404, "Department not found.");
    repo.audit("department.updated", { entityType: "department", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", department });
  }),
);

route(
  "DELETE",
  "/api/departments/:department_id",
  h(async (req, res) => {
    const id = deptId(req);
    if (!(await deptChange(() => deptDb.deleteDepartment(id)))) throw new HttpError(404, "Department not found.");
    repo.audit("department.deleted", { entityType: "department", entityId: id, ip: clientIp(req) });
    return sendJson(res, 200, { status: "success", message: "Department deleted" });
  }),
);

route(
  "GET",
  "/api/department-overview",
  h(async (req, res) => sendJson(res, 200, { status: "success", ...(await deptChange(() => deptDb.departmentOverview())) })),
);

route(
  "GET",
  "/api/department-pages/:slug",
  h(async (req, res) => {
    const slug = String(req.params.slug);
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new HttpError(404, "Department not found.");
    const detail = await deptChange(() => deptDb.departmentDetail(slug));
    if (!detail) throw new HttpError(404, "Department not found.");
    return sendJson(res, 200, { status: "success", ...detail });
  }),
);

// ------------------------------------------------------------------------------ settings
// Read-only view of how this room is set up, for the Settings page. Never includes credentials,
// paths, project ids or phone numbers; the values themselves are changed in backend/.env.

route(
  "GET",
  "/api/settings",
  h(async (req, res) => {
    const st = await db.status().catch(() => ({ connected: false }));
    return sendJson(res, 200, {
      status: "success",
      storage: { provider: config.STORAGE.provider === "oci" ? "oci" : "local", region: config.STORAGE.provider === "oci" ? config.OCI.region || null : null },
      retention_hours: config.UPLOAD_RETENTION_HOURS, // 0 = keep recordings
      ai: { provider: "Google Gemini (Vertex AI)", transcribe_model: config.settings.GEMINI_TRANSCRIBE_MODEL, text_model: config.settings.GEMINI_TEXT_MODEL, location: config.GOOGLE_CLOUD_LOCATION },
      database: { connected: Boolean(st.connected), migrations: Array.isArray(st.migrations) ? st.migrations.length : null },
      login: {
        enabled: true,
        method: "email",
        code_delivery: config.AUTH.otpProvider === "console" ? "console" : "email",
        session_days: config.AUTH.sessionDays,
        signup: config.AUTH.signupEnabled ? (config.AUTH.signupAllowed.length ? "restricted" : "open") : "closed",
      },
      upload: { audio_formats: SUPPORTED_FORMATS, max_audio_mb: MAX_UPLOAD_SIZE_MB },
    });
  }),
);

// ------------------------------------------------------------------------------ database

route(
  "GET",
  "/api/db/status",
  h(async (req, res) => {
    // Any account can ask, so only whether it works: never the server's host, user or database name.
    const st = await db.status();
    return sendJson(res, 200, { status: st.connected ? "success" : "error", connected: st.connected, server_version: st.server_version, migrations: st.migrations.length, error: st.connected ? null : "The database is not reachable." });
  }),
);
