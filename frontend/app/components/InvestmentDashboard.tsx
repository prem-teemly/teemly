"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { type DeptDetail, type DeptPerson, deptStyle } from "../lib/departments";
import { withFrom } from "../lib/origin";
import { type Person, STAGES, addOpportunity, dayLabel, dueLabel, getPeople, kindLabel, rupees, stageClass, whenLabel } from "../lib/people";
import { DownloadIcon, LinkIcon, PhoneIcon, PlusIcon, SparkleIcon, WhatsAppIcon } from "./Icons";
import { PersonAvatar, ScorePill } from "./PeopleBits";

// Investment department as an investor pipeline (design: "Teemly · Investment"). Every number comes
// from the opportunities captured from calls (or added by the owner) in the Investment department.
// (A round name and target — "department goals" — are not shown for now; the columns stay in MySQL.)


const FUNNEL_LABEL: Record<string, string> = { "First contact": "1st contact", "In discussion": "Discussion", "Pitch / bid shared": "Pitch" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Interest across conversations: a small line, green when rising, red when falling. */
function Sparkline({ values, change }: { values: number[]; change: number }) {
  if (!values.length) return <span className="pl-direct">—</span>;
  const W = 64;
  const H = 22;
  const pts = values.length === 1 ? [values[0], values[0]] : values;
  const x = (i: number) => ((i / (pts.length - 1)) * (W - 4) + 2).toFixed(1);
  const y = (v: number) => (H - 3 - ((v - 20) / 70) * (H - 6)).toFixed(1);
  const tone = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return (
    <span className={`iv-trend iv-trend-${tone}`} title={`Interest in the last ${values.length} conversation${values.length === 1 ? "" : "s"}`}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <polyline points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="iv-change">{change > 0 ? `+${change}` : change}</span>
    </span>
  );
}

function lastContact(p: DeptPerson): string {
  if (!p.last_contact_at) return "—";
  return `${dayLabel(p.last_contact_at)} · ${p.last_contact_via ? `via ${p.last_contact_via}` : kindLabel(p.last_contact_kind)}`;
}

/** Plain-text investor update from the numbers on this page (copied to the clipboard). */
function updateText(data: DeptDetail): string {
  const { department: d, totals, people } = data;
  const lines = [
    `${d.name} update · ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`,
    `Pipeline ${rupees(totals.open_value_inr)} · weighted ${rupees(totals.weighted_inr ?? 0)} · committed ${rupees(totals.won_value_inr)}`,
    "",
    `Investors (${people.length}):`,
    ...people.map((p) => `- ${p.name}${p.role_title ? ` (${p.role_title})` : ""}: ${p.open_value_inr ? rupees(p.open_value_inr) : p.won_value_inr ? `${rupees(p.won_value_inr)} committed` : "amount not discussed"}${p.stage ? ` · ${p.stage}` : ""}${p.next_step ? ` · next: ${p.next_step}` : ""}`),
  ];
  if (data.insights?.length) lines.push("", ...data.insights.map((i) => `• ${i}`));
  return lines.join("\n");
}

/** "+ Investor": an investment deal with someone in People (the AI adds them from calls too). */
function AddInvestor({ deptName, onDone, onClose }: { deptName: string; onDone: () => void; onClose: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [pid, setPid] = useState("");
  const [title, setTitle] = useState("Investment");
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState("Identified");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    getPeople().then(setPeople, (e) => setError(message(e, "Could not load People.")));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const digits = amount.replace(/[,\s₹]/g, "");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!pid) return setError("Choose who is investing.");
    if (!title.trim()) return setError("Give it a title.");
    if (digits && !/^\d+$/.test(digits)) return setError("Amount should be a number of rupees, e.g. 2500000.");
    setBusy(true);
    setError(null);
    try {
      await addOpportunity(pid, { title: title.trim(), department: deptName, stage: stage as "Identified", value_inr: digits ? Number(digits) : null, next_step: next.trim() || null });
      onDone();
    } catch (err) {
      setError(message(err, "Could not add."));
      setBusy(false);
    }
  }
  return (
    <div className="ib-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ib-dialog" role="dialog" aria-modal="true" aria-labelledby="iv-add-title" ref={box}>
        <div className="ib-dialog-head">
          <h2 id="iv-add-title" className="ib-dialog-title">
            Add an investor deal
          </h2>
          <button type="button" className="ib-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="ib-form" onSubmit={(e) => void save(e)}>
          <p className="ib-why">Investors are also added automatically when a call talks about an investment. Use this for one you know about already.</p>
          <label className="ib-field">
            <span>Investor (from People)</span>
            <select value={pid} onChange={(e) => setPid(e.target.value)} autoFocus>
              <option value="">{people ? "Choose a person…" : "Loading…"}</option>
              {people?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.role_title ? ` · ${p.role_title}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="ib-row">
            <label className="ib-field">
              <span>Title</span>
              <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="ib-field">
              <span>Ticket (₹)</span>
              <input value={amount} inputMode="numeric" placeholder="e.g. 2500000" onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
          <div className="ib-row">
            <label className="ib-field">
              <span>Stage</span>
              <select value={stage} onChange={(e) => setStage(e.target.value)}>
                {STAGES.filter((s) => s !== "Lost").map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="ib-field">
              <span>Next step</span>
              <input value={next} maxLength={300} placeholder="e.g. Meeting on Monday" onChange={(e) => setNext(e.target.value)} />
            </label>
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
            <button type="submit" className="pa-btn pa-btn-primary" disabled={busy}>
              {busy ? "Adding…" : "Add investor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function InvestmentDashboard({ data, onReload }: { data: DeptDetail; onReload: () => void }) {
  const { department: d, totals, funnel, people, opportunities } = data;
  // People opened from here come back here (breadcrumb "Departments › Investment › <person>").
  const fromDept = `dept:${d.slug}` as const;
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const chance = data.stage_chance ?? {};
  const stages = funnel.filter((f) => f.stage !== "Lost");
  const maxBar = Math.max(1, ...stages.map((f) => f.value_inr));
  const inPlay = people.filter((p) => p.open_value_inr > 0 || p.stage).length;

  async function copyUpdate() {
    const text = updateText(data);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Investor update copied. Paste it in WhatsApp or email.");
    } catch {
      setCopied(text);
    }
  }

  return (
    <>
      <div className="pl-head iv-head">
        <div className="dd-title">
          <span className="dp-icon dd-icon" style={deptStyle(d.color)} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 17 6-6 4 4 8-8" />
              <path d="M15 7h6v6" />
            </svg>
          </span>
          <div>
            <h1 className="pl-title">{d.name}</h1>
            <p className="pl-sub">
              {inPlay} investor{inPlay === 1 ? "" : "s"} in play
            </p>
          </div>
        </div>
        <div className="pl-views">
          <button type="button" className="pl-view" onClick={() => void copyUpdate()} title="Copy a plain-text update with these numbers">
            <DownloadIcon size={14} /> Investor update
          </button>
          <button type="button" className="pl-view iv-primary" onClick={() => setAdding(true)}>
            <PlusIcon size={14} /> Investor
          </button>
        </div>
      </div>
      {copied && (
        <div className="ib-notice" role="status">
          <span className="iv-copied">{copied}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setCopied(null)}>
            ×
          </button>
        </div>
      )}

      <section className="iv-top" aria-label="Pipeline">
        <div className="iv-stat">
          <span className="iv-stat-label">Total pipeline</span>
          <span className="iv-stat-value">{rupees(totals.open_value_inr)}</span>
          <span className="iv-stat-sub">{`${totals.open_opportunities} open deal${totals.open_opportunities === 1 ? "" : "s"}`}</span>
        </div>
        <div className="iv-stat" title={`Each deal's amount × its stage chance: ${Object.entries(chance).filter(([s]) => s !== "Lost").map(([s, c]) => `${s} ${pct(c)}`).join(", ")}`}>
          <span className="iv-stat-label">Weighted</span>
          <span className="iv-stat-value">{rupees(totals.weighted_inr ?? 0)}</span>
          <span className={`iv-stat-sub ${totals.weighted_added_this_week_inr ? "iv-up" : ""}`}>{totals.weighted_added_this_week_inr ? `↗ ${rupees(totals.weighted_added_this_week_inr)} this week` : "amount × stage chance"}</span>
        </div>
        <div className="iv-stat">
          <span className="iv-stat-label">Committed</span>
          <span className="iv-stat-value">{rupees(totals.won_value_inr)}</span>
          <span className="iv-stat-sub">
            {totals.won_value_inr ? `${totals.won_people} investor${totals.won_people === 1 ? "" : "s"}` : totals.closest ? `${totals.closest.person.name} closest (${totals.closest.stage})` : "nothing committed yet"}
          </span>
        </div>
        <div className="iv-stat iv-funnel">
          <span className="iv-stat-label">Funnel</span>
          <div className="iv-bars">
            {stages.map((f) => (
              <div key={f.stage} className="iv-bar-col" title={`${f.stage}: ${f.count} · ${rupees(f.value_inr)} · ${pct(chance[f.stage] ?? 0)} chance`}>
                <span className="iv-bar" style={{ height: `${f.value_inr ? Math.max(14, (f.value_inr / maxBar) * 56) : f.count ? 14 : 8}px`, background: d.color, opacity: f.count ? (f.value_inr === maxBar ? 1 : 0.6) : 0.18 }} />
                <span className="iv-bar-label">{FUNNEL_LABEL[f.stage] ?? f.stage}</span>
                <span className="iv-bar-sub">
                  {f.count} · {f.value_inr ? rupees(f.value_inr) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card iv-table-card" aria-label="Investors">
        {people.length ? (
          <div className="dd-scroll">
            <table className="pl-table iv-table">
              <thead>
                <tr>
                  <th>Investor</th>
                  <th>Introduced by</th>
                  <th>Ticket</th>
                  <th>Stage</th>
                  <th>Interest</th>
                  <th>Interest trend</th>
                  <th>Last contact</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="pl-row iv-row">
                    <td>
                      <div className="pl-person">
                        <PersonAvatar name={p.name} initials={p.initials} />
                        <div>
                          <Link href={withFrom(`/people/${p.id}`, fromDept)} className="pl-name">
                            {p.name}
                          </Link>
                          <p className="pl-role">{p.role_title ?? p.category ?? "—"}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      {p.introduced_by ? (
                        <Link href={withFrom(`/people/${p.introduced_by.id}`, fromDept)} className="iv-intro">
                          <LinkIcon size={12} /> {p.introduced_by.name}
                        </Link>
                      ) : (
                        <span className="pl-direct">Direct</span>
                      )}
                    </td>
                    <td className="dd-money">{p.open_value_inr ? rupees(p.open_value_inr) : p.won_value_inr ? rupees(p.won_value_inr) : <span className="pl-direct">—</span>}</td>
                    <td>{p.stage ? <span className={`pw-stage pw-stage-${stageClass(p.stage)} dd-stage`}>{p.stage}</span> : <span className="pl-direct">—</span>}</td>
                    <td>
                      <ScorePill score={p.score} />
                    </td>
                    <td>
                      <Sparkline values={p.interest_trend ?? []} change={p.interest_change ?? 0} />
                    </td>
                    <td className="pl-last">{lastContact(p)}</td>
                    <td className={`dd-next ${p.overdue ? "iv-overdue" : ""}`}>
                      {p.overdue ? `Overdue${p.due_date ? ` (${dueLabel(p.due_date)})` : ""}${p.next_step ? `: ${p.next_step}` : ""}` : (p.next_step ?? <span className="pl-direct">—</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="pa-empty">No investors yet. When a call talks about investing in the company, the investor and the amount are added here.</p>
        )}
      </section>

      {!!data.insights?.length && (
        <p className="iv-pattern">
          <SparkleIcon size={14} />
          <span>
            <strong>Pattern:</strong> {data.insights.join(" ")}
          </span>
        </p>
      )}

      <section className="card dd-table-card" aria-label="Investment deals">
        <h2 className="dp-h2">
          Deals <span className="dp-muted">· every amount links to the call it was said in</span>
        </h2>
        {opportunities.length ? (
          <ul className="dd-opps">
            {opportunities.map((o) => (
              <li key={o.id} className={`dd-opp ${o.stage === "Won" || o.stage === "Lost" ? "pw-opp-closed" : ""}`}>
                <div className="dd-opp-main">
                  <Link href={withFrom(`/opportunities/${o.id}`, fromDept)} className="pw-opp-title pw-opp-link" title="View this opportunity">
                    {o.title}
                  </Link>
                  <span className="dd-opp-who">
                    <Link href={withFrom(`/people/${o.person.id}`, fromDept)} className="pl-intro">
                      {o.person.name}
                    </Link>
                    {o.next_step && <> · Next: {o.next_step}</>}
                    {o.due_date && <> · Due {dueLabel(o.due_date)}</>}
                    {o.chance !== undefined && o.stage !== "Lost" && <> · {pct(o.chance)} chance</>}
                  </span>
                  {o.source && (
                    <Link href={withFrom(`/people/${o.person.id}/calls/${o.source.job_id}`, fromDept)} className="pw-source-line">
                      {o.source.kind === "whatsapp" ? <WhatsAppIcon size={12} /> : <PhoneIcon size={12} />}
                      <span className="pw-source-file">{o.source.file_name}</span>
                      <span>· {whenLabel(o.source.at)}</span>
                      {o.origin === "ai" && (
                        <span className="pw-ai">
                          <SparkleIcon size={10} /> Found in call
                        </span>
                      )}
                    </Link>
                  )}
                </div>
                <span className={`pw-stage pw-stage-${stageClass(o.stage)} dd-stage`}>{o.stage}</span>
                <span className="dd-money dd-opp-value">{o.value_inr !== null ? rupees(o.value_inr) : "—"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pa-empty">No investment deals yet.</p>
        )}
      </section>

      {adding && (
        <AddInvestor
          deptName={d.name}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            onReload();
          }}
        />
      )}
    </>
  );
}
