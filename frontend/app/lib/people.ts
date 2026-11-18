/**
 * People found in your calls and chats (backend: GET /api/people, /api/people/:id).
 *
 * After a recording or WhatsApp chat is analysed, the backend stores the people who took part (other
 * than you) and the people who were talked about, with what was said about them. Nothing here is
 * sample data.
 */

import { API_BASE_URL, ApiError } from "./api";

export type Category = "Investor" | "HNI" | "Business partner" | "Expert" | "Govt official" | "Vendor";
/** A department name: one of the built-in eight or one the owner added in Settings (see lib/departments). */
export type Department = string;
export type Consent = "Yes" | "No" | "Ask";
export type Interest = "high" | "medium" | "low" | "none" | "unknown";

export const CATEGORIES: Category[] = ["Investor", "HNI", "Business partner", "Expert", "Govt official", "Vendor"];
export const DEPARTMENTS: Department[] = ["Investment", "Sales", "Channel partners", "Accounts", "Marketing", "Tech & AI", "Govt tenders", "Vendors"];

export type Person = {
  id: string;
  name: string;
  initials: string;
  /** null = not clear from the conversations yet. */
  category: Category | null;
  /** The owner chose the category; conversations never change it. */
  category_locked: boolean;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  phone: string | null;
  departments: Department[];
  /** Interest 0-100 from their calls (latest call weighs half); null = not clear yet. See interestOf(). */
  score: number | null;
  consent: Consent;
  /** What the latest conversation that described them said. */
  summary: string | null;
  introduced_by: { id: string; name: string } | null;
  mention_count: number;
  first_seen_at: string;
  last_contact_at: string;
  /** "added" = added by the owner by hand, no call or chat yet. */
  last_contact_kind: "audio" | "whatsapp" | "added";
};

export type Mention = {
  job_id: string;
  kind: "audio" | "whatsapp";
  file_name: string;
  duration_seconds: number | null;
  relation: "participant" | "mentioned";
  category: Category | null;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  interest: Interest;
  introduced_by_name: string | null;
  context: string;
  quote: string | null;
  /** Transcript line numbers (audio) or message numbers (WhatsApp) where they are talked about. */
  evidence_lines: number[];
  /** When the recording or chat was uploaded. */
  at: string;
  /** WhatsApp only: number of text messages. */
  message_count: number | null;
  /** The call's interest (Pulse): "Very interested" | "Interested" | "Slightly interested" | "Not interested" (null when not clear). */
  tone: string | null;
  commitment_count: number;
  /** People in this conversation who went to the inbox (new people). */
  new_people: number;
  /** Opportunities with this person that came from this conversation (older backends: missing). */
  opportunity_count?: number;
  /** The first decision of the conversation. */
  headline: string | null;
  /** Strongest concern raised (Pulse). */
  concern: "high" | "medium" | "low" | null;
};

export type Commitment = {
  id: number;
  /** The same promise from more than one conversation: all of them, ticked off together. */
  ids?: number[];
  job_id: string;
  task: string;
  who: string | null;
  /** True when the owner is the one who does it. */
  yours?: boolean;
  /** The words said ("this week"). */
  due: string | null;
  /** The real due day (YYYY-MM-DD), counted from the day of the call; null when no day was said. */
  due_date?: string | null;
  /** Days from today to the due day: negative = late. */
  due_in_days?: number | null;
  done: boolean;
  done_at: string | null;
  /** How many conversations said it. */
  calls?: number;
};
export type CommitmentView = "open" | "theirs" | "yours" | "done";
export type CommitmentPage = { view: CommitmentView; items: Commitment[]; total: number; has_more: boolean; counts: Record<CommitmentView, number> };
/** More of a person's commitments (5 at first on the page). */
export const getCommitments = (personId: string, view: CommitmentView, offset: number, limit = 10) =>
  call<CommitmentPage & { offset: number }>(`/api/people/${encodeURIComponent(personId)}/commitments?view=${view}&offset=${offset}&limit=${limit}`);

export type PersonDetail = {
  person: Person;
  mentions: Mention[];
  commitments: Commitment[];
  /** Totals for the commitments (older backends: missing). */
  commitments_page?: Omit<CommitmentPage, "items">;
  notes?: Note[];
  opportunities?: Opportunity[];
  introduced: { id: string; name: string; initials: string; category: Category | null; departments: Department[] }[];
};

/**
 * How interested someone is, in plain words, from what the AI heard in their calls. The same five
 * levels on every page; the bands match the backend (services/people.js interestLevel()).
 */
export type InterestLevel = "very" | "interested" | "slight" | "not" | "unclear";
export const INTEREST_LABEL: Record<InterestLevel, string> = {
  very: "Very interested",
  interested: "Interested",
  slight: "Slightly interested",
  not: "Not interested",
  unclear: "Not clear yet",
};
export function interestOf(score: number | null | undefined): { level: InterestLevel; label: string } {
  const level: InterestLevel = score === null || score === undefined ? "unclear" : score >= 75 ? "very" : score >= 55 ? "interested" : score >= 30 ? "slight" : "not";
  return { level, label: INTEREST_LABEL[level] };
}
/** The tooltip: what the label comes from. */
export function interestTitle(score: number | null | undefined, calls?: number): string {
  if (score === null || score === undefined) return "No call has shown how interested they are yet";
  return `${score}/100 from the interest they showed${calls ? ` in ${calls} conversation${calls === 1 ? "" : "s"}` : " in their calls"} (the latest call counts most)`;
}

