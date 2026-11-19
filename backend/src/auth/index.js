// Accounts: sign-up and sign-in (email + password, or email + one-time code), and the session check
// that protects every other API.
//
//   POST /api/auth/otp/request  { email, intent?, name? }       -> a code is emailed (intent: signin |
//                                                                 signup | reset = Forgot password)
//   POST /api/auth/otp/verify   { challenge_id, code, email, name?, password? }
//                                                              -> session cookie (httpOnly, SameSite=Lax);
//                                                                 creates the account on sign-up; with
//                                                                 `password`, sets it (sign-up / reset)
//   GET  /api/auth/me                                          -> { auth_enabled: true, user, signup }
//   POST /api/auth/password/login { email, password }          -> session cookie (password sign-in)
//   POST /api/auth/password    { current_password?, new_password } -> set / change the password
//   POST /api/auth/logout                                      -> session revoked, cookie cleared
//   GET  /api/auth/profile                                     -> account, room counts, devices, settings
//   POST /api/auth/profile      { name }                       -> change the account's name
//   POST /api/auth/sessions/:id/revoke                         -> sign out another device
//   POST /api/auth/sessions/revoke-others                      -> sign out every other device
//
// Sign-in is always required: every /api/* call except these and /health needs a valid session, and
// runs as that session's user (tenant.runAs), so it sees only that user's room.
//
// One flow for both: the code proves the person owns the email. Then an existing account signs in; an
// email without an account gets one when sign-up is allowed for it (config.canSignUp) and a name is
// given ("Sign up" asks for it first; "Sign in" asks for it only then). "Create account" with an email
// that already has an account is refused at once (409 account_exists, no code sent), so nobody makes
// a second account by mistake; signing in never says whether an email has an account before the code.

