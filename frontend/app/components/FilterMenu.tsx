"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { FilterIcon } from "./Icons";

// A filter button with a menu (department filter on the Opportunity panel and the Network map, levels
// on the Network map): colour dots, counts, a check on the chosen one, keyboard ↑ ↓ Enter Esc.

export type FilterOption = { value: string; label: string; color?: string | null; count?: number; separatorBefore?: boolean };

export default function FilterMenu({ value, onChange, options, label, minWidth = 190 }: { value: string; onChange: (v: string) => void; options: FilterOption[]; label: string; minWidth?: number }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];
  const isDefault = value === options[0]?.value;

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  const mark = (o: FilterOption) => (o.color ? <span className="df-dot" style={{ background: o.color }} aria-hidden="true" /> : <FilterIcon size={13} />);
  return (
    <div className="df" ref={box}>
      <button type="button" className={`df-trigger ${isDefault ? "" : "df-active"}`} style={{ minWidth }} aria-haspopup="menu" aria-expanded={open} aria-label={`${label}: ${current?.label}`} onClick={() => setOpen((x) => !x)}>
        {current && mark(current)}
        <span className="df-label">{current?.label}</span>
        <svg className="df-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="df-menu" role="menu" aria-label={label} ref={list} onKeyDown={onKey}>
          {options.map((o) => (
            <Fragment key={o.value}>
              {o.separatorBefore && <div className="df-sep" role="separator" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                className={`df-item ${o.value === value ? "df-on" : ""} ${o.count === 0 ? "df-empty" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {mark(o)}
                <span className="df-name">{o.label}</span>
                {o.count !== undefined ? <span className="df-count">{o.count}</span> : <span />}
                <span className="df-check" aria-hidden="true">
                  {o.value === value ? "✓" : ""}
                </span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
