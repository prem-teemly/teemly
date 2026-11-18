/**
 * The new-person inbox (backend: /api/inbox).
 *
 * When a call or WhatsApp chat talks about someone who is not in People yet, or whose name matches
 * more than one person, the backend puts them here. Nobody is added to People until the owner adds
 * them; nothing is matched by guesswork.
 */

import { type Category, type Consent, type Department, type Interest, call } from "./people";

export type Evidence = { id: number; speaker: string | null; time_label: string | null; text: string; english: string | null };

/** Someone already in People with the same name. */
export type Match = {
  id: string;
  name: string;
  initials: string;
  category: Category | null;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  departments?: string[];
  /** Last 4 digits of their phone (to tell two same-name people apart). */
  phone_end?: string | null;
  mention_count: number;
};

export type InboxStatus = "pending" | "added" | "ignored";

/**
 * The AI's suggestion for which department a new person should go to, and why: a reason from what
 * was said, how sure it is (null for items found before suggestions existed) and the lines.
 */
export type DeptSuggestion = { department: Department; reason: string | null; confidence: "high" | "medium" | "low" | null; evidence: Evidence[] };

export type InboxItem = {
  id: string;
  status: InboxStatus;
  name: string;
  initials: string;
  relation: "participant" | "mentioned";
  category: Category | null;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  departments: Department[];
  /** Most certain first; empty when the AI could not tell (older backends: missing). */
  department_suggestions?: DeptSuggestion[];
  interest: Interest;
  /** `person` is set when the introducer is exactly one person in People. */
  introduced_by: { name: string; person: { id: string; name: string } | null } | null;
  context: string;
  quote: string | null;
  evidence: Evidence[];
  matches: Match[];
  /** Deals said in the call: added with the person when they are added. */
  opportunities?: { title: string; stage: string; department: string | null; value_inr: number | null; next_step: string | null }[];
  source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; duration_seconds: number | null };
  person_id: string | null;
  found_at: string;
  decided_at: string | null;
};

export type NewPerson = {
  name: string;
  city: string | null;
  phone: string | null;
  category: Category | null;
  departments: Department[];
  role_title: string | null;
  organisation: string | null;
  consent: Consent;
  context: string | null;
  /** The owner said this is someone else than the same-name people in People. */
  same_name_ok?: boolean;
};

/** "Tech" or "Business": the kind of conversation they came up in (null when unclear). */
export function styleOf(item: Pick<InboxItem, "category" | "departments">): "Tech" | "Business" | null {
  if (item.departments.includes("Tech & AI")) return "Tech";
  if (item.category === "Expert" && !item.departments.length) return "Tech";
  if (item.category || item.departments.length) return "Business";
  return null;
}

/** Where the evidence is: "Call · 00:03" or "WhatsApp · 2026-11-13 10:01". */
export function momentLabel(item: InboxItem): string {
  const at = item.evidence[0]?.time_label;
  return [item.source.kind === "whatsapp" ? "WhatsApp" : "Call", at].filter(Boolean).join(" · ");
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A new department someone in a conversation said the owner should create. */
export type DeptIdea = {
  id: string;
  status: "pending" | "created" | "ignored";
  name: string;
  description: string | null;
  reason: string | null;
  said_by: string | null;
  evidence: Evidence[];
  source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string };
  /** Set once created. */
  department: { id: string; slug: string } | null;
  found_at: string;
  decided_at: string | null;
};

export const getInbox = (status: InboxStatus = "pending") => call<{ pending: number; items: InboxItem[]; departments?: DeptIdea[] }>(`/api/inbox?status=${status}`);
export const createFromIdea = (id: string, d: { name: string; description: string | null; color: string }) =>
  call<{ department: { id: string; slug: string; name: string } }>(`/api/department-ideas/${encodeURIComponent(id)}/create`, json(d)).then((r) => r.department);
export const ignoreIdea = (id: string) => call<{ message: string }>(`/api/department-ideas/${encodeURIComponent(id)}/ignore`, { method: "POST" });
export const addAsNewPerson = (id: string, person: NewPerson) => call<{ person_id: string }>(`/api/inbox/${encodeURIComponent(id)}/add`, json(person));
export const addToExisting = (id: string, personId: string) => call<{ person_id: string }>(`/api/inbox/${encodeURIComponent(id)}/add`, json({ person_id: personId }));
export const ignoreItem = (id: string) => call<{ message: string }>(`/api/inbox/${encodeURIComponent(id)}/ignore`, { method: "POST" });

/** Fired after a decision so the sidebar count refreshes. */
export const INBOX_CHANGED = "teemly:inbox-changed";
export const inboxChanged = () => window.dispatchEvent(new Event(INBOX_CHANGED));