/** Line under the name: "Angel investor · Investor", or the category alone. */
export function roleLine(p: Pick<Person, "role_title" | "category" | "organisation">): string {
  const parts = [p.role_title, p.organisation].filter(Boolean) as string[];
  if (p.category && !parts.some((x) => x.toLowerCase().includes(p.category!.toLowerCase()))) parts.push(p.category);
  return parts.join(" · ") || "Category not clear yet";
}

const DAY = 86_400_000;
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** Whole days between a date and today (0 = today). */
export function daysAgo(iso: string, now = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY);
}
/** "Today", "Yesterday", "3 Nov", "3 Nov 2025". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const n = daysAgo(iso, now);
  if (n === 0) return "Today";
  if (n === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
export const kindLabel = (k: "audio" | "whatsapp" | "added") => (k === "whatsapp" ? "WhatsApp" : k === "added" ? "added by you" : "call");

// ------------------------------------------------------------------------------ API

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    throw new ApiError("Cannot reach the backend. Is the backend server running (npm start in backend/)?");
  }
  if (res.status === 401 && typeof window !== "undefined") {
    // Session expired: a full load sends the gate to /login.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  let body: { message?: string } & Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(typeof body.message === "string" ? body.message : `Request failed (HTTP ${res.status})`);
  return body as T;
}

export const getPeople = () => call<{ people: Person[] }>("/api/people").then((r) => r.people);

/** What the owner fills in on "Add person". */
export type NewPerson = {
  name: string;
  city?: string | null;
  phone?: string | null;
  category?: Category | null;
  departments?: Department[];
  introduced_by_id?: string | null;
  /** Purpose of the introduction / who they are. */
  context?: string | null;
  consent?: Consent;
  opportunity?: OpportunityInput | null;
  /** Add even though someone with the same name is in People. */
  same_name_ok?: boolean;
};
export type SameName = { id: string; name: string; city: string | null; organisation: string | null; departments?: string[]; phone_end?: string | null; level?: DupLevel };

/**
 * What tells two people with one name apart: "Sales · ••1111 · Chennai · ABC Traders".
 * Only the last 4 digits of the phone are ever sent for this, never the number.
 */
export function whoLabel(p: { departments?: string[]; phone_end?: string | null; city?: string | null; organisation?: string | null }): string {
  return [...(p.departments ?? []), p.phone_end ? `••${p.phone_end}` : null, p.city, p.organisation].filter(Boolean).join(" · ");
}

/** How close a same-name person is: strong = name + city + department, likely = name + city, weak = name only. */
export type DupLevel = "strong" | "likely" | "weak";
export type DupCheck = { phone_match: SameName | null; name_matches: (SameName & { level: DupLevel })[] };
/** Who is already in People with this phone number or name (asked while "+ Add" is filled in). */
export function checkDuplicates(q: { name?: string; city?: string; phone?: string; department?: string }, signal?: AbortSignal): Promise<DupCheck> {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
  return call<DupCheck>(`/api/people-check?${qs}`, { signal });
}

/** Add a person by hand. A same name already in People comes back as `existing` (nothing saved yet). */
export async function createPerson(p: NewPerson): Promise<{ person_id: string } | { existing: SameName[]; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/people`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  } catch {
    throw new ApiError("Cannot reach the backend. Is the backend server running (npm start in backend/)?");
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string; person_id?: string; existing?: SameName[] };
  if (res.status === 409 && body.existing?.length) return { existing: body.existing, message: body.message ?? "Already in People." };
  if (!res.ok || !body.person_id) throw new ApiError(body.message ?? `Request failed (HTTP ${res.status})`);
  return { person_id: body.person_id };
}
export const getPerson = (id: string) => call<PersonDetail>(`/api/people/${encodeURIComponent(id)}`);
export const deletePerson = (id: string) => call<{ message: string }>(`/api/people/${encodeURIComponent(id)}`, { method: "DELETE" });
export const setCommitmentDone = (id: number, done: boolean) =>
  call<{ done: boolean }>(`/api/commitments/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ done }) });
/** The stored recording of a call (signed-in owner only). */
export const recordingUrl = (jobId: string) => `${API_BASE_URL}/api/conversations/${encodeURIComponent(jobId)}/audio`;

