"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deptStyle, useDepartments } from "../lib/departments";
import { type Connector, type NetNode, type Network, getNetwork } from "../lib/network";
import { GROUP_AT, LABEL_PX, type Placed, labelText, layoutNetwork, pickLabels } from "../lib/networkLayout";
import { withFrom } from "../lib/origin";
import { dayLabel, rupees, stageClass } from "../lib/people";
import FilterMenu, { type FilterOption } from "./FilterMenu";
import { SearchIcon, SparkleIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import { ScorePill } from "./PeopleBits";

// Referral network (design: "see where every relationship came from"). You in the middle, the people
// you know around you, and the people they introduced further out; a line for every introduction.
// Colour = department, a bigger circle = more introductions. Tap anyone for who introduced them, their
// department and stage, their account and the path from you. Top connectors: who brings the most
// (second-level introductions included). Say thank you: an introduced person's deal moved forward.
// Everything comes from People (GET /api/network); nothing is drawn that is not in the database.
//
// Built for big networks: zoom (wheel, buttons) and pan (drag); names stay readable and never overlap
// (the most important are shown first; zoom in for the rest); someone who introduced many people
// shows them as one "+N" bubble until opened; "Find person" zooms to anyone.

const GREY = "#94a3b8";
const PURPLE = "#7c3aed";
const MIN_SCALE = 0.08;
const MAX_SCALE = 4;
type View = { x: number; y: number; w: number; h: number };

export default function NetworkMap() {
  const { departments } = useDepartments();
  const [data, setData] = useState<Network | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState("all");
  const [levels, setLevels] = useState("2");
  const [selected, setSelected] = useState<string | null>(null);
  const [showPath, setShowPath] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set()); // "+N" groups opened
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [box, setBox] = useState({ w: 760, h: 560 }); // the map's size on screen (px)
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getNetwork());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the network.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  // The map's size on screen.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.max(280, e.contentRect.width), h: Math.max(320, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const colorOf = useCallback(
    (n: NetNode) => {
      const d = departments.find((x) => x.name === n.departments[0]);
      return d ? (deptStyle(d.color).color as string) : GREY;
    },
    [departments],
  );
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  // Levels, then department: people in the department, and whoever introduced them (shown faded).
  const { visible, faded } = useMemo(() => {
    const all = (data?.nodes ?? []).filter((n) => levels === "all" || n.level <= Number(levels));
    if (dept === "all") return { visible: all, faded: new Set<string>() };
    const inDept = new Set(all.filter((n) => (dept === "none" ? !n.departments.length : n.departments.includes(dept))).map((n) => n.id));
    const keep = new Set(inDept);
    for (const id of inDept) {
      let p = byId.get(id)?.introduced_by;
      while (p && !keep.has(p)) {
        keep.add(p);
        p = byId.get(p)?.introduced_by;
      }
    }
    return { visible: all.filter((n) => keep.has(n.id)), faded: new Set([...keep].filter((id) => !inDept.has(id))) };
  }, [data, levels, dept, byId]);

  // The path from you to the selected person (owner -> introducers -> them).
  const pathIds = useMemo(() => {
    const out = new Set<string>();
    let p: string | null | undefined = selected;
    while (p && !out.has(p)) {
      out.add(p);
      p = byId.get(p)?.introduced_by;
    }
    return out;
  }, [selected, byId]);

  const keep = useMemo(() => new Set([selected, focusId].filter((x): x is string => !!x)), [selected, focusId]);
  const L = useMemo(() => layoutNetwork(visible, { open, keep }), [visible, open, keep]);

  // Fit the whole map in the box (on load and when the filters change).
  const fit = useCallback(() => {
    const pad = 20;
    const s = Math.min((box.w - pad * 2) / L.width, (box.h - pad * 2) / L.height);
    const w = box.w / s;
    const h = box.h / s;
    setView({ x: L.cx - w / 2, y: L.cy - h / 2, w, h });
  }, [L.width, L.height, L.cx, L.cy, box.w, box.h]);
  const fitKey = `${visible.length}:${levels}:${dept}:${Math.round(box.w)}x${Math.round(box.h)}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    fit();
  }, [fitKey, fit]);

  const v = view ?? { x: 0, y: 0, w: L.width, h: L.height };
  const scale = box.w / v.w; // screen px per canvas unit

  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setView((cur) => {
        const c = cur ?? { x: 0, y: 0, w: L.width, h: L.height };
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (box.w / c.w) * factor));
        const w = box.w / s;
        const h = box.h / s;
        const px = cx ?? c.x + c.w / 2;
        const py = cy ?? c.y + c.h / 2;
        // Keep the point under the cursor where it is.
        return { x: px - ((px - c.x) / c.w) * w, y: py - ((py - c.y) / c.h) * h, w, h };
      });
    },
    [box.w, box.h, L.width, L.height],
  );
  const zoomTo = useCallback(
    (id: string, s = 1.4) => {
      const p = L.byId.get(id);
      if (!p) return;
      const w = box.w / s;
      const h = box.h / s;
      setView({ x: p.x - w / 2, y: p.y - h / 2, w, h });
    },
    [L, box.w, box.h],
  );

  // Find person: zoom to them once they are on the map.
  useEffect(() => {
    if (!focusId || !L.byId.has(focusId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- moving the view to the found person
    zoomTo(focusId);
    setFocusId(null);
  }, [focusId, L, zoomTo]);

  // Wheel zoom (not passive, so the page does not scroll while zooming the map).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const c = view ?? { x: 0, y: 0, w: L.width, h: L.height };
      const cx = c.x + ((e.clientX - rect.left) / rect.width) * c.w;
      const cy = c.y + ((e.clientY - rect.top) / rect.height) * c.h;
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, L.width, L.height, zoomAt]);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view: v, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) (e.currentTarget as Element).setPointerCapture(e.pointerId);
    d.moved = true;
    setView({ ...d.view, x: d.view.x - dx / scale, y: d.view.y - dy / scale });
  }
  function onPointerUp() {
    setTimeout(() => (drag.current = null), 0); // a drag is not a click on a person
  }
  const dragged = () => !!drag.current?.moved;

  const sel = selected ? (byId.get(selected) ?? null) : null;
  function pick(id: string) {
    if (dragged()) return;
    setSelected((s) => (s === id ? null : id));
    setShowPath(false);
  }
  function openGroup(of: string) {
    if (dragged()) return;
    setOpen((s) => new Set(s).add(of));
  }
  function find(n: NetNode) {
    // Make sure they are on the map (filters), then select and zoom to them.
    if (levels !== "all" && n.level > Number(levels)) setLevels("all");
    if (dept !== "all" && !(dept === "none" ? !n.departments.length : n.departments.includes(dept))) setDept("all");
    setSelected(n.id);
    setShowPath(true);
    setFocusId(n.id);
    setQuery("");
  }
  const matches = query.trim() ? (data?.nodes ?? []).filter((n) => n.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6) : [];

  // Names: never overlapping on screen; the most important first.
  const textOf = useCallback((p: Placed) => (p.group ? `+${p.group.count} more` : (byId.get(p.id)?.name ?? "")), [byId]);
  const labels = useMemo(() => {
    const prio = (p: Placed) => {
      if (p.id === selected) return 1e6;
      if (p.id === hover) return 9e5;
      if (showPath && pathIds.has(p.id)) return 8e5;
      if (sel && p.parent === sel.id) return 7e5;
      if (p.group) return 5e4;
      const n = byId.get(p.id);
      return (n?.introduced ?? 0) * 1000 + (n?.score ?? 0) + (n?.open_value_inr ? 200 : 0);
    };
    return pickLabels(L.nodes, textOf, scale, prio);
  }, [L.nodes, textOf, scale, selected, hover, showPath, pathIds, sel, byId]);

  const deptOptions: FilterOption[] = [
    { value: "all", label: "All departments", count: data?.nodes.length ?? 0 },
    ...departments.map((d, i) => ({ value: d.name, label: d.name, color: deptStyle(d.color).color as string, count: (data?.nodes ?? []).filter((n) => n.departments.includes(d.name)).length, separatorBefore: i === 0 })),
    { value: "none", label: "No department", color: "#a1a1aa", count: (data?.nodes ?? []).filter((n) => !n.departments.length).length, separatorBefore: true },
  ];
  const maxLevel = Math.max(1, ...(data?.nodes ?? []).map((n) => n.level));
  const levelOptions: FilterOption[] = [
    { value: "1", label: "1 level", count: (data?.nodes ?? []).filter((n) => n.level <= 1).length },
    { value: "2", label: "2 levels", count: (data?.nodes ?? []).filter((n) => n.level <= 2).length },
    { value: "all", label: `All levels (${maxLevel})`, count: data?.nodes.length ?? 0 },
  ];
  const usedDepts = departments.filter((d) => (data?.nodes ?? []).some((n) => n.departments[0] === d.name));
  const pathNames = [...pathIds].reverse().map((id) => byId.get(id)?.name ?? "");
  const groupsShown = L.nodes.filter((p) => p.group).length;

  const edgeOn = (p: Placed) => (sel && p.parent === sel.id) || (showPath && pathIds.has(p.id) && (p.parent === null || pathIds.has(p.parent)));
  const fs = LABEL_PX / scale; // names: the same size on screen at any zoom
  return (
    <PeopleChrome active="network-map">
      <div className="pl-head nm-head">
        <div>
          <h1 className="pl-title">Referral network</h1>
          <p className="pl-sub">
            Who introduced whom
            {sel ? (
              <>
                {" · "}lines in purple are <strong>{sel.name}</strong>&apos;s introductions{showPath ? " and the path from you" : ""}
              </>
            ) : (
              " · tap anyone to see their introductions"
            )}
          </p>
        </div>
        <div className="pl-views op-tools">
          <FilterMenu value={dept} onChange={setDept} options={deptOptions} label="Show department" />
          <FilterMenu value={levels} onChange={setLevels} options={levelOptions} label="Levels" minWidth={130} />
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
      ) : !data.nodes.length ? (
        <div className="card pl-state">
          <p className="pl-state-title">No one in your network yet</p>
          <p>Upload a call: the people in it, and who introduced them, appear here.</p>
        </div>
      ) : (
        <div className="nm-grid">
          <section className="card nm-map" aria-label="Referral network map">
            <div className="nm-tools">
              <div className="nm-find">
                <SearchIcon size={14} />
                <input
                  value={query}
                  placeholder="Find person…"
                  aria-label="Find a person on the map"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matches[0]) find(matches[0]);
                    if (e.key === "Escape") setQuery("");
                  }}
                />
                {matches.length > 0 && (
                  <ul className="nm-find-list" role="listbox" aria-label="People found">
                    {matches.map((n) => (
                      <li key={n.id}>
                        <button type="button" role="option" aria-selected="false" onClick={() => find(n)}>
                          <span className="nm-dot" style={{ background: colorOf(n) }} aria-hidden="true" />
                          <span className="nm-find-name">{n.name}</span>
                          <span className="nm-faint">{n.introduced_by ? `via ${byId.get(n.introduced_by)?.name}` : "known directly"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim() && !matches.length && <p className="nm-find-none">No one called “{query.trim()}”.</p>}
              </div>
              <div className="nm-zoom" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.3)}>
                  +
                </button>
                <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.3)}>
                  −
                </button>
                <button type="button" aria-label="Fit the whole map" title="Fit" onClick={fit}>
                  ⤢
                </button>
              </div>
            </div>
            <div className="nm-canvas" ref={wrap} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <svg viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`} className="nm-svg" role="img" aria-label={`${visible.length} people and who introduced them`}>
                {/* Lines: you to the people you know, introducers to the people they introduced. */}
                {L.nodes.map((p) => {
                  const a = p.parent ? L.byId.get(p.parent) : { x: L.cx, y: L.cy };
                  if (!a) return null;
                  const on = edgeOn(p);
                  return (
                    <line
                      key={`e-${p.id}`}
                      x1={a.x}
                      y1={a.y}
                      x2={p.x}
                      y2={p.y}
                      stroke={on ? PURPLE : "#d5dbe3"}
                      strokeWidth={on ? 2.4 : p.parent ? 1.4 : 1}
                      strokeDasharray={p.parent && !p.group ? undefined : "3 4"}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                {/* You. */}
                <g>
                  <circle cx={L.cx} cy={L.cy} r={27} fill="#14213d" />
                  <text x={L.cx} y={L.cy + 5} textAnchor="middle" className="nm-initials nm-initials-owner">
                    {data.owner.slice(0, 1).toUpperCase()}
                  </text>
                  <text x={L.cx} y={L.cy + 27 + fs * 1.2} textAnchor="middle" className="nm-name nm-name-owner" style={{ fontSize: fs * 1.08 }}>
                    {data.owner} (you)
                  </text>
                </g>
                {/* People, and "+N" bubbles. */}
                {L.nodes.map((p) => {
                  if (p.group) {
                    const of = byId.get(p.group.of);
                    return (
                      <g
                        key={p.id}
                        className={`nm-node nm-group ${sel && sel.id !== p.group.of ? "nm-dim" : ""}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${p.group.count} more people introduced by ${of?.name}. Open`}
                        onClick={() => openGroup(p.group!.of)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openGroup(p.group!.of))}
                      >
                        <circle cx={p.x} cy={p.y} r={p.r} fill="#f1f5f9" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                        <text x={p.x} y={p.y + 4} textAnchor="middle" className="nm-initials" fill="#475569">
                          +{p.group.count}
                        </text>
                        {labels.has(p.id) && (
                          <text x={p.x} y={p.y + p.r + fs * 1.15} textAnchor="middle" className="nm-name nm-name-group" style={{ fontSize: fs }}>
                            {labelText(`by ${of?.name ?? ""}`)}
                          </text>
                        )}
                        <title>{`${p.group.ids.map((id) => byId.get(id)?.name).slice(0, 12).join(", ")}${p.group.count > 12 ? "…" : ""} · click to show them`}</title>
                      </g>
                    );
                  }
                  const n = byId.get(p.id);
                  if (!n) return null;
                  const c = colorOf(n);
                  const isSel = sel?.id === n.id;
                  const dim = faded.has(n.id) || (sel && !isSel && p.parent !== sel.id && !(showPath && pathIds.has(n.id)));
                  return (
                    <g
                      key={p.id}
                      className={`nm-node ${dim ? "nm-dim" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${n.name}${n.introduced ? `, introduced ${n.introduced}` : ""}`}
                      aria-pressed={isSel}
                      onClick={() => pick(n.id)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(n.id))}
                      onPointerEnter={() => setHover(n.id)}
                      onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    >
                      {isSel && <circle cx={p.x} cy={p.y} r={p.r + 6} fill="none" stroke={PURPLE} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                      <circle cx={p.x} cy={p.y} r={p.r} fill={`${c}26`} stroke={c} strokeWidth={isSel ? 2.6 : 1.6} vectorEffect="non-scaling-stroke" />
                      <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="nm-initials" fill={c}>
                        {n.initials}
                      </text>
                      {labels.has(p.id) && (
                        <text x={p.x} y={p.y + p.r + fs * 1.15} textAnchor="middle" className="nm-name" style={{ fontSize: fs }}>
                          {labelText(n.name)}
                        </text>
                      )}
                      <title>{`${n.name}${n.departments.length ? ` · ${n.departments.join(", ")}` : ""}${n.stage ? ` · ${n.stage}` : ""}`}</title>
                    </g>
                  );
                })}
              </svg>
            </div>
            <p className="nm-hidden">
              {visible.length} of {data.nodes.length} people
              {levels !== "all" && data.nodes.some((n) => n.level > Number(levels)) ? ` · ${data.nodes.filter((n) => n.level > Number(levels)).length} more at deeper levels` : ""}
              {groupsShown ? " · click a “+N” bubble to show the people in it" : ""}
              {labels.size < L.nodes.length ? " · zoom in for more names" : ""}
              {" · scroll or use + − to zoom, drag to move"}
            </p>
          </section>

          <aside className="nm-side">
            {sel ? (
              <section className="card nm-card nm-sel" aria-label={`${sel.name}, selected`}>
                <div className="nm-sel-top">
                  <span className="nm-av" style={{ background: `${colorOf(sel)}26`, color: colorOf(sel) }} aria-hidden="true">
                    {sel.initials}
                  </span>
                  <div className="nm-sel-main">
                    <p className="nm-sel-name">
                      {sel.name} <span className="nm-faint">selected</span>
                    </p>
                    <p className="nm-sel-sub">
                      {[sel.category ?? sel.role_title, sel.introduced_by ? `introduced by ${byId.get(sel.introduced_by)?.name}` : "known to you directly", dayLabel(sel.first_seen_at)].filter(Boolean).join(" · ")}
                    </p>
                    {(sel.departments.length > 0 || sel.stage) && (
                      <p className="nm-sel-tags">
                        {sel.departments.map((d) => {
                          const dd = departments.find((x) => x.name === d);
                          return (
                            <span key={d} className="nm-tag" style={deptStyle(dd?.color)}>
                              {d}
                            </span>
                          );
                        })}
                        {sel.stage && <span className={`pw-stage pw-stage-${stageClass(sel.stage)} dd-stage`}>{sel.stage}</span>}
                      </p>
                    )}
                    {sel.deal && (
                      <p className="nm-sel-deal">
                        {sel.deal.title}
                        {sel.deal.value_inr !== null ? ` · ${rupees(sel.deal.value_inr)}` : ""}
                      </p>
                    )}
                    {sel.introduced > 0 && (
                      <p className="nm-sel-deal">
                        Introduced {sel.introduced} {sel.introduced === 1 ? "person" : "people"}
                      </p>
                    )}
                  </div>
                  <ScorePill score={sel.score} />
                </div>
                {showPath && <p className="nm-path">{[data.owner, ...pathNames].join(" → ")}</p>}
                <div className="nm-sel-actions">
                  <Link href={withFrom(`/people/${sel.id}`, "network")} className="pa-btn pw-btn">
                    Open account
                  </Link>
                  <button type="button" className={`pa-btn pw-btn ${showPath ? "nm-on" : ""}`} aria-pressed={showPath} onClick={() => setShowPath((x) => !x)}>
                    {showPath ? "Hide path" : "Show path"}
                  </button>
                  <button type="button" className="pa-btn pw-btn" onClick={() => zoomTo(sel.id)}>
                    Zoom to
                  </button>
                  {sel.introduced > GROUP_AT && (
                    <button
                      type="button"
                      className="pa-btn pw-btn"
                      onClick={() =>
                        setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(sel.id)) n.delete(sel.id);
                          else n.add(sel.id);
                          return n;
                        })
                      }
                    >
                      {open.has(sel.id) ? "Group their introductions" : `Show all ${sel.introduced}`}
                    </button>
                  )}
                </div>
              </section>
            ) : (
              <section className="card nm-card nm-hint">Tap anyone on the map to see who introduced them, their department and stage, and the path from you.</section>
            )}

            <section className="card nm-card" aria-labelledby="nm-top">
              <h2 id="nm-top" className="nm-h2">
                Top connectors
              </h2>
              {data.connectors.length ? (
                <ul className="nm-conn">
                  {data.connectors.map((c: Connector) => {
                    const node = byId.get(c.id);
                    const col = node ? colorOf(node) : GREY;
                    return (
                      <li key={c.id}>
                        <button type="button" className={`nm-conn-row ${sel?.id === c.id ? "nm-conn-on" : ""}`} onClick={() => node && find(node)}>
                          <span className="nm-av nm-av-sm" style={{ background: `${col}26`, color: col }} aria-hidden="true">
                            {c.initials}
                          </span>
                          <span className="nm-conn-main">
                            <span className="nm-conn-name">{c.name}</span>
                            <span className="nm-faint">
                              {c.direct} introduction{c.direct === 1 ? "" : "s"}
                              {c.second_level ? ` + ${c.second_level} through them` : ""}
                              {c.active ? ` · ${c.active} active` : ""}
                            </span>
                          </span>
                          <span className="nm-conn-value">{c.value_inr ? rupees(c.value_inr) : "—"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="nm-faint">No introductions yet. When a call says who introduced someone, they show here.</p>
              )}
              <p className="nm-note">Value: open deals of the people they introduced, and of the people those introduced.</p>
            </section>

            {data.thanks.map((t) => (
              <section key={t.id} className="card nm-card nm-thanks" aria-label={`Say thank you to ${t.connector.name}`}>
                <p className="nm-thanks-label">
                  <SparkleIcon size={12} /> Say thank you
                </p>
                <p className="nm-thanks-text">
                  <strong>{t.person.name}</strong> moved to <strong>{t.to}</strong> on {t.opportunity.title} ({dayLabel(t.at).toLowerCase()}). A good moment to update <strong>{t.connector.name}</strong> and thank them.
                </p>
                <div className="nm-sel-actions">
                  <Link href={withFrom(`/people/${t.connector.id}`, "network")} className="pa-btn pw-btn">
                    Open {t.connector.name}
                  </Link>
                  <Link href={withFrom(`/opportunities/${t.opportunity.id}`, "network")} className="pa-btn pw-btn">
                    View deal
                  </Link>
                </div>
              </section>
            ))}

            <section className="card nm-card nm-legend" aria-label="Legend">
              <p className="nm-sel-tags">
                {usedDepts.map((d) => (
                  <span key={d.id} className="nm-tag" style={deptStyle(d.color)}>
                    {d.name}
                  </span>
                ))}
                <span className="nm-tag" style={{ background: "#94a3b81f", color: "#64748b" }}>
                  No department
                </span>
              </p>
              <p className="nm-note">Colour = department · bigger circle = more introductions · dotted line = known to you directly · “+N” = more people, click to show</p>
            </section>
          </aside>
        </div>
      )}
    </PeopleChrome>
  );
}
