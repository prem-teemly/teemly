"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import AddPersonDialog from "./AddPersonDialog";
import { SUPPORTED_EXTENSIONS } from "../lib/api";
import { UserAvatar } from "./AuthGate";
import { DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from "./Icons";
import NotificationBell from "./NotificationBell";

type Props = {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
  /** Download the full context as a Teemly PDF report. */
  onExport: () => void;
  canExport: boolean;
  exporting: boolean;
  /** Search text (filters the transcript to matching lines). */
  query: string;
  onQuery: (q: string) => void;
};

export type TopBarHandle = { focusSearch: () => void; openPicker: () => void };

const TopBar = forwardRef<TopBarHandle, Props>(function TopBar({ onFileSelected, disabled, onExport, canExport, exporting, query, onQuery }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }
  useImperativeHandle(ref, () => ({ focusSearch: () => searchRef.current?.focus(), openPicker }));

  // "/" focuses the search, like the hint in the box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow choosing the same file again
    if (f) onFileSelected(f);
  }

  return (
    <header className="topbar">
      <label className="search">
        <SearchIcon size={16} className="search-icon" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search people, calls, notes..."
          aria-label="Search the transcript"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onQuery("")}
        />
        <kbd className="search-kbd">/</kbd>
      </label>

      <div className="topbar-actions">
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={[...SUPPORTED_EXTENSIONS.map((e) => `.${e}`), "audio/*"].join(",")}
          onChange={onChange}
        />
        <button
          type="button"
          className="tb-btn tb-btn-outline"
          onClick={openPicker}
          disabled={disabled}
          title="Upload a call recording"
        >
          <UploadIcon size={16} />
          <span className="btn-label">Upload</span>
        </button>
        <button type="button" className="tb-btn tb-btn-primary" onClick={() => setAdding(true)} title="Add a person by hand">
          <PlusIcon size={16} />
          <span className="btn-label">Add</span>
        </button>
        {adding && <AddPersonDialog onClose={() => setAdding(false)} />}
        <button
          type="button"
          className="tb-icon"
          onClick={onExport}
          disabled={!canExport || exporting}
          aria-label={exporting ? "Exporting PDF" : "Export PDF report"}
          title={canExport ? "Download the conversation context as a Teemly PDF report" : "Complete an analysis to export"}
        >
          <DownloadIcon size={18} />
        </button>
        <NotificationBell />
        <UserAvatar />
      </div>
    </header>
  );
});

export default TopBar;
