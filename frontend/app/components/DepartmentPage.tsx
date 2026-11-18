"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type DeptDetail, deptStyle, getDepartmentDetail } from "../lib/departments";
import { dayLabel, dueLabel, kindLabel, rupees, stageClass, whenLabel } from "../lib/people";
const FUNNEL_SHORT: Record<string, string> = { "First contact": "1st contact", "In discussion": "Discussion", "Pitch / bid shared": "Pitch" };
import { LayersIcon, PhoneIcon, SparkleIcon, WhatsAppIcon } from "./Icons";
import { withFrom } from "../lib/origin";
import InvestmentDashboard from "./InvestmentDashboard";
import { PartnersDashboard, SalesDashboard, SuppliersDashboard, TendersDashboard } from "./DeptDashboards";
import PeopleChrome from "./PeopleChrome";
import { PersonAvatar, ScorePill } from "./PeopleBits";

// One department: only the people in it (sorted in by their calls, or by an opportunity here) and its
// opportunities. Investment reads as an investor pipeline: the total, and each investor's amount.



const DASHBOARDS: Partial<Record<string, typeof SalesDashboard>> = { sales: SalesDashboard, partners: PartnersDashboard, suppliers: SuppliersDashboard, tenders: TendersDashboard };

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="pf-stat">
      <span className="pf-stat-label">{label}</span>
      <span className="pf-stat-value">{value}</span>
      {sub && <span className="pf-stat-sub">{sub}</span>}
    </div>
  );
}

