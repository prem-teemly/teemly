"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { deptStyle } from "../lib/departments";
import { withFrom } from "../lib/origin";
import { dueLabel, interestOf, rupees, setCommitmentDone, stageClass, updateOpportunity } from "../lib/people";
import { type TodayData, getFollowUps, getInsights, getToday, getTopOpportunities, startOf } from "../lib/today";
import { AlertIcon, CheckIcon, SparkleIcon, TrendDownIcon, TrendUpIcon, UploadIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import SelectMenu from "./SelectMenu";
import { DeptTag, PersonAvatar, ScorePill } from "./PeopleBits";

// Today (design slide 7): the first screen every time the room opens. Everything comes from
// GET /api/today: counts from the database, and the calls being analysed right now. Nothing is made up;
// a section with nothing to show says so. "Overdue" (red) is only for deals with a due date in the past;
// commitments from calls show the due words that were spoken.

type Range = "today" | "week";
const RANGE_KEY = "teemly.today.range";
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not load Today.");

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "neg" }) {
  return (
    <div className="td-stat">
      <span className="td-stat-label">{label}</span>
      <strong className="td-stat-value">{value}</strong>
      {sub && <span className={`td-stat-sub ${tone === "neg" ? "td-neg" : ""}`}>{sub}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="td-empty">{children}</p>;
}

const NUDGE_LABEL: Record<TodayData["attention"][number]["kind"], string> = { overdue: "Overdue", quiet: "Gone quiet", committed: "Committed, not won", stalled: "Stalled" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Needs attention: the panel's nudges, full width, most important first. */
function Attention({ items }: { items: TodayData["attention"] }) {
  if (!items.length)
    return (
      <p className="td-allclear">
        <CheckIcon size={14} /> All clear: no deal is overdue, gone quiet or stalled.
      </p>
    );
  return (
    <section className="td-card td-attn" aria-labelledby="td-attn">
      <div className="td-card-head">
        <h2 id="td-attn">
          <AlertIcon size={15} /> Needs attention <span className="td-count">{items.length}</span>
        </h2>
        <Link href="/opportunity-panel" className="td-link">
          Opportunity panel
        </Link>
      </div>
      <ul className="td-attn-list">
        {items.map((n) => (
          <li key={`${n.kind}-${n.opportunity_id}`}>
            <span className={`td-tag td-tag-${n.kind}`}>{NUDGE_LABEL[n.kind]}</span>
            <span className="td-attn-text">{n.text}</span>
            <Link href={withFrom(`/opportunities/${n.opportunity_id}`, "today")} className="td-link">
              Open →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- AI insights already made on opportunity pages (this page never asks the AI: reading a deal is a
// Gemini call started on the deal's page). What needs you first: at-risk deals (the AI's chance below
// the stage's), then the biggest rupee change; stale ones last, greyed. Four at first; "Load more" asks
// the server for the next four. Deals not read yet: three named, "and N more" opens the full list.
const INSIGHTS_PAGE = 4;
const UNREAD_FIRST = 3;
type Insight = TodayData["insights"]["items"][number];

function Insights({ data }: { data: TodayData["insights"] }) {
  const [extra, setExtra] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allUnread, setAllUnread] = useState(false);
  const seen = new Set<string>();
  const items = [...data.items, ...extra].filter((i) => !seen.has(i.id) && !!seen.add(i.id));
  const left = Math.max(0, data.total - items.length);
  const unread = allUnread ? data.not_read_top : data.not_read_top.slice(0, UNREAD_FIRST);

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await getInsights(items.length, INSIGHTS_PAGE);
      setExtra((x) => [...x, ...page.items]);
    } catch (e) {
      setLoadError(message(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="td-card" aria-labelledby="td-ai">
      <div className="td-card-head">
        <h2 id="td-ai">
          <SparkleIcon size={14} /> AI insights
        </h2>
        <span className="td-faint">
          {data.total} of {data.total + data.not_read} open deals read
        </span>
      </div>
      <p className="td-card-sub">At-risk deals first, then the biggest change in expected rupees: the AI&apos;s chance vs the stage&apos;s, and what would help</p>
      {items.length === 0 ? (
        <Empty>No AI view yet. Open a deal and the AI reads its calls.</Empty>
      ) : (
        <ul className="td-ai" aria-live="polite">
          {items.map((i) => {
            const now = Math.round(i.chance * 100);
            const ai = i.suggested_chance_pct;
            const impact = i.impact_inr ?? null;
            return (
              <li key={i.id} className={i.stale ? "td-ai-old" : undefined}>
                <div className="td-ai-top">
                  <Link href={withFrom(`/opportunities/${i.id}`, "today")} className="td-ai-name">
                    {i.person.name} · {i.title}
                  </Link>
                  {ai !== null && (
                    <span className={`td-ai-chance ${ai > now ? "td-pos" : ai < now ? "td-neg" : ""}`} title="Chance now (stage or yours) → the AI's estimate">
                      {now}% → {ai}%
                      {impact !== null && impact !== 0 && (
                        <span className="td-ai-impact" title="What the AI's chance changes in expected rupees: (AI chance − chance now) × deal value">
                          {impact < 0 ? `−${rupees(-impact)} at risk` : `+${rupees(impact)}`}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {i.factor && (
                  <p className="td-ai-factor">
                    <span className={`td-level td-level-${i.factor.level.toLowerCase()}`}>{cap(i.factor.level)}</span> {i.factor.label}: {i.factor.reason}
                  </p>
                )}
                {i.would_change && <p className="td-ai-would">{i.would_change}</p>}
                {i.stale && <p className="td-ai-stale">Newer call since the AI read it. Open the deal to refresh.</p>}
              </li>
            );
          })}
        </ul>
      )}
      {(left > 0 || extra.length > 0) && (
        <div className="td-fu-more">
          {left > 0 && (
            <button type="button" className="td-more" disabled={loading} aria-busy={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : `Load more (${left})`}
            </button>
          )}
          {extra.length > 0 && (
            <button type="button" className="td-more" onClick={() => setExtra([])}>
              Show less
            </button>
          )}
        </div>
      )}
      {loadError && (
        <p className="td-faint" role="alert">
          {loadError}
        </p>
      )}
      {data.not_read > 0 && (
        <p className="td-ai-unread">
          Not read yet:{" "}
          {unread.map((o, k) => (
            <span key={o.id}>
              {k > 0 && ", "}
              <Link href={withFrom(`/opportunities/${o.id}`, "today")}>
                {o.person.name}
                {o.value_inr !== null ? ` (${rupees(o.value_inr)})` : ""}
              </Link>
            </span>
          ))}
          {data.not_read_top.length > UNREAD_FIRST && (
            <>
              {" "}
              <button type="button" className="td-more td-more-inline" aria-expanded={allUnread} onClick={() => setAllUnread((x) => !x)}>
                {allUnread ? "show less" : `and ${data.not_read_top.length - UNREAD_FIRST} more`}
              </button>
            </>
          )}
          {/* An older backend sends only three names: the rest as a count. */}
          {data.not_read > data.not_read_top.length && ` and ${data.not_read - data.not_read_top.length} more`}
        </p>
      )}
    </section>
  );
}

/** Stage movement in the period, net per deal. */
function Moves({ data, period }: { data: TodayData["moves"]; period: string }) {
  return (
    <section className="td-card" aria-labelledby="td-moves">
      <div className="td-card-head">
        <h2 id="td-moves">Stage movement</h2>
        <span className="td-faint">
          {data.forward} forward · {data.back} back
        </span>
      </div>
      {data.items.length === 0 ? (
        <Empty>
          No deal changed stage {period}.
          {data.unchanged > 0 && ` ${data.unchanged} ${data.unchanged === 1 ? "was" : "were"} moved and moved back.`}
        </Empty>
      ) : (
        <ul className="td-moves">
          {data.items.map((m) => (
            <li key={m.id}>
              <span className={`td-move-dir td-move-${m.direction}`} aria-hidden="true">
                {m.direction === "forward" ? "▲" : "▼"}
              </span>
              <span className="td-move-main">
                <Link href={withFrom(`/opportunities/${m.id}`, "today")} className="td-move-name">
                  {m.person.name} · {m.title}
                </Link>
                <span className="td-move-stages">
                  <span className={`pw-stage pw-stage-${stageClass(m.from)} dd-stage`}>{m.from}</span> →{" "}
                  <span className={`pw-stage pw-stage-${stageClass(m.to)} dd-stage`}>{m.to}</span>
                  <span className="td-faint"> · {m.by === "ai" ? "from a call" : "by you"}</span>
                </span>
              </span>
              {m.value_inr !== null && <span className="td-move-value">{rupees(m.value_inr)}</span>}
            </li>
          ))}
          {data.unchanged > 0 && (
            <li className="td-faint td-move-note">
              {data.unchanged} more {data.unchanged === 1 ? "was" : "were"} moved and moved back.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Inbox: people and departments found in calls, waiting for a decision. */
function InboxCard({ data }: { data: TodayData["inbox"] }) {
  const total = data.people + data.departments;
  return (
    <section className="td-card" aria-labelledby="td-inbox">
      <div className="td-card-head">
        <h2 id="td-inbox">
          Inbox {total > 0 && <span className="td-count">{total}</span>}
        </h2>
        <Link href="/inbox" className="td-link">
          Open Inbox
        </Link>
      </div>
      {total === 0 ? (
        <Empty>Nothing waiting. New people and department ideas from calls show here.</Empty>
      ) : (
        <ul className="td-inbox">
          {data.people > 0 && (
            <li>
              <strong>
                {data.people} new {data.people === 1 ? "person" : "people"}
              </strong>{" "}
              to add
              <span className="td-faint">
                {" "}
                · {data.people_names.join(", ")}
                {data.people > data.people_names.length ? "…" : ""}
              </span>
            </li>
          )}
          {data.departments > 0 && (
            <li>
              <strong>
                {data.departments} department {data.departments === 1 ? "idea" : "ideas"}
              </strong>
              <span className="td-faint"> · {data.department_names.join(", ")}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// (Department goals and department signals are not on Today: the signals repeated "Pipeline by
// department" without an action. The Departments page still shows the department facts.)

// --- Top opportunities: open deals ranked by value × chance × urgency. The first five come with the
// Today data; "Load more" asks the server for the next five (ranked and paged in MySQL).
const TOP_PAGE = 5;
type Top = TodayData["top"][number];

function TopOpportunities({ first, total }: { first: Top[]; total: number }) {
  const router = useRouter();
  const [extra, setExtra] = useState<Top[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seen = new Set<string>();
  const visible = [...first, ...extra].filter((o) => !seen.has(o.id) && !!seen.add(o.id));
  const left = Math.max(0, total - visible.length);
  const open = (id: string) => router.push(withFrom(`/opportunities/${id}`, "today"));

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await getTopOpportunities(visible.length, TOP_PAGE);
      setExtra((x) => [...x, ...page.items]);
    } catch (e) {
      setLoadError(message(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="td-card" aria-labelledby="td-top">
      <div className="td-card-head">
        <h2 id="td-top">Top opportunities</h2>
        <Link href="/opportunity-panel" className="td-link">
          Open panel
        </Link>
      </div>
      <p className="td-card-sub">
        Ranked by value × chance × how soon it is due{total > 0 ? ` · ${total} open ${total === 1 ? "deal" : "deals"}` : ""}
      </p>
      {visible.length === 0 ? (
        <Empty>No open opportunities yet. Upload a call and they appear here.</Empty>
      ) : (
        <ul className="td-top" aria-live="polite">
          {visible.map((o) => (
            <li key={o.id}>
              <div
                className="td-top-row"
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest("a, button")) open(o.id);
                }}
                onKeyDown={(e) => e.key === "Enter" && open(o.id)}
              >
                <PersonAvatar name={o.person.name} initials={o.person.initials} />
                <div className="td-top-main">
                  <div className="td-top-line">
                    <Link href={withFrom(`/opportunities/${o.id}`, "today")} className="td-top-name">
                      {o.person.name}
                    </Link>
                    {o.department && <DeptTag dept={o.department} />}
                    <span className={`pw-stage pw-stage-${stageClass(o.stage)} dd-stage`}>{o.stage}</span>
                  </div>
                  <p className="td-top-sub">
                    {o.title}
                    {o.value_inr !== null && ` · ${rupees(o.value_inr)}`}
                    {` · ${Math.round(o.chance * 100)}% chance`}
                  </p>
                  {o.reason && (
                    <p className="td-top-reason">
                      <SparkleIcon size={12} /> {o.reason.speaker ? `${o.reason.speaker}: ` : ""}“{o.reason.text}”
                    </p>
                  )}
                </div>
                <div className="td-top-next">
                  {o.overdue ? (
                    <span className="td-neg">Overdue{o.due_date ? ` · ${dueLabel(o.due_date)}` : ""}</span>
                  ) : o.due_date ? (
                    <span>{o.urgency ?? `Due ${dueLabel(o.due_date)}`}</span>
                  ) : (
                    <span className="td-faint">No due date</span>
                  )}
                  {o.next_step && <span className="td-top-step">{o.next_step}</span>}
                </div>
                <ScorePill score={o.person.score} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {(left > 0 || extra.length > 0) && (
        <div className="td-fu-more">
          {left > 0 && (
            <button type="button" className="td-more" disabled={loading} aria-busy={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : `Load more (${left})`}
            </button>
          )}
          {extra.length > 0 && (
            <button type="button" className="td-more" onClick={() => setExtra([])}>
              Show less
            </button>
          )}
        </div>
      )}
      {loadError && (
        <p className="pw-error" role="alert">
          {loadError}
        </p>
      )}
    </section>
  );
}

// --- Follow-ups: what you promised, what others owe you, and what is late (in red). A to-do list: it
// does not open other pages; ticking one marks it done. The first five come with the Today data;
// "Load more" asks the server for the next five (paged in MySQL, like notifications).
const FU_PAGE = 5;
type FollowUp = TodayData["follow_ups"][number];

/** "by Thu", "due today", "3 days late", or the words said in the call ("Friday"). */
function dueOf(f: FollowUp): { text: string | null; late: boolean } {
  if (f.due_date) {
    const [y, m, d] = f.due_date.split("-").map(Number);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000);
    if (days < 0) return { text: `${-days} ${days === -1 ? "day" : "days"} late`, late: true };
    if (days === 0) return { text: "due today", late: false };
    if (days === 1) return { text: "by tomorrow", late: false };
    if (days < 7) return { text: `by ${new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short" })}`, late: false };
    return { text: `by ${dueLabel(f.due_date)}`, late: false };
  }
  if (f.overdue) return { text: "late", late: true };
  return { text: f.due_text, late: false };
}

function FollowUps({ items, total, onDone }: { items: FollowUp[]; total: number; onDone: (f: FollowUp) => Promise<void> }) {
  const [extra, setExtra] = useState<FollowUp[]>([]); // pages loaded after the first
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const keyOf = (f: FollowUp) => `${f.kind}-${f.id}`;
  // The first page (refreshed with Today) and the pages loaded since, each item once.
  const seen = new Set<string>();
  const visible = [...items, ...extra].filter((f) => !seen.has(keyOf(f)) && !!seen.add(keyOf(f)));
  const left = Math.max(0, total - visible.length);

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await getFollowUps(visible.length, FU_PAGE);
      setExtra((x) => [...x, ...page.items]);
    } catch (e) {
      setLoadError(message(e));
    } finally {
      setLoading(false);
    }
  }

  async function done(f: FollowUp) {
    const k = keyOf(f);
    setBusy((b) => new Set(b).add(k));
    try {
      await onDone(f);
      setExtra((x) => x.filter((y) => keyOf(y) !== k)); // the server list moved up by one as well
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(k);
        return n;
      });
    }
  }

  return (
    <section className="td-card" aria-labelledby="td-fu">
      <div className="td-card-head">
        <h2 id="td-fu">Follow-ups</h2>
        <span className="td-faint">{total} open</span>
      </div>
      {items.length === 0 ? (
        <Empty>No follow-ups. Next steps and promises from calls show here.</Empty>
      ) : (
        <ul className="td-fu" aria-live="polite">
          {visible.map((f) => {
            const due = dueOf(f);
            // Who: their name when they owe it; otherwise the person it is with (you promised it).
            const who = f.who === "them" ? `${f.by ?? f.person?.name ?? "They"} owes you` : (f.person?.name ?? "You");
            // Who they are: role and company, city (or the category when nothing else is known).
            const p = f.person;
            const role = p ? [[p.role_title, p.organisation].filter(Boolean).join(", "), p.city].filter(Boolean).join(" · ") || p.category || "" : "";
            // Why: the deal this step moves on, or the call where it was promised.
            const d = f.deal_info;
            const why = d
              ? { label: "Deal", text: [d.title, d.value_inr ? rupees(d.value_inr) : null, d.stage].filter(Boolean).join(" · ") }
              : f.source?.file_name
                ? { label: "From the call", text: [f.source.file_name, f.source.at ? new Date(f.source.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : null].filter(Boolean).join(" · ") }
                : null;
            return (
              <li key={keyOf(f)} className={due.late ? "td-fu-late" : ""}>
                <input type="checkbox" className="td-fu-check" aria-label={`Mark done: ${f.text}${p ? ` (${p.name})` : ""}`} disabled={busy.has(keyOf(f))} onChange={() => void done(f)} />
                <div className="td-fu-main">
                  <span className="td-fu-text">{f.text}</span>
                  {why && (
                    <span className="td-fu-why">
                      <span className="td-fu-why-label">{why.label}:</span> {why.text}
                    </span>
                  )}
                  <span className="td-fu-meta">
                    <span className="td-fu-who">{who}</span>
                    {role && <span className="td-fu-role"> · {role}</span>}
                    {due.text && <span className="td-fu-due"> · {due.text}</span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(left > 0 || extra.length > 0) && (
        <div className="td-fu-more">
          {left > 0 && (
            <button type="button" className="td-more" disabled={loading} aria-busy={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : `Load more (${left})`}
            </button>
          )}
          {extra.length > 0 && (
            <button type="button" className="td-more" onClick={() => setExtra([])}>
              Show less
            </button>
          )}
        </div>
      )}
      {loadError && (
        <p className="pw-error" role="alert">
          {loadError}
        </p>
      )}
    </section>
  );
}

export default function TodayPage() {
  const [range, setRange] = useState<Range>("today");
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Remember the range per browser (a convenience only).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RANGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read after hydration (browser storage)
      if (saved === "week" || saved === "today") setRange(saved);
    } catch {
      /* storage not available */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getToday(startOf(range));
      setData(d);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [range]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  // Poll: every 4 s while a call is being analysed, otherwise every 45 s.
  const active = data?.live.some((j) => j.status === "queued" || j.status === "processing") ?? false;
  useEffect(() => {
    const t = window.setInterval(() => void load(), active ? 4000 : 45000);
    return () => window.clearInterval(t);
  }, [active, load]);

  function changeRange(r: Range) {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* ignore */
    }
  }

  /** Tick a follow-up: a promise from a call is marked done; a deal's next step is cleared (done). */
  async function markDone(f: TodayData["follow_ups"][number]) {
    try {
      if (f.kind === "commitment") await setCommitmentDone(Number(f.id), true);
      else await updateOpportunity(String(f.id), { next_step: null });
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  const period = range === "today" ? "today" : "this week";
  const n = data?.numbers;

  return (
    <PeopleChrome active="today">
      <div className="pl-head td-head">
        <div>
          <h1 className="pl-title">
            {greeting()}
            {data?.owner ? `, ${data.owner}` : ""}
          </h1>
          <p className="pl-sub">
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
            {data && (
              <>
                {" · "}
                {data.analysed.calls} {data.analysed.calls === 1 ? "call" : "calls"} analysed {period}
              </>
            )}
          </p>
        </div>
        <div className="td-range">
          <SelectMenu
            ariaLabel="Period"
            value={range}
            options={[
              { value: "today", label: "Today" },
              { value: "week", label: "This week" },
            ]}
            onChange={(v) => changeRange(v as Range)}
          />
        </div>
      </div>

      {error && (
        <p className="td-error" role="alert">
          <AlertIcon size={14} /> {error}
        </p>
      )}

      {!data && !error && <p className="td-loading">Loading…</p>}

      {data && n && (
        <>
          <div className="td-stats">
            <Stat label="Open opportunities" value={String(n.open_opportunities)} sub={`${n.hot} very interested · ${n.new_opportunities} new ${period}`} />
            <Stat
              label="Investor pipeline"
              value={rupees(n.investor_pipeline_inr)}
              sub={`${rupees(n.investor_weighted_inr)} weighted · ${n.investors} ${n.investors === 1 ? "investor" : "investors"}`}
            />
            <Stat
              label="Follow-ups due"
              value={String(n.follow_ups)}
              sub={n.overdue > 0 ? `${n.overdue} overdue` : "None overdue"}
              tone={n.overdue > 0 ? "neg" : undefined}
            />
            <Stat
              label="New referrals"
              value={String(n.referrals)}
              sub={n.referrals_top_via ? `${n.referrals_top_via.count} via ${n.referrals_top_via.name}` : `None ${period}`}
            />
          </div>

          <Attention items={data.attention} />

          <div className="td-grid">
            <div className="td-col">
              <TopOpportunities first={data.top} total={data.top_total ?? data.top.length} />

              <Insights key={data.since} data={data.insights} />

              <Moves data={data.moves} period={period} />

              <section className="td-card" aria-labelledby="td-pipe">
                <div className="td-card-head">
                  <h2 id="td-pipe">Pipeline by department</h2>
                  <Link href="/departments" className="td-link">
                    Departments
                  </Link>
                </div>
                {data.pipeline.length === 0 ? (
                  <Empty>No open deal amounts yet.</Empty>
                ) : (
                  <ul className="td-pipe">
                    {data.pipeline.map((d) => {
                      const max = data.pipeline[0].open_value_inr || 1;
                      const c = deptStyle(d.color).color as string;
                      return (
                        <li key={d.slug}>
                          <Link href={`/departments/${d.slug}`} className="td-pipe-name">
                            {d.name}
                          </Link>
                          <span className="td-bar" aria-hidden="true">
                            <span style={{ width: `${Math.max(3, (d.open_value_inr / max) * 100)}%`, background: c }} />
                          </span>
                          <span className="td-pipe-value">
                            {rupees(d.open_value_inr)} <span className="td-faint">· {d.open} open</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            <div className="td-col">
              <section className="td-card" aria-labelledby="td-live">
                <div className="td-card-head">
                  <h2 id="td-live">
                    <span className={`td-dot ${active ? "td-dot-on" : ""}`} aria-hidden="true" /> Live
                  </h2>
                  <Link href="/" className="td-link">
                    <UploadIcon size={13} /> Upload
                  </Link>
                </div>
                {data.live.length === 0 ? (
                  <Empty>Nothing being analysed right now. Upload a call and it shows here.</Empty>
                ) : (
                  <ul className="td-live">
                    {data.live.map((j) => (
                      <li key={j.job_id}>
                        <div className="td-live-top">
                          <span className="td-live-name" title={j.file_name}>
                            {j.file_name}
                          </span>
                          <span className={`td-live-state ${j.status === "failed" ? "td-neg" : j.status === "completed" ? "td-pos" : ""}`}>
                            {j.status === "completed" ? "Done" : j.status === "failed" ? "Failed" : j.stage_label}
                          </span>
                        </div>
                        <span className="td-bar td-bar-thin" aria-hidden="true">
                          <span className={j.status === "failed" ? "td-bar-fail" : ""} style={{ width: `${j.status === "completed" ? 100 : Math.max(4, Math.min(100, Math.round(j.progress * 100)))}%` }} />
                        </span>
                        {j.status === "failed" && j.error && <p className="td-live-err">{j.error}</p>}
                        {j.status === "completed" && j.person_id && (
                          <Link href={withFrom(`/people/${j.person_id}`, "today")} className="td-link td-live-open">
                            Open person
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <InboxCard data={data.inbox} />

              <section className="td-card" aria-labelledby="td-heat">
                <div className="td-card-head">
                  <h2 id="td-heat">Investor interest</h2>
                  <Link href="/departments/investment" className="td-link">
                    Investment
                  </Link>
                </div>
                {data.investor_heat.length === 0 ? (
                  <Empty>No investors yet.</Empty>
                ) : (
                  <ul className="td-heat">
                    {data.investor_heat.map((p) => (
                      <li key={p.id}>
                        <Link href={withFrom(`/people/${p.id}`, "today")} className="td-heat-name">
                          {p.name}
                        </Link>
                        <span className="td-bar" aria-hidden="true">
                          <span className={`td-bar-${interestOf(p.score).level}`} style={{ width: `${Math.max(3, p.score ?? 0)}%` }} />
                        </span>
                        <ScorePill score={p.score} />
                        <span
                          className={`td-heat-change ${p.change > 0 ? "td-pos" : p.change < 0 ? "td-neg" : "td-faint"}`}
                          title={p.change ? `Interest ${p.change > 0 ? "up" : "down"} ${Math.abs(p.change)} points in the last call` : "No change in the last call"}
                        >
                          {p.change > 0 ? <TrendUpIcon size={12} /> : p.change < 0 ? <TrendDownIcon size={12} /> : null}
                          {p.change > 0 ? `+${p.change}` : p.change < 0 ? p.change : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <FollowUps items={data.follow_ups} total={n.follow_ups} onDone={markDone} />

            </div>
          </div>
        </>
      )}
    </PeopleChrome>
  );
}
