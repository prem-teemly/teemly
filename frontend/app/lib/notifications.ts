import { call } from "./people";

// The bell (backend: GET /api/notifications, POST /api/notifications/read, notification-settings).

export type NoteKind = "analysis" | "failed" | "opportunity" | "stage" | "thanks" | "inbox" | "due" | "overdue" | "quiet" | "digest";
/** Something inside a grouped notification (a call's new person, a deal's earlier update, one of many). */
export type NoteItem = { kind: NoteKind; text: string; sub: string | null; link: string | null; action?: string; at?: string };
export type Note = {
  id: number;
  kind: NoteKind;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  /** The latest update (rows updated by a newer fact come back to the top). */
  at: string;
  created_at?: string;
  /** Updates merged into this row ("3 updates"), or items inside a call / summary row. */
  count?: number;
  grouped?: "call" | "deal" | "bulk" | null;
  items?: NoteItem[];
  avatar?: { name: string; initials: string | null } | null;
};
/** unread: not opened yet (blue dot). unseen: arrived since the bell was last opened (the bell's number). */
export type NoteList = { items: Note[]; unread: number; unseen?: number; has_more?: boolean; active_jobs: number; unavailable?: boolean };

export type NotePrefs = {
  analysis: boolean;
  opportunity: boolean;
  stage: boolean;
  inbox: boolean;
  due: boolean;
  quiet: boolean;
  digest: boolean;
  /** Hour of the day-end digest (0-23). */
  digest_hour: number;
};

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getNotes = ({ limit = 30, offset = 0, filter = "all", kind = "" }: { limit?: number; offset?: number; filter?: "all" | "unread"; kind?: string } = {}) =>
  call<NoteList>(`/api/notifications?limit=${limit}&offset=${offset}&filter=${filter}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`);
export const markRead = (ids: number[]) => call<{ changed: number }>("/api/notifications/read", post({ ids }));
export const markUnread = (ids: number[]) => call<{ changed: number }>("/api/notifications/unread", post({ ids }));
/** The bell was opened: its number goes to 0; the rows stay unread until opened. */
export const markSeen = () => call<{ status: string }>("/api/notifications/seen", { method: "POST" });

/** Filter options for "View all" (Due & overdue together, Calls with failed uploads). */
export const NOTE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All types" },
  { value: "analysis", label: "Calls" },
  { value: "opportunity", label: "New opportunities" },
  { value: "stage", label: "Stage moves" },
  { value: "thanks", label: "Thank-yous" },
  { value: "inbox", label: "Inbox" },
  { value: "due", label: "Due & overdue" },
  { value: "quiet", label: "Nudges" },
  { value: "digest", label: "Day-end digest" },
];

/** Notifications by day: Today, Yesterday, Earlier. */
export function byDay(notes: Note[], now = new Date()): { label: string; notes: Note[] }[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const label = (iso: string) => {
    const t = Date.parse(iso);
    return t >= t0 ? "Today" : t >= t0 - 86_400_000 ? "Yesterday" : "Earlier";
  };
  const out: { label: string; notes: Note[] }[] = [];
  for (const n of notes) {
    const l = label(n.at);
    const g = out.find((x) => x.label === l);
    if (g) g.notes.push(n);
    else out.push({ label: l, notes: [n] });
  }
  return out;
}
export const markAllRead = () => call<{ changed: number }>("/api/notifications/read", post({ all: true }));
export const getNotePrefs = () => call<{ settings: NotePrefs }>("/api/notification-settings").then((r) => r.settings);
export const saveNotePrefs = (change: Partial<NotePrefs>) => call<{ settings: NotePrefs }>("/api/notification-settings", post(change)).then((r) => r.settings);

/** What each kind is, for the Settings page. */
export const PREF_LABELS: { key: Exclude<keyof NotePrefs, "digest_hour">; label: string; hint: string }[] = [
  { key: "analysis", label: "Call analysed", hint: "When a call is analysed (or could not be): who was in it, opportunities, follow-ups" },
  { key: "opportunity", label: "New opportunity", hint: "When a call brings a new deal" },
  { key: "stage", label: "Stage moves and thank-yous", hint: "When a later call moves a deal on, and when to thank the person who introduced them" },
  { key: "inbox", label: "Inbox", hint: "New people, or a new department idea, waiting for you" },
  { key: "due", label: "Follow-up reminders", hint: "A deal's next step is due today, or its date has passed" },
  { key: "quiet", label: "Gone quiet / stalled", hint: "No call with the person for 14 days, or no move for 3 weeks" },
  { key: "digest", label: "Day-end digest", hint: "One summary of the day, after the hour you choose" },
];
