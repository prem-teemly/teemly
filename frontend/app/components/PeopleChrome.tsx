"use client";

import Link from "next/link";
import { useState } from "react";
import AddPersonDialog from "./AddPersonDialog";
import GlobalSearch from "./GlobalSearch";
import { UserAvatar } from "./AuthGate";
import { PlusIcon, SearchIcon, UploadIcon } from "./Icons";
import NotificationBell from "./NotificationBell";
import Sidebar from "./Sidebar";

/**
 * Shell for the People screens: the same sidebar and top bar as the call screen. Upload opens the
 * call screen (recordings are uploaded and analysed there); Add adds a person by hand.
 */
export default function PeopleChrome({
  search,
  onSearch,
  placeholder = "Search people, calls, notes...",
  active = "people",
  children,
}: {
  search?: string;
  onSearch?: (q: string) => void;
  placeholder?: string;
  /** Sidebar item to highlight. */
  active?: string;
  children: React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="shell">
      <Sidebar active={active} />
      <div className="app">
        <header className="topbar">
          {onSearch ? (
            // A page that filters its own list (People) uses the box for that.
            <label className="search">
              <SearchIcon size={16} className="search-icon" />
              <input
                type="search"
                placeholder={placeholder}
                aria-label="Search"
                value={search ?? ""}
                onChange={(e) => onSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && onSearch("")}
              />
              <kbd className="search-kbd">/</kbd>
            </label>
          ) : (
            // Every other page: search the whole room (people, deals, calls, notes).
            <GlobalSearch />
          )}
          <div className="topbar-actions">
            <Link href="/" className="tb-btn tb-btn-outline" title="Upload a call recording">
              <UploadIcon size={16} />
              <span className="btn-label">Upload</span>
            </Link>
            <button type="button" className="tb-btn tb-btn-primary" title="Add a person by hand" onClick={() => setAdding(true)}>
              <PlusIcon size={16} />
              <span className="btn-label">Add</span>
            </button>
            {adding && <AddPersonDialog onClose={() => setAdding(false)} />}
            <NotificationBell />
            <UserAvatar />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
