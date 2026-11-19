"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { safeNext, useAuth } from "../components/AuthGate";
import { ShareIcon } from "../components/Icons";
import { AuthError, type AuthIntent, type OtpRequest, passwordLogin, requestOtp, verifyOtp } from "../lib/api";

const LEN = 6;
const MIN_PASSWORD = 8;
const digitsOnly = (s: string) => s.replace(/\D/g, "");
const validEmail = (e: string) => /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[a-z]{2,}$/i.test(e.trim());
/** A name for a new account: 2-80 characters with a letter (the backend checks the same). */
const cleanName = (n: string) => n.replace(/\s+/g, " ").trim();
const validName = (n: string) => {
  const c = cleanName(n);
  return [...c].length >= 2 && [...c].length <= 80 && /\p{L}/u.test(c) && !/[<>"]/.test(c);
};
/** Length only here; the backend also refuses common passwords and ones made of the email. */
const okPassword = (p: string) => [...p].length >= MIN_PASSWORD && [...p].length <= 128;
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

/** How the "Sign in" tab signs in: with the password, or with a code emailed (also "Forgot password"). */
type SignInWay = "password" | "code" | "reset";

/**
 * Sign in or create an account.
 *
 * Sign in: email + password (fast), or "Email me a code" (always works, even without a password), or
 * "Forgot password?" (a code, then a new password). Create account: name, email and a password, then
 * the code sent to the email proves it is yours. Signing in by code with an email that has no account
 * asks for the name, then creates the account with the same code. Afterwards the room opens on Today
 * (or the page you came from).
 */
export default function LoginPage() {
  const router = useRouter();
  const { auth, refresh } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [way, setWay] = useState<SignInWay>("password");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [challenge, setChallenge] = useState<OtpRequest | null>(null);
  const [needName, setNeedName] = useState(false); // signing in by code, but this email has no account yet
  const [code, setCode] = useState<string[]>(Array(LEN).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false); // "Create account" with an email that already has one
  const [resendIn, setResendIn] = useState(0);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const nameBox = useRef<HTMLInputElement | null>(null);
  const passwordBox = useRef<HTMLInputElement | null>(null);

  const signupOpen = auth?.signup?.enabled !== false;
  const intent: AuthIntent = mode === "signup" ? "signup" : way === "reset" ? "reset" : "signin";
  const askingName = mode === "signup" || needName;
  // A password goes with the code when creating an account, or as the new one after "Forgot password".
  const sendsPassword = mode === "signup" || (mode === "signin" && way === "reset");

  // ?mode=signup opens "Create account" (e.g. a link shared with a teammate).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("mode");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL once on load
    if (wanted === "signup") setMode("signup");
  }, []);

  // Resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function reset(next: { mode?: "signin" | "signup"; way?: SignInWay }) {
    if (next.mode) setMode(next.mode);
    if (next.way) setWay(next.way);
    setError(null);
    setExists(false);
    setNeedName(false);
    setChallenge(null);
    setPassword("");
  }

  async function done() {
    await refresh();
    router.replace(safeNext());
  }

  // --- Step 1 -----------------------------------------------------------------------------------------
  const passwordStep = mode === "signin" && way === "password";
  const canSubmit =
    !busy &&
    validEmail(email) &&
    (passwordStep ? password.length > 0 : mode === "signup" ? validName(name) && okPassword(password) : true);

  async function signInWithPassword() {
    setBusy(true);
    setError(null);
    try {
      await passwordLogin(email.trim(), password);
      await done();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      setPassword("");
      setTimeout(() => passwordBox.current?.focus(), 0);
      setBusy(false);
    }
  }

  async function send() {
    if (!canSubmit && !challenge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requestOtp(email.trim(), intent, mode === "signup" ? cleanName(name) : null);
      setChallenge(r);
      setNeedName(false);
      setCode(Array(LEN).fill(""));
      setResendIn(r.resend_in);
      setTimeout(() => (way === "reset" && mode === "signin" ? passwordBox.current : boxes.current[0])?.focus(), 0);
    } catch (e) {
      if (e instanceof AuthError && e.retryAfter && challenge) setResendIn(e.retryAfter);
      setExists(e instanceof AuthError && e.code === "account_exists");
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  // --- Step 2: the code ---------------------------------------------------------------------------------
  const codeReady = (value: string) => value.length === LEN && (!askingName || validName(name)) && (!sendsPassword || okPassword(password));

  async function verify(value = code.join("")) {
    if (!challenge || value.length !== LEN || busy) return;
    if (askingName && !validName(name)) {
      setError("Enter your name (at least 2 letters) to create your account.");
      nameBox.current?.focus();
      return;
    }
    if (sendsPassword && !okPassword(password)) {
      setError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      passwordBox.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(challenge.challenge_id, value, email.trim(), askingName ? cleanName(name) : null, sendsPassword ? password : null);
      await done();
    } catch (e) {
      setBusy(false);
      if (e instanceof AuthError && e.code === "name_required") {
        // The code is right and still valid: this email is new. Ask for the name, keep the code.
        setNeedName(true);
        setTimeout(() => nameBox.current?.focus(), 0);
        return;
      }
      setError(e instanceof Error ? e.message : "Could not verify the code.");
      if (e instanceof AuthError && e.code === "weak_password") {
        // The code was not used: choose another password and send the same code again.
        setTimeout(() => passwordBox.current?.focus(), 0);
        return;
      }
      if (!(e instanceof AuthError && e.code === "signup_closed")) {
        setCode(Array(LEN).fill(""));
        setTimeout(() => boxes.current[0]?.focus(), 0);
      }
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
      if (codeReady(next.join(""))) void verify(next.join(""));
      return;
    }
    const next = [...code];
    next[i] = d;
    setCode(next);
    if (d && i < LEN - 1) boxes.current[i + 1]?.focus();
    if (d && next.every(Boolean) && codeReady(next.join(""))) void verify(next.join(""));
  }

  function onKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !code[i] && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < LEN - 1) boxes.current[i + 1]?.focus();
    else if (e.key === "Enter") void verify();
  }

  // --- Fields -------------------------------------------------------------------------------------------
  const nameField = (
    <div className="login-field">
      <label className="login-label" htmlFor="name">
        Your name
      </label>
      <div className="login-phone">
        <input
          id="name"
          ref={nameBox}
          className="login-text"
          type="text"
          autoComplete="name"
          maxLength={80}
          placeholder="e.g. Prem Kumar"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>
    </div>
  );

  const passwordField = (label: string, isNew: boolean) => (
    <div className="login-field">
      <label className="login-label" htmlFor="password">
        {label}
      </label>
      <div className="login-phone">
        <input
          id="password"
          ref={passwordBox}
          className="login-text"
          type={showPassword ? "text" : "password"}
          autoComplete={isNew ? "new-password" : "current-password"}
          maxLength={128}
          placeholder={isNew ? `At least ${MIN_PASSWORD} characters` : "Your password"}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
        <button type="button" className="login-show" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? "Hide password" : "Show password"}>
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
      {isNew && <p className="login-hint">Not a common password, and not your email.</p>}
    </div>
  );

  const title =
    mode === "signup" ? "Create your room" : way === "reset" ? "Reset your password" : "Sign in to your room";
  const sub =
    mode === "signup"
      ? "Your calls, people and deals stay private to you. We'll email you a code to confirm it's your email."
      : way === "password"
        ? "Sign in with your email and password."
        : way === "reset"
          ? "We'll email you a code, then you choose a new password."
          : "We'll email you a one-time code.";

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
          Your own private room.
        </p>
        <p className="login-brand-foot">Private · Encrypted · Only you</p>
      </aside>

      <main className="login-main">
        <div className="login-card">
          <span className="login-mark" aria-hidden="true">
            <ShareIcon size={20} strokeWidth={2} />
          </span>

          {!challenge ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!canSubmit) return;
                void (passwordStep ? signInWithPassword() : send());
              }}
            >
              {signupOpen && (
                <div className="login-tabs" role="tablist" aria-label="Sign in or create an account">
                  <button type="button" role="tab" className="login-tab" aria-selected={mode === "signin"} onClick={() => mode !== "signin" && reset({ mode: "signin", way: "password" })}>
                    Sign in
                  </button>
                  <button type="button" role="tab" className="login-tab" aria-selected={mode === "signup"} onClick={() => mode !== "signup" && reset({ mode: "signup" })}>
                    Create account
                  </button>
                </div>
              )}
              <h1 className="login-title">{title}</h1>
              <p className="login-sub">{sub}</p>
              {mode === "signup" && nameField}
              <div className="login-field">
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
                      setExists(false);
                    }}
                    aria-invalid={!!error}
                    aria-describedby={error ? "login-error" : undefined}
                    autoFocus
                  />
                </div>
              </div>
              {passwordStep && passwordField("Password", false)}
              {mode === "signup" && passwordField("Choose a password", true)}
              {error && (
                <p id="login-error" className="login-error" role="alert">
                  {error}
                </p>
              )}
              {exists ? (
                <button type="button" className="login-btn" onClick={() => reset({ mode: "signin", way: "password" })}>
                  Sign in with this email
                </button>
              ) : (
                <button type="submit" className="login-btn" disabled={!canSubmit}>
                  {busy ? (passwordStep ? "Signing in…" : "Sending…") : passwordStep ? "Sign in" : "Send code"}
                </button>
              )}
              {mode === "signin" && (
                <p className="login-ways">
                  {way === "password" ? (
                    <>
                      <button type="button" className="login-link" onClick={() => reset({ way: "code" })}>
                        Email me a code instead
                      </button>
                      <button type="button" className="login-link" onClick={() => reset({ way: "reset" })}>
                        Forgot password?
                      </button>
                    </>
                  ) : (
                    <button type="button" className="login-link" onClick={() => reset({ way: "password" })}>
                      Sign in with password instead
                    </button>
                  )}
                </p>
              )}
              {signupOpen && (
                <p className="login-switch">
                  {mode === "signin" ? (
                    <>
                      New here?{" "}
                      <button type="button" className="login-link" onClick={() => reset({ mode: "signup" })}>
                        Create an account
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{" "}
                      <button type="button" className="login-link" onClick={() => reset({ mode: "signin", way: "password" })}>
                        Sign in
                      </button>
                    </>
                  )}
                </p>
              )}
              <p className="login-foot">
                <ShieldIcon /> Only you can see your room
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
                  setNeedName(false);
                  setError(null);
                }}
                aria-label="Change email"
              >
                ‹ Change email
              </button>
              <h1 className="login-title">{needName ? "Create your account" : way === "reset" && mode === "signin" ? "Choose a new password" : "Enter the code"}</h1>
              <p className="login-sub">
                {challenge.delivery === "console" ? "For" : "Code sent to"} {masked(email)}
                {challenge.delivery !== "console" && " · check your inbox (and spam)"}
              </p>
              {needName && (
                <>
                  <p className="login-note" role="status">
                    There is no account for this email yet. Enter your name to create your room.
                  </p>
                  {nameField}
                </>
              )}
              {mode === "signin" && way === "reset" && passwordField("New password", true)}
              {(needName || (mode === "signin" && way === "reset")) && (
                <p className="login-label" style={{ marginTop: 16 }}>
                  Code
                </p>
              )}
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
              <button type="submit" className="login-btn" disabled={busy || !codeReady(code.join(""))}>
                {busy ? "Verifying…" : askingName ? "Create account" : way === "reset" && mode === "signin" ? "Save password and sign in" : "Verify"}
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
