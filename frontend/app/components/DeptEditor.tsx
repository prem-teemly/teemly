"use client";

import { useEffect, useRef, useState } from "react";
import { deptStyle, refreshDepartments, useDepartments } from "../lib/departments";
import { type Department, savePersonDepartments } from "../lib/people";

// "Edit departments" on a person's page: every department as a checkbox; Save replaces the person's
// list. A department the owner unticks is never added back by a later call. A person with an open deal
// in a department still shows on that department's page while the deal is open (said next to it).

export default function DeptEditor({
  personId,
  name,
  current,
  dealDepartments,
  onSaved,
}: {
  personId: string;
  name: string;
  current: Department[];
  /** Departments of the person's open opportunities. */
  dealDepartments: string[];
  onSaved: (departments: Department[]) => void;
}) {
  const { departments } = useDepartments();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (busy) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, busy]);

  function start() {
    setPicked(new Set(current));
    setError(null);
    setOpen(true);
  }
  function toggle(d: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Keep the order of the departments list.
      const list = departments.map((d) => d.name).filter((d) => picked.has(d));
      const saved = await savePersonDepartments(personId, list);
      onSaved(saved);
      setOpen(false);
      void refreshDepartments().catch(() => {}); // sidebar and panel counts
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const changed = picked.size !== current.length || current.some((d) => !picked.has(d));
  return (
    <div className="de" ref={box}>
      <button type="button" className="pa-fact de-trigger" onClick={() => (open ? setOpen(false) : start())} aria-expanded={open} aria-haspopup="dialog" title={`Edit ${name}'s departments`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        {current.length ? "Edit" : "Add department"}
      </button>
      {open && (
        <div className="de-panel" role="dialog" aria-label={`${name}'s departments`}>
          <p className="de-title">{name}&apos;s departments</p>
          <ul className="de-list">
            {departments.map((d) => {
              const on = picked.has(d.name);
              const deal = dealDepartments.includes(d.name);
              return (
                <li key={d.id}>
                  <label className={`de-row ${on ? "de-on" : ""}`}>
                    <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(d.name)} />
                    <span className="de-dot" style={{ background: deptStyle(d.color).color as string }} aria-hidden="true" />
                    <span className="de-name">{d.name}</span>
                    {deal && <span className="de-deal" title={`${name} has an open deal in ${d.name}, so they show on its page while the deal is open`}>open deal</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          {dealDepartments.some((d) => !picked.has(d)) && <p className="de-note">An open deal keeps them on that department&apos;s page until the deal is closed or moved.</p>}
          <p className="de-note">A department you untick is not added back by later calls.</p>
          {error && (
            <p className="pw-error" role="alert">
              {error}
            </p>
          )}
          <div className="de-actions">
            <button type="button" className="pw-link pa-muted-link" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="pa-btn pa-btn-primary pw-btn" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