/** "38 sec", "22 min", "1 h 5 min". */
export function lengthLabel(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** "today 6:12 PM", "yesterday 9:05 AM", "8 Nov 4:30 PM". */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
  const n = daysAgo(iso, now);
  const day = n === 0 ? "today" : n === 1 ? "yesterday" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${day} ${time}`;
}

/** Name for matching speakers to people: lower case, honorifics removed (as the backend does). */
export const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\b(sir|madam|anna|ji|garu|mr|mrs|ms|dr)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ------------------------------------------------------------- notes and opportunities

export type Note = { id: string; body: string; pinned: boolean; created_at: string; updated_at: string };

/** Opportunity stages, in order (backend: src/stages.js). Lost is outside the flow. */
export type Stage = "Identified" | "First contact" | "In discussion" | "Pitch / bid shared" | "Negotiation" | "Committed" | "Won" | "Lost";
export const STAGES: Stage[] = ["Identified", "First contact", "In discussion", "Pitch / bid shared", "Negotiation", "Committed", "Won", "Lost"];
/** Chance of closing at each stage: weighted pipeline = value × chance. */
export const STAGE_CHANCE: Record<Stage, number> = { Identified: 0.1, "First contact": 0.2, "In discussion": 0.3, "Pitch / bid shared": 0.5, Negotiation: 0.7, Committed: 0.9, Won: 1, Lost: 0 };
/** CSS class suffix for a stage pill: "Pitch / bid shared" -> "pitchbidshared". */
export const stageClass = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export type OpportunityEvidence = { id: number; speaker: string | null; time_label: string | null; start: number | null; text: string; english: string | null };

export type Opportunity = {
  id: string;
  person_id: string;
  title: string;
  stage: Stage;
  department: Department | null;
  value_inr: number | null;
  next_step: string | null;
  /** YYYY-MM-DD */
  due_date: string | null;
  /** The call or chat it came from (the recording's file name and upload time). */
  source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; duration_seconds?: number | null; at: string } | null;
  /** "ai" = captured from the source conversation by the AI; "manual" = added by the owner. */
  origin?: "ai" | "manual";
  /** AI only: the lines of the source conversation that show this opportunity. */
  evidence?: OpportunityEvidence[];
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};
export type OpportunityInput = Partial<Pick<Opportunity, "title" | "stage" | "department" | "value_inr" | "next_step" | "due_date">> & { source_job_id?: string | null; chance_pct?: number | null };

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const addNote = (personId: string, body: string) => call<{ note: Note }>(`/api/people/${enc(personId)}/notes`, post({ body })).then((r) => r.note);
export const updateNote = (id: string, change: { body?: string; pinned?: boolean }) => call<{ note: Note }>(`/api/notes/${enc(id)}`, post(change)).then((r) => r.note);
export const deleteNote = (id: string) => call<{ message: string }>(`/api/notes/${enc(id)}`, { method: "DELETE" });

/**
 * A conversation on the wrong person's timeline (two people with the same name): move it to another
 * person in People, or send it to the inbox as someone new.
 */
export const moveConversation = (personId: string, jobId: string, to: { person_id: string } | { to: "inbox" }) =>
  call<{ person_id?: string; suggestion_id?: string }>(`/api/people/${enc(personId)}/mentions/${enc(jobId)}/move`, post(to));

export const addOpportunity =(personId: string, o: OpportunityInput) => call<{ opportunity: Opportunity }>(`/api/people/${enc(personId)}/opportunities`, post(o)).then((r) => r.opportunity);
export const updateOpportunity = (id: string, change: OpportunityInput) => call<{ opportunity: Opportunity }>(`/api/opportunities/${enc(id)}`, post(change)).then((r) => r.opportunity);
export const deleteOpportunity = (id: string) => call<{ message: string }>(`/api/opportunities/${enc(id)}`, { method: "DELETE" });

/** "₹2.5 L", "₹1.2 Cr", "₹45,000". */
export function rupees(v: number): string {
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString("en-IN")}`;
}
/** "Thu 20 Nov" for a YYYY-MM-DD date (no time zone shift). */
export function dueLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
/** True when a YYYY-MM-DD date is before today. */
export function isPast(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date();
  return new Date(y, m - 1, d).getTime() < new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
}

// ------------------------------------------------------------------------------ phone

/** "+91 98••• ••210" (Indian mobile) or the last three digits for other numbers. */
export function maskPhone(phone: string): string {
  const m = /^\+91(\d{10})$/.exec(phone);
  if (m) return `+91 ${m[1].slice(0, 2)}••• ••${m[1].slice(7)}`;
  return `${phone.slice(0, 3)}•••${phone.slice(-3)}`;
}
export const telHref = (phone: string) => `tel:${phone}`;
/** Opens a WhatsApp chat with the number (app on phones, WhatsApp Web on computers). */
export const whatsappHref = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "")}`;
/** Save or clear a person's number; returns the number as stored (+91…). */
/** Set a person's departments (the owner's choice; a later call never adds back one taken away). */
export const savePersonDepartments = (personId: string, departments: Department[]) =>
  call<{ departments: Department[] }>(`/api/people/${enc(personId)}/departments`, post({ departments })).then((r) => r.departments);
export const savePhone = (personId: string, phone: string | null) =>
  call<{ phone: string | null }>(`/api/people/${encodeURIComponent(personId)}/phone`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) }).then((r) => r.phone);
