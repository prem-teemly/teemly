"use client";

import Link from "next/link";
import type { DeptDetail, DeptExtras, DeptPerson } from "../lib/departments";
import { deptStyle } from "../lib/departments";
import { type From, withFrom } from "../lib/origin";
import { dayLabel, dueLabel, kindLabel, rupees, stageClass } from "../lib/people";
import { AlertIcon, CalendarIcon, LayersIcon, MapPinIcon, SparkleIcon } from "./Icons";
import { PersonAvatar, ScorePill } from "./PeopleBits";

// Department dashboards, one for each kind of work (Settings → Departments → Dashboard):
//   Sales pipeline   win rate, average deal, conversion by stage, closing soon, stalled, customers
//   Partners         territories (cities), onboarding, what each partner brings (incl. introductions)
//   Suppliers        quoted vs committed, every vendor, promises and deliveries from the calls
//   Tenders          deadline countdown, tender value, officials
// Everything comes from the department's people and deals (GET /api/department-pages/:slug). Empty
// sections say what would fill them; nothing is estimated.

type Props = { data: DeptDetail; extras: DeptExtras; from: From };
const OPEN = (s: string) => s !== "Won" && s !== "Lost";
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------- shared

// (Department goals — a target and its progress bar — are left out for now; the data stays in MySQL.)
function Header({ data, title, sub }: { data: DeptDetail; title: string; sub: string }) {
  const d = data.department;
  return (
    <div className="pl-head dv-head">
      <div className="dd-title">
        <span className="dp-icon dd-icon" style={deptStyle(d.color)} aria-hidden="true">
          <LayersIcon size={18} />
        </span>
        <div>
          <h1 className="pl-title">{title}</h1>
          <p className="pl-sub">{sub}</p>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "neg" | "warn" | "pos" }) {
  return (
    <div className={`dv-kpi ${tone ? `dv-kpi-${tone}` : ""}`}>
      <span className="dv-kpi-label">{label}</span>
      <span className="dv-kpi-value">{value}</span>
      {sub && <span className="dv-kpi-sub">{sub}</span>}
    </div>
  );
}

function Card({ title, note, children, className = "" }: { title: React.ReactNode; note?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card dv-card ${className}`}>
      <div className="dv-card-head">
        <h2 className="dv-h2">{title}</h2>
        {note && <span className="dv-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="dv-empty">{children}</p>;

function Stage({ stage, label }: { stage: string | null; label?: string }) {
  if (!stage) return <span className="pl-direct">—</span>;
  return <span className={`pw-stage pw-stage-${stageClass(stage)} dd-stage`}>{label ?? stage}</span>;
}

function DaysChip({ days }: { days: number }) {
  const tone = days < 0 ? "neg" : days <= 3 ? "warn" : "ok";
  const text = days < 0 ? `Overdue ${-days}d` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `${days} days left`;
  return <span className={`dv-days dv-days-${tone}`}>{text}</span>;
}

/** A deal as a line: who · what · ₹ · stage, with a chip on the right. */
function DealLine({ o, from, right }: { o: { id: string; title: string; person: { id: string; name: string }; stage: string; value_inr: number | null; next_step: string | null }; from: From; right?: React.ReactNode }) {
  return (
    <li className="dv-deal">
      <div className="dv-deal-main">
        <Link href={withFrom(`/opportunities/${o.id}`, from)} className="dv-deal-title">
          {o.title}
        </Link>
        <span className="dv-deal-sub">
          <Link href={withFrom(`/people/${o.person.id}`, from)}>{o.person.name}</Link>
          {o.value_inr !== null && ` · ${rupees(o.value_inr)}`}
          {o.next_step && ` · Next: ${o.next_step}`}
        </span>
      </div>
      <Stage stage={o.stage} />
      {right}
    </li>
  );
}

function Commitments({ items, from, empty, title = "Promises from calls" }: { items: DeptExtras["commitments"]; from: From; empty: string; title?: string }) {
  return (
    <Card title={title} note={items.length ? `${items.length} open` : undefined}>
      {items.length ? (
        <ul className="dv-list">
          {items.slice(0, 8).map((c) => (
            <li key={c.id} className="dv-promise">
              <span className={`dv-who dv-who-${c.who}`}>{c.who === "you" ? "You" : `${c.by ?? "They"} owe${c.by ? "s" : ""} you`}</span>
              <span className="dv-promise-text">{c.text}</span>
              <span className="dv-promise-meta">
                <Link href={withFrom(`/people/${c.person.id}/calls/${c.job_id}`, from)}>{c.person.name}</Link>
                {c.due_text && ` · ${c.due_text}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{empty}</Empty>
      )}
    </Card>
  );
}