import * as config from "../config.js";
import { clientAddress, jsonBody, parseBody, sendJson } from "../http.js";
import { getPool } from "../db/pool.js";
import { audit, clientHash } from "../db/repository.js";
import { roomStats } from "../db/people.js";
import { runAs } from "../tenant.js";
import { HttpError, getLogger } from "../util.js";
import { codeHash, codeMatches, newChallengeId, newCode, sendCode } from "./otp.js";
import { burnTime, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password.js";
import { hashEmail, maskEmail, normalizeEmail } from "./email.js";
import * as store from "./store.js";

const logger = getLogger("app.auth");
const PER_CLIENT_PER_HOUR = 10;
// Password sign-in: 5 wrong in a row lock that account's password sign-in for 15 minutes (the emailed
// code still works); 20 wrong from one address in 15 minutes stop that address for a while.
const PASSWORD_MAX_FAILS = 5;
const PASSWORD_LOCK_MINUTES = 15;
const PASSWORD_FAILS_PER_CLIENT = 20;
const WRONG_LOGIN = "Incorrect email or password. Forgot it, or never set one? Use “Email me a code”.";

/** A new password from a request: checked against the rules (422 with the reason), or null when not given. */
function parseNewPassword(raw, email) {
  if (raw === undefined || raw === null || raw === "") return null;
  const problem = passwordProblem(raw, { email });
  if (problem) throw new HttpError(422, `password: ${problem}`, "weak_password");
  return raw;
}

/** Start a session for a user: cookie, last sign-in, audit. */
async function startSession(req, res, user, method) {
  await store.markSignedIn(user.id);
  const token = await store.createSession({ userId: user.id, days: config.AUTH.sessionDays, clientHash: clientHash(clientAddress(req)), userAgent: req.headers["user-agent"] });
  setSessionCookie(res, token, config.AUTH.sessionDays * 86400);
  logger.info(`Signed in (${method}): user ${user.id}`);
  await audit("auth.signin", { userId: user.id, entityType: "user", entityId: String(user.id), ip: clientAddress(req), detail: { method } });
}
const PUBLIC_PATHS = /^\/(health|docs|redoc|openapi\.json)$|^\/api\/auth\//;

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function readCookie(req, name = config.AUTH.cookieName) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [`${config.AUTH.cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (config.AUTH.cookieSecure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

const initials = (name) =>
  String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
const publicUser = (u) => {
  const name = u.name ?? u.display_name;
  return { name, initials: initials(name), email_masked: maskEmail(u.email), role: u.role };
};

/** A person's name for a new account: 2-80 characters with at least one letter; null if not given. */
export function parseName(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    if (required) throw new HttpError(422, "name: enter your name");
    return null;
  }
  if (typeof raw !== "string") throw new HttpError(422, "name: should be text");
  const name = raw.replace(/\s+/g, " ").trim();
  if ([...name].length < 2 || [...name].length > 80) throw new HttpError(422, "name: should be 2 to 80 characters");
  if (!/\p{L}/u.test(name) || /[<>"]/.test(name)) throw new HttpError(422, "name: use letters (and spaces)");
  return name;
}

const isOwnerEmail = (email) => config.AUTH.ownerEmails.includes(email);

async function requireReady() {
  if (!getPool()) throw new HttpError(503, "Accounts need the database (MySQL), which is not configured on this server.");
  if (!(await store.ready().catch(() => false))) {
    throw new HttpError(503, "Accounts are not set up yet: the database needs its migrations (npm run db:migrate).");
  }
}

function tooMany(res, seconds, message) {
  res.setHeader("Retry-After", String(Math.max(1, seconds)));
  return sendJson(res, 429, { status: "error", message, retry_after: Math.max(1, seconds) });
}

/** Register the account routes with the app's route() helper (keeps 404/405 handling consistent). */
export function registerAuthRoutes(route) {
  route(
    "POST",
    "/api/auth/otp/request",
    jsonBody,
    h(async (req, res) => {
      await requireReady();
      const body = parseBody(req, {
        email: { type: "string", required: true, maxLength: 254 },
        // "reset" (Forgot password) works like "signin": the code proves the email, then a new password is set.
        intent: { type: "literal", values: ["signin", "signup", "reset"], default: "signin" },
        name: { type: "string", nullable: true, default: null, maxLength: 200 },
      });
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(422, "Enter a valid email address.");
      // Sign-up: say at once when this email cannot create an account (no code is sent for nothing).
      if (body.intent === "signup") {
        parseName(body.name, { required: true });
        if (!config.canSignUp(email)) throw new HttpError(403, "Sign-ups are not open for this email. Ask the room's owner to allow it.", "signup_closed");
      }
      const emailHash = hashEmail(email);
      const client = clientHash(clientAddress(req));
      const { perEmail, perClient, sinceLast } = await store.recentRequests(emailHash, client);
      const { otpResendSeconds, otpMaxPerHour, otpTtlSeconds, otpProvider } = config.AUTH;
      if (perClient >= PER_CLIENT_PER_HOUR) return tooMany(res, 3600, "Too many code requests. Please try again later.");
      if (sinceLast !== null && sinceLast < otpResendSeconds) {
        return tooMany(res, otpResendSeconds - sinceLast, `Please wait ${otpResendSeconds - sinceLast} s before requesting a new code.`);
      }
      if (perEmail >= otpMaxPerHour) return tooMany(res, 3600, "Too many codes for this email. Please try again in an hour.");

      const existing = await store.userByEmail(email);
      // "Create account" with an email that already has one: say so at once (no code, no second
      // account); the page offers "Sign in" instead. Checked after the rate limits above.
      if (body.intent === "signup" && existing) {
        throw new HttpError(409, "An account with this email already exists. Sign in instead: your room and its data are waiting.", "account_exists");
      }
      const greet = existing?.display_name ?? parseName(body.name); // "Hi Prem," in the email
      const id = newChallengeId();
      const code = newCode();
      await store.createChallenge({ id, emailHash, codeHash: codeHash(id, code), ttlSeconds: otpTtlSeconds, clientHash: client });
      try {
        await sendCode(otpProvider, email, code, otpTtlSeconds, greet);
      } catch (exc) {
        await store.cancelChallenge(id).catch(() => {});
        logger.error(`Sign-in code could not be emailed to ${maskEmail(email)} (${exc?.code ?? exc?.responseCode ?? exc?.message ?? "error"})`);
        throw new HttpError(502, "The code could not be emailed right now. Please try again in a minute.");
      }
      return sendJson(res, 200, {
        status: "success",
        message: "A code has been sent to this email.",
        challenge_id: id,
        expires_in: otpTtlSeconds,
        resend_in: otpResendSeconds,
        delivery: otpProvider === "console" ? "console" : "email",
      });
    }),
  );

  route(
    "POST",
    "/api/auth/otp/verify",
    jsonBody,
    h(async (req, res) => {
      await requireReady();
      const body = parseBody(req, {
        challenge_id: { type: "string", required: true, maxLength: 64 },
        code: { type: "string", required: true, maxLength: 10 },
        email: { type: "string", required: true, maxLength: 254 },
        name: { type: "string", nullable: true, default: null, maxLength: 200 },
        // Optional: the password for a new account, or a new password (Forgot password).
        password: { type: "string", nullable: true, default: null, maxLength: 512 },
      });
      const code = body.code.trim();
      if (!/^[0-9a-f]{32}$/.test(body.challenge_id) || !/^\d{6}$/.test(code)) throw new HttpError(422, "Enter the 6-digit code.");
      const email = normalizeEmail(body.email);
      const name = parseName(body.name);
      // Checked before the code is: a weak password costs no attempt, and the same code can be sent again.
      const password = parseNewPassword(body.password, email);
      const { status, row } = await store.useAttempt(body.challenge_id, config.AUTH.otpMaxAttempts);
      if (status === "missing" || status === "expired") throw new HttpError(400, "This code has expired. Please request a new one.");
      if (status === "locked") throw new HttpError(429, "Too many wrong codes. Please request a new one.");
      // The code must match, for the email it was sent to (the code table keeps only the email's hash).
      if (!email || !row.email_hash || hashEmail(email) !== row.email_hash || !codeMatches(body.challenge_id, code, row.code_hash)) {
        const left = config.AUTH.otpMaxAttempts - row.attempts;
        throw new HttpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Please request a new one.");
      }

      // The person owns this email. Their account, the room from before accounts (the owner), or a new one.
      let user = await store.userByEmail(email);
      let created = false;
      if (!user && isOwnerEmail(email)) user = await store.claimLegacyAccount({ email, name: name ?? config.AUTH.ownerName });
      if (!user) {
        if (!config.canSignUp(email)) {
          await store.consume(body.challenge_id);
          throw new HttpError(403, "There is no account for this email, and sign-ups are not open for it.", "signup_closed");
        }
        const newName = name ?? (isOwnerEmail(email) ? config.AUTH.ownerName : null);
        // The code stays valid: the page asks for the name and sends the same code again.
        if (!newName) throw new HttpError(409, "No account for this email yet. Enter your name to create one.", "name_required");
      }
      if (user && user.status !== "active") throw new HttpError(403, "This account is disabled.");
      if (!(await store.consume(body.challenge_id))) throw new HttpError(400, "This code has already been used. Please request a new one.");
      const passwordHash = password ? await hashPassword(password) : null;
      const ip = clientAddress(req);
      if (!user) {
        user = await store.createAccount({ email, name: name ?? config.AUTH.ownerName, passwordHash });
        created = true;
        logger.info(`Account created: user ${user.id}`);
        // Who signed up, and when (audit_logs; the client address only as a keyed hash).
        await audit("auth.signup", { userId: user.id, entityType: "user", entityId: String(user.id), ip, detail: { password: Boolean(passwordHash) } });
      } else if (passwordHash) {
        // Forgot password (or a first one): set it, and sign out every other device.
        await store.setPasswordHash(user.id, passwordHash);
        const signedOut = await store.revokeOtherSessions(user.id, 0);
        await audit("auth.password_reset", { userId: user.id, entityType: "user", entityId: String(user.id), ip, detail: { signed_out: signedOut } });
      }
      await startSession(req, res, user, "code");
      return sendJson(res, created ? 201 : 200, { status: "success", created, password_set: Boolean(passwordHash), user: publicUser(user) });
    }),
  );

  // Sign in with email + password. Wrong email, wrong password and "no password set" get the same
  // answer (and take as long), so it never says which emails have an account.
  route(
    "POST",
    "/api/auth/password/login",
    jsonBody,
    h(async (req, res) => {
      await requireReady();
      const body = parseBody(req, {
        email: { type: "string", required: true, maxLength: 254 },
        password: { type: "string", required: true, maxLength: 512 },
      });
      const ip = clientAddress(req);
      const client = clientHash(ip);
      if ((await store.recentPasswordFailures(client)) >= PASSWORD_FAILS_PER_CLIENT) {
        return tooMany(res, PASSWORD_LOCK_MINUTES * 60, "Too many wrong passwords from this device. Please wait, or use “Email me a code”.");
      }
      const email = normalizeEmail(body.email);
      const cred = email ? await store.credentialsByEmail(email) : null;
      const failed = async (userId) => audit("auth.password_failed", { userId, entityType: "user", entityId: userId ? String(userId) : null, outcome: "failure", ip });
      if (!cred?.password_hash) {
        await burnTime(body.password);
        await failed(null);
        throw new HttpError(400, WRONG_LOGIN, "wrong_password");
      }
      if (cred.locked) {
        const minutes = Math.max(1, Math.ceil(cred.locked_for / 60));
        res.setHeader("Retry-After", String(Math.max(1, cred.locked_for)));
        throw new HttpError(429, `Too many wrong passwords. Password sign-in is paused for ${minutes} min. Use “Email me a code” to sign in now.`, "password_locked");
      }
      if (!(await verifyPassword(body.password, cred.password_hash))) {
        const nowLocked = await store.recordFailedLogin(cred.id, { maxFails: PASSWORD_MAX_FAILS, lockMinutes: PASSWORD_LOCK_MINUTES });
        await failed(cred.id);
        if (nowLocked) {
          await audit("auth.password_locked", { userId: cred.id, entityType: "user", entityId: String(cred.id), outcome: "failure", ip });
          throw new HttpError(429, `Too many wrong passwords. Password sign-in is paused for ${PASSWORD_LOCK_MINUTES} min. Use “Email me a code” to sign in now.`, "password_locked");
        }
        throw new HttpError(400, WRONG_LOGIN, "wrong_password");
      }
      if (cred.status !== "active") throw new HttpError(403, "This account is disabled.");
      if (needsRehash(cred.password_hash)) await store.upgradePasswordHash(cred.id, await hashPassword(body.password));
      await startSession(req, res, cred, "password");
      return sendJson(res, 200, { status: "success", user: publicUser(cred) });
    }),
  );

  // Set a password (signed in by code, none yet) or change it (the current one is needed). Every other
  // device is signed out; this one stays.
  route(
    "POST",
    "/api/auth/password",
    jsonBody,
    h(async (req, res) => {
      const { user } = await signedIn(req, { write: true });
      const body = parseBody(req, {
        current_password: { type: "string", nullable: true, default: null, maxLength: 512 },
        new_password: { type: "string", required: true, maxLength: 512 },
      });
      const ip = clientAddress(req);
      const existing = await store.passwordHashOf(user.id);
      if (existing && !(await verifyPassword(body.current_password ?? "", existing))) {
        await audit("auth.password_failed", { userId: user.id, entityType: "user", entityId: String(user.id), outcome: "failure", ip, detail: { change: true } });
        throw new HttpError(400, "Your current password is not right.", "wrong_password");
      }
      const next = parseNewPassword(body.new_password, user.email);
      if (!next) throw new HttpError(422, "password: Enter a new password.", "weak_password");
      if (existing && (await verifyPassword(next, existing))) throw new HttpError(422, "password: Choose a password different from the current one.", "weak_password");
      await store.setPasswordHash(user.id, await hashPassword(next));
      const signedOut = await store.revokeOtherSessions(user.id, user.sessionId);
      await audit(existing ? "auth.password_changed" : "auth.password_set", { userId: user.id, entityType: "user", entityId: String(user.id), ip, detail: { signed_out: signedOut } });
      return sendJson(res, 200, { status: "success", signed_out: signedOut });
    }),
  );

  route(
    "GET",
    "/api/auth/me",
    h(async (req, res) => {
      const signup = { enabled: config.AUTH.signupEnabled, restricted: config.AUTH.signupAllowed.length > 0 };
      const test = config.testUser();
      if (test) return sendJson(res, 200, { status: "success", auth_enabled: true, user: publicUser(test), signup });
      await requireReady();
      const u = await store.sessionUser(readCookie(req));
      return sendJson(res, 200, { status: "success", auth_enabled: true, user: u ? publicUser(u) : null, signup });
    }),
  );

  // --- The signed-in user's profile: account, room counts, signed-in devices, sign-in settings.
  route(
    "GET",
    "/api/auth/profile",
    h(async (req, res) => {
      const { user } = await signedIn(req);
      const [info, sessions, room] = await Promise.all([store.userInfo(user.id), store.listSessions(user.id), runAs(user, () => roomStats()).catch(() => null)]);
      return sendJson(res, 200, {
        status: "success",
        user: { ...publicUser(user), ...info },
        room, // null when the people tables are not available
        sessions: sessions.map((s) => ({ id: s.id, device: deviceLabel(s.user_agent), signed_in_at: s.signed_in_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at, current: s.id === user.sessionId })),
        security: { method: info?.has_password ? "Email + password, or email + one-time code" : "Email + one-time code", code_delivery: config.AUTH.otpProvider === "console" ? "console" : "email", session_days: config.AUTH.sessionDays, code_minutes: Math.round(config.AUTH.otpTtlSeconds / 60) },
      });
    }),
  );

  // Change the account's name (the room greets them with it; the AI knows them by it in calls).
  route(
    "POST",
    "/api/auth/profile",
    jsonBody,
    h(async (req, res) => {
      const { user } = await signedIn(req, { write: true });
      const name = parseName(req.body?.name, { required: true });
      await store.setDisplayName(user.id, name);
      return sendJson(res, 200, { status: "success", user: publicUser({ ...user, name }) });
    }),
  );

  // Sign out another device (never the current one: that is "Sign out").
  route(
    "POST",
    "/api/auth/sessions/:session_id/revoke",
    h(async (req, res) => {
      const { user } = await signedIn(req, { write: true });
      const id = req.params.session_id;
      if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "Device not found.");
      if (Number(id) === user.sessionId) throw new HttpError(409, "This is the device you are using. Use Sign out instead.");
      if (!(await store.revokeUserSession(user.id, id))) throw new HttpError(404, "Device not found or already signed out.");
      logger.info(`Signed out a device: user ${user.id}`);
      return sendJson(res, 200, { status: "success" });
    }),
  );

  route(
    "POST",
    "/api/auth/sessions/revoke-others",
    h(async (req, res) => {
      const { user } = await signedIn(req, { write: true });
      const n = await store.revokeOtherSessions(user.id, user.sessionId);
      logger.info(`Signed out ${n} other device(s): user ${user.id}`);
      return sendJson(res, 200, { status: "success", signed_out: n });
    }),
  );

  route(
    "POST",
    "/api/auth/logout",
    h(async (req, res) => {
      if (getPool() && (await store.ready().catch(() => false))) {
        const user = await store.sessionUser(readCookie(req)).catch(() => null);
        await store.revokeSession(readCookie(req));
        if (user) await audit("auth.signout", { userId: user.id, entityType: "user", entityId: String(user.id), ip: clientAddress(req) });
      }
      setSessionCookie(res, "", 0);
      return sendJson(res, 200, { status: "success" });
    }),
  );
}

/**
 * The signed-in user for a profile route (these are under /api/auth/, which requireAuth lets through,
 * so they check the session themselves). `write` also applies the same origin rule as other APIs.
 */
async function signedIn(req, { write = false } = {}) {
  await requireReady();
  const origin = req.headers.origin;
  if (write && origin && !config.FRONTEND_ORIGINS.includes(origin)) throw new HttpError(403, "Request blocked: unknown origin.");
  const user = await store.sessionUser(readCookie(req));
  if (!user) throw new HttpError(401, "Please sign in.");
  return { user };
}

/** "Chrome on Windows", "Safari on iPhone"... from a User-Agent (only for display). */
export function deviceLabel(ua) {
  const s = String(ua ?? "");
  if (!s) return "Unknown device";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\/|CriOS\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /node|undici|curl|PostmanRuntime/i.test(s) ? "Script" : "Browser";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Protects every API: a valid session is required (except the account routes, /health and the API
 * docs), state-changing requests must come from an allowed origin, and the rest of the request runs as
 * the signed-in user (req.user, tenant.runAs).
 */
export function requireAuth(req, res, next) {
  if (req.method === "OPTIONS" || PUBLIC_PATHS.test(req.path)) return next();
  const origin = req.headers.origin;
  if (req.method !== "GET" && req.method !== "HEAD" && origin && !config.FRONTEND_ORIGINS.includes(origin)) {
    return sendJson(res, 403, { status: "error", message: "Request blocked: unknown origin." });
  }
  const test = config.testUser();
  if (test) {
    req.user = test;
    return runAs(test, next);
  }
  if (!getPool()) return sendJson(res, 503, { status: "error", message: "Accounts need the database (MySQL), which is not configured on this server." });
  store
    .sessionUser(readCookie(req))
    .then((user) => {
      if (!user) return sendJson(res, 401, { status: "error", message: "Please sign in." });
      req.user = user;
      return runAs(user, next);
    })
    .catch((e) => {
      logger.error("Session check failed", e);
      sendJson(res, 503, { status: "error", message: "Sign-in could not be checked right now. Please try again." });
    });
}
