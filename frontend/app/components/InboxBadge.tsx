"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "../lib/api";
import { INBOX_CHANGED } from "../lib/inbox";

/** Number of inbox items waiting for a decision (hidden when none, or when it cannot be read). */
export default function InboxBadge() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE_URL}/api/inbox/count`, { cache: "no-store", credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => alive && setN(typeof b?.pending === "number" ? b.pending : 0))
        .catch(() => alive && setN(0));
    void load();
    window.addEventListener(INBOX_CHANGED, load);
    return () => {
      alive = false;
      window.removeEventListener(INBOX_CHANGED, load);
    };
  }, []);
  if (!n) return null;
  return (
    <span className="sb-badge" aria-label={`${n} waiting`}>
      {n}
    </span>
  );
}
