"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLEAR_CONFIRM, type Note, clearAllNotes, getNotes, markAllRead, markRead, markSeen, markUnread } from "../lib/notifications";
import { BellIcon, SettingsIcon } from "./Icons";
import { NoteGroups } from "./NotificationList";

// The bell. Best practice for many notifications:
//   * the number on the bell = new since the bell was last opened ("seen"); opening it clears the number
//     while each row keeps its blue dot until it is opened ("read") or marked read;
//   * one row per call (its people and deals inside) and per deal (later updates bring it back to the
//     top), and "5 deals overdue" instead of five rows (all done by the backend);
//   * one toast at a time: "3 new notifications" when several arrive together.
// It asks every 15 s (every 4 s while a call is being analysed, never while the tab is hidden).

const SLOW_MS = 15_000;
const FAST_MS = 4_000;
type Tab = "all" | "unread";

export default function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [toast, setToast] = useState<{ title: string; body: string | null; note: Note | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef<string | null>(null); // the newest "at" seen (null = first load: no toast)
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await getNotes({ limit: 30 });
      setItems(r.items);
      setUnread(r.unread);
      setUnseen(r.unseen ?? r.unread);
      setActive(r.active_jobs);
      setFailed(false);
      const top = r.items.reduce<string | null>((m, n) => (!m || n.at > m ? n.at : m), null);
      if (latest.current !== null) {
        const fresh = r.items.filter((n) => !n.read && n.at > (latest.current ?? ""));
        if (fresh.length === 1) setToast({ title: fresh[0].title, body: fresh[0].body, note: fresh[0] });
        else if (fresh.length > 1) setToast({ title: `${fresh.length} new notifications`, body: fresh.slice(0, 2).map((n) => n.title).join(" · "), note: null });
      }
      if (top && (!latest.current || top > latest.current)) latest.current = top;
      else if (latest.current === null) latest.current = "";
    } catch {
      setFailed(true); // signed out or backend down: the bell just stays quiet
    }
  }, []);

  // First load, then poll (faster while a call is being analysed; paused while the tab is hidden).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void load();
    const t = window.setInterval(tick, active > 0 ? FAST_MS : SLOW_MS);
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [active, load]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // The toast goes away by itself.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [toast]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unseen > 0) {
      setUnseen(0); // seen: the number goes, the dots stay
      void markSeen().catch(() => {});
    }
  }

  async function openNote(n: Note, link?: string | null) {
    setOpen(false);
    setToast(null);
    if (!n.read) {
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      void markRead([n.id]).catch(() => load());
    }
    const to = link ?? n.link;
    if (to) router.push(to);
  }

  async function toggleRead(n: Note) {
    setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: !n.read } : x)));
    setUnread((u) => Math.max(0, u + (n.read ? 1 : -1)));
    try {
      await (n.read ? markUnread([n.id]) : markRead([n.id]));
    } catch {
      void load();
    }
  }

  async function readAll() {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setUnread(0);
    try {
      await markAllRead();
    } catch {
      void load();
    }
  }

  async function clearAll() {
    if (!window.confirm(CLEAR_CONFIRM)) return;
    setItems([]);
    setUnread(0);
    setUnseen(0);
    try {
      await clearAllNotes();
    } catch {
      void load();
    }
  }

  const shown = tab === "unread" ? items.filter((n) => !n.read) : items;
  const label = unseen ? `Notifications: ${unseen} new` : unread ? `Notifications: ${unread} unread` : "Notifications";
  return (
    <div className="nb" ref={box}>
      <button type="button" className="tb-icon nb-trigger" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <BellIcon size={19} />
        {unseen > 0 && (
          <span className="nb-badge" aria-hidden="true">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div className="nb-panel" role="dialog" aria-label="Notifications">
          <div className="nb-head">
            <strong className="nb-title">Notifications</strong>
            {active > 0 && (
              <span className="nb-live">
                <span className="nb-dot" aria-hidden="true" /> {active} analysing
              </span>
            )}
            <button type="button" className="nb-close" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="nb-tabs" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "nb-tab-on" : ""} onClick={() => setTab("all")}>
              All
            </button>
            <button type="button" role="tab" aria-selected={tab === "unread"} className={tab === "unread" ? "nb-tab-on" : ""} onClick={() => setTab("unread")}>
              Unread {unread > 0 && <span className="nb-tab-count">{unread}</span>}
            </button>
          </div>
          <div className="nb-scroll">
            {failed && !items.length ? (
              <p className="nb-empty">Could not load notifications. Is the backend running?</p>
            ) : !shown.length ? (
              <p className="nb-empty">{tab === "unread" ? "You're all caught up." : "No notifications yet. Calls analysed, new opportunities, the Inbox and follow-up reminders show here."}</p>
            ) : (
              <NoteGroups notes={shown} onOpen={(n, link) => void openNote(n, link)} onToggleRead={(n) => void toggleRead(n)} />
            )}
          </div>
          <div className="nb-foot">
            <Link href="/settings?tab=digest" className="nb-gear" aria-label="Notification settings" title="Notification settings" onClick={() => setOpen(false)}>
              <SettingsIcon size={16} />
            </Link>
            <button type="button" className="nb-readall" onClick={() => void readAll()} disabled={!unread}>
              ✓✓ Mark all as read
            </button>
            <button type="button" className="nb-readall nb-clear" onClick={() => void clearAll()} disabled={!items.length}>
              Clear all
            </button>
            <Link href="/notifications" className="nb-viewall" onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </div>
        </div>
      )}

      {toast && !open && (
        <div className="nb-toast" role="status" aria-live="polite">
          <button
            type="button"
            className="nb-toast-main"
            onClick={() => {
              if (toast.note) void openNote(toast.note);
              else {
                setToast(null);
                setOpen(true);
              }
            }}
          >
            <span className="nb-toast-title">{toast.title}</span>
            {toast.body && <span className="nb-toast-body">{toast.body}</span>}
          </button>
          <button type="button" className="nb-toast-x" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
