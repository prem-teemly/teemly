"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type DeviceSession, type Profile, getProfile, revokeDevice, revokeOtherDevices, setMyPassword, updateMyName } from "../lib/api";
import { rupees, whenLabel } from "../lib/people";
import { useAuth } from "./AuthGate";
import PeopleChrome from "./PeopleChrome";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** "16 Nov 2026" */
const dateLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

function DeviceIcon({ device }: { device: string }) {
  const phone = /iPhone|Android|iPad/.test(device);
  return (
    <span className="pf-dev-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {phone ? (
          <>
            <rect x="7" y="2.5" width="10" height="19" rx="2" />
            <path d="M11 18.5h2" />
          </>
        ) : (
          <>
            <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
            <path d="M8 20h8M12 16.5V20" />
          </>
        )}
      </svg>
    </span>
  );
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <>
      <span className="pf-stat-label">{label}</span>
      <span className="pf-stat-value">{value}</span>
      {sub && <span className="pf-stat-sub">{sub}</span>}
    </>
  );
  return href ? (
    <Link href={href} className="pf-stat pf-stat-link">
      {body}
    </Link>
  ) : (
    <div className="pf-stat">{body}</div>
  );
}

/** The signed-in user's profile: account, room at a glance, signed-in devices, sign-in & security. */
export default function ProfilePage() {
  const { signOut, refresh } = useAuth();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "others" | "signout" | "name" | "password" | null>(null);
  // Set / change password form (closed until asked for).
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setP(await getProfile());
    } catch (e) {
      setError(message(e, "Could not load your profile."));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);

  async function signOutDevice(s: DeviceSession) {
    if (busy || !window.confirm(`Sign out ${s.device}? It will need a new code to open the room.`)) return;
    setBusy(s.id);
    setNotice(null);
    try {
      await revokeDevice(s.id);
      setP((x) => (x ? { ...x, sessions: x.sessions.filter((d) => d.id !== s.id) } : x));
      setNotice(`${s.device} was signed out.`);
    } catch (e) {
      setNotice(message(e, "Could not sign out that device."));
      void load();
    } finally {
      setBusy(null);
    }
  }
  /** Change the account's name (the room greets you with it; the AI knows you by it in calls). */
  async function rename() {
    if (busy || !p) return;
    const next = window.prompt("Your name", p.user.name)?.replace(/\s+/g, " ").trim();
    if (!next || next === p.user.name) return;
    setBusy("name");
    setNotice(null);
    try {
      const r = await updateMyName(next);
      setP((x) => (x ? { ...x, user: { ...x.user, ...r.user } } : x));
      void refresh(); // the sidebar and top bar show the new name
      setNotice("Your name was changed.");
    } catch (e) {
      setNotice(message(e, "Could not change your name."));
    } finally {
      setBusy(null);
    }
  }
  /** Set a first password or change it; every other device is signed out (this one stays). */
  async function savePassword() {
    if (busy || !p) return;
    if ([...pwNew].length < 8) return setPwError("Use at least 8 characters.");
    setBusy("password");
    setPwError(null);
    try {
      const r = await setMyPassword(pwNew, p.user.has_password ? pwCurrent : null);
      setPwOpen(false);
      setPwCurrent("");
      setPwNew("");
      setNotice(`Password ${p.user.has_password ? "changed" : "set"}. You can now sign in with your email and password${r.signed_out ? `; ${r.signed_out} other device${r.signed_out === 1 ? " was" : "s were"} signed out` : ""}.`);
      void load();
    } catch (e) {
      setPwError(message(e, "Could not save the password.").replace(/^password: /, ""));
    } finally {
      setBusy(null);
    }
  }
  async function signOutOthers() {
    if (busy || !window.confirm("Sign out every other device? Only this one stays signed in.")) return;
    setBusy("others");
    setNotice(null);
    try {
      const r = await revokeOtherDevices();
      setP((x) => (x ? { ...x, sessions: x.sessions.filter((d) => d.current) } : x));
      setNotice(r.signed_out ? `${r.signed_out} other device${r.signed_out === 1 ? " was" : "s were"} signed out.` : "No other devices were signed in.");
    } catch (e) {
      setNotice(message(e, "Could not sign out the other devices."));
    } finally {
      setBusy(null);
    }
  }

  if (error || !p) {
    return (
      <PeopleChrome active="profile">
        <div className="card pl-state" role={error ? "alert" : undefined} aria-busy={!error}>
          {error ? (
            <>
              <p>{error}</p>
              <button type="button" className="pl-view" onClick={() => void load()}>
                Try again
              </button>
            </>
          ) : (
            <span className="auth-spinner" />
          )}
        </div>
      </PeopleChrome>
    );
  }

  const { user, room, sessions, security } = p;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <PeopleChrome active="profile">
      <div className="pl-head">
        <div>
          <h1 className="pl-title">My profile</h1>
          <p className="pl-sub">Your account, your room and the devices signed in to it</p>
        </div>
      </div>

      {notice && (
        <div className="ib-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <section className="card pf-account" aria-label="Account">
        <span className="pf-avatar" aria-hidden="true">
          {user.initials}
        </span>
        <div className="pf-who">
          <div className="pf-name-row">
            <h2 className="pf-name">{user.name}</h2>
            <span className="pf-role">{user.role === "owner" ? "Owner" : "Member"}</span>
          </div>
          <p className="pf-facts">
            <span>Email {user.email ?? user.email_masked}</span>
            <span>Member since {dateLabel(user.member_since)}</span>
            <span>Last sign-in {user.last_login_at ? whenLabel(user.last_login_at) : "—"}</span>
          </p>
          <p className="pf-hint">
            Only you can see the calls, people and deals in your room.{" "}
            <button type="button" className="pw-link" disabled={busy !== null} onClick={() => void rename()}>
              {busy === "name" ? "Saving…" : "Change name"}
            </button>
          </p>
          <p className="pf-hint">
            Password: {user.has_password ? `set${user.password_set_at ? ` on ${dateLabel(user.password_set_at)}` : ""}` : "not set (you sign in with an email code)"}.{" "}
            <button type="button" className="pw-link" disabled={busy !== null} onClick={() => (setPwOpen((o) => !o), setPwError(null))}>
              {user.has_password ? "Change password" : "Set a password"}
            </button>
          </p>
          {pwOpen && (
            <form
              className="pf-password"
              onSubmit={(e) => {
                e.preventDefault();
                void savePassword();
              }}
            >
              {user.has_password && (
                <input type="password" className="pf-input" autoComplete="current-password" placeholder="Current password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} maxLength={128} />
              )}
              <input type="password" className="pf-input" autoComplete="new-password" placeholder="New password (at least 8 characters)" value={pwNew} onChange={(e) => setPwNew(e.target.value)} maxLength={128} />
              <button type="submit" className="pa-btn pw-btn" disabled={busy !== null || !pwNew || (user.has_password && !pwCurrent)}>
                {busy === "password" ? "Saving…" : "Save password"}
              </button>
              {pwError && (
                <span className="pf-pw-error" role="alert">
                  {pwError}
                </span>
              )}
              <span className="pf-hint">Other devices will be signed out. Forgot it? Sign out and use “Forgot password?”.</span>
            </form>
          )}
        </div>
        <button type="button" className="pa-btn pf-signout" disabled={busy === "signout"} onClick={() => (setBusy("signout"), void signOut())}>
          {busy === "signout" ? "Signing out…" : "Sign out"}
        </button>
      </section>

      {room && (
        <section className="pf-stats" aria-label="Your room">
          <Stat label="People" value={String(room.people)} href="/people" />
          <Stat label="Conversations" value={String(room.conversations)} sub="calls on timelines" />
          <Stat label="Open opportunities" value={String(room.open_opportunities)} sub={room.open_value_inr ? rupees(room.open_value_inr) : undefined} />
          <Stat label="Inbox" value={String(room.inbox_pending)} sub={room.inbox_pending ? "waiting for you" : "all clear"} href="/inbox" />
        </section>
      )}

      <div className="pf-grid">
        <section className="card pf-card" aria-label="Signed-in devices">
          <div className="pf-card-head">
            <h2 className="pa-card-title">Signed-in devices</h2>
            {others > 0 && (
              <button type="button" className="pw-link pw-link-danger" disabled={busy !== null} onClick={() => void signOutOthers()}>
                {busy === "others" ? "Signing out…" : "Sign out all other devices"}
              </button>
            )}
          </div>
          <ul className="pf-devices">
            {sessions.map((s) => (
              <li key={s.id} className="pf-device">
                <DeviceIcon device={s.device} />
                <span className="pf-dev-main">
                  <span className="pf-dev-name">
                    {s.device}
                    {s.current && <span className="pf-this">This device</span>}
                  </span>
                  <span className="pf-dev-sub">
                    Signed in {whenLabel(s.signed_in_at)} · active {whenLabel(s.last_seen_at)} · until {dateLabel(s.expires_at)}
                  </span>
                </span>
                {!s.current && (
                  <button type="button" className="pa-btn pw-btn" disabled={busy !== null} onClick={() => void signOutDevice(s)}>
                    {busy === s.id ? "…" : "Sign out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="card pf-card" aria-label="Sign-in and security">
          <h2 className="pa-card-title">Sign-in &amp; security</h2>
          <dl className="pf-list">
            <div>
              <dt>Sign-in</dt>
              <dd>{security.method}</dd>
            </div>
            <div>
              <dt>Codes</dt>
              <dd>
                {security.code_delivery === "console" ? "Shown in the backend terminal (development mode, no email sent)" : "Sent by email"} · valid {security.code_minutes} min
              </dd>
            </div>
            <div>
              <dt>Stay signed in</dt>
              <dd>{security.session_days} days on each device</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>Your number and codes are never stored in plain text; only one-way hashes are kept.</dd>
            </div>
          </dl>
        </section>
      </div>
    </PeopleChrome>
  );
}
