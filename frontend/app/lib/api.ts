// Same origin by default: Next.js forwards /api/* to the backend (next.config.ts), so the login
// session cookie is first-party. NEXT_PUBLIC_API_BASE_URL can still point elsewhere if needed.
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

/** The session is missing or expired: go to the login page (and come back afterwards). */
function onUnauthorized(): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  const next = window.location.pathname + window.location.search;
  // A full load (not router.push) on purpose: it clears all signed-in state held in memory.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** Audio formats from Android and iPhone call recorders, plus common meeting formats. */
export const SUPPORTED_EXTENSIONS = ["wav", "mp3", "m4a", "flac", "aac", "amr", "3gp", "ogg", "opus", "mp4", "webm"];
export const MAX_UPLOAD_MB = 100;

export type Segment = {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  warning?: string | null;
  /** Emotion audible in this line (tone of voice and words); "neutral" when none is clear. */
  emotion?: string | null;
};

export type EmotionShare = { emotion: string; seconds: number; share: number };

export type EmotionsBlock = {
  available: boolean;
  reason: string | null;
  overall: EmotionShare[];
  by_speaker: Record<string, EmotionShare[]>;
  timeline: { emotion: string; speaker: string | null; start: number; end: number; lines: number }[];
};

export type Decision = {
  decision: string;
  made_by: string | null;
  evidence: string;
};

export type ActionItem = {
  task: string;
  responsible_person: string | null;
  date: string | null;
  time: string | null;
  deadline: string | null;
  speaker: string | null;
  evidence: string;
  uncertain: string | null;
};

export type MeetingAnalysis = {
  summary: string;
  purpose: string | null;
  topics: string[];
  important_points: string[];
  key_context: string[];
  problems_discussed: string[];
  decisions: Decision[];
  action_items: ActionItem[];
  follow_ups: string[];
  final_summary: string;
  key_takeaways: string[];
  transcript_quality_note: string | null;
};

export type AnalysisBlock = { available: boolean; reason: string | null; model: string; data: MeetingAnalysis | null };

export type PulseCategory =
  | "product_interest"
  | "purchase_intent"
  | "feature_preference"
  | "pain_point"
  | "question_concern"
  | "positive_feedback"
  | "negative_feedback"
  | "follow_up_interest"
  | "competitor_mention"
  | "commitment";

/** A real transcript line attached by the backend (never model-written text). */
export type PulseEvidence = {
  id: number;
  speaker: string | null;
  /** Audio position in seconds; null for WhatsApp messages. */
  start: number | null;
  end: number | null;
  time_label: string;
  original: string;
  english: string | null;
};

export type PulseSignal = {
  category: PulseCategory;
  person: string;
  subject: string;
  level: "high" | "medium" | "low";
  basis: "explicit" | "inferred";
  context: string;
  /** Exact supporting words, only when verified against the transcript. */
  quote: string | null;
  quote_verified: boolean;
  evidence: PulseEvidence[];
};

export type PulseData = {
  overall_interest: "high" | "medium" | "low" | "none" | "not_enough_evidence";
  overview: string;
  signals: PulseSignal[];
  recommended_actions: {
    action: string;
    reason: string;
    evidence: Pick<PulseEvidence, "id" | "speaker" | "start" | "time_label">[];
  }[];
  dropped_unsupported: number;
};

export type PulseBlock = { available: boolean; reason: string | null; model: string; data: PulseData | null };

/** A part of the conversation: what was discussed, between which times, by whom. */
export type ContextSection = {
  title: string;
  summary: string;
  start: number;
  end: number;
  time_label: string;
  first_line: number;
  last_line: number;
  speakers: string[];
};

export type MomentTag = "commitment" | "hedging" | "new_person" | "interest" | "concern" | "decision" | "question";

/** A line that carries the conversation: exact time and speaker from the transcript, short English text. */
export type KeyMoment = {
  line: number;
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  original: string;
  tag: MomentTag | null;
};

export type ContextData = {
  main_topic: string;
  /** What was discussed: points, interests, decisions, commitments, next steps (absent on older results). */
  overview?: string;
  /** Absent on results from before key moments existed. */
  key_moments?: KeyMoment[];
  /** Names proven by the conversation itself (e.g. "Hi Prem"), with the line where they were heard. */
  speaker_names: { label: string; name: string; how: "self_introduction" | "addressed_by_name" | "same_voice"; evidence: PulseEvidence[] }[];
  sections: ContextSection[];
};

export type ContextBlock = { available: boolean; reason: string | null; model: string; data: ContextData | null };

