"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useDepartments } from "../lib/departments";
import { type Insight, type OpportunityPage, getOpportunityPage, refreshInsight, setChance } from "../lib/opportunities";
import { sidebarFor, useOrigin, withFrom } from "../lib/origin";
import { STAGES, type Stage, dayLabel, deleteOpportunity, dueLabel, isPast, rupees, updateOpportunity, whenLabel } from "../lib/people";
import { LinkIcon, PhoneIcon, SparkleIcon, WhatsAppIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { DeptTag, PersonAvatar, ScorePill } from "./PeopleBits";

// One opportunity, everything in one place (design slide 10): value, chance and score; where it
// stands (a stage tracker — one click moves it, every move is logged); the AI's view ("Will it work
// out?") with a suggested chance to accept or ignore; the evidence from calls; the next step; the deal
// details said in the calls; and how the person came to the owner. All from the database.

const FLOW: Stage[] = STAGES.filter((s) => s !== "Lost");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const LEVEL = { high: "High", medium: "Medium", low: "Low" } as const;

function Tracker({ stage, busy, onMove }: { stage: Stage; busy: boolean; onMove: (s: Stage) => void }) {
  const at = FLOW.indexOf(stage);
  return (
    <ol className="od-track" aria-label="Where it stands">
      {FLOW.map((s, i) => {
        const done = stage !== "Lost" && i < at;
        const now = s === stage;
        return (
          <li key={s} className={`od-step ${done ? "od-step-done" : ""} ${now ? "od-step-now" : ""}`}>
            <button type="button" className="od-step-dot" disabled={busy || now} onClick={() => onMove(s)} aria-current={now ? "step" : undefined} title={now ? `${s} (now)` : `Move to ${s}`}>
              {done ? "✓" : now ? i + 1 : ""}
            </button>
            <span className="od-step-label">{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

function WillItWork({ page, insight, state, error, onRefresh, onAccept, onKeep, kept }: {
  page: OpportunityPage;
  insight: Insight | null;
  state: "idle" | "loading";
  error: string | null;
  onRefresh: () => void;
  onAccept: (pct: number) => void;
  onKeep: () => void;
  kept: boolean;
}) {
  const o = page.opportunity;
  const i = insight?.data;
  const suggested = i?.suggested_chance_pct ?? null;
  const accepted = suggested !== null && o.chance_pct === suggested;
  return (
    <section className="card od-ai" aria-label="Will it work out?">
      <div className="od-ai-head">
        <p className="od-ai-title">
          <SparkleIcon size={12} /> Will it work out?
        </p>
        {page.can_analyse && insight && (
          <button type="button" className="pw-link" onClick={onRefresh} disabled={state === "loading"}>
            {state === "loading" ? "Reading…" : insight.stale ? "New call: refresh" : "Refresh"}
          </button>
        )}
      </div>
      {!page.can_analyse ? (
        <p className="od-muted">No call with {page.person.name} yet. Upload one and the AI will read it.</p>
      ) : state === "loading" && !i ? (
        <p className="od-muted">
          <span className="auth-spinner od-spin" /> Reading the calls with {page.person.name}…
        </p>
      ) : error && !i ? (
        <p className="od-muted">
          {error}{" "}
          <button type="button" className="pw-link" onClick={onRefresh}>
            Try again
          </button>
        </p>
      ) : i ? (
        <>
          {insight?.stale && <p className="od-stale">A newer call with {page.person.name} came in after this view. Refresh to read it.</p>}
          {i.factors.length ? (
            <div className="od-factors">
              {i.factors.map((f) => (
                <div key={f.label} className="od-factor">
                  <span className="od-factor-label">{f.label}</span>
                  <span className={`od-level od-level-${f.level}`}>{LEVEL[f.level]}</span>
                  <span className="od-factor-why">{f.reason}</span>
                  {f.evidence[0] && (
                    <Link href={withFrom(`/people/${page.person.id}/calls/${f.evidence[0].job_id}`, "panel")} className="od-factor-ev">
                      {f.evidence[0].time_label} {f.evidence[0].speaker}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="od-muted">The calls do not say enough about this deal yet.</p>
          )}
          {i.would_change && <p className="od-change">{i.would_change}</p>}
          {suggested !== null && !kept && (
            <p className="od-suggest">
              <span>
                AI suggests chance <strong>{suggested}%</strong>
              </span>
              {accepted ? (
                <span className="od-accepted">✓ Accepted</span>
              ) : (
                <>
                  <button type="button" className="pa-btn pw-btn" onClick={() => onAccept(suggested)}>
                    Accept
                  </button>
                  <button type="button" className="pw-link" onClick={onKeep}>
                    Keep {pct(o.chance)}
                  </button>
                </>
              )}
            </p>
          )}
          <p className="od-fine">From the last {Math.min(3, page.conversations.length)} call{page.conversations.length === 1 ? "" : "s"} with {page.person.name}{insight?.created_at ? ` · ${whenLabel(insight.created_at)}` : ""}. Only what was said.</p>
        </>
      ) : null}
    </section>
  );
}

function EditDeal({ page, onSaved, onCancel }: { page: OpportunityPage; onSaved: () => void; onCancel: () => void }) {
  const { departments } = useDepartments();
  const o = page.opportunity;
  const [f, setF] = useState({ title: o.title, value: o.value_inr === null ? "" : String(o.value_inr), department: o.department ?? "", next: o.next_step ?? "", due: o.due_date ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const digits = f.value.replace(/[,\s₹]/g, "");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!f.title.trim()) return setError("Give the deal a title.");
    if (digits && !/^\d+$/.test(digits)) return setError("Value should be a number of rupees.");
    setBusy(true);
    setError(null);
    try {
      await updateOpportunity(o.id, { title: f.title.trim(), value_inr: digits ? Number(digits) : null, department: f.department || null, next_step: f.next.trim() || null, due_date: f.due || null });
      onSaved();
    } catch (err) {
      setError(message(err, "Could not save."));
      setBusy(false);
    }
  }
  return (
    <form className="card od-edit" onSubmit={(e) => void save(e)}>
      <div className="ib-row">
        <label className="ib-field">
          <span>Title</span>
          <input value={f.title} maxLength={160} onChange={(e) => set("title", e.target.value)} autoFocus />
        </label>
        <label className="ib-field">
          <span>Value (₹)</span>
          <input value={f.value} inputMode="numeric" onChange={(e) => set("value", e.target.value)} />
        </label>
        <label className="ib-field">
          <span>Department</span>
          <select value={f.department} onChange={(e) => set("department", e.target.value)}>
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.slug}>{d.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="ib-row">
        <label className="ib-field">
          <span>Next step</span>
          <input value={f.next} maxLength={300} onChange={(e) => set("next", e.target.value)} />
        </label>
        <label className="ib-field">
          <span>Due date</span>
          <input type="date" value={f.due} onChange={(e) => set("due", e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="pw-error" role="alert">
          {error}
        </p>
      )}
      <span className="pw-row-actions">
        <button type="button" className="pa-btn pw-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="pa-btn pa-btn-primary pw-btn" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </form>
  );
}

export default function OpportunityDetail({ id }: { id: string }) {
  const router = useRouter();
  const origin = useOrigin();
  const [page, setPage] = useState<OpportunityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [aiState, setAiState] = useState<"idle" | "loading">("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const asked = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await getOpportunityPage(id);
      setPage(p);
      setInsight(p.insight);
      return p;
    } catch (e) {
      setError(message(e, "Could not load this opportunity."));
      return null;
    }
  }, [id]);

  const ask = useCallback(async () => {
    setAiState("loading");
    setAiError(null);
    try {
      setInsight(await refreshInsight(id));
    } catch (e) {
      setAiError(message(e, "The AI could not read the calls right now."));
    } finally {
      setAiState("idle");
    }
  }, [id]);

  // Open: load the page; the first time (no saved view yet) the AI reads the calls once.
  useEffect(() => {
    void (async () => {
      const p = await load();
      if (p && !p.insight && p.can_analyse && !asked.current) {
        asked.current = true;
        void ask();
      }
    })();
  }, [load, ask]);

  async function move(to: Stage) {
    if (!page || busy || to === page.opportunity.stage) return;
    const from = page.opportunity.stage;
    setBusy(true);
    try {
      await updateOpportunity(page.opportunity.id, { stage: to });
      setNotice({ text: `Moved from ${from} to ${to} (${pct(page.stages.find((s) => s.stage === to)?.chance ?? 0)} chance).` });
      setKept(false);
      await load();
    } catch (e) {
      setNotice({ text: `Could not move it: ${message(e, "not saved")}.`, error: true });
    } finally {
      setBusy(false);
    }
  }
  async function accept(p: number | null) {
    if (!page) return;
    try {
      await setChance(page.opportunity.id, p);
      setNotice({ text: p === null ? "Back to the stage's chance." : `Chance set to ${p}% for this deal. The weighted pipeline uses it.` });
      await load();
    } catch (e) {
      setNotice({ text: message(e, "Could not save the chance."), error: true });
    }
  }
  async function remove() {
    if (!page || !window.confirm(`Delete “${page.opportunity.title}”? The calls are not deleted.`)) return;
    try {
      await deleteOpportunity(page.opportunity.id);
      router.replace(origin.from === "person" ? `/people/${page.person.id}` : origin.from ? origin.crumbs[origin.crumbs.length - 1].href : "/opportunity-panel");
    } catch (e) {
      setNotice({ text: message(e, "Could not delete."), error: true });
    }
  }

  const crumbs = origin.from ? origin.crumbs : [{ label: "Opportunity panel", href: "/opportunity-panel" }];
  const from = origin.from ?? "panel";

  if (error || !page) {
    return (
      <PeopleChrome active="opportunity-panel">
        <div className="card pl-state" role={error ? "alert" : undefined} aria-busy={!error}>
          {error ? (
            <>
              <p>{error}</p>
              <Link href={crumbs[crumbs.length - 1].href} className="pl-view">
                Back to {crumbs[crumbs.length - 1].label}
              </Link>
            </>
          ) : (
            <span className="auth-spinner" />
          )}
        </div>
      </PeopleChrome>
    );
  }

  const { opportunity: o, person: p } = page;
  const inv = page.department?.slug === "investment";
  const details = insight?.data.details;
  const lastMove = page.history.at(-1);
  const sourceLink = (jobId: string) => withFrom(`/people/${p.id}/calls/${jobId}`, from);

  return (
    <PeopleChrome active={sidebarFor(from)}>
      <nav className="pa-crumbs" aria-label="Breadcrumb">
        {crumbs.map((c) => (
          <Fragment key={c.href}>
            <Link href={c.href}>{c.label}</Link> <span aria-hidden="true">›</span>{" "}
          </Fragment>
        ))}
        {page.department && from === "panel" && (
          <>
            <Link href={`/departments/${page.department.slug}`}>{page.department.name}</Link> <span aria-hidden="true">›</span>{" "}
          </>
        )}
        {from === "person" ? (
          <>
            <Link href={`/people/${p.id}`}>{p.name}</Link> <span aria-hidden="true">›</span> <span>{o.title}</span>
          </>
        ) : (
          <span>{p.name}</span>
        )}
      </nav>

      {notice && (
        <div className={`ib-notice ${notice.error ? "op-notice-error" : ""}`} role="status">
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <section className="card od-head" aria-label="The deal">
        <div className="od-head-top">
          <PersonAvatar name={p.name} initials={p.initials} size="lg" />
          <div className="od-who">
            <h1 className="od-title">
              <Link href={withFrom(`/people/${p.id}`, from)} className="od-person">
                {p.name}
              </Link>{" "}
              — {o.title} {o.department && <DeptTag dept={o.department} link />}
            </h1>
            <p className="od-sub">
              {[p.role_title ?? p.category, p.organisation, p.city].filter(Boolean).join(" · ") || "No details yet"}
              {p.introduced_by && (
                <>
                  {" "}
                  · introduced by{" "}
                  <Link href={withFrom(`/people/${p.introduced_by.id}`, from)} className="od-intro">
                    {p.introduced_by.name}
                  </Link>
                  {p.first_seen_at ? ` on ${dayLabel(p.first_seen_at)}` : ""}
                </>
              )}
            </p>
          </div>
          <div className="od-numbers">
            <span className="od-num">
              <span className="od-num-label">Value</span>
              <strong>{o.value_inr !== null ? rupees(o.value_inr) : "—"}</strong>
            </span>
            <span className="od-num">
              <span className="od-num-label">Chance</span>
              <strong>{pct(o.chance)}</strong>
              {o.chance_pct !== null && (
                <button type="button" className="od-num-note" onClick={() => void accept(null)} title={`Your chance for this deal. Click to go back to the stage's ${pct(o.stage_chance)}.`}>
                  yours · stage {pct(o.stage_chance)}
                </button>
              )}
            </span>
            <ScorePill score={p.score} />
          </div>
        </div>
        <Tracker stage={o.stage} busy={busy} onMove={(s) => void move(s)} />
        <p className="od-track-foot">
          {o.stage === "Lost" ? <strong className="od-lost">Lost{o.closed_at ? ` · ${dayLabel(o.closed_at)}` : ""}</strong> : null}
          {lastMove ? (
            <span>
              {lastMove.from ? `Moved to ${lastMove.to}` : `Started at ${lastMove.to}`} by {lastMove.by === "ai" ? "the AI (from a call)" : "you"} · {whenLabel(lastMove.at)}
              {page.history.length > 1 ? ` · ${page.history.length} moves logged` : ""}
            </span>
          ) : (
            <span>Every move from now on is logged.</span>
          )}
          <span className="pw-row-actions">
            <button type="button" className="pw-link" onClick={() => setEditing((x) => !x)}>
              Edit deal
            </button>
            {o.stage !== "Lost" ? (
              <button type="button" className="pw-link pw-link-danger" disabled={busy} onClick={() => void move("Lost")}>
                Mark lost
              </button>
            ) : (
              <button type="button" className="pw-link" disabled={busy} onClick={() => void move("Identified")}>
                Reopen
              </button>
            )}
          </span>
        </p>
      </section>

      {editing && (
        <EditDeal
          page={page}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice({ text: "Saved." });
            void load();
          }}
        />
      )}

      <div className="od-grid">
        <div className="od-col">
          <WillItWork page={page} insight={insight} state={aiState} error={aiError} onRefresh={() => void ask()} onAccept={(n) => void accept(n)} onKeep={() => setKept(true)} kept={kept} />

          <section className="card od-card" aria-label="Evidence">
            <h2 className="od-h2">Evidence</h2>
            <ul className="od-ev">
              {o.evidence.map((e) => (
                <li key={e.id}>
                  {o.source?.kind === "whatsapp" ? <WhatsAppIcon size={15} /> : <PhoneIcon size={15} />}
                  <span>
                    <span className="od-ev-text">
                      {e.speaker ? `${e.speaker}: ` : ""}“{e.english || e.text}”
                    </span>
                    {o.source && (
                      <Link href={sourceLink(o.source.job_id)} className="od-ev-src">
                        {o.source.kind === "whatsapp" ? "Chat" : "Call"} · {o.source.file_name} · {e.time_label ?? whenLabel(o.source.at)}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
              {!o.evidence.length && o.source && (
                <li>
                  <PhoneIcon size={15} />
                  <span>
                    <span className="od-ev-text">Linked to this {o.source.kind === "whatsapp" ? "chat" : "call"}</span>
                    <Link href={sourceLink(o.source.job_id)} className="od-ev-src">
                      {o.source.file_name} · {whenLabel(o.source.at)}
                    </Link>
                  </span>
                </li>
              )}
              {p.introduced_by && (
                <li>
                  <LinkIcon size={15} />
                  <span>
                    <span className="od-ev-text">Introduced by {p.introduced_by.name}</span>
                    <span className="od-ev-src od-ev-plain">Referral{p.first_seen_at ? ` · ${dayLabel(p.first_seen_at)}` : ""}</span>
                  </span>
                </li>
              )}
              {page.conversations
                .filter((c) => c.job_id !== o.source?.job_id)
                .slice(0, 3)
                .map((c) => (
                  <li key={c.job_id}>
                    {c.kind === "whatsapp" ? <WhatsAppIcon size={15} /> : <PhoneIcon size={15} />}
                    <span>
                      <span className="od-ev-text">{c.context}</span>
                      <Link href={sourceLink(c.job_id)} className="od-ev-src">
                        {c.kind === "whatsapp" ? "Chat" : "Call"} · {c.file_name} · {whenLabel(c.at)}
                      </Link>
                    </span>
                  </li>
                ))}
              {!o.evidence.length && !o.source && !p.introduced_by && !page.conversations.length && <li className="od-muted">Added by hand: no call behind it yet.</li>}
            </ul>
          </section>
        </div>

        <div className="od-col">
          <section className="card od-next" aria-label="Next step">
            <p className="od-label">Next step</p>
            <p className="od-next-text">{o.next_step ?? "No next step yet"}</p>
            {o.due_date && <p className={`od-due ${isPast(o.due_date) && o.stage !== "Won" && o.stage !== "Lost" ? "od-due-late" : ""}`}>Due {dueLabel(o.due_date)}{isPast(o.due_date) && o.stage !== "Won" && o.stage !== "Lost" ? " · overdue" : ""}</p>}
            <button type="button" className="pa-btn pw-btn" onClick={() => setEditing(true)}>
              {o.next_step ? "Change" : "Add a next step"}
            </button>
          </section>

          <section className="card od-card" aria-label={inv ? "Investor details" : "Deal details"}>
            <h2 className="od-h2">{inv ? "Investor details" : "Deal details"}</h2>
            <dl className="od-dl">
              <div>
                <dt>{inv ? "Ticket size" : "Value"}</dt>
                <dd>{o.value_inr !== null ? rupees(o.value_inr) : <span className="od-muted">Not said yet</span>}</dd>
              </div>
              {inv && (
                <div>
                  <dt>Instrument</dt>
                  <dd>{details?.instrument ?? <span className="od-muted">Not discussed yet</span>}</dd>
                </div>
              )}
              <div>
                <dt>Decision by</dt>
                <dd>{details?.decision_by ?? <span className="od-muted">Not discussed yet</span>}</dd>
              </div>
              <div>
                <dt>Expected</dt>
                <dd>{details?.expected ?? <span className="od-muted">Not discussed yet</span>}</dd>
              </div>
              <div>
                <dt>Weighted</dt>
                <dd>{o.value_inr !== null ? `${rupees(Math.round(o.value_inr * o.chance))} (${pct(o.chance)})` : "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="card od-card od-path" aria-label="Introduction path">
            <span className="od-label">Path:</span>
            {page.path.map((x, i) => (
              <Fragment key={`${x.id}-${i}`}>
                {i > 0 && <span aria-hidden="true">→</span>}
                {x.id ? (
                  <Link href={withFrom(`/people/${x.id}`, from)} title={x.name}>
                    <PersonAvatar name={x.name} initials={x.initials} />
                  </Link>
                ) : (
                  <span title={`${x.name} (you)`}>
                    <PersonAvatar name={x.name} initials={x.initials} />
                  </span>
                )}
              </Fragment>
            ))}
            <span className="od-path-via">{page.path.length > 2 ? `via ${page.path.slice(1, -1).map((x) => x.name).join(" → ")}` : "direct"}</span>
          </section>
        </div>
      </div>

      <p className="pa-delete-row">
        <button type="button" className="pw-link pw-link-danger" onClick={() => void remove()}>
          Delete this opportunity
        </button>
      </p>
    </PeopleChrome>
  );
}
