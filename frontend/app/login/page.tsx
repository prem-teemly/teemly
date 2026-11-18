"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { safeNext, useAuth } from "../components/AuthGate";
import { ShareIcon } from "../components/Icons";
import { AuthError, type OtpRequest, requestOtp, verifyOtp } from "../lib/api";

const LEN = 6;
const digitsOnly = (s: string) => s.replace(/\D/g, "");
const validEmail = (e: string) => /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[a-z]{2,}$/i.test(e.trim());
/** "ownername.sample@gmail.com" -> "own•••••••••••••@gmail.com" (as the backend shows it). */
const masked = (e: string) => {
  const [local = "", domain = ""] = e.trim().toLowerCase().split("@");
  const keep = local.slice(0, Math.min(3, Math.max(1, local.length - 2)));
  return `${keep}${"•".repeat(Math.max(3, local.length - keep.length))}@${domain}`;
};

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { auth, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState<OtpRequest | null>(null);
  const [code, setCode] = useState<string[]>(Array(LEN).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // Resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function send() {
    if (!validEmail(email) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requestOtp(email.trim());
      setChallenge(r);
      setCode(Array(LEN).fill(""));
      setResendIn(r.resend_in);
      setTimeout(() => boxes.current[0]?.focus(), 0);
    } catch (e) {
      if (e instanceof AuthError && e.retryAfter && challenge) setResendIn(e.retryAfter);
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(value = code.join("")) {
    if (!challenge || value.length !== LEN || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(challenge.challenge_id, value);
      await refresh();
      router.replace(safeNext());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify the code.");
      setCode(Array(LEN).fill(""));
      setTimeout(() => boxes.current[0]?.focus(), 0);
      setBusy(false);
    }
  }

  function setDigit(i: number, raw: string) {
    const d = digitsOnly(raw);
    if (d.length > 1) {
      // Pasted or auto-filled code.
      const next = d.slice(0, LEN).split("");
      const full = [...next, ...Array(LEN - next.length).fill("")];
      setCode(full);
      boxes.current[Math.min(next.length, LEN - 1)]?.focus();
      if (next.length === LEN) void verify(next.join(""));
      return;
    }
    const next = [...code];
    next[i] = d;
    setCode(next);
    if (d && i < LEN - 1) boxes.current[i + 1]?.focus();
    if (d && next.every(Boolean)) void verify(next.join(""));
  }

  function onKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !code[i] && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < LEN - 1) boxes.current[i + 1]?.focus();
    else if (e.key === "Enter") void verify();
  }

  const loginOff = auth && !auth.auth_enabled;

  return (
    <div className="login-page">
      <aside className="login-brand" aria-hidden="true">
        <span className="login-logo">
          <ShareIcon size={30} strokeWidth={2} />
        </span>
        <p className="login-brand-name">Opportunity Room</p>
        <p className="login-brand-by">by Teemly</p>
        <p className="login-brand-line">
          Every person.
          <br />
          Every opportunity.
          <br />
          One private room.
        </p>
        <p className="login-brand-foot">Private · Encrypted · Only you</p>
      </aside>

      <main className="login-main">
        <div className="login-card">
          <span className="login-mark" aria-hidden="true">
            <ShareIcon size={20} strokeWidth={2} />
          </span>

          {loginOff ? (
            <>
              <h1 className="login-title">Sign-in is not enabled</h1>
              <p className="login-sub">
                Add <code>OWNER_EMAIL</code> (and <code>OWNER_NAME</code>) to <code>backend/.env</code> and restart the backend to require sign-in.
              </p>
              <button type="button" className="login-btn" onClick={() => router.replace("/people")}>
                Continue to People
              </button>
            </>
          ) : !challenge ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <h1 className="login-title">Sign in to your room</h1>
              <p className="login-sub">We&apos;ll email you a one-time code.</p>
              <label className="login-label" htmlFor="email">
                Email
              </label>
              <div className={`login-phone ${error ? "login-phone-err" : ""}`}>
                <input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value.replace(/\s+/g, ""));
                    setError(null);
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? "login-error" : undefined}
                  autoFocus
                />
              </div>
              {error && (
                <p id="login-error" className="login-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="login-btn" disabled={!validEmail(email) || busy}>
                {busy ? "Sending…" : "Send code"}
              </button>
              <p className="login-foot">
                <ShieldIcon /> Only the owner&apos;s email can open this room
              </p>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <button
                type="button"
                className="login-back"
                onClick={() => {
                  setChallenge(null);
                  setError(null);
                }}
                aria-label="Change email"
              >
                ‹ Change email
              </button>
              <h1 className="login-title">Enter the code</h1>
              <p className="login-sub">
                {challenge.delivery === "console" ? "For" : "Sent to"} {masked(email)}
                {challenge.delivery !== "console" && " · check your inbox (and spam)"}
              </p>
              <div className="login-code" role="group" aria-label="6-digit code">
                {code.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      boxes.current[i] = el;
                    }}
                    className={`login-digit ${error ? "login-digit-err" : ""}`}
                    type="text"
                    inputMode="numeric"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    maxLength={i === 0 ? LEN : 1}
                    value={d}
                    onChange={(e) => setDigit(i, e.target.value)}
                    onKeyDown={(e) => onKey(i, e)}
                    onFocus={(e) => e.target.select()}
                    aria-label={`Digit ${i + 1}`}
                    disabled={busy}
                  />
                ))}
              </div>
              {error && (
                <p className="login-error" role="alert">
                  {error}
                </p>
              )}
              <p className="login-resend">
                {resendIn > 0 ? (
                  <>
                    Resend code in <strong>0:{String(resendIn).padStart(2, "0")}</strong>
                  </>
                ) : (
                  <button type="button" className="login-link" onClick={() => void send()} disabled={busy}>
                    Resend code
                  </button>
                )}
              </p>
              <button type="submit" className="login-btn" disabled={code.some((x) => !x) || busy}>
                {busy ? "Verifying…" : "Verify"}
              </button>
              {challenge.delivery === "console" && (
                <p className="login-dev" role="note">
                  <strong>Development mode:</strong> no email is sent. The code is printed in the backend terminal.
                </p>
              )}
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
