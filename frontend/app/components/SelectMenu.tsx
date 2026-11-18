"use client";

import { useEffect, useId, useRef, useState } from "react";

// A form dropdown in the room's own style (the browser's native list looks out of place): colour dots,
// a hint on the right (e.g. "50%"), a check on the chosen one. Keyboard: ↓ ↑ Enter Space open it; in the
// list ↓ ↑ Home End move, Enter / Space choose, Esc closes (without closing a dialog around it), Tab
// leaves. It opens upward when there is no room below (inside a scrolling dialog too).

export type SelectOption = { value: string; label: string; hint?: string; color?: string | null };

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown while nothing is chosen. */
  placeholder?: string;
  invalid?: boolean;
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  describedBy?: string;
  onBlur?: () => void;
  /** The trigger button (e.g. to focus it when the field has an error). */
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
};

const ITEM_PX = 38;
const MAX_MENU_PX = 264;

/** The nearest ancestor that scrolls (its bottom edge limits the menu), else the window. */
function roomBelow(el: HTMLElement): number {
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") {
      bottom = Math.min(bottom, p.getBoundingClientRect().bottom);
      break;
    }
  }
  return bottom - el.getBoundingClientRect().bottom;
}

export default function SelectMenu({ value, onChange, options, placeholder = "Choose…", invalid = false, id, labelledBy, ariaLabel, describedBy, onBlur, buttonRef }: Props) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const trigger = buttonRef ?? ownTrigger;
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    const chosen = list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>('[role="option"]');
    chosen?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function show() {
    const need = Math.min(MAX_MENU_PX, options.length * ITEM_PX + 12);
    if (trigger.current) setUp(roomBelow(trigger.current) < need + 8 && trigger.current.getBoundingClientRect().top > need + 8);
    setOpen(true);
  }
  function choose(v: string) {
    onChange(v);
    setOpen(false);
    trigger.current?.focus();
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show();
    }
  }
  function onListKey(e: React.KeyboardEvent) {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // close the menu only, not the dialog
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div className="sm" ref={box}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={`sm-trigger ${current ? "" : "sm-empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-describedby={describedBy /* the error line, when there is one */}
        data-invalid={invalid || undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        onBlur={(e) => {
          if (!box.current?.contains(e.relatedTarget as Node)) onBlur?.();
        }}
      >
        {current?.color && <span className="df-dot" style={{ background: current.color }} aria-hidden="true" />}
        <span className="sm-value">{current ? current.label : placeholder}</span>
        {current?.hint && <span className="sm-hint">{current.hint}</span>}
        <svg className="df-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={listId} className={`df-menu sm-menu ${up ? "sm-up" : ""}`} role="listbox" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : ariaLabel} ref={list} onKeyDown={onListKey}>
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={`df-item ${o.value === value ? "df-on" : ""}`} onClick={() => choose(o.value)}>
              {o.color ? <span className="df-dot" style={{ background: o.color }} aria-hidden="true" /> : <span aria-hidden="true" />}
              <span className="df-name">{o.label}</span>
              {o.hint ? <span className="df-count">{o.hint}</span> : <span />}
              <span className="df-check" aria-hidden="true">
                {o.value === value ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
