"use client";

import type { Note, NoteKind } from "../lib/notifications";
import { byDay } from "../lib/notifications";
import { AlertIcon, BellIcon, CalendarIcon, CheckIcon, InboxIcon, PhoneIcon, SparkleIcon, TrendUpIcon } from "./Icons";

// One notification row, and rows grouped by day (Today / Yesterday / Earlier). Used by the bell's
// panel and the "All notifications" page. Unread: a blue dot, a light blue background and a bold
// title; read: none of these. A grouped row shows what is inside: a call's new people and deals, a
// deal's earlier updates ("3 updates"), or the list behind "5 deals overdue".

const ICON: Record<NoteKind, (p: { size?: number }) => React.ReactNode> = {
  analysis: PhoneIcon,
  failed: AlertIcon,
  opportunity: SparkleIcon,
  stage: TrendUpIcon,
  thanks: SparkleIcon,
  inbox: InboxIcon,
  due: CalendarIcon,
  overdue: AlertIcon,
  quiet: AlertIcon,
  digest: CheckIcon,
};

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function Avatar({ n }: { n: Note }) {
  const Icon = ICON[n.kind] ?? BellIcon;
  return (
    <span className={`nl-avatar nl-k-${n.kind}`} aria-hidden="true">
      {n.avatar?.initials ? <span className="nl-initials">{n.avatar.initials}</span> : <Icon size={15} />}
      {n.avatar?.initials && (
        <span className="nl-kind-badge">
          <Icon size={10} />
        </span>
      )}
    </span>
  );
}

export function NoteRow({
  n,
  day,
  onOpen,
  onToggleRead,
}: {
  n: Note;
  /** The day group it is in: time only for Today / Yesterday, with the date for Earlier. */
  day: string;
  onOpen: (n: Note, link?: string | null) => void;
  onToggleRead: (n: Note) => void;
}) {
  const items = n.items ?? [];
  const shown = n.grouped === "deal" ? items.slice(1, 3) : items.slice(0, 3); // a deal row's first item is its title
  const updates = n.grouped === "deal" && (n.count ?? 1) > 1 ? `${n.count} updates` : null;
  return (
    <li className={`nl-row ${n.read ? "" : "nl-unread"} nl-kind-${n.kind}`}>
      <div
        className="nl-main"
        role="link"
        tabIndex={0}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, a")) onOpen(n);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(n)}
        aria-label={`${n.read ? "" : "Unread: "}${n.title}`}
      >
        <Avatar n={n} />
        <div className="nl-body">
          <p className="nl-title">{n.title}</p>
          {n.body && <p className="nl-text">{n.body}</p>}
          {shown.length > 0 && (
            <ul className="nl-items">
              {shown.map((i, k) => (
                <li key={`${i.text}-${k}`}>
                  <button type="button" className="nl-item" onClick={() => onOpen(n, i.link)}>
                    <span className={`nl-item-dot nl-k-${i.kind}`} aria-hidden="true" />
                    <span className="nl-item-main">
                      <span className="nl-item-text">{i.text}</span>
                      {i.sub && <span className="nl-item-sub">{i.sub}</span>}
                    </span>
                    {i.action && <span className="nl-item-action">{i.action}</span>}
                  </button>
                </li>
              ))}
              {items.length - (n.grouped === "deal" ? 1 : 0) > shown.length && (
                <li className="nl-more">+{items.length - (n.grouped === "deal" ? 1 : 0) - shown.length} more</li>
              )}
            </ul>
          )}
          <p className="nl-meta">
            <span>{day === "Earlier" ? `${dateOf(n.at)} · ${timeOf(n.at)}` : timeOf(n.at)}</span>
            {updates && <span className="nl-updates">{updates}</span>}
          </p>
        </div>
      </div>
      <div className="nl-side">
        <button type="button" className="nl-toggle" onClick={() => onToggleRead(n)} aria-label={n.read ? "Mark as unread" : "Mark as read"} title={n.read ? "Mark as unread" : "Mark as read"}>
          <CheckIcon size={13} />
        </button>
        {!n.read && <span className="nl-dot" aria-hidden="true" />}
      </div>
    </li>
  );
}

/** Rows under Today / Yesterday / Earlier headings. */
export function NoteGroups({ notes, onOpen, onToggleRead }: { notes: Note[]; onOpen: (n: Note, link?: string | null) => void; onToggleRead: (n: Note) => void }) {
  return (
    <>
      {byDay(notes).map((g) => (
        <section key={g.label} className="nl-day" aria-label={g.label}>
          <h3 className="nl-day-label">{g.label}</h3>
          <ul className="nl-list">
            {g.notes.map((n) => (
              <NoteRow key={n.id} n={n} day={g.label} onOpen={onOpen} onToggleRead={onToggleRead} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
