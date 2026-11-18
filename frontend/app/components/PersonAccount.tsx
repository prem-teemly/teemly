"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { type From, sidebarFor, useOrigin, withFrom } from "../lib/origin";
import { formatClock } from "../lib/api";
import { inboxChanged } from "../lib/inbox";
import {
  type Commitment,
  type CommitmentView,
  type Interest,
  type Mention,
  type Note,
  type Opportunity,
  type Person,
  type PersonDetail,
  dayLabel,
  deletePerson,
  getCommitments,
  getPeople,
  getPerson,
  kindLabel,
  lengthLabel,
  maskPhone,
  moveConversation,
  savePhone,
  setCommitmentDone,
  whenLabel,
} from "../lib/people";
import ConversationPanel, { type PanelTab } from "./ConversationPanel";
import { FileTextIcon, FilterIcon, MapPinIcon, PhoneIcon, SparkleIcon, UploadIcon, WhatsAppIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { NotesTab, OpportunitiesTab } from "./PersonWork";
import PersonUpload, { ACCEPT } from "./PersonUpload";
import { DeptTag, PersonAvatar, ScorePill } from "./PeopleBits";
import DeptEditor from "./DeptEditor";

// A call's interest, in the same words as the person's (the points match the backend's INTEREST_POINTS).
const INTEREST_VALUE: Record<Interest, number | null> = { high: 90, medium: 65, low: 40, none: 10, unknown: null };
const INTEREST_LABEL: Record<Interest, string> = { high: "Very interested", medium: "Interested", low: "Slightly interested", none: "Not interested", unknown: "" };

const CONCERN_VALUE = { high: 80, medium: 55, low: 30 } as const;

/** "Call · 22 min · today 6:12 PM" or "WhatsApp · 14 messages · 8 Nov 4:30 PM" (upload time). */
function mentionTitle(m: Mention): string {
  const parts = [m.kind === "whatsapp" ? "WhatsApp" : "Call"];
  if (m.kind === "audio" && m.duration_seconds) parts.push(lengthLabel(m.duration_seconds));
  if (m.kind === "whatsapp" && m.message_count != null) parts.push(`${m.message_count} message${m.message_count === 1 ? "" : "s"}`);
  parts.push(whenLabel(m.at));
  return parts.join(" · ");
}

/** "Interested · 2 commitments · 1 new person · TD meeting agreed". */
function mentionLine(m: Mention): string {
  const parts: string[] = [];
  if (m.tone) parts.push(m.tone);
  if (m.commitment_count) parts.push(`${m.commitment_count} commitment${m.commitment_count === 1 ? "" : "s"}`);
  if (m.new_people) parts.push(`${m.new_people} new ${m.new_people === 1 ? "person" : "people"}`);
  if (m.headline) parts.push(m.headline.length > 70 ? `${m.headline.slice(0, 68).trimEnd()}…` : m.headline);
  return parts.join(" · ");
}

type Open = { job: string; tab: PanelTab; autoplay: boolean };

// --- Timeline filter (top right of the tabs, Timeline tab only)
// (No "Type" filter: only calls are uploaded now. A chat analysed before chat upload was removed still
// shows on the timeline.)
type TimelineFilter = {
  interest: "all" | "high" | "medium" | "low";
  relation: "all" | "participant" | "mentioned";
  days: 0 | 7 | 30 | 90; // 0 = any time
};
const NO_FILTER: TimelineFilter = { interest: "all", relation: "all", days: 0 };
const FILTER_GROUPS: { key: keyof TimelineFilter; label: string; options: { value: TimelineFilter[keyof TimelineFilter]; label: string }[] }[] = [
  { key: "interest", label: "Interest", options: [{ value: "all", label: "All" }, { value: "high", label: "High" }, { value: "medium", label: "Some" }, { value: "low", label: "Low" }] },
  { key: "relation", label: "Role", options: [{ value: "all", label: "All" }, { value: "participant", label: "Took part" }, { value: "mentioned", label: "Talked about" }] },
  { key: "days", label: "When", options: [{ value: 0, label: "Any time" }, { value: 7, label: "7 days" }, { value: 30, label: "30 days" }, { value: 90, label: "90 days" }] },
];
const activeFilters = (f: TimelineFilter) => (Object.keys(NO_FILTER) as (keyof TimelineFilter)[]).filter((k) => f[k] !== NO_FILTER[k]).length;

function applyFilter(mentions: Mention[], f: TimelineFilter): Mention[] {
  const since = f.days ? Date.now() - f.days * 86_400_000 : 0;
  return mentions.filter(
    (m) =>
      (f.interest === "all" || m.interest === f.interest) &&
      (f.relation === "all" || m.relation === f.relation) &&
      (!since || new Date(m.at).getTime() >= since),
  );
}

function TimelineFilterMenu({ value, onChange }: { value: TimelineFilter; onChange: (f: TimelineFilter) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const count = activeFilters(value);
  return (
    <div className="pa-filter" ref={box}>
      <button type="button" className={`pa-filter-btn ${count ? "pa-filter-btn-on" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <FilterIcon size={13} /> Filter
        {count > 0 && <span className="pa-filter-count">{count}</span>}
      </button>
      {open && (
        <div className="pa-filter-pop" role="dialog" aria-label="Filter timeline">
          {FILTER_GROUPS.map((g) => (
            <div key={g.key} className="pa-filter-group">
              <p className="pa-filter-label">{g.label}</p>
              <div className="pa-filter-opts">
                {g.options.map((o) => (
                  <button key={String(o.value)} type="button" className="pa-filter-opt" aria-pressed={value[g.key] === o.value} onClick={() => onChange({ ...value, [g.key]: o.value })}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="pa-filter-foot">
            <button type="button" className="pw-link pa-muted-link" disabled={!count} onClick={() => onChange(NO_FILTER)}>
              Clear filters
            </button>
            <button type="button" className="pa-chip-btn" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Timeline({
  mentions,
  personName,
  personId,
  filtered,
  onClearFilter,
  onOpportunities,
  opportunities,
  from,
  onMove,
}: {
  mentions: Mention[];
  personName: string;
  personId: string;
  filtered: boolean;
  onClearFilter: () => void;
  onOpportunities: () => void;
  /** The person's opportunities: each call links to the ones that came from it. */
  opportunities: Opportunity[];
  from: From;
  onMove: (m: Mention) => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  if (!mentions.length)
    return filtered ? (
      <p className="pa-empty">
        No conversations match these filters.{" "}
        <button type="button" className="pw-link" onClick={onClearFilter}>
          Clear filters
        </button>
      </p>
    ) : (
      <p className="pa-empty">No calls with this person yet.</p>
    );
  const toggle = (job: string, tab: PanelTab, autoplay = false) => setOpen((o) => (o?.job === job && o.tab === tab && !autoplay ? null : { job, tab, autoplay }));
  return (
    // Only the list of calls scrolls (the tabs and the filter above it stay put); focusable so the
    // keyboard can scroll it too.
    <div className="pa-tl-scroll" role="region" aria-label={`Calls with ${personName}`} tabIndex={0}>
    <ol className="pa-timeline">
      {mentions.map((m, i) => {
        const line = mentionLine(m);
        const isOpen = open?.job === m.job_id;
        return (
          <li key={m.job_id} className="pa-tl-item">
            <div className="pa-tl-head">
              <span className={`pa-tl-icon ${i === 0 ? "pa-tl-icon-on" : ""}`} aria-hidden="true">
                {m.kind === "whatsapp" ? <WhatsAppIcon size={15} /> : <PhoneIcon size={15} />}
              </span>
              <span className="pa-tl-text">
                <span className="pa-tl-title" title={m.file_name}>
                  <Link href={withFrom(`/people/${personId}/calls/${m.job_id}`, from)}>{mentionTitle(m)}</Link>
                </span>
                {line && <span className="pa-tl-detail">{line}</span>}
                <span className="pa-tl-about">{m.context}</span>
                <span className="pa-tl-chips">
                  <span className="pa-chip">{m.relation === "participant" ? "Took part" : "Talked about"}</span>
                  {m.introduced_by_name && <span className="pa-chip">Introduced by {m.introduced_by_name}</span>}
                  {m.interest !== "unknown" && <span className={`pa-chip pa-chip-${m.interest}`}>{INTEREST_LABEL[m.interest]}</span>}
                  {(() => {
                    // One opportunity from this call: straight to its page; several: the Opportunities tab.
                    const fromCall = opportunities.filter((o) => o.source?.job_id === m.job_id);
                    if (fromCall.length === 1)
                      return (
                        <Link href={withFrom(`/opportunities/${fromCall[0].id}`, "person")} className="pa-chip pa-chip-opp" title={`View opportunity: ${fromCall[0].title}`}>
                          <SparkleIcon size={10} /> {fromCall[0].title} →
                        </Link>
                      );
                    const n = fromCall.length || m.opportunity_count || 0;
                    return n ? (
                      <button type="button" className="pa-chip pa-chip-opp" onClick={onOpportunities} title="Open the opportunities from this conversation">
                        <SparkleIcon size={10} /> {n} opportunit{n === 1 ? "y" : "ies"}
                      </button>
                    ) : null;
                  })()}
                </span>
              </span>
            </div>
            <div className="pa-tl-actions">
              {m.kind === "audio" && (
                <button type="button" className="pa-chip-btn" onClick={() => toggle(m.job_id, "transcript", true)}>
                  <span aria-hidden="true">▷</span> Play
                </button>
              )}
              <button type="button" className="pa-chip-btn" aria-pressed={isOpen && open.tab === "transcript"} onClick={() => toggle(m.job_id, "transcript")}>
                <FileTextIcon size={12} /> {m.kind === "whatsapp" ? "Chat" : "Transcript"}
              </button>
              <button type="button" className="pa-chip-btn" aria-pressed={isOpen && open.tab === "analysis"} onClick={() => toggle(m.job_id, "analysis")}>
                <SparkleIcon size={12} /> Analysis
              </button>
              <Link href={withFrom(`/people/${personId}/calls/${m.job_id}`, from)} className="pa-chip-btn">
                Open {m.kind === "whatsapp" ? "chat" : "call"} →
              </Link>
              <button type="button" className="pa-chip-btn pa-chip-move" onClick={() => onMove(m)} title={`This ${m.kind === "whatsapp" ? "chat" : "call"} is about a different ${personName}`}>
                Wrong person?
              </button>
              {isOpen && (
                <button type="button" className="pa-chip-btn pa-chip-close" onClick={() => setOpen(null)}>
                  Close
                </button>
              )}
            </div>
            {isOpen && (
              <ConversationPanel key={m.job_id} mention={m} personName={personName} tab={open.tab} autoplay={open.autoplay} onTab={(t) => setOpen({ job: m.job_id, tab: t, autoplay: false })} />
            )}
          </li>
        );
      })}
    </ol>
    </div>
  );
}

/**
 * "Wrong person?": this conversation is about someone else with the same name. Move it to the right
 * person in People, or send it to the inbox to add them as someone new. Its deals go with it.
 */
function MoveDialog({ personId, personName, mention, from, onDone, onClose }: { personId: string; personName: string; mention: Mention; from: From; onDone: (msg: string, href?: string) => void; onClose: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getPeople().then(
      (ps) => setPeople(ps.filter((p) => p.id !== personId)),
      (e) => setError(e instanceof Error ? e.message : "Could not load People."),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [personId, onClose]);
  // People with the same first name first: the usual reason for a call on the wrong timeline.
  const first = personName.split(" ")[0].toLowerCase();
  const sorted = [...(people ?? [])].sort((a, b) => Number(b.name.split(" ")[0].toLowerCase() === first) - Number(a.name.split(" ")[0].toLowerCase() === first) || a.name.localeCompare(b.name));
  const kind = mention.kind === "whatsapp" ? "chat" : "call";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!pick) return setError("Choose who this is about.");
    setBusy(true);
    setError(null);
    try {
      if (pick === "inbox") {
        await moveConversation(personId, mention.job_id, { to: "inbox" });
        inboxChanged();
        onDone(`The ${kind} is in the Inbox: add the right ${personName} there (“Someone new”).`, "/inbox");
      } else {
        await moveConversation(personId, mention.job_id, { person_id: pick });
        const to = people?.find((p) => p.id === pick);
        onDone(`Moved to ${to?.name ?? "the other person"}.`, withFrom(`/people/${pick}`, from));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move it.");
      setBusy(false);
    }
  }
  return (
    <div className="ib-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ib-dialog" role="dialog" aria-modal="true" aria-labelledby="mv-title">
        <div className="ib-dialog-head">
          <h2 id="mv-title" className="ib-dialog-title">
            Is this {kind} about a different {personName}?
          </h2>
          <button type="button" className="ib-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="ib-form" onSubmit={(e) => void save(e)}>
          <p className="ib-why">
            “{mention.file_name}” · {whenLabel(mention.at)}. It leaves {personName}&apos;s timeline together with its deals; what only this {kind} said about them (city, company, department) is taken off.
          </p>
          <div className="ib-choices" role="radiogroup" aria-label="Who is it about">
            <label className={`ib-choice ${pick === "inbox" ? "ib-choice-on" : ""}`}>
              <input type="radio" name="mv" value="inbox" checked={pick === "inbox"} onChange={() => setPick("inbox")} />
              <span className="ib-choice-main">
                <strong>Someone new</strong>
                <span>Not in People yet: send it to the Inbox and add them there</span>
              </span>
            </label>
            {!people && !error && <p className="pa-empty">Loading People…</p>}
            {sorted.map((p) => (
              <label key={p.id} className={`ib-choice ${pick === p.id ? "ib-choice-on" : ""}`}>
                <input type="radio" name="mv" value={p.id} checked={pick === p.id} onChange={() => setPick(p.id)} />
                <PersonAvatar name={p.name} initials={p.initials} />
                <span className="ib-choice-main">
                  <strong>{p.name}</strong>
                  <span>{[p.role_title, p.organisation, p.city].filter(Boolean).join(" · ") || "No details yet"}</span>
                </span>
              </label>
            ))}
          </div>
          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}
          <div className="ib-actions">
            <button type="button" className="pa-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="pa-btn pa-btn-primary" disabled={busy || !pick}>
              {busy ? "Moving…" : pick === "inbox" ? "Send to Inbox" : "Move"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Commitments: the promises from their conversations. Five at first, the most pressing first (late
// ones in red, then by due day); "Load more" asks the server for the next ten, "Show less" goes back to
// five. Chips: all open / theirs (they owe you) / yours (you owe them) / done. The due day is counted
// from the day of the call ("today" said on 13 Nov is 13 Nov), as on Today's follow-ups.
const COMMITMENTS_FIRST = 5;
const COMMITMENT_VIEWS: { id: CommitmentView; label: string; empty: string }[] = [
  { id: "open", label: "All open", empty: "Nothing open." },
  { id: "theirs", label: "Theirs", empty: "They owe you nothing right now." },
  { id: "yours", label: "Yours", empty: "You owe them nothing right now." },
  { id: "done", label: "Done", empty: "Nothing ticked off yet." },
];

function commitmentDue(c: Commitment): { text: string; late: boolean } {
  if (c.done) return { text: `Done ${c.done_at ? dayLabel(c.done_at) : ""}`.trim(), late: false };
  const d = c.due_in_days;
  if (d === null || d === undefined || !c.due_date) return { text: c.due ? `Due ${c.due}` : "No due date", late: false };
  if (d < 0) return { text: `${-d} day${d === -1 ? "" : "s"} late · was due ${shortDay(c.due_date)}`, late: true };
  if (d === 0) return { text: "Due today", late: false };
  if (d === 1) return { text: "Due tomorrow", late: false };
  return { text: `Due ${shortDay(c.due_date)}`, late: false };
}
const shortDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function Commitments({ personId, first, page }: { personId: string; first: Commitment[]; page?: PersonDetail["commitments_page"] }) {
  const [view, setView] = useState<CommitmentView>("open");
  const [list, setList] = useState(first);
  const [total, setTotal] = useState(page?.total ?? first.length);
  const [counts, setCounts] = useState(page?.counts ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0); // an older answer never replaces a newer one

  async function load(v: CommitmentView, offset: number, limit: number) {
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const r = await getCommitments(personId, v, offset, limit);
      if (ticket !== request.current) return;
      setList((xs) => (offset === 0 ? r.items : [...xs, ...r.items.filter((x) => !xs.some((y) => y.id === x.id))]));
      setTotal(r.total);
      setCounts(r.counts);
    } catch (e) {
      if (ticket === request.current) setError(e instanceof Error ? e.message : "Could not load.");
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }
  function pick(v: CommitmentView) {
    if (v === view && list.length <= COMMITMENTS_FIRST) return;
    setView(v);
    void load(v, 0, COMMITMENTS_FIRST);
  }

  async function toggle(c: Commitment) {
    const done = !c.done;
    const ids = c.ids?.length ? c.ids : [c.id];
    setError(null);
    // Stays in the list (struck through) so it can be undone; the counts move at once.
    setList((xs) => xs.map((x) => (x.id === c.id ? { ...x, done, done_at: done ? new Date().toISOString() : null } : x)));
    const shift = (n: number) =>
      setCounts((k) => (k ? { ...k, open: k.open - n, done: k.done + n, ...(c.yours ? { yours: k.yours - n } : { theirs: k.theirs - n }) } : k));
    shift(done ? 1 : -1);
    try {
      for (const id of ids) await setCommitmentDone(id, done);
    } catch (e) {
      setList((xs) => xs.map((x) => (x.id === c.id ? c : x)));
      shift(done ? -1 : 1);
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  const all = counts ? counts.open + counts.done : list.length;
  if (!all && !loading) return <p className="pa-empty">No commitments yet.</p>;
  const left = Math.max(0, total - list.length);
  const empty = COMMITMENT_VIEWS.find((x) => x.id === view)?.empty ?? "";
  return (
    <>
      {counts && (
        <div className="pa-commit-views" role="group" aria-label="Show commitments">
          {COMMITMENT_VIEWS.map((x) => (
            <button key={x.id} type="button" className={`pa-commit-view ${view === x.id ? "pa-commit-view-on" : ""}`} aria-pressed={view === x.id} onClick={() => pick(x.id)}>
              {x.label} <span>{counts[x.id]}</span>
            </button>
          ))}
        </div>
      )}
      {list.length ? (
        <ul className="pa-commitments" aria-busy={loading}>
          {list.map((c) => {
            const due = commitmentDue(c);
            return (
              <li key={c.id}>
                <label className={`pa-commit ${c.done ? "pa-commit-done" : ""} ${due.late ? "pa-commit-late" : ""}`}>
                  <input type="checkbox" checked={c.done} onChange={() => void toggle(c)} />
                  <span>
                    <span className="pa-commit-text">
                      {c.who ? `${c.who}: ` : ""}
                      {c.task}
                    </span>
                    <span className="pa-commit-due">
                      {due.text}
                      {(c.calls ?? 1) > 1 ? ` · said in ${c.calls} calls` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pa-empty">{loading ? "Loading…" : empty}</p>
      )}
      {(left > 0 || list.length > COMMITMENTS_FIRST) && (
        <div className="td-fu-more">
          {left > 0 && (
            <button type="button" className="td-more" disabled={loading} aria-busy={loading} onClick={() => void load(view, list.length, 10)}>
              {loading ? "Loading…" : `Load more (${left})`}
            </button>
          )}
          {list.length > COMMITMENTS_FIRST && (
            <button type="button" className="td-more" onClick={() => setList((xs) => xs.slice(0, COMMITMENTS_FIRST))}>
              Show less
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="pa-empty" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

// --- People they introduced: the newest five, "Show all (12)" for the rest (the list is small and
// already loaded with the page, so nothing more is asked of the server). A line of departments on top.
const INTRODUCED_FIRST = 5;
function Introduced({ people, from }: { people: PersonDetail["introduced"]; from: From | null }) {
  const [all, setAll] = useState(false);
  if (!people.length) return <p className="pa-empty">No introductions yet.</p>;
  const byDept = new Map<string, number>();
  for (const p of people) {
    const d = p.departments[0] ?? "No department yet";
    byDept.set(d, (byDept.get(d) ?? 0) + 1);
  }
  const shown = all ? people : people.slice(0, INTRODUCED_FIRST);
  return (
    <>
      {people.length > INTRODUCED_FIRST && (
        <p className="pa-intro-sum">
          {[...byDept.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([d, n]) => `${d} ${n}`)
            .join(" · ")}
        </p>
      )}
      <ul className="pa-intro">
        {shown.map((r) => (
          <li key={r.id}>
            <Link href={withFrom(`/people/${r.id}`, from)} className="pa-intro-row">
              <PersonAvatar name={r.name} initials={r.initials} />
              <span className="pa-intro-name">{r.name}</span>
              {r.departments[0] && <DeptTag dept={r.departments[0]} />}
              <span className="pa-stage">{r.category ?? "Not clear yet"}</span>
            </Link>
          </li>
        ))}
      </ul>
      {people.length > INTRODUCED_FIRST && (
        <div className="td-fu-more">
          <button type="button" className="td-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
            {all ? "Show less" : `Show all (${people.length})`}
          </button>
        </div>
      )}
    </>
  );
}

/** Interest and concerns in the last six conversations, oldest to newest. */
function InterestTrend({ mentions }: { mentions: Mention[] }) {
  const last = [...mentions].reverse().slice(-6);
  const interest = last.map((m) => INTEREST_VALUE[m.interest]);
  const concern = last.map((m) => (m.concern ? CONCERN_VALUE[m.concern] : null));
  const known = interest.filter((v) => v !== null).length;
  if (last.length < 2 || known < 2) return <p className="pa-empty">Shown after two or more conversations.</p>;
  const W = 300;
  const H = 80;
  const x = (i: number) => ((i / (last.length - 1)) * (W - 8) + 4).toFixed(1);
  const y = (v: number) => (H - 6 - (v / 100) * (H - 12)).toFixed(1);
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter((p): p is string => p !== null);
  const pi = path(interest);
  const pc = path(concern);
  const dot = (pts: string[]) => pts.at(-1)!.split(",").map(Number);
  const [ix, iy] = dot(pi);
  return (
    <>
      <svg className="pa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Interest and concerns across the last conversations">
        <polyline points={pi.join(" ")} fill="none" className="pa-line-interest" />
        <circle cx={ix} cy={iy} r="3" className="pa-dot-interest" />
        {pc.length >= 2 && (
          <>
            <polyline points={pc.join(" ")} fill="none" className="pa-line-caution" />
            <circle cx={dot(pc)[0]} cy={dot(pc)[1]} r="3" className="pa-dot-caution" />
          </>
        )}
      </svg>
      <p className="pa-legend">
        <span className="pa-key pa-key-interest" /> Interest
        {pc.length >= 2 && (
          <>
            <span className="pa-key pa-key-caution" /> Concerns
          </>
        )}
      </p>
    </>
  );
}

export default function PersonAccount({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"timeline" | "opportunities" | "files" | "notes">("timeline");
  const [filter, setFilter] = useState<TimelineFilter>(NO_FILTER);
  const [notes, setNotes] = useState<Note[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [upload, setUpload] = useState<{ file: File; key: number } | null>(null);
  const [phoneEdit, setPhoneEdit] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Mention | null>(null);
  const [moved, setMoved] = useState<{ text: string; href?: string } | null>(null);
  const closeMove = useCallback(() => setMoving(null), []);
  const fileInput = useRef<HTMLInputElement>(null);
  // Opened from Departments (?from=…): the breadcrumb, "back" and the sidebar lead back there.
  const origin = useOrigin();
  const back = origin.crumbs[origin.crumbs.length - 1];
  const sidebar = sidebarFor(origin.from);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getPerson(id);
      setData(d);
      setNotes(d.notes ?? []);
      setOpportunities(d.opportunities ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this person.");
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);
  // A file added with "Add file" is on the timeline: reload to show it.
  const onAdded = useCallback(() => {
    setTab("timeline");
    void load();
  }, [load]);

  async function savePhoneNumber() {
    if (phoneBusy || phoneEdit === null) return;
    setPhoneBusy(true);
    setPhoneError(null);
    try {
      const phone = await savePhone(id, phoneEdit.trim() ? phoneEdit : null);
      setData((d) => (d ? { ...d, person: { ...d.person, phone } } : d));
      setPhoneEdit(null);
    } catch (e) {
      setPhoneError(e instanceof Error ? e.message : "Could not save the number.");
    } finally {
      setPhoneBusy(false);
    }
  }

  async function remove() {
    if (!data) return;
    if (!window.confirm(`Delete ${data.person.name} and everything stored about them? The calls themselves are not deleted.`)) return;
    setDeleting(true);
    try {
      await deletePerson(id);
      router.replace(back.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
      setDeleting(false);
    }
  }

  if (error || !data) {
    return (
      <PeopleChrome active={sidebar}>
        <div className="card pl-state" role={error ? "alert" : undefined} aria-busy={!error}>
          {error ? (
            <>
              <p>{error}</p>
              <Link href={back.href} className="pl-view">
                Back to {back.label}
              </Link>
            </>
          ) : (
            <span className="auth-spinner" />
          )}
        </div>
      </PeopleChrome>
    );
  }

  const { person, mentions, introduced } = data;
  const commitments = data.commitments ?? []; // older backends do not send commitments
  const tags = [person.category ?? "Category not clear yet", person.role_title, person.organisation].filter((t): t is string => !!t);
  const files = [...new Map(mentions.map((m) => [m.job_id, m])).values()];

  return (
    <PeopleChrome active={sidebar}>
      <nav className="pa-crumbs" aria-label="Breadcrumb">
        {origin.crumbs.map((c) => (
          <Fragment key={c.href}>
            <Link href={c.href}>{c.label}</Link> <span aria-hidden="true">›</span>{" "}
          </Fragment>
        ))}
        <span>{person.name}</span>
      </nav>

      <section className="card pa-head">
        <div className="pa-who">
          <PersonAvatar name={person.name} initials={person.initials} size="lg" />
          <div className="pa-who-main">
            <div className="pa-name-row">
              <h1 className="pa-name">{person.name}</h1>
              {tags.map((t) => (
                <span key={t} className="pa-tag">
                  {t}
                </span>
              ))}
            </div>
            <div className="pa-facts">
              {phoneEdit === null ? (
                <button type="button" className="pa-fact pa-phone" onClick={() => setPhoneEdit(person.phone ?? "")} title={person.phone ? "Change number" : "Add their number"}>
                  <PhoneIcon size={13} /> {person.phone ? maskPhone(person.phone) : "Add number"}
                </button>
              ) : (
                <span className="pa-phone-edit">
                  <PhoneIcon size={13} />
                  <input
                    value={phoneEdit}
                    inputMode="tel"
                    maxLength={24}
                    placeholder="+91 98765 43210"
                    aria-label="Phone number"
                    autoFocus
                    onChange={(e) => setPhoneEdit(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void savePhoneNumber();
                      if (e.key === "Escape") setPhoneEdit(null);
                    }}
                  />
                  <button type="button" className="pw-link" disabled={phoneBusy} onClick={() => void savePhoneNumber()}>
                    {phoneBusy ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="pw-link pa-muted-link" disabled={phoneBusy} onClick={() => (setPhoneEdit(null), setPhoneError(null))}>
                    Cancel
                  </button>
                </span>
              )}
              <span className="pa-fact">
                <MapPinIcon size={13} /> {person.city ?? "City not known"}
              </span>
              {person.departments.map((d) => (
                <DeptTag key={d} dept={d} />
              ))}
              <DeptEditor
                personId={person.id}
                name={person.name}
                current={person.departments}
                dealDepartments={[...new Set(opportunities.filter((o) => o.stage !== "Won" && o.stage !== "Lost" && o.department).map((o) => o.department as string))]}
                onSaved={(departments) => setData((d) => (d ? { ...d, person: { ...d.person, departments } } : d))}
              />
              <span className={`pl-consent pl-consent-${person.consent.toLowerCase()}`}>{person.consent === "Yes" ? "✓ Consent" : person.consent === "No" ? "No consent" : "Consent: Ask"}</span>
              {person.introduced_by && (
                <span className="pa-fact">
                  Introduced by <Link href={withFrom(`/people/${person.introduced_by.id}`, origin.from)}>{person.introduced_by.name}</Link>
                </span>
              )}
            </div>
            {phoneError && (
              <p className="pw-error pa-phone-error" role="alert">
                {phoneError}
              </p>
            )}
          </div>
          <div className="pa-actions">
            <ScorePill score={person.score} calls={person.mention_count} />
            <button type="button" className="pa-btn pa-btn-primary pw-btn" onClick={() => fileInput.current?.click()}>
              <UploadIcon size={14} /> Add file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              hidden
              aria-label={`Add a call recording for ${person.name}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) {
                  setTab("timeline");
                  setUpload({ file: f, key: Date.now() });
                }
              }}
            />
          </div>
        </div>
        {person.summary && (
          <div className="pa-snapshot">
            {person.mention_count === 0 ? (
              <p className="pa-snap-label">Your note · added by you {dayLabel(person.first_seen_at).toLowerCase()} · no call yet</p>
            ) : (
              <p className="pa-snap-label">
                <SparkleIcon size={12} /> AI snapshot · from {person.mention_count} conversation{person.mention_count === 1 ? "" : "s"} · last contact {dayLabel(person.last_contact_at).toLowerCase()} · {kindLabel(person.last_contact_kind)}
              </p>
            )}
            <p className="pa-snap-text">{person.summary}</p>
          </div>
        )}
      </section>

      <div className="pa-grid">
        <section className="card pa-main" aria-label="Activity">
          <div className="pa-tabs" role="tablist">
            {[
              { id: "timeline" as const, label: "Timeline" },
              { id: "opportunities" as const, label: `Opportunities ${opportunities.length}` },
              { id: "files" as const, label: `Files ${files.length}` },
              { id: "notes" as const, label: `Notes ${notes.length}` },
            ].map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`pa-tab ${tab === t.id ? "pa-tab-on" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
            {tab === "timeline" && mentions.length > 0 && <TimelineFilterMenu value={filter} onChange={setFilter} />}
          </div>
          {upload && <PersonUpload key={upload.key} personId={person.id} personName={person.name} file={upload.file} onAdded={onAdded} onClose={() => setUpload(null)} />}
          {moved && (
            <div className="ib-notice" role="status">
              <span>{moved.text}</span>
              {moved.href && <Link href={moved.href}>{moved.href === "/inbox" ? "Open Inbox" : "Open"}</Link>}
              <button type="button" aria-label="Dismiss" onClick={() => setMoved(null)}>
                ×
              </button>
            </div>
          )}
          {moving && (
            <MoveDialog
              personId={person.id}
              personName={person.name}
              mention={moving}
              from={origin.from}
              onClose={closeMove}
              onDone={(text, href) => {
                setMoving(null);
                setMoved({ text, href });
                void load();
              }}
            />
          )}
          {tab === "timeline" && (
            <Timeline mentions={applyFilter(mentions, filter)} personName={person.name} personId={person.id} filtered={activeFilters(filter) > 0} onClearFilter={() => setFilter(NO_FILTER)} onOpportunities={() => setTab("opportunities")} opportunities={opportunities} from={origin.from} onMove={setMoving} />
          )}
          {tab === "opportunities" && <OpportunitiesTab personId={person.id} items={opportunities} mentions={mentions} onChange={setOpportunities} from={origin.from} />}
          {tab === "notes" && <NotesTab personId={person.id} notes={notes} onChange={setNotes} />}
          {tab === "files" &&
            (files.length ? (
              <ul className="pa-list">
                {files.map((f) => (
                  <li key={f.job_id}>
                    <span className="pa-list-title">
                      <FileTextIcon size={13} /> {f.file_name}
                    </span>
                    <span className="pa-list-detail">
                      {f.kind === "whatsapp" ? "Chat export" : "Call recording"}
                      {f.duration_seconds ? ` · ${formatClock(f.duration_seconds)}` : ""} · {dayLabel(f.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pa-empty">No files yet.</p>
            ))}
        </section>

        <div className="pa-side">
          <section className="card pa-card" aria-label="People introduced">
            <h2 className="pa-card-title">People they introduced</h2>
            <Introduced key={person.id} people={introduced} from={origin.from} />
          </section>

          <section className="card pa-card" aria-label="Commitments">
            <h2 className="pa-card-title">Commitments</h2>
            <Commitments key={person.id} personId={person.id} first={commitments} page={data.commitments_page} />
          </section>

          <section className="card pa-card" aria-label="Interest across conversations">
            <h2 className="pa-card-title">Across the last {Math.min(6, mentions.length) > 1 ? `${Math.min(6, mentions.length)} ` : ""}conversations</h2>
            <InterestTrend mentions={mentions} />
          </section>
        </div>
      </div>
      <p className="pa-delete-row">
        <button type="button" className="pw-link pw-link-danger" onClick={() => void remove()} disabled={deleting}>
          {deleting ? "Deleting…" : `Delete ${person.name}`}
        </button>
      </p>
    </PeopleChrome>
  );
}