export type AnalysisResult = {
  audio_duration_seconds: number;
  transcription_model: string;
  language: string;
  coverage: { last_segment_end_seconds: number; segments: number; note: string };
  /** Transcript in the original spoken language(s): Tamil, English or Tanglish. */
  tamil_transcript: string;
  english_translation: string;
  tamil_segments: Segment[];
  english_segments: Segment[];
  speakers: {
    available: boolean;
    reason: string | null;
    count: number;
    turns: { start: number; end: number; speaker: string }[];
  };
  analysis: AnalysisBlock;
  /** Names, overview and timed sections; absent on older results. */
  context?: ContextBlock;
  /** Absent while the transcript is still being written, and on older results. */
  emotions?: EmotionsBlock;
  /** Absent on results produced before Pulse existed. */
  pulse?: PulseBlock;
  timings_seconds: Record<string, number>;
};

export type ChatMessage = {
  index: number;
  timestamp: string;
  sender: string | null;
  text: string;
  kind: "text" | "media" | "system";
  english: string | null;
};

export type ChatResult = {
  source: "whatsapp";
  message_count: number;
  text_message_count: number;
  participants: string[];
  first_message_at: string;
  last_message_at: string;
  messages: ChatMessage[];
  analysis: AnalysisBlock;
  pulse?: PulseBlock;
};

/** Audio file details measured on the server (ffprobe) and stored in MySQL; null when not available. */
export type AudioMetadata = {
  original_filename: string | null;
  file_format: string | null;
  mime_type: string | null;
  container_format: string | null;
  codec: string | null;
  sample_rate_hz: number | null;
  channels: number | null;
  bitrate_bps: number | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  uploaded_at: string | null;
  metadata_status: "extracted" | "unavailable" | "failed" | null;
};

export type Job<R = AnalysisResult> = {
  job_id: string;
  kind?: "audio" | "whatsapp";
  filename: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  stage_label: string;
  progress: number;
  elapsed_seconds: number;
  error: string | null;
  /** Audio jobs: the uploaded file's metadata. */
  audio?: AudioMetadata;
  result: R | null;
};

export type ChatJob = Job<ChatResult>;

export type UploadResponse = {
  filename: string;
  original_filename: string;
  file_size: number;
  file_format?: string;
  /** Audio uploads: measured metadata. */
  metadata?: AudioMetadata;
};

export class ApiError extends Error {}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.message === "string") return body.message;
    if (Array.isArray(body?.detail)) return body.detail.map((d: { msg: string }) => d.msg).join("; ");
  } catch {
    /* not JSON */
  }
  return `Request failed (HTTP ${res.status})`;
}

function networkError(): ApiError {
  return new ApiError(`Cannot reach the backend${API_BASE_URL ? ` at ${API_BASE_URL}` : ""}. Is the backend server running (npm start in backend/)?`);
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Upload with progress reporting (fetch has no upload progress, so this uses XHR). */
function uploadWithProgress<T>(path: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    xhr.open("POST", `${API_BASE_URL}${path}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(networkError());
    xhr.onload = () => {
      let body: { message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(body.message ?? `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.send(form);
  });
}

export function uploadAudio(file: File, onProgress: (fraction: number) => void): Promise<UploadResponse> {
  return uploadWithProgress<UploadResponse>("/api/audio/upload", file, onProgress);
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE_URL}${path}`,
      body === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw networkError();
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(await readError(res));
  return res.json();
}

export function startAnalysis(filename: string, numSpeakers: number | null): Promise<Job> {
  return request<Job>("/api/analysis", { filename, num_speakers: numSpeakers });
}

export function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/analysis/${jobId}`);
}

/** Download the full conversation context as a Teemly PDF report (rendered by the backend). */
export async function exportReportPdf(jobId: string, title: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/export/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, title }),
    });
  } catch {
    throw networkError();
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(await readError(res));
  return res.blob();
}

