"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import FilterMenu, { type FilterOption } from "./FilterMenu";
import { type DeptWithCount, deptStyle, useDepartments } from "../lib/departments";
import { type Board, type BoardOpportunity, type Nudge, getBoard, totals } from "../lib/opportunities";
import { withFrom } from "../lib/origin";
import { type Person, STAGES, STAGE_CHANCE, type Stage, addOpportunity, dayLabel, dueLabel, getPeople, rupees, stageClass, updateOpportunity } from "../lib/people";
import { PhoneIcon, PlusIcon, SparkleIcon, WhatsAppIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { DeptTag, ScorePill } from "./PeopleBits";

// Opportunity panel (design: "every opportunity by stage"). Every opportunity in the database — from
// calls, or added by the owner — as a card in its stage's column. Dragging a card to another column
// (or "Move to…" on the card) saves the stage; the column totals, the total and the weighted pipeline
// (value × stage chance) change at once. A move that fails to save goes back.

const COLUMNS = STAGES.filter((s) => s !== "Lost"); // Identified … Committed, Won
const pct = (x: number) => `${Math.round(x * 100)}%`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
type View = "board" | "list";

/** "Move to…": every stage, for keyboard, touch and anyone who prefers not to drag. */
function MoveMenu({ o, onMove, onClose }: { o: BoardOpportunity; onMove: (to: Stage) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="op-menu" role="menu" aria-label={`Move ${o.title}`}>
      {STAGES.filter((s) => s !== o.stage).map((s) => (
        <button key={s} type="button" role="menuitem" className="op-menu-item" onClick={() => onMove(s)}>
          <span className={`op-dot pw-stage-${stageClass(s)}`} aria-hidden="true" />
          {s}
          <span className="op-menu-chance">{pct(STAGE_CHANCE[s])}</span>
        </button>
      ))}
    </div>
  );
}

function Card({ o, dragging, busy, menuOpen, onMenu, onMove, onDragStart, onDragEnd, onOpen }: {
  o: BoardOpportunity;
  dragging: boolean;
  busy: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onMove: (to: Stage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const subtitle = [o.title, o.value_inr !== null ? rupees(o.value_inr) : null].filter(Boolean).join(" · ");
  return (
    <article
      className={`op-card ${o.overdue ? "op-card-overdue" : ""} ${dragging ? "op-card-dragging" : ""} ${busy ? "op-card-busy" : ""}`}
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", o.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        // A click on the card opens the opportunity (not when it lands on Move, a menu or a link).
        if (!(e.target as HTMLElement).closest("button, a, select")) onOpen();
      }}
      aria-label={`${o.person.name}, ${subtitle}, ${o.stage}`}
    >
      <div className="op-card-top">
        <Link href={withFrom(`/opportunities/${o.id}`, "panel")} className="op-name" draggable={false}>
          {o.person.name}
        </Link>
        <ScorePill score={o.person.score} />
      </div>
      <p className="op-sub">{subtitle}</p>
      {o.came_from && (
        // Where it was before its latest move: "↓ from Negotiation · today" (moved back) or "↑ from Pitch".
        <p
          className={`op-from ${STAGES.indexOf(o.stage) < STAGES.indexOf(o.came_from.stage) ? "op-from-back" : "op-from-fwd"}`}
          title={`Was in ${o.came_from.stage} before it moved to ${o.stage}`}
        >
          {STAGES.indexOf(o.stage) < STAGES.indexOf(o.came_from.stage) ? "↓" : "↑"} from {o.came_from.stage}
          {o.came_from.at ? ` · ${dayLabel(o.came_from.at).toLowerCase()}` : ""}
        </p>
      )}
      {o.department && (
        <p className="op-tags">
          <DeptTag dept={o.department} />
        </p>
      )}
      <div className="op-foot">
        <span className={`op-next ${o.overdue ? "op-next-overdue" : ""}`}>
          {o.overdue ? (
            <>
              <ClockIcon /> Overdue{o.due_date ? ` · ${dueLabel(o.due_date)}` : ""}
            </>
          ) : o.next_step || o.due_date ? (
            <>
              <ClockIcon /> {o.next_step ?? ""}
              {o.due_date ? `${o.next_step ? " · " : ""}${dueLabel(o.due_date)}` : ""}
            </>
          ) : (
            <span className="op-muted">No next step yet</span>
          )}
        </span>
        <span className="op-move-wrap">
          <button type="button" className="op-move" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => onMenu(!menuOpen)} disabled={busy} title="Move to another stage">
            {busy ? "Saving…" : "Move"}
          </button>
          {menuOpen && <MoveMenu o={o} onMove={onMove} onClose={() => onMenu(false)} />}
        </span>
      </div>
      {o.source && (
        <p className="op-src" title={`From ${o.source.file_name}`}>
          {o.source.kind === "whatsapp" ? <WhatsAppIcon size={11} /> : <PhoneIcon size={11} />}
          {o.origin === "ai" ? "Found in call" : "From call"}
        </p>
      )}
    </article>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** "+ Opportunity": a deal with someone in People (calls add them automatically too). */
function AddDialog({ onDone, onClose }: { onDone: (title: string) => void; onClose: () => void }) {
  const { departments } = useDepartments();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [f, setF] = useState({ person: "", title: "", department: "", value: "", stage: "Identified" as Stage, next: "", due: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getPeople().then(setPeople, (e) => setError(message(e, "Could not load People.")));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const digits = f.value.replace(/[,\s₹]/g, "");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!f.person) return setError("Choose who the deal is with.");
    if (!f.title.trim()) return setError("Give the deal a title.");
    if (digits && !/^\d+$/.test(digits)) return setError("Value should be a number of rupees, e.g. 250000.");
    setBusy(true);
    setError(null);
    try {
      await addOpportunity(f.person, { title: f.title.trim(), department: f.department || null, value_inr: digits ? Number(digits) : null, stage: f.stage, next_step: f.next.trim() || null, due_date: f.due || null });
      onDone(f.title.trim());
    } catch (err) {
      setError(message(err, "Could not add the opportunity."));
      setBusy(false);
    }
  }
  return (
    <div className="ib-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ib-dialog" role="dialog" aria-modal="true" aria-labelledby="op-add-title">
        <div className="ib-dialog-head">
          <h2 id="op-add-title" className="ib-dialog-title">
            New opportunity
          </h2>
          <button type="button" className="ib-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="ib-form" onSubmit={(e) => void save(e)}>
          <p className="ib-why">Deals talked about in calls are added automatically. Use this for one you know about already.</p>
          <label className="ib-field">
            <span>With (from People)</span>
            <select value={f.person} onChange={(e) => set("person", e.target.value)} autoFocus>
              <option value="">{people ? "Choose a person…" : "Loading…"}</option>
              {people?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.role_title ? ` · ${p.role_title}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="ib-field">
            <span>Title</span>
            <input value={f.title} maxLength={160} placeholder="e.g. South TN distribution" onChange={(e) => set("title", e.target.value)} />
          </label>
          <div className="ib-row">
            <label className="ib-field">
              <span>Department</span>
              <select value={f.department} onChange={(e) => set("department", e.target.value)}>
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.slug}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="ib-field">
              <span>Value (₹)</span>
              <input value={f.value} inputMode="numeric" placeholder="e.g. 2500000" onChange={(e) => set("value", e.target.value)} />
            </label>
          </div>
          <div className="ib-row">
            <label className="ib-field">
              <span>Stage</span>
              <select value={f.stage} onChange={(e) => set("stage", e.target.value)}>
                {COLUMNS.map((s) => (
                  <option key={s} value={s}>
                    {s} ({pct(STAGE_CHANCE[s])})
                  </option>
                ))}
              </select>
            </label>
            <label className="ib-field">
              <span>Due date</span>
              <input type="date" value={f.due} onChange={(e) => set("due", e.target.value)} />
            </label>
          </div>
          <label className="ib-field">
            <span>Next step</span>
            <input value={f.next} maxLength={300} placeholder="e.g. Demo on Monday" onChange={(e) => set("next", e.target.value)} />
          </label>
          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}
          <div className="ib-actions">
            <button type="button" className="pa-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="pa-btn pa-btn-primary" disabled={busy}>
              {busy ? "Adding…" : "Add opportunity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Department filter: a menu with each department's colour and how many open deals it has. */
function DeptFilter({ value, onChange, departments, opps }: { value: string; onChange: (v: string) => void; departments: DeptWithCount[]; opps: BoardOpportunity[] }) {
  const openOf = (match: (o: BoardOpportunity) => boolean) => opps.filter((o) => o.stage !== "Won" && o.stage !== "Lost" && match(o)).length;
  const options: FilterOption[] = [
    { value: "all", label: "All departments", count: openOf(() => true) },
    ...departments.map((d, i) => ({ value: d.name, label: d.name, color: deptStyle(d.color).color as string, count: openOf((o) => o.department === d.name), separatorBefore: i === 0 })),
    { value: "none", label: "No department", color: "#a1a1aa", count: openOf((o) => !o.department), separatorBefore: true },
  ];
  return <FilterMenu value={value} onChange={onChange} options={options} label="Show department" />;
}

export default function OpportunityPanel() {
  const router = useRouter();
  const { departments } = useDepartments();
  const [board, setBoard] = useState<Board | null>(null);
  const [opps, setOpps] = useState<BoardOpportunity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState("all");
  const [view, setView] = useState<View>("board");
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [nudgeAt, setNudgeAt] = useState(0);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null);
    try {
      const b = await getBoard();
      setBoard(b);
      setOpps(b.opportunities);
    } catch (e) {
      if (!quiet) setError(message(e, "Could not load the opportunities."));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  // Filter: department.
  const shown = useMemo(() => opps.filter((o) => dept === "all" || (dept === "none" ? !o.department : o.department === dept)), [opps, dept]);
  const sum = totals(shown);
  const won = shown.filter((o) => o.stage === "Won").length;
  const lost = shown.filter((o) => o.stage === "Lost");
  const filtered = dept !== "all";

  /** Save a stage move: shown at once, sent to the server, put back if it could not be saved. */
  async function move(id: string, to: Stage) {
    setMenu(null);
    const o = opps.find((x) => x.id === id);
    if (!o || o.stage === to || busy.has(id)) return;
    const before = totals(opps).weighted;
    const next = opps.map((x) => (x.id === id ? { ...x, stage: to, chance: STAGE_CHANCE[to], overdue: to === "Won" || to === "Lost" ? false : x.overdue } : x));
    const after = totals(next).weighted;
    setOpps(next);
    setBusy((s) => new Set(s).add(id));
    try {
      await updateOpportunity(id, { stage: to });
      const diff = after - before;
      setNotice({ text: `${o.person.name} · ${o.title}: ${o.stage} → ${to} (${pct(STAGE_CHANCE[to])} chance). Weighted pipeline ${diff >= 0 ? "+" : "−"}${rupees(Math.abs(diff))} → ${rupees(after)}.` });
      void load(true); // nudges and "in this stage since" from the server
    } catch (e) {
      setOpps((xs) => xs.map((x) => (x.id === id ? o : x)));
      setNotice({ text: `Could not move ${o.title}: ${message(e, "the change was not saved")}. It is back in ${o.stage}.`, error: true });
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  const nudges = (board?.nudges ?? []).filter((n) => !dismissed.has(n.opportunity_id) && opps.some((o) => o.id === n.opportunity_id && o.stage !== "Won" && o.stage !== "Lost"));
  const nudge: Nudge | undefined = nudges[Math.min(nudgeAt, nudges.length - 1)];
  const nudgeOpp = nudge ? opps.find((o) => o.id === nudge.opportunity_id) : undefined;

  return (
    <PeopleChrome active="opportunity-panel">
      <div className="pl-head op-head">
        <div>
          <h1 className="pl-title">Opportunity panel</h1>
          <p className="pl-sub">
            {board ? (
              <>
                {sum.count} open opportunit{sum.count === 1 ? "y" : "ies"} · <strong>{rupees(sum.value)}</strong> total · <strong>{rupees(sum.weighted)}</strong> weighted
                {won ? ` · ${won} won` : ""}
                {lost.length ? ` · ${lost.length} lost` : ""}
                {filtered ? " (filtered)" : ""}
              </>
            ) : (
              "Loading…"
            )}
          </p>
        </div>
        <div className="pl-views op-tools">
          <DeptFilter value={dept} onChange={setDept} departments={departments} opps={opps} />
          <button type="button" className={`pl-view ${view === "board" ? "pl-view-on" : ""}`} aria-pressed={view === "board"} onClick={() => setView("board")}>
            Board
          </button>
          <button type="button" className={`pl-view ${view === "list" ? "pl-view-on" : ""}`} aria-pressed={view === "list"} onClick={() => setView("list")}>
            List
          </button>
          <button type="button" className="pl-view iv-primary" onClick={() => setAdding(true)}>
            <PlusIcon size={14} /> Opportunity
          </button>
        </div>
      </div>

      {notice && (
        <div className={`ib-notice ${notice.error ? "op-notice-error" : ""}`} role="status">
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {error ? (
        <div className="card pl-state" role="alert">
          <p>{error}</p>
          <button type="button" className="pl-view" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !board ? (
        <div className="card pl-state" aria-busy="true">
          <span className="auth-spinner" />
        </div>
      ) : !opps.length ? (
        <div className="card pl-state">
          <p className="pl-state-title">No opportunities yet</p>
          <p>Upload a call: deals talked about in it appear here with their stage, amount and the call they came from. Or add one with “+ Opportunity”.</p>
        </div>
      ) : view === "board" ? (
        <div className="op-board" aria-label="Opportunities by stage">
          {COLUMNS.map((stage) => {
            const cards = shown.filter((o) => o.stage === stage);
            const value = cards.reduce((s, o) => s + (o.value_inr ?? 0), 0);
            return (
              <section
                key={stage}
                className={`op-col ${over === stage ? "op-col-over" : ""} ${stage === "Won" ? "op-col-won" : ""}`}
                aria-label={`${stage}: ${cards.length}`}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== stage) setOver(stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((s) => (s === stage ? null : s));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain") || dragId;
                  setOver(null);
                  setDragId(null);
                  if (id) void move(id, stage);
                }}
              >
                <header className="op-col-head">
                  <span className="op-col-name">{stage}</span>
                  <span className="op-col-count">{cards.length}</span>
                </header>
                <p className="op-col-sum">
                  {value ? rupees(value) : "₹0"} <span title="Chance of closing at this stage">· {pct(STAGE_CHANCE[stage])}</span>
                </p>
                <div className="op-cards">
                  {cards.map((o) => (
                    <Card
                      key={o.id}
                      o={o}
                      dragging={dragId === o.id}
                      busy={busy.has(o.id)}
                      menuOpen={menu === o.id}
                      onMenu={(open) => setMenu(open ? o.id : null)}
                      onMove={(to) => void move(o.id, to)}
                      onDragStart={() => setDragId(o.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOver(null);
                      }}
                      onOpen={() => router.push(withFrom(`/opportunities/${o.id}`, "panel"))}
                    />
                  ))}
                  {!cards.length && <p className="op-empty">{dragId ? "Drop here" : "—"}</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="card op-list-card" aria-label="Opportunities">
          <div className="dd-scroll">
            <table className="pl-table op-table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>With</th>
                  <th>Department</th>
                  <th>Stage</th>
                  <th>Value</th>
                  <th>Chance</th>
                  <th>Weighted</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {[...shown]
                  .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || (b.value_inr ?? 0) - (a.value_inr ?? 0))
                  .map((o) => (
                    <tr key={o.id} className={`pl-row op-row ${o.stage === "Lost" ? "op-row-lost" : ""}`}>
                      <td className="op-deal">
                        <Link href={withFrom(`/opportunities/${o.id}`, "panel")} className="pl-name">
                          {o.title}
                        </Link>
                      </td>
                      <td>
                        <div className="op-with">
                          <Link href={withFrom(`/people/${o.person.id}`, "panel")} className="pl-name">
                            {o.person.name}
                          </Link>
                          <ScorePill score={o.person.score} />
                        </div>
                      </td>
                      <td>{o.department ? <DeptTag dept={o.department} /> : <span className="pl-direct">—</span>}</td>
                      <td>
                        <select className={`pw-stage pw-stage-${stageClass(o.stage)}`} value={o.stage} disabled={busy.has(o.id)} aria-label={`Stage of ${o.title}`} onChange={(e) => void move(o.id, e.target.value as Stage)}>
                          {STAGES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td className="dd-money">{o.value_inr !== null ? rupees(o.value_inr) : "—"}</td>
                      <td>{pct(o.chance)}</td>
                      <td className="dd-money">{o.value_inr ? rupees(Math.round(o.value_inr * o.chance)) : "—"}</td>
                      <td className={`dd-next ${o.overdue ? "iv-overdue" : ""}`}>
                        {o.overdue ? "Overdue · " : ""}
                        {o.next_step ?? (o.overdue ? "" : "—")}
                        {o.due_date ? ` · ${dueLabel(o.due_date)}` : ""}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <p className="pl-empty">No opportunities match these filters.</p>}
        </section>
      )}

      {board && nudge && nudgeOpp && (
        <div className="op-nudge" role="status">
          <SparkleIcon size={14} />
          <p>
            <strong>Suggestion:</strong> {nudge.text}
            {nudges.length > 1 && (
              <button type="button" className="pw-link op-nudge-more" onClick={() => setNudgeAt((i) => (i + 1) % nudges.length)}>
                {Math.min(nudgeAt, nudges.length - 1) + 1} of {nudges.length} ›
              </button>
            )}
          </p>
          <span className="op-nudge-actions">
            {nudge.move_to && (
              <button type="button" className="pa-btn pw-btn" onClick={() => void move(nudge.opportunity_id, nudge.move_to!)}>
                Move to {nudge.move_to}
              </button>
            )}
            <Link href={withFrom(`/people/${nudgeOpp.person.id}`, "panel")} className="pa-btn pw-btn">
              Open
            </Link>
            <button type="button" className="pa-btn pw-btn" onClick={() => setDismissed((s) => new Set(s).add(nudge.opportunity_id))}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {board && !nudges.length && opps.length > 0 && (
        <p className="op-nudge op-nudge-clear">
          <SparkleIcon size={14} /> Nothing has stalled: no overdue next steps, no deals gone quiet.
        </p>
      )}

      <p className="ib-note">
        <strong>How it works:</strong> deals come from your calls (or “+ Opportunity”). Drag a card to another stage, or use <em>Move</em>; it is saved and logged. Weighted = value × the stage&apos;s chance (
        {STAGES.filter((s) => s !== "Lost")
          .map((s) => `${s} ${pct(STAGE_CHANCE[s])}`)
          .join(", ")}
        ).
      </p>

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onDone={(title) => {
            setAdding(false);
            setNotice({ text: `“${title}” added.` });
            void load(true);
          }}
        />
      )}
    </PeopleChrome>
  );
}
