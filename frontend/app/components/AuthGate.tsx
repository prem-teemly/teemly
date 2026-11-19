"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AuthError, type AuthState, getAuth, logout } from "../lib/api";

type AuthContextValue = { auth: AuthState | null; refresh: () => Promise<AuthState | null>; signOut: () => Promise<void> };
const AuthContext = createContext<AuthContextValue>({ auth: null, refresh: async () => null, signOut: async () => {} });

export const useAuth = () => useContext(AuthContext);

/** Why the sign-in state could not be read. */
function describeFailure(e: unknown): string {
  if (e instanceof AuthError && e.status === 404) {
    return "The backend that is running is an older version without sign-in. Restart it (npm start in backend) and try again.";
  }
  if (e instanceof AuthError && e.status === 503) return e.message;
  return "Can't reach the Teemly backend. Make sure it is running (npm start in backend), then try again.";
}

/**
 * Asks the backend who is signed in. Nobody signed in: every page except /login goes to /login (sign
 * in or create an account); a signed-in user on /login goes on to their room (Today, or the page they
 * came from). The backend enforces the same rule on every API call, so this only decides what to show.
 *
 * The page is always rendered (hidden until the check passes) so the tree stays stable and Next.js can
 * prerender and validate each route. If the check fails, nothing is shown but the error: the app never
 * assumes sign-in is off just because the backend could not answer.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await getAuth();
      setAuth(next);
      setFailure(null);
      return next;
    } catch (e) {
      setAuth(null);
      setFailure(describeFailure(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external state
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setAuth({ auth_enabled: true, user: null });
      // A full page load, not client navigation: nothing of this account (departments, lists kept in
      // memory) can still be on screen for whoever signs in next on this browser.
      window.location.replace("/login");
    }
  }, []);

  const onLogin = pathname === "/login";
  const mustSignIn = !!auth?.auth_enabled && !auth.user && !onLogin;
  const signedInOnLogin = !!auth?.user && onLogin;
  const show = !!auth && !mustSignIn && !signedInOnLogin;

  useEffect(() => {
    if (mustSignIn) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (signedInOnLogin) router.replace(safeNext());
  }, [mustSignIn, signedInOnLogin, pathname, router]);

  return (
    <AuthContext.Provider value={{ auth, refresh, signOut }}>
      <div className="auth-root" hidden={!show} inert={!show}>
        {children}
      </div>
      {!show &&
        (failure ? (
          <div className="auth-loading" role="alert">
            <div className="auth-failure">
              <p className="auth-failure-title">Can&apos;t check sign-in</p>
              <p className="auth-failure-text">{failure}</p>
              <button type="button" className="login-btn" onClick={() => void refresh()} disabled={checking}>
                {checking ? "Checking…" : "Try again"}
              </button>
            </div>
          </div>
        ) : (
          <div className="auth-loading" aria-busy="true" aria-label="Loading">
            <span className="auth-spinner" />
          </div>
        ))}
    </AuthContext.Provider>
  );
}

/** Where to go after sign-in: ?next= if it is a local page, otherwise the dashboard (Today). */
export function safeNext(): string {
  const next = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("next");
  // Only a path on this site: browsers read "/\evil.com" (and other backslashes) like "//evil.com".
  const local = !!next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") && !/[\u0000-\u001f]/.test(next);
  return local && next !== "/login" && next !== "/" ? next : "/today";
}

/** Bottom of the sidebar: the signed-in owner, with sign-out. */
export function SidebarUser() {
  const { auth, signOut } = useAuth();
  const user = auth?.user;
  return (
    <div className="sb-user">
      {user ? (
        <Link href="/profile" className="sb-user-link" title="My profile">
          <span className="sb-avatar" aria-hidden="true">
            {user.initials}
          </span>
          <span className="sb-user-text">
            <span className="sb-user-name">{user.name}</span>
            <span className="sb-user-sub">Your private room</span>
          </span>
        </Link>
      ) : (
        <>
          <span className="sb-avatar" aria-hidden="true">
            T
          </span>
          <span className="sb-user-text">
            <span className="sb-user-name">Teemly</span>
            <span className="sb-user-sub">Private room</span>
          </span>
        </>
      )}
      {user && (
        <button type="button" className="sb-logout" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
            <path d="M10 17l-5-5 5-5M5 12h11" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Top-right account avatar (initials of the signed-in owner). Click: a menu with who is signed in,
 * My profile and Sign out. Closes on Escape, an outside click or choosing an item.
 */
export function UserAvatar() {
  const { auth, signOut } = useAuth();
  const user = auth?.user;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
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

  if (!user) {
    return (
      <span className="tb-avatar" aria-label="Account">
        T
      </span>
    );
  }
  return (
    <div className="um" ref={box}>
      <button type="button" className="tb-avatar um-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${user.name}`} onClick={() => setOpen((o) => !o)}>
        {user.initials}
      </button>
      {open && (
        <div className="um-menu" role="menu" aria-label="Account">
          <div className="um-head">
            <span className="um-avatar" aria-hidden="true">
              {user.initials}
            </span>
            <span className="um-who">
              <span className="um-name">{user.name}</span>
              <span className="um-sub">
                {user.role === "owner" ? "Owner" : "Member"} · {user.email_masked}
              </span>
            </span>
          </div>
          <Link href="/profile" role="menuitem" className="um-item" onClick={() => setOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
            My profile
          </Link>
          <button
            type="button"
            role="menuitem"
            className="um-item um-danger"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
              <path d="M10 17l-5-5 5-5M5 12h11" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
