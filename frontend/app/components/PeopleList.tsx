"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deptStyle, useDepartments } from "../lib/departments";
import { type Person, dayLabel, daysAgo, getPeople, interestOf, kindLabel, roleLine } from "../lib/people";
import FilterMenu, { type FilterOption } from "./FilterMenu";
import { PlusIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { DeptTag, PersonAvatar, ScorePill } from "./PeopleBits";

type View = "all" | "hot-investors" | "not-contacted" | "experts";
const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "hot-investors", label: "Very interested investors" },
  { id: "not-contacted", label: "Not contacted 30 d" },
  { id: "experts", label: "Experts" },
];
const NO_CATEGORY = "Not clear yet";
const NO_DEPARTMENT = "No department yet";

const PAGE_SIZES = [10, 25, 50] as const;

/** Page numbers to show: always first and last, the current page and its neighbours, "…" between gaps. */
function pageItems(page: number, pages: number): (number | "…")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev === 2) out.push(n - 1); // a gap of one page: show it instead of "…"
    else if (n - prev > 2) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

function Pagination({ page, pages, total, size, onPage, onSize }: { page: number; pages: number; total: number; size: number; onPage: (p: number) => void; onSize: (s: number) => void }) {
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(total, page * size);
  return (
    <nav className="pg" aria-label="People pages">
      <span className="pg-info">
        Showing {from}–{to} of {total}
      </span>
      <label className="pg-size">
        Rows
        <select value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label="Rows per page">
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="pg-pages">
        <button type="button" className="pg-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          ‹ Prev
        </button>
        {pageItems(page, pages).map((n, i) =>
          n === "…" ? (
            <span key={`gap-${i}`} className="pg-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button key={n} type="button" className={`pg-btn pg-num ${n === page ? "pg-on" : ""}`} aria-current={n === page ? "page" : undefined} aria-label={`Page ${n}`} onClick={() => onPage(n)}>
              {n}
            </button>
          ),
        )}
        <button type="button" className="pg-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next ›
        </button>
      </div>
    </nav>
  );
}

function Check({ label, count, checked, onChange, color }: { label: string; count: number; checked: boolean; onChange: () => void; color?: string }) {
  return (
    <label className="pf-check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {color && <span className="pf-dot" style={{ background: color }} aria-hidden="true" />}
      <span className="pf-label">{label}</span>
      <span className="pf-count">{count}</span>
    </label>
  );
}

