// Settings loaded from backend/.env and environment variables (env vars take precedence).

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(BACKEND_DIR, ".env"), quiet: true });

const env = (name, fallback) => (process.env[name] ?? fallback);

// The owner's time zone: "today", due dates, overdue and the day-end digest use it, so the app gives
// the same answers on any server (cloud servers usually run in UTC). TZ, if set, wins; otherwise
// APP_TIMEZONE (default Asia/Kolkata). Stored times stay UTC.
export const APP_TIMEZONE = (() => {
  const tz = (process.env.TZ || env("APP_TIMEZONE", "Asia/Kolkata")).trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`APP_TIMEZONE / TZ '${tz}' is not a valid time zone (e.g. Asia/Kolkata).`);
  }
  process.env.TZ = tz;
  return tz;
})();
const list = (value) => value.split(",").map((v) => v.trim()).filter(Boolean);
const int = (name, fallback) => {
  const raw = env(name, String(fallback)).trim();
  if (!/^[+-]?\d+$/.test(raw)) throw new Error(`${name} must be an integer, got '${raw}'`);
  return parseInt(raw, 10);
};

export const HOST = env("HOST", "127.0.0.1");
export const PORT = int("PORT", 8000);

export const MODELS_DIR = env("MODELS_DIR", path.join(BACKEND_DIR, "models"));
// UPLOAD_DIR is for tests (a temporary folder); normally uploads go to backend/uploads.
export const UPLOAD_DIR = env("UPLOAD_DIR", "").trim() ? path.resolve(env("UPLOAD_DIR", "").trim()) : path.join(BACKEND_DIR, "uploads");

export const FRONTEND_ORIGINS = list(env("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"));

// Proxies allowed to say who the client is (X-Forwarded-For): the same machine always (Next.js and
// Nginx on the server), plus these addresses or IPv4 ranges, e.g. an AWS load balancer's subnet
// ("10.0.0.0/16"). Without the right entry every visitor would look like the proxy to the rate limit.
export const TRUSTED_PROXIES = list(env("TRUSTED_PROXIES", ""));

// API docs (/docs, /redoc, /openapi.json): on in development, off in production unless API_DOCS=true.
export const API_DOCS = ["1", "true", "yes"].includes(env("API_DOCS", process.env.NODE_ENV === "production" ? "false" : "true").trim().toLowerCase());

// --- Login (email + one-time code). Login is ON only when OWNER_EMAIL is set: then every /api/* call
// needs a session, and only these emails can sign in ("one owner, one room").
// The code is emailed through SMTP (e.g. Gmail with an App Password: SMTP_USER + SMTP_PASS).
// OTP_PROVIDER: "auto" (default) = SMTP when SMTP_PASS is set, otherwise "console", which prints the
// code in the backend terminal (development only; refused when NODE_ENV=production).
const smtpPass = env("SMTP_PASS", "").replace(/\s+/g, ""); // Gmail shows App Passwords in groups of 4
const otpSetting = env("OTP_PROVIDER", "auto").trim().toLowerCase();
export const SMTP = {
  host: env("SMTP_HOST", "smtp.gmail.com").trim(),
  port: int("SMTP_PORT", 465),
  user: env("SMTP_USER", "").trim(),
  pass: smtpPass,
  from: env("SMTP_FROM", "").trim(),
};
export const AUTH = {
  ownerEmails: list(env("OWNER_EMAIL", "")).map((e) => e.toLowerCase()),
  // Phone sign-in was replaced by email; still read only to explain a backend/.env not updated yet.
  legacyOwnerPhones: list(env("OWNER_PHONE", "")),
  ownerName: env("OWNER_NAME", "Owner").trim().slice(0, 80) || "Owner",
  otpProvider: otpSetting === "auto" ? (smtpPass ? "smtp" : "console") : otpSetting,
  otpTtlSeconds: int("OTP_TTL_SECONDS", 300),
  otpMaxAttempts: int("OTP_MAX_ATTEMPTS", 5),
  otpResendSeconds: int("OTP_RESEND_SECONDS", 30),
  otpMaxPerHour: int("OTP_MAX_PER_HOUR", 5),
  sessionDays: int("SESSION_DAYS", 7),
  cookieName: "teemly_session",
  // Secure cookies need HTTPS; on by default in production.
  cookieSecure: ["1", "true", "yes"].includes(env("COOKIE_SECURE", process.env.NODE_ENV === "production" ? "true" : "false").toLowerCase()),
};
export const authEnabled = () => AUTH.ownerEmails.length > 0;

