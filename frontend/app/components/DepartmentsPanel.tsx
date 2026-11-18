"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type DeptCard, type Overview, deptStyle, getDepartmentOverview } from "../lib/departments";
import { withFrom } from "../lib/origin";
import { dayLabel, rupees } from "../lib/people";
import { LayersIcon, PlusIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { DeptTag, PersonAvatar } from "./PeopleBits";

// Departments panel: one card per department (built-in and added in Settings) with what is really in
// it: people sorted into it from their calls and chats, and the money in its open opportunities.

function TrendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}

function Card({ d }: { d: DeptCard }) {
  const money = d.open_value_inr > 0;
  return (
    <Link href={`/departments/${d.slug}`} className="dp-card" style={{ ["--dept" as string]: d.color }}>
      <div className="dp-card-top">
        <span className="dp-icon" style={deptStyle(d.color)} aria-hidden="true">
          <LayersIcon size={16} />
        </span>
        <span className="dp-name">{d.name}</span>
        {d.new_this_week > 0 && (
          <span className="dp-trend" title={`${d.new_this_week} new this week`}>
            <TrendIcon />
          </span>
        )}
      </div>
      <p className="dp-big">{money ? rupees(d.open_value_inr) : `${d.people} ${d.people === 1 ? "person" : "people"}`}</p>
      <p className="dp-sub">
        {d.open_opportunities ? `${d.open_opportunities} open ${d.open_opportunities === 1 ? "opportunity" : "opportunities"}` : "No open opportunities yet"}
        {d.won_value_inr > 0 && ` · ${rupees(d.won_value_inr)} won`}
      </p>
      <p className="dp-chips">
        <span className="dp-chip">
          {d.people} {d.people === 1 ? "person" : "people"}
        </span>
        <span className="dp-muted">{d.hot ? `${d.hot} very interested` : d.warm ? `${d.warm} interested` : d.people ? "0 very interested" : "—"}</span>
      </p>
      <p className="dp-key">
        Key: <strong>{d.key_people.length ? d.key_people.map((p) => p.name).join(", ") : "—"}</strong>
      </p>
    </Link>
  );
}

export default function DepartmentsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getDepartmentOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load departments.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  return (
    <PeopleChrome active="departments">
      <div className="pl-head">
        <div>
          <h1 className="pl-title">Departments</h1>
          <p className="pl-sub">{data ? `${data.total_people} people · ${data.departments.length} departments · a person can sit in more than one` : "Loading…"}</p>
        </div>
        <div className="pl-views">
          <Link href="/settings?tab=departments" className="pl-view">
            <PlusIcon size={14} /> Department
          </Link>
        </div>
      </div>

      {error ? (
        <div className="card pl-state" role="alert">
          <p>{error}</p>
          <button type="button" className="pl-view" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <div className="card pl-state" aria-busy="true">
          <span className="auth-spinner" />
        </div>
      ) : (
        <>
          <section className="dp-grid" aria-label="Departments">
            {data.departments.map((d) => (
              <Card key={d.id} d={d} />
            ))}
          </section>

          <div className="dp-bottom">
            <section className="card dp-sits" aria-label="Who sits where">
              <h2 className="dp-h2">Who sits where (people × departments)</h2>
              {data.sits_where.length ? (
                <ul className="dp-sits-list">
                  {data.sits_where.map((p) => (
                    <li key={p.id}>
                      <Link href={withFrom(`/people/${p.id}`, "departments")} className="dp-sits-person">
                        <PersonAvatar name={p.name} initials={p.initials} />
                        <span>{p.name}</span>
                      </Link>
                      <span className="dp-sits-tags">
                        {p.departments.map((dep) => (
                          <DeptTag key={dep} dept={dep} link />
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pa-empty">Nobody is in a department yet. Upload a call: the people in it are sorted into departments from what is said.</p>
              )}
            </section>

            <section className="card dp-facts" aria-label="This week across departments">
              <h2 className="dp-facts-title">This week across departments</h2>
              {data.facts.length ? (
                <ul>
                  {data.facts.map((f, i) => (
                    <li key={i}>
                      {f.text}
                      {f.value_inr ? <strong> {rupees(f.value_inr)}</strong> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pa-empty">Nothing yet. Facts appear here as calls come in.</p>
              )}
              <p className="dp-facts-note">Counted from your calls and opportunities{data.departments.some((d) => d.last_contact_at) ? ` · last contact ${dayLabel(data.departments.map((d) => d.last_contact_at).filter((x): x is string => !!x).sort().at(-1)!).toLowerCase()}` : ""}.</p>
            </section>
          </div>
        </>
      )}
    </PeopleChrome>
  );
}