export default function PeopleList() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Opened from the top-bar search ("All people matching…"): start with its words.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("q");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL once on load
    if (fromUrl) setQ(fromUrl.slice(0, 80));
  }, []);
  const [view, setView] = useState<View>("all");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [cities, setCities] = useState<Set<string>>(new Set());
  const [depts, setDepts] = useState<Set<string>>(new Set());
  const [introducer, setIntroducer] = useState("");
  const { departments } = useDepartments();

  const load = useCallback(async () => {
    setError(null);
    try {
      setPeople(await getPeople());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load people.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  const all = useMemo(() => people ?? [], [people]);
  const toggle = <T,>(set: Set<T>, setter: (s: Set<T>) => void, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };
  const categoryOf = (p: Person) => p.category ?? NO_CATEGORY;
  // Every filter lists only what the people (found in calls) actually have, most people first;
  // nothing with no one in it. "Not clear yet" / "No department yet" go last.
  const occurring = useCallback(
    (valuesOf: (p: Person) => string[]) => {
      const n = new Map<string, number>();
      for (const p of all) for (const v of valuesOf(p)) n.set(v, (n.get(v) ?? 0) + 1);
      return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
    },
    [all],
  );
  const categoryList = useMemo(() => occurring((p) => (p.category ? [p.category] : [])), [occurring]);
  const deptList = useMemo(() => occurring((p) => p.departments), [occurring]);
  const cityList = useMemo(() => occurring((p) => (p.city ? [p.city] : [])), [occurring]);
  const deptColor = (name: string) => {
    const d = departments.find((x) => x.name === name);
    return d ? (deptStyle(d.color).color as string) : "#94a3b8";
  };
  // Introduced by: who introduced most first, with how many.
  const introducerOptions: FilterOption[] = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of all) if (p.introduced_by) n.set(p.introduced_by.name, (n.get(p.introduced_by.name) ?? 0) + 1);
    const direct = all.filter((p) => !p.introduced_by).length;
    return [
      { value: "", label: "Anyone", count: all.length },
      ...(direct ? [{ value: "Direct", label: "Direct (no one)", count: direct, separatorBefore: true }] : []),
      ...[...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, c], i) => ({ value: name, label: name, count: c, separatorBefore: i === 0 && !direct })),
    ];
  }, [all]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((p) => {
      const hay = `${p.name} ${p.role_title ?? ""} ${p.organisation ?? ""} ${p.city ?? ""} ${p.category ?? ""} ${p.departments.join(" ")} ${p.summary ?? ""}`;
      if (needle && !hay.toLowerCase().includes(needle)) return false;
      if (cats.size && !cats.has(categoryOf(p))) return false;
      if (cities.size && !(p.city && cities.has(p.city))) return false;
      if (depts.size && !(p.departments.length ? p.departments.some((d) => depts.has(d)) : depts.has(NO_DEPARTMENT))) return false;
      if (introducer && (introducer === "Direct" ? p.introduced_by !== null : p.introduced_by?.name !== introducer)) return false;
      if (view === "hot-investors" && !((p.category === "Investor" || p.category === "HNI") && interestOf(p.score).level === "very")) return false;
      if (view === "not-contacted" && daysAgo(p.last_contact_at) < 30) return false;
      if (view === "experts" && p.category !== "Expert") return false;
      return true;
    });
  }, [all, q, cats, cities, depts, introducer, view]);

  // Pagination: any change to the search, filters or page size goes back to page 1.
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const filterKey = JSON.stringify([q, [...cats], [...cities], [...depts], introducer, view, size]);
  const [pager, setPager] = useState({ key: filterKey, page: 1 });
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const page = pager.key === filterKey ? Math.min(pager.page, pages) : 1;
  const pageRows = shown.slice((page - 1) * size, page * size);
  const goTo = (p: number) => setPager({ key: filterKey, page: Math.max(1, Math.min(pages, p)) });

  const count = (pred: (p: Person) => boolean) => all.filter(pred).length;
  const hasUnclear = all.some((p) => !p.category);
  const hasNoDept = all.some((p) => !p.departments.length);

  return (
    <PeopleChrome search={q} onSearch={setQ} placeholder="Search name, city, role, company...">
      <div className="pl-head">
        <div>
          <h1 className="pl-title">People</h1>
          <p className="pl-sub">{people ? `${all.length} people · ${shown.length} shown` : "Loading…"}</p>
        </div>
        <div className="pl-views" role="tablist" aria-label="Saved views">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`pl-view ${view === v.id ? "pl-view-on" : ""}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pl-body">
        <aside className="pl-filters" aria-label="Filters">
          <p className="pf-title">Category</p>
          {categoryList.length || hasUnclear ? (
            [...categoryList, ...(hasUnclear ? [NO_CATEGORY] : [])].map((c) => (
              <Check key={c} label={c} count={count((p) => categoryOf(p) === c)} checked={cats.has(c)} onChange={() => toggle(cats, setCats, c)} />
            ))
          ) : (
            <p className="pf-none">No categories yet</p>
          )}
          <p className="pf-title">Department</p>
          {deptList.length || hasNoDept ? (
            [...deptList, ...(hasNoDept ? [NO_DEPARTMENT] : [])].map((d) => (
              <Check
                key={d}
                label={d}
                color={d === NO_DEPARTMENT ? "#cbd5e1" : deptColor(d)}
                count={count((p) => (d === NO_DEPARTMENT ? !p.departments.length : p.departments.includes(d)))}
                checked={depts.has(d)}
                onChange={() => toggle(depts, setDepts, d)}
              />
            ))
          ) : (
            <p className="pf-none">No departments yet</p>
          )}
          <p className="pf-title">City</p>
          {cityList.length ? (
            cityList.map((c) => <Check key={c} label={c} count={count((p) => p.city === c)} checked={cities.has(c)} onChange={() => toggle(cities, setCities, c)} />)
          ) : (
            <p className="pf-none">No cities yet</p>
          )}
          <p className="pf-title">Introduced by</p>
          <div className="pf-menu">
            <FilterMenu value={introducer} onChange={setIntroducer} options={introducerOptions} label="Introduced by" minWidth={0} />
          </div>
        </aside>

        <section className="pl-table-card" aria-label="People">
          {error ? (
            <div className="pl-state" role="alert">
              <p>{error}</p>
              <button type="button" className="pl-view" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : !people ? (
            <div className="pl-state" aria-busy="true">
              <span className="auth-spinner" />
            </div>
          ) : !all.length ? (
            <div className="pl-state">
              <p className="pl-state-title">No people yet</p>
              <p>Upload a call recording. The people in it, and the people talked about, appear here with what was said about them.</p>
              <Link href="/" className="tb-btn tb-btn-primary">
                <PlusIcon size={16} /> Upload a call
              </Link>
            </div>
          ) : (
            <>
              <table className="pl-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Departments</th>
                    <th>City</th>
                    <th>Interest</th>
                    <th>Last contact</th>
                    <th>Introduced by</th>
                    <th>Consent</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((p) => (
                    <tr key={p.id} className="pl-row" onClick={() => router.push(`/people/${p.id}`)}>
                      <td>
                        <div className="pl-person">
                          <PersonAvatar name={p.name} initials={p.initials} />
                          <div>
                            <Link href={`/people/${p.id}`} className="pl-name" onClick={(e) => e.stopPropagation()}>
                              {p.name}
                            </Link>
                            <p className="pl-role">{roleLine(p)}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="pl-depts">
                          {p.departments.length ? p.departments.map((d) => <DeptTag key={d} dept={d} />) : <span className="pl-direct">—</span>}
                        </div>
                      </td>
                      <td className="pl-city">{p.city ?? <span className="pl-direct">—</span>}</td>
                      <td>
                        <ScorePill score={p.score} />
                      </td>
                      <td className="pl-last">
                        {dayLabel(p.last_contact_at)} · {kindLabel(p.last_contact_kind)}
                      </td>
                      <td className={p.introduced_by ? "pl-intro" : "pl-direct"}>
                        {p.introduced_by ? (
                          <Link href={`/people/${p.introduced_by.id}`} className="pl-intro" onClick={(e) => e.stopPropagation()}>
                            {p.introduced_by.name}
                          </Link>
                        ) : (
                          "Direct"
                        )}
                      </td>
                      <td>
                        <span className={`pl-consent pl-consent-${p.consent.toLowerCase()}`}>{p.consent}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!shown.length && <p className="pl-empty">No one matches these filters.</p>}
              {shown.length > 0 && <Pagination page={page} pages={pages} total={shown.length} size={size} onPage={goTo} onSize={setSize} />}
            </>
          )}
        </section>
      </div>
    </PeopleChrome>
  );
}