export default function DepartmentPage({ slug }: { slug: string }) {
  // People opened from here come back here (breadcrumb "Departments › <department> › <person>").
  const fromDept = `dept:${slug}` as const;
  const [data, setData] = useState<DeptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getDepartmentDetail(slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this department.");
    }
  }, [slug]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  if (error || !data) {
    return (
      <PeopleChrome active={`dept:${slug}`}>
        <div className="card pl-state" role={error ? "alert" : undefined} aria-busy={!error}>
          {error ? (
            <>
              <p>{error}</p>
              <Link href="/departments" className="pl-view">
                Back to Departments
              </Link>
            </>
          ) : (
            <span className="auth-spinner" />
          )}
        </div>
      </PeopleChrome>
    );
  }

  // Each department has the dashboard for its work (Settings → Departments → Dashboard; by default
  // from its name). Investors: the investor pipeline; the others: see DeptDashboards.
  const view = data.department.view ?? (data.department.slug === "investment" ? "investors" : "standard");
  const crumbs = (
    <nav className="pa-crumbs" aria-label="Breadcrumb">
      <Link href="/departments">Departments</Link> <span aria-hidden="true">›</span> <span>{data.department.name}</span>
    </nav>
  );
  if (view === "investors") {
    return (
      <PeopleChrome active={`dept:${slug}`}>
        {crumbs}
        <InvestmentDashboard data={data} onReload={() => void load()} />
      </PeopleChrome>
    );
  }
  const Dashboard = DASHBOARDS[view];
  if (Dashboard && data.extras) {
    return (
      <PeopleChrome active={`dept:${slug}`}>
        {crumbs}
        <Dashboard data={data} extras={data.extras} from={fromDept} />
      </PeopleChrome>
    );
  }

  const { department: d, totals, funnel, people, opportunities } = data;
  const inv = false;
  const who = inv ? "Investor" : "Person";
  const maxFunnel = Math.max(1, ...funnel.map((f) => f.value_inr || f.count));
  const open = opportunities.filter((o) => o.stage !== "Won" && o.stage !== "Lost");

  return (
    <PeopleChrome active={`dept:${d.slug}`}>
      <nav className="pa-crumbs" aria-label="Breadcrumb">
        <Link href="/departments">Departments</Link> <span aria-hidden="true">›</span> <span>{d.name}</span>
      </nav>
      <div className="pl-head">
        <div className="dd-title">
          <span className="dp-icon dd-icon" style={deptStyle(d.color)} aria-hidden="true">
            <LayersIcon size={18} />
          </span>
          <div>
            <h1 className="pl-title">{inv ? "Investment pipeline" : d.name}</h1>
            <p className="pl-sub">{d.description || `${totals.people} ${totals.people === 1 ? "person" : "people"} in this department`}</p>
          </div>
        </div>
      </div>

      <section className="pf-stats dd-stats" aria-label="Totals">
        <Stat label={inv ? "Total pipeline" : "Open value"} value={rupees(totals.open_value_inr)} sub={`${totals.open_opportunities} open ${totals.open_opportunities === 1 ? "opportunity" : "opportunities"}`} />
        <Stat label={inv ? "Investors" : "People"} value={String(totals.people)} sub={inv ? `${totals.people_with_value} with an amount` : `${totals.hot} very interested`} />
        <Stat label={inv ? "Committed (won)" : "Won"} value={rupees(totals.won_value_inr)} sub={totals.won_value_inr ? undefined : "nothing closed yet"} />
        <section className="pf-stat dd-funnel" aria-label="Funnel">
          <span className="pf-stat-label">Funnel</span>
          <div className="dd-bars">
            {funnel
              .filter((f) => f.stage !== "Lost")
              .map((f) => (
                <div key={f.stage} className="dd-bar-col" title={`${f.stage}: ${f.count} · ${rupees(f.value_inr)}`}>
                  <span className="dd-bar" style={{ height: `${Math.max(f.count ? 12 : 3, ((f.value_inr || f.count) / maxFunnel) * 52)}px`, background: d.color, opacity: f.count ? 0.85 : 0.2 }} />
                  <span className="dd-bar-label">{FUNNEL_SHORT[f.stage] ?? f.stage}</span>
                  <span className="dd-bar-sub">
                    {f.count} · {f.value_inr ? rupees(f.value_inr) : "—"}
                  </span>
                </div>
              ))}
          </div>
        </section>
      </section>

      <section className="card dd-table-card" aria-label={inv ? "Investors" : "People"}>
        <h2 className="dp-h2">{inv ? "Every investor" : `People in ${d.name}`}</h2>
        {people.length ? (
          <div className="dd-scroll">
            <table className="pl-table dd-table">
              <thead>
                <tr>
                  <th>{who}</th>
                  <th>Introduced by</th>
                  <th>{inv ? "Ticket" : "Open value"}</th>
                  <th>Stage</th>
                  <th>Interest</th>
                  <th>Last contact</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="pl-row">
                    <td>
                      <div className="pl-person">
                        <PersonAvatar name={p.name} initials={p.initials} />
                        <div>
                          <Link href={withFrom(`/people/${p.id}`, fromDept)} className="pl-name">
                            {p.name}
                          </Link>
                          <p className="pl-role">{[p.role_title ?? p.category, p.organisation, p.city].filter(Boolean).join(" · ") || "—"}</p>
                        </div>
                      </div>
                    </td>
                    <td className={p.introduced_by ? "pl-intro" : "pl-direct"}>
                      {p.introduced_by ? (
                        <Link href={withFrom(`/people/${p.introduced_by.id}`, fromDept)} className="pl-intro">
                          {p.introduced_by.name}
                        </Link>
                      ) : (
                        "Direct"
                      )}
                    </td>
                    <td className="dd-money">{p.open_value_inr ? rupees(p.open_value_inr) : p.won_value_inr ? `${rupees(p.won_value_inr)} won` : "—"}</td>
                    <td>{p.stage ? <span className={`pw-stage pw-stage-${stageClass(p.stage)} dd-stage`}>{p.stage}</span> : <span className="pl-direct">—</span>}</td>
                    <td>
                      <ScorePill score={p.score} />
                    </td>
                    <td className="pl-last">{p.last_contact_at ? `${dayLabel(p.last_contact_at)} · ${kindLabel(p.last_contact_kind)}` : "—"}</td>
                    <td className="dd-next">{p.next_step ?? <span className="pl-direct">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="pa-empty">Nobody in {d.name} yet. When a call talks about someone who fits here, they are sorted in automatically.</p>
        )}
      </section>

      <section className="card dd-table-card" aria-label="Opportunities">
        <h2 className="dp-h2">
          Opportunities in {d.name} <span className="dp-muted">· {open.length} open</span>
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
                    with{" "}
                    <Link href={withFrom(`/people/${o.person.id}`, fromDept)} className="pl-intro">
                      {o.person.name}
                    </Link>
                    {o.next_step && <> · Next: {o.next_step}</>}
                    {o.due_date && <> · Due {dueLabel(o.due_date)}</>}
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
          <p className="pa-empty">No opportunities in {d.name} yet. They are captured from calls, or added on a person&apos;s page.</p>
        )}
      </section>
    </PeopleChrome>
  );
}