// --- Audio storage. "local" (default) keeps originals only in UPLOAD_DIR, exactly as before. "oci"
// also stores every original in a private OCI Object Storage bucket (backend-only credentials); the
// local file stays as a working copy and is re-downloaded (checksum-verified) when missing.
export const STORAGE = { provider: env("STORAGE_PROVIDER", "local").trim().toLowerCase() };
export const OCI = {
  // api_key (OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, OCI_PRIVATE_KEY_PATH, OCI_REGION),
  // config_file (OCI_CONFIG_FILE / OCI_CONFIG_PROFILE) or instance_principal (on an OCI compute instance).
  auth: env("OCI_AUTH", "api_key").trim().toLowerCase(),
  tenancy: env("OCI_TENANCY_OCID", "").trim(),
  user: env("OCI_USER_OCID", "").trim(),
  fingerprint: env("OCI_FINGERPRINT", "").trim(),
  privateKeyPath: env("OCI_PRIVATE_KEY_PATH", "").trim(),
  privateKeyPassphrase: env("OCI_PRIVATE_KEY_PASSPHRASE", "") || null,
  configFile: env("OCI_CONFIG_FILE", "").trim(),
  configProfile: env("OCI_CONFIG_PROFILE", "DEFAULT").trim(),
  region: env("OCI_REGION", "").trim(),
  namespace: env("OCI_NAMESPACE", "").trim(),
  bucket: env("OCI_BUCKET", "").trim(),
  prefix: env("OCI_OBJECT_PREFIX", "audio/").trim(),
  // Only for tests / private endpoints; normally derived from the region.
  endpoint: env("OCI_ENDPOINT", "").trim(),
  maxAttempts: int("OCI_MAX_ATTEMPTS", 4),
  retryDelayMs: int("OCI_RETRY_DELAY_MS", 500),
  timeoutMs: int("OCI_TIMEOUT_MS", 120_000),
};

// --- Google Cloud / Gemini (Vertex AI). Authentication uses Application Default Credentials only:
// `gcloud auth application-default login` locally, or GOOGLE_APPLICATION_CREDENTIALS / an attached
// service account (gemini-app-backend) in deployment. No API keys are read.
export const GOOGLE_CLOUD_PROJECT = env("GOOGLE_CLOUD_PROJECT", "").trim();
export const GOOGLE_CLOUD_LOCATION = env("GOOGLE_CLOUD_LOCATION", "global").trim();

// gemini-2.5-flash was retired on Vertex AI on 2026-10-20; gemini-3.8-flash is its replacement.
export const GEMINI_TRANSCRIBE_MODEL = env("GEMINI_TRANSCRIBE_MODEL", "gemini-3.8-flash").trim();
export const GEMINI_TEXT_MODEL = env("GEMINI_TEXT_MODEL", "gemini-3.8-flash").trim();

// gemini-3.5-transcribe does not list Tamil as a supported language. When it fails or returns
// nothing for a chunk, the chunk is transcribed by the text model's audio understanding instead.
export const TRANSCRIBE_FALLBACK = ["1", "true", "yes"].includes(env("TRANSCRIBE_FALLBACK", "true").toLowerCase());

// gemini-3.5-transcribe processes at most 15 minutes per request with diarization/timestamps on.
// Audio is sent in chunks of this length (inline WAV; 5 min of 16 kHz mono = ~9.6 MB).
export const TRANSCRIBE_CHUNK_SECONDS = int("TRANSCRIBE_CHUNK_SECONDS", 300);

// Names and terms the transcriber must spell exactly (it heard "Teemly" as "Teamly" without this).
export const TRANSCRIBE_VOCABULARY = list(env("TRANSCRIBE_VOCABULARY", "Teemly"));
// Languages for gemini-3.5-transcribe (it rejects automatic detection). Not used by the Flash path.
export const TRANSCRIBE_LANGUAGE_CODES = list(env("TRANSCRIBE_LANGUAGE_CODES", "ta-IN,en-IN"));

