"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { call } from "../lib/people";
import { SearchIcon } from "./Icons";

type Hit = { id: string; title?: string; name?: string; sub: string | null; link: string };
type Results = { q: string; people: Hit[]; opportunities: Hit[]; calls: Hit[]; notes: Hit[] };

const MIN = 2;
const GROUPS: { key: keyof Omit<Results, "q">; label: string }[] = [
  { key: "people", label: "People" },
  { key: "opportunities", label: "Deals" },
  { key: "calls", label: "Calls" },
  { key: "notes", label: "Notes" },
];

/**
 * The top bar's search on every room page: as you type (2+ letters) it shows your people, deals,
 * calls and notes that match; ↑/↓ and Enter open one, Escape closes. "/" anywhere focuses it.
 * "All people matching…" opens the People list filtered by the same words.
 */
export default function GlobalSearch({ placeholder = "Search people, deals, calls, notes..." }: { placeholder?: string }) {
  const router = useRouter();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const term = q.replace(/\s+/g, " ").trim();

  // Ask the backend a moment after typing stops; an older answer never replaces a newer one.
  useEffect(() => {
    if ([...term].length < MIN) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing results for a short query
      setResults(null);
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      call<Results>(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (stale) return;
          setResults(r);
          setError(null);
          setActive(0);
        })
        .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : "Search failed."))
        .finally(() => !stale && setLoading(false));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [term]);

  // "/" focuses the search (unless typing somewhere else); a click outside closes the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  // Every result in display order (for ↑/↓), plus "All people matching…" at the end.
  const flat = useMemo(() => {
    const items: { link: string; key: string }[] = [];
    if (results) for (const g of GROUPS) for (const h of results[g.key]) items.push({ link: h.link, key: `${g.key}:${h.id}` });
    if ([...term].length >= MIN) items.push({ link: `/people?q=${encodeURIComponent(term)}`, key: "all-people" });
    return items;
  }, [results, term]);

  function go(link: string) {
    setOpen(false);
    setQ("");
    input.current?.blur();
    router.push(link);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (q) setQ("");
      else input.current?.blur();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      go(flat[active].link);
    }
  }

  const total = results ? GROUPS.reduce((n, g) => n + results[g.key].length, 0) : 0;
  const show = open && [...term].length >= MIN;
  let index = -1;

  return (
    <div className="gs" ref={box}>
      <label className="search">
        <SearchIcon size={16} className="search-icon" />
        <input
          ref={input}
          type="search"
          placeholder={placeholder}
          aria-label="Search your room"
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          maxLength={80}
        />
        <kbd className="search-kbd">/</kbd>
      </label>
      {show && (
        <div className="gs-panel" id={listId} role="listbox" aria-label="Search results">
          {error ? (
            <p className="gs-empty" role="alert">
              {error}
            </p>
          ) : !results ? (
            <p className="gs-empty">{loading ? "Searching…" : ""}</p>
          ) : total === 0 ? (
            <p className="gs-empty">No people, deals, calls or notes match “{term}”.</p>
          ) : (
            GROUPS.filter((g) => results[g.key].length).map((g) => (
              <div key={g.key} className="gs-group">
                <p className="gs-label">{g.label}</p>
                {results[g.key].map((h) => {
                  index += 1;
                  const i = index;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      role="option"
                      aria-selected={active === i}
                      className={`gs-item ${active === i ? "gs-active" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(h.link)}
                    >
                      <span className="gs-title">{h.name ?? h.title}</span>
                      {h.sub && <span className="gs-sub">{h.sub}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {(() => {
            const i = flat.length - 1;
            return (
              <button type="button" role="option" aria-selected={active === i} className={`gs-item gs-all ${active === i ? "gs-active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => go(flat[i].link)}>
                All people matching “{term}” →
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