function Insights({ data }: { data: DeptDetail }) {
  if (!data.insights?.length) return null;
  return (
    <Card
      title={
        <>
          <SparkleIcon size={13} /> What stands out
        </>
      }
    >
      <ul className="dv-insights">
        {data.insights.slice(0, 5).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Card>
  );
}

function PersonCell({ p, from }: { p: DeptPerson; from: From }) {
  return (
    <div className="pl-person">
      <PersonAvatar name={p.name} initials={p.initials} />
      <div>
        <Link href={withFrom(`/people/${p.id}`, from)} className="pl-name">
          {p.name}
        </Link>
        <p className="pl-role">{[p.role_title ?? p.category, p.organisation, p.city].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    </div>
  );
}
const lastContact = (p: DeptPerson) => (p.last_contact_at ? `${dayLabel(p.last_contact_at)} · ${kindLabel(p.last_contact_kind)}` : "—");

// --------------------------------------------------------------------------------- Sales

export function SalesDashboard({ data, extras: x, from }: Props) {
  const d = data.department;
  const t = data.totals;
  const flow = x.reached.filter((r) => r.stage !== "Lost");
  const top = Math.max(1, ...flow.map((r) => r.count));
  const soonValue = x.closing_soon.reduce((s, o) => s + (o.value_inr ?? 0), 0);
  return (
    <>
      <Header data={data} title={`${d.name} pipeline`} sub={`${plural(t.people, "customer")} · ${plural(t.open_opportunities, "open deal")}`} />
      <section className="dv-kpis" aria-label="Sales numbers">
        <Kpi label="Open pipeline" value={rupees(t.open_value_inr)} sub={`${rupees(t.weighted_inr ?? 0)} weighted`} />
        <Kpi label="Win rate" value={x.win_rate === null ? "—" : `${x.win_rate}%`} sub={x.win_rate === null ? "no deal closed yet" : `${x.won_count} won · ${x.lost_count} lost`} tone={x.win_rate !== null && x.win_rate >= 50 ? "pos" : undefined} />
        <Kpi label="Average deal" value={x.avg_deal_inr === null ? "—" : rupees(x.avg_deal_inr)} sub={x.avg_deal_inr === null ? "no amounts yet" : "deals with an amount"} />
        <Kpi label="Closing in 14 days" value={String(x.closing_soon.length)} sub={x.closing_soon.length ? rupees(soonValue) : "nothing dated"} tone={x.closing_soon.some((o) => o.days_left < 0) ? "neg" : x.closing_soon.length ? "warn" : undefined} />
      </section>

      <Card title="How far deals get" note="deals that reached each stage · % of the stage before">
        {flow.some((r) => r.count) ? (
          <ol className="dv-funnel">
            {flow.map((r, i) => (
              <li key={r.stage}>
                <span className="dv-funnel-stage">{r.stage}</span>
                <span className="dv-funnel-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(r.count ? 4 : 0, (r.count / top) * 100)}%`, background: d.color }} />
                </span>
                <span className="dv-funnel-n">{r.count}</span>
                <span className="dv-funnel-pct">{i === 0 || !flow[i - 1].count ? "" : `${pct(r.count, flow[i - 1].count)}%`}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No deals yet. Deals talked about in calls appear here by stage.</Empty>
        )}
      </Card>

      <div className="dv-two">
        <Card
          title={
            <>
              <CalendarIcon size={14} /> Closing soon
            </>
          }
          note="next 14 days and overdue"
        >
          {x.closing_soon.length ? (
            <ul className="dv-list">
              {x.closing_soon.map((o) => (
                <DealLine key={o.id} o={o} from={from} right={<DaysChip days={o.days_left} />} />
              ))}
            </ul>
          ) : (
            <Empty>No deal is due in the next 14 days. Give a deal a due date on its page to see it here.</Empty>
          )}
        </Card>
        <Card
          title={
            <>
              <AlertIcon size={14} /> Stalled
            </>
          }
          note="no stage move for 3+ weeks"
        >
          {x.stalled.length ? (
            <ul className="dv-list">
              {x.stalled.map((o) => (
                <DealLine key={o.id} o={o} from={from} right={<span className="dv-days dv-days-warn">{o.days_in_stage} days</span>} />
              ))}
            </ul>
          ) : (
            <Empty>Every open deal moved in the last 3 weeks.</Empty>
          )}
        </Card>
      </div>

      <Card title="Customers" note={`${plural(t.people, "customer")} · biggest first`}>
        {data.people.length ? (
          <div className="dd-scroll">
            <table className="pl-table dd-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Open deals</th>
                  <th>Won</th>
                  <th>Stage</th>
                  <th>Next</th>
                  <th>Last contact</th>
                  <th>Interest</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id} className="pl-row">
                    <td>
                      <PersonCell p={p} from={from} />
                    </td>
                    <td className="dd-money">{p.open_value_inr ? rupees(p.open_value_inr) : "—"}</td>
                    <td className="dd-money">{p.won_value_inr ? rupees(p.won_value_inr) : "—"}</td>
                    <td>
                      <Stage stage={p.stage} />
                    </td>
                    <td className={`dd-next ${p.overdue ? "dv-neg" : ""}`}>
                      {p.next_step ?? <span className="pl-direct">—</span>}
                      {p.due_date && <span className="dv-due"> · {p.overdue ? "overdue" : dueLabel(p.due_date)}</span>}
                    </td>
                    <td className="pl-last">{lastContact(p)}</td>
                    <td>
                      <ScorePill score={p.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No customers yet. When a call talks about a buyer, they are sorted in here.</Empty>
        )}
      </Card>
      <Insights data={data} />
    </>
  );
}

// ------------------------------------------------------------------------------ Partners

const BUCKETS: { key: string; label: string; stages: string[] }[] = [
  { key: "talking", label: "Talking", stages: ["Identified", "First contact", "In discussion"] },
  { key: "agreement", label: "Agreement", stages: ["Pitch / bid shared", "Negotiation", "Committed"] },
  { key: "active", label: "Active", stages: ["Won"] },
];
const bucketOf = (stage: string | null) => BUCKETS.find((b) => stage && b.stages.includes(stage))?.key ?? "none";

export function PartnersDashboard({ data, extras: x, from }: Props) {
  const d = data.department;
  const t = data.totals;
  const cities = x.cities.filter((c) => c.known);
  const unknownCity = x.cities.find((c) => !c.known)?.people ?? 0;
  const topCity = Math.max(1, ...cities.map((c) => c.people));
  const brought = (id: string) => x.introduced[id] ?? null;
  const sourced = data.people.reduce((s, p) => s + p.open_value_inr + (brought(p.id)?.open_value_inr ?? 0), 0);
  const counts = Object.fromEntries([...BUCKETS.map((b) => b.key), "none"].map((k) => [k, data.people.filter((p) => bucketOf(p.stage) === k).length]));
  const active = data.people.filter((p) => p.won_value_inr > 0 || p.open_value_inr > 0).length;
  return (
    <>
      <Header data={data} title={`${d.name}`} sub={`${plural(t.people, "partner")} · ${plural(cities.length, "city", "cities")} covered`} />
      <section className="dv-kpis" aria-label="Partner numbers">
        <Kpi label="Partners" value={String(t.people)} sub={`${active} with a live deal`} />
        <Kpi label="Partner-sourced value" value={rupees(sourced)} sub="their deals + people they introduced" />
        <Kpi label="Cities covered" value={String(cities.length)} sub={unknownCity ? `${unknownCity} without a city yet` : cities.slice(0, 2).map((c) => c.city).join(", ") || "—"} />
        <Kpi label="Quiet 14+ days" value={String(x.quiet.length)} sub={x.quiet.length ? x.quiet.slice(0, 2).map((q) => q.name).join(", ") : "everyone in touch"} tone={x.quiet.length ? "warn" : undefined} />
      </section>

      <div className="dv-two">
        <Card
          title={
            <>
              <MapPinIcon size={14} /> Territory coverage
            </>
          }
          note="partners by city"
        >
          {cities.length ? (
            <ul className="dv-bars">
              {cities.map((c) => (
                <li key={c.city}>
                  <span className="dv-bar-name">{c.city}</span>
                  <span className="dv-bar" aria-hidden="true">
                    <span style={{ width: `${(c.people / topCity) * 100}%`, background: d.color }} />
                  </span>
                  <span className="dv-bar-n">
                    {c.people}
                    {c.open_value_inr ? <span className="dv-faint"> · {rupees(c.open_value_inr)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No cities yet. When a call says where a partner works, it shows here.</Empty>
          )}
        </Card>
        <Card title="Partner onboarding" note="by each partner's furthest deal">
          <ol className="dv-steps">
            {BUCKETS.map((b, i) => (
              <li key={b.key} className={counts[b.key] ? "dv-step-on" : ""} style={counts[b.key] ? { borderColor: d.color } : undefined}>
                <span className="dv-step-n">{counts[b.key]}</span>
                <span className="dv-step-label">{b.label}</span>
                <span className="dv-step-sub">{b.stages.join(" · ")}</span>
                {i < BUCKETS.length - 1 && <span className="dv-step-arrow" aria-hidden="true">→</span>}
              </li>
            ))}
          </ol>
          {counts.none > 0 && <p className="dv-faint dv-step-none">{plural(counts.none, "partner")} with no deal yet</p>}
        </Card>
      </div>

      <Card title="Partners" note="what each one brings">
        {data.people.length ? (
          <ul className="dv-cards">
            {data.people.map((p) => {
              const b = brought(p.id);
              return (
                <li key={p.id} className="dv-pcard">
                  <div className="dv-pcard-top">
                    <PersonCell p={p} from={from} />
                    <ScorePill score={p.score} />
                  </div>
                  <div className="dv-pcard-facts">
                    <span>
                      <strong>{p.open_value_inr ? rupees(p.open_value_inr) : "—"}</strong> open
                      {p.won_value_inr ? ` · ${rupees(p.won_value_inr)} won` : ""}
                    </span>
                    <span>
                      Brought <strong>{b ? b.count : 0}</strong>
                      {b?.open_value_inr ? ` · ${rupees(b.open_value_inr)}` : ""}
                    </span>
                  </div>
                  {b && <p className="dv-faint dv-pcard-names">Introduced {b.names.join(", ")}</p>}
                  <div className="dv-pcard-foot">
                    <Stage stage={p.stage} label={p.stage ? `${BUCKETS.find((x2) => x2.key === bucketOf(p.stage))?.label} · ${p.stage}` : undefined} />
                    <span className="dv-faint">{lastContact(p)}</span>
                  </div>
                  {p.next_step && <p className="dv-pcard-next">Next: {p.next_step}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No partners yet. When a call talks about a distributor, dealer or reseller, they are sorted in here.</Empty>
        )}
      </Card>
      <div className="dv-two">
        <Commitments items={x.commitments} from={from} empty="No open promises with partners from the calls." />
        <Insights data={data} />
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------- Suppliers

export function SuppliersDashboard({ data, extras: x, from }: Props) {
  const d = data.department;
  const t = data.totals;
  const quoted = data.opportunities.filter((o) => OPEN(o.stage) && o.stage !== "Committed").reduce((s, o) => s + (o.value_inr ?? 0), 0);
  const committed = data.opportunities.filter((o) => o.stage === "Committed" || o.stage === "Won").reduce((s, o) => s + (o.value_inr ?? 0), 0);
  const theyOwe = x.commitments.filter((c) => c.who === "them");
  const dealsOf = (pid: string) => data.opportunities.filter((o) => o.person.id === pid);
  return (
    <>
      <Header data={data} title={`${d.name}`} sub={`${plural(t.people, "supplier")} · ${plural(data.opportunities.length, "quote or order", "quotes and orders")}`} />
      <section className="dv-kpis" aria-label="Supplier numbers">
        <Kpi label="Suppliers" value={String(t.people)} sub={`${t.people_with_value} with a quote`} />
        <Kpi label="Quoted (open)" value={rupees(quoted)} sub="not committed yet" />
        <Kpi label="Committed" value={rupees(committed)} sub="committed and won orders" tone={committed ? "pos" : undefined} />
        <Kpi label="Their promises" value={String(theyOwe.length)} sub={`${x.commitments.length - theyOwe.length} you promised`} tone={theyOwe.length ? "warn" : undefined} />
      </section>

      <Card title="Suppliers" note="what they supply · quote · status">
        {data.people.length ? (
          <div className="dd-scroll">
            <table className="pl-table dd-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Supplies</th>
                  <th>Quote / order</th>
                  <th>Status</th>
                  <th>Next</th>
                  <th>Last contact</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => {
                  const ds = dealsOf(p.id);
                  const lead = ds.find((o) => OPEN(o.stage)) ?? ds[0];
                  return (
                    <tr key={p.id} className="pl-row">
                      <td>
                        <PersonCell p={p} from={from} />
                      </td>
                      <td className="dv-supplies">{lead ? <Link href={withFrom(`/opportunities/${lead.id}`, from)}>{lead.title}</Link> : (p.role_title ?? <span className="pl-direct">—</span>)}</td>
                      <td className="dd-money">{p.open_value_inr ? rupees(p.open_value_inr) : p.won_value_inr ? `${rupees(p.won_value_inr)} ordered` : "—"}</td>
                      <td>
                        <Stage stage={p.stage} />
                      </td>
                      <td className={`dd-next ${p.overdue ? "dv-neg" : ""}`}>
                        {p.next_step ?? <span className="pl-direct">—</span>}
                        {p.due_date && <span className="dv-due"> · {p.overdue ? "overdue" : dueLabel(p.due_date)}</span>}
                      </td>
                      <td className="pl-last">{lastContact(p)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No suppliers yet. When a call talks about a vendor, they are sorted in here.</Empty>
        )}
      </Card>

      <div className="dv-two">
        <Commitments items={x.commitments} from={from} title="Deliveries and promises" empty="No open promises with suppliers from the calls (a delivery date or a quote they said they would send shows here)." />
        <Card
          title={
            <>
              <CalendarIcon size={14} /> Due dates
            </>
          }
          note="orders and quotes with a date"
        >
          {x.deadlines.length ? (
            <ul className="dv-list">
              {x.deadlines.map((o) => (
                <DealLine key={o.id} o={o} from={from} right={<DaysChip days={o.days_left} />} />
              ))}
            </ul>
          ) : (
            <Empty>No dated orders. Give a supplier deal a due date on its page to track it here.</Empty>
          )}
        </Card>
      </div>
      <Insights data={data} />
    </>
  );
}

// ------------------------------------------------------------------------------- Tenders

export function TendersDashboard({ data, extras: x, from }: Props) {
  const d = data.department;
  const tenders = data.opportunities;
  const open = tenders.filter((o) => OPEN(o.stage));
  const value = open.reduce((s, o) => s + (o.value_inr ?? 0), 0);
  const thisWeek = x.deadlines.filter((o) => o.days_left >= 0 && o.days_left <= 7);
  const overdue = x.deadlines.filter((o) => o.days_left < 0);
  const daysOf = new Map(x.deadlines.map((o) => [o.id, o.days_left]));
  const undated = open.filter((o) => !o.due_date);
  return (
    <>
      <Header data={data} title={`${d.name}`} sub={`${plural(open.length, "open tender")} · ${plural(data.totals.people, "official or contact", "officials and contacts")}`} />
      <section className="dv-kpis" aria-label="Tender numbers">
        <Kpi label="Open tenders" value={String(open.length)} sub={`${tenders.filter((o) => o.stage === "Won").length} won`} />
        <Kpi label="Tender value" value={rupees(value)} sub="open tenders" />
        <Kpi label="Due this week" value={String(thisWeek.length)} sub={thisWeek[0] ? `next: ${thisWeek[0].title}` : "nothing this week"} tone={thisWeek.length ? "warn" : undefined} />
        <Kpi label="Overdue" value={String(overdue.length)} sub={overdue.length ? "deadline passed" : "none"} tone={overdue.length ? "neg" : undefined} />
      </section>

      <Card
        title={
          <>
            <CalendarIcon size={14} /> Deadlines
          </>
        }
        note="soonest first"
      >
        {x.deadlines.length ? (
          <ol className="dv-timeline">
            {x.deadlines.map((o) => (
              <li key={o.id} className={o.days_left < 0 ? "dv-tl-over" : o.days_left <= 3 ? "dv-tl-soon" : ""}>
                <span className="dv-tl-date">
                  <strong>{o.due_date ? dueLabel(o.due_date) : ""}</strong>
                  <DaysChip days={o.days_left} />
                </span>
                <span className="dv-tl-main">
                  <Link href={withFrom(`/opportunities/${o.id}`, from)} className="dv-deal-title">
                    {o.title}
                  </Link>
                  <span className="dv-deal-sub">
                    <Link href={withFrom(`/people/${o.person.id}`, from)}>{o.person.name}</Link>
                    {o.value_inr !== null && ` · ${rupees(o.value_inr)}`}
                    {o.next_step && ` · Next: ${o.next_step}`}
                  </span>
                </span>
                <Stage stage={o.stage} />
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No tender deadlines yet. When a call mentions a tender and its last date (or you set a due date on it), it shows here.</Empty>
        )}
        {undated.length > 0 && <p className="dv-faint dv-undated">{plural(undated.length, "open tender")} without a deadline: {undated.slice(0, 3).map((o) => o.title).join(", ")}</p>}
      </Card>

      <Card title="Tenders" note="Pitch / bid shared = bid submitted">
        {tenders.length ? (
          <div className="dd-scroll">
            <table className="pl-table dd-table">
              <thead>
                <tr>
                  <th>Tender</th>
                  <th>Official / contact</th>
                  <th>Value</th>
                  <th>Stage</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {tenders.map((o) => (
                  <tr key={o.id} className="pl-row">
                    <td>
                      <Link href={withFrom(`/opportunities/${o.id}`, from)} className="pl-name">
                        {o.title}
                      </Link>
                    </td>
                    <td>
                      <Link href={withFrom(`/people/${o.person.id}`, from)} className="pl-intro">
                        {o.person.name}
                      </Link>
                    </td>
                    <td className="dd-money">{o.value_inr !== null ? rupees(o.value_inr) : "—"}</td>
                    <td>
                      <Stage stage={o.stage} />
                    </td>
                    <td>{o.due_date ? OPEN(o.stage) && daysOf.has(o.id) ? <DaysChip days={daysOf.get(o.id)!} /> : dueLabel(o.due_date) : <span className="pl-direct">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No tenders yet. Tenders talked about in calls appear here with their value and deadline.</Empty>
        )}
      </Card>

      <div className="dv-two">
        <Card title="Officials and contacts" note={plural(data.totals.people, "person", "people")}>
          {data.people.length ? (
            <ul className="dv-list">
              {data.people.map((p) => (
                <li key={p.id} className="dv-official">
                  <PersonCell p={p} from={from} />
                  <span className="dv-faint">{lastContact(p)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No officials yet. When a call talks about a government officer or department contact, they show here.</Empty>
          )}
        </Card>
        <Commitments items={x.commitments} from={from} title="Tasks from calls" empty="No open tasks from tender calls (documents to send, EMD, site visits…)." />
      </div>
      <Insights data={data} />
    </>
  );
}