// How long Gemini may reason before answering Pulse / the meeting summary ("minimal" | "low" |
// "medium" | "high"; empty = model default). At the default level, single calls stalled for 315-330 s
// (one Google-side 504) on short recordings; "low" answered in 3-15 s with equal or better output.
export const PULSE_THINKING_LEVEL = env("PULSE_THINKING_LEVEL", "low").trim() || null;
export const ANALYSIS_THINKING_LEVEL = env("ANALYSIS_THINKING_LEVEL", "low").trim() || null;
// Request timeout for text-only calls (summary, Pulse); they normally take 3-25 s, so a stalled call
// is retried after this instead of after GEMINI_TIMEOUT_SECONDS (used for audio chunks).
export const GEMINI_TEXT_TIMEOUT_SECONDS = int("GEMINI_TEXT_TIMEOUT_SECONDS", 120);

// --- Security / data protection
// Uploaded recordings and chats are deleted after this many hours. Off by default (0 = keep
// forever): originals are only ever deleted when this is set explicitly, and never while a job uses them.
export const UPLOAD_RETENTION_HOURS = int("UPLOAD_RETENTION_HOURS", 0);
// POST requests (uploads, job starts, Gemini calls) allowed per client address per minute (0 = no limit).
export const RATE_LIMIT_PER_MINUTE = int("RATE_LIMIT_PER_MINUTE", 30);
// Largest JSON request body accepted (translate/summarize text is limited to 200,000 characters).
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

// PDF export renders with the installed Microsoft Edge or Google Chrome; set a path to use another.
export const EXPORT_BROWSER_PATH = env("EXPORT_BROWSER_PATH", "").trim() || null;

// Hedged requests: if Gemini has not answered after this long, the same request is sent again and the
// first answer wins (the same request was measured at 19 s, 127 s and 813 s; stalled summary calls were
// answered in ~5 s by the second request). Normal answers: transcription ~0.3-0.5 s per second of
// audio, text calls 3-8 s. Transcription waits TRANSCRIBE_HEDGE_SECONDS + 15% of the audio length.
// 0 disables hedging.
export const TRANSCRIBE_HEDGE_SECONDS = int("TRANSCRIBE_HEDGE_SECONDS", 20);
export const TEXT_HEDGE_SECONDS = int("TEXT_HEDGE_SECONDS", 15);

// Jobs processed at the same time. With 1, a short upload waited ("Waiting to start 0%") behind a
// long recording for the whole of its ~20 min speaker identification.
export const JOB_CONCURRENCY = Math.max(1, int("JOB_CONCURRENCY", 3));

// Parallel Gemini requests per job (audio chunks, translation batches).
export const GEMINI_CONCURRENCY = int("GEMINI_CONCURRENCY", 4);

export const GEMINI_TIMEOUT_SECONDS = int("GEMINI_TIMEOUT_SECONDS", 300);

// Speaker diarization (lower threshold = more speakers). Calibrated 2026-11-12: 0.5 split one speaker
// into 4; 0.7 still split a 2-person call into 3; 0.75 was correct on 1- and 2-speaker Tamil, Tanglish
// and English test recordings; 0.8 merged two.
export const DIARIZATION_THRESHOLD = Number(env("DIARIZATION_THRESHOLD", "0.75"));
export const DIARIZATION_THREADS = int("DIARIZATION_THREADS", Math.max(1, Math.floor((os.cpus().length || 2) / 2)));

// Mutable view used by tests to change settings at runtime (mirrors module attribute patching).
export const settings = {
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TEXT_MODEL,
  TRANSCRIBE_FALLBACK,
  TRANSCRIBE_CHUNK_SECONDS,
  TRANSCRIBE_VOCABULARY,
  TRANSCRIBE_LANGUAGE_CODES,
  PULSE_THINKING_LEVEL,
  ANALYSIS_THINKING_LEVEL,
  GEMINI_TEXT_TIMEOUT_SECONDS,
  GEMINI_CONCURRENCY,
  GEMINI_TIMEOUT_SECONDS,
  TRANSCRIBE_HEDGE_SECONDS,
  TEXT_HEDGE_SECONDS,
};
