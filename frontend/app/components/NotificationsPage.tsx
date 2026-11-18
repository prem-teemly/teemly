"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { NOTE_FILTERS, type Note, getNotes, markAllRead, markRead, markUnread } from "../lib/notifications";
import FilterMenu from "./FilterMenu";
import { SettingsIcon } from "./Icons";
import { NoteGroups } from "./NotificationList";
import PeopleChrome from "./PeopleChrome";

// "View all notifications": every notification, latest first, by day; All / Unread; one type; more
// on request (25 at a time). Opening one marks it read; each can be marked read or unread.

const PAGE = 25;

export default function NotificationsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<Note[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (offset = 0) => {
      setBusy(true);
      try {
        const r = await getNotes({ limit: PAGE, offset, filter: tab, kind });
        setItems((xs) => (offset && xs ? [...xs, ...r.items.filter((n) => !xs.some((x) => x.id === n.id))] : r.items));
        setUnread(r.unread);
        setMore(Boolean(r.has_more));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load notifications.");
      } finally {
        setBusy(false);
      }
    },
    [tab, kind],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load(0);
  }, [load]);

  async function open(n: Note, link?: string | null) {
    if (!n.read) {
      setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? xs);
      setUnread((u) => Math.max(0, u - 1));
      void markRead([n.id]).catch(() => {});
    }
    const to = link ?? n.link;
    if (to) router.push(to);
  }
  async function toggleRead(n: Note) {
    setItems((xs) => (tab === "unread" && !n.read ? xs?.filter((x) => x.id !== n.id) : xs?.map((x) => (x.id === n.id ? { ...x, read: !n.read } : x))) ?? xs);
    setUnread((u) => Math.max(0, u + (n.read ? 1 : -1)));
    try {
      await (n.read ? markUnread([n.id]) : markRead([n.id]));
    } catch {
      void load(0);
    }
  }
  async function readAll() {
    setItems((xs) => (tab === "unread" ? [] : (xs?.map((x) => ({ ...x, read: true })) ?? xs)));
    setUnread(0);
    try {
      await markAllRead();
    } catch {
      void load(0);
    }
  }

  return (
    <PeopleChrome active="">
      <div className="pl-head np-head">
        <div>
          <h1 className="pl-title">Notifications</h1>
          <p className="pl-sub">{unread ? `${unread} unread` : "All caught up"} · calls, deals, the Inbox and reminders</p>
        </div>
        <div className="pl-views op-tools">
          <FilterMenu value={kind} onChange={setKind} options={NOTE_FILTERS.map((f, i) => ({ ...f, separatorBefore: i === 1 }))} label="Type" minWidth={170} />
          <button type="button" className="pl-view" onClick={() => void readAll()} disabled={!unread}>
            ✓✓ Mark all as read
          </button>
          <Link href="/settings?tab=digest" className="pl-view" title="Notification settings">
            <SettingsIcon size={14} /> Settings
          </Link>
        </div>
      </div>
      <div className="nb-tabs np-tabs" role="tablist" aria-label="Show">
        <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "nb-tab-on" : ""} onClick={() => setTab("all")}>
          All
        </button>
        <button type="button" role="tab" aria-selected={tab === "unread"} className={tab === "unread" ? "nb-tab-on" : ""} onClick={() => setTab("unread")}>
          Unread {unread > 0 && <span className="nb-tab-count">{unread}</span>}
        </button>
      </div>
      <section className="card np-card" aria-label="Notifications">
        {error ? (
          <p className="nb-empty" role="alert">
            {error}
          </p>
        ) : !items ? (
          <div className="pl-state" aria-busy="true">
            <span className="auth-spinner" />
          </div>
        ) : !items.length ? (
          <p className="nb-empty">{tab === "unread" ? "You're all caught up." : kind ? "No notifications of this type yet." : "No notifications yet."}</p>
        ) : (
          <NoteGroups notes={items} onOpen={(n, link) => void open(n, link)} onToggleRead={(n) => void toggleRead(n)} />
        )}
        {more && (
          <button type="button" className="np-more" disabled={busy} onClick={() => void load(items?.length ?? 0)}>
            {busy ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </PeopleChrome>
  );
}