/** A WhatsApp chat analysed before chat upload was removed (still shown on people's timelines). */
export function getChatJob(jobId: string): Promise<ChatJob> {
  return request<ChatJob>(`/api/whatsapp/${jobId}`);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Readable codec name (ffprobe id otherwise, upper-cased). */
function codecLabel(codec: string | null): string | null {
  if (!codec) return null;
  const pcm = /^pcm_[su](\d+)/.exec(codec);
  if (pcm) return `PCM ${pcm[1]}-bit`;
  return ({ aac: "AAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", amr_nb: "AMR-NB", amr_wb: "AMR-WB" } as Record<string, string>)[codec] ?? codec.toUpperCase();
}

/**
 * One-line summary of the persisted audio metadata, e.g. "MP4 · 5.1 MB · 10:24 · AAC 48 kHz mono".
 * Only values the server measured are shown; missing values are left out, never guessed.
 */
export function describeAudio(m: AudioMetadata): string[] {
  const parts: string[] = [];
  if (m.file_format) parts.push(m.file_format.toUpperCase());
  if (m.size_bytes !== null) parts.push(formatBytes(m.size_bytes));
  if (m.duration_seconds !== null) parts.push(formatTime(m.duration_seconds));
  const ch = m.channels === 1 ? "mono" : m.channels === 2 ? "stereo" : m.channels ? `${m.channels} ch` : null;
  const tech = [codecLabel(m.codec), m.sample_rate_hz ? `${(m.sample_rate_hz / 1000).toFixed(m.sample_rate_hz % 1000 ? 1 : 0)} kHz` : null, ch].filter(Boolean);
  if (tech.length) parts.push(tech.join(" "));
  return parts;
}

/** Clock-style time as in the call view: "00:42", "12:40", "1:02:05". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ------------------------------------------------------------------------------ login

export type AuthUser = { name: string; initials: string; email_masked: string; role: "owner" | "member" };
/** Sign-in is always on; `signup` says whether new accounts can be made (restricted = only some emails). */
export type AuthState = { auth_enabled: boolean; user: AuthUser | null; signup?: { enabled: boolean; restricted: boolean } };
export type OtpRequest = { challenge_id: string; expires_in: number; resend_in: number; delivery: "console" | "email"; message: string };
/** What a code is asked for: sign in, create an account, or "Forgot password" (then a new one is set). */
export type AuthIntent = "signin" | "signup" | "reset";

/**
 * Login-related calls; errors carry the backend's message, retry_after for rate limits, and `code` for
 * answers the page acts on ("name_required": no account yet, ask for the name; "signup_closed").
 */
export class AuthError extends ApiError {
  constructor(message: string, readonly status: number, readonly retryAfter: number | null = null, readonly code: string | null = null) {
    super(message);
  }
}

async function authCall<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  let data: { message?: string; retry_after?: number; code?: string } & Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const message = typeof data.message === "string" ? data.message : `Request failed (HTTP ${res.status})`;
    throw new AuthError(message, res.status, data.retry_after ?? null, typeof data.code === "string" ? data.code : null);
  }
  return data as T;
}

export const getAuth = () => authCall<AuthState>("/api/auth/me");
/** Email a code. Sign-up sends the name first, so an email that cannot make an account is told at once. */
export const requestOtp = (email: string, intent: AuthIntent = "signin", name: string | null = null) =>
  authCall<OtpRequest>("/api/auth/otp/request", { email, intent, ...(name ? { name } : {}) });
/**
 * Check the code; with `name`, an email without an account gets one (201, created: true); with
 * `password`, it becomes the account's password (a new account, or "Forgot password").
 */
export const verifyOtp = (challengeId: string, code: string, email: string, name: string | null = null, password: string | null = null) =>
  authCall<{ user: AuthUser; created: boolean; password_set: boolean }>("/api/auth/otp/verify", {
    challenge_id: challengeId,
    code,
    email,
    ...(name ? { name } : {}),
    ...(password ? { password } : {}),
  });
/** Sign in with email + password. */
export const passwordLogin = (email: string, password: string) => authCall<{ user: AuthUser }>("/api/auth/password/login", { email, password });
/** Set a first password, or change it (the current one is needed then). Other devices are signed out. */
export const setMyPassword = (newPassword: string, currentPassword: string | null = null) =>
  authCall<{ signed_out: number }>("/api/auth/password", { new_password: newPassword, ...(currentPassword ? { current_password: currentPassword } : {}) });
export const logout = () => authCall<{ status: string }>("/api/auth/logout", {});
export const updateMyName = (name: string) => authCall<{ user: AuthUser }>("/api/auth/profile", { name });

// ---------------------------------------------------------------------------- profile

export type DeviceSession = { id: number; device: string; signed_in_at: string; last_seen_at: string; expires_at: string; current: boolean };
export type Profile = {
  user: AuthUser & { member_since: string | null; last_login_at: string | null; has_password?: boolean; password_set_at?: string | null };
  /** null when the people tables are not available. */
  room: { people: number; conversations: number; open_opportunities: number; open_value_inr: number; inbox_pending: number } | null;
  sessions: DeviceSession[];
  security: { method: string; code_delivery: "console" | "email"; session_days: number; code_minutes: number };
};

export const getProfile = () => authCall<Profile>("/api/auth/profile");
export const revokeDevice = (id: number) => authCall<{ status: string }>(`/api/auth/sessions/${id}/revoke`, {});
export const revokeOtherDevices = () => authCall<{ signed_out: number }>("/api/auth/sessions/revoke-others", {});
