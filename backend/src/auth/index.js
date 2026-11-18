// Login API (email + one-time code) and the session check that protects every other API.
//
//   POST /api/auth/otp/request  { email }                 -> a code is emailed (if the email may sign in)
//   POST /api/auth/otp/verify   { challenge_id, code }    -> session cookie (httpOnly, SameSite=Lax)
//   GET  /api/auth/me                                     -> { auth_enabled, user }
//   POST /api/auth/logout                                 -> session revoked, cookie cleared
//   GET  /api/auth/profile                                -> account, room counts, devices, sign-in settings
//   POST /api/auth/sessions/:id/revoke                    -> sign out another device
//   POST /api/auth/sessions/revoke-others                 -> sign out every other device
//
// Login is ON only when OWNER_EMAIL is set; then only those emails can sign in and every /api/* call
// (except these and /health) needs a valid session. With OWNER_EMAIL unset, nothing changes.

import * as config from "../config.js";
import { clientAddress, jsonBody, parseBody, sendJson } from "../http.js";
import { clientHash } from "../db/repository.js";
import { roomStats } from "../db/people.js";
import { HttpError, getLogger } from "../util.js";
import { codeHash, codeMatches, newChallengeId, newCode, sendCode } from "./otp.js";
import { hashEmail, maskEmail, normalizeEmail } from "./email.js";
import * as store from "./store.js";

const logger = getLogger("app.auth");
const PER_CLIENT_PER_HOUR = 10;
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

const ownerHashes = () => new Set(config.AUTH.ownerEmails.map(normalizeEmail).filter(Boolean).map(hashEmail));
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
const publicUser = (u) => ({ name: u.name ?? u.display_name, initials: initials(u.name ?? u.display_name), email_masked: maskEmail(u.email), role: u.role });

async function requireReady() {
  if (!config.authEnabled()) throw new HttpError(409, "Login is not enabled on this server.");
  if (!(await store.ready().catch(() => false))) {
    throw new HttpError(503, "Login is not set up yet: the database needs migrations 003 and 019 (npm run db:migrate).");
  }
}

function tooMany(res, seconds, message) {
  res.setHeader("Retry-After", String(Math.max(1, seconds)));
  return sendJson(res, 429, { status: "error", message, retry_after: Math.max(1, seconds) });
}

/** Register the login routes with the app's route() helper (keeps 404/405 handling consistent). */
export function registerAuthRoutes(route) {
  route(
    "POST",
    "/api/auth/otp/request",
    jsonBody,
    h(async (req, res) => {
      await requireReady();
      const body = parseBody(req, { email: { type: "string", required: true, maxLength: 254 } });
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(422, "Enter a valid email address.");
      const emailHash = hashEmail(email);
      const client = clientHash(clientAddress(req));
      const { perEmail, perClient, sinceLast } = await store.recentRequests(emailHash, client);
      const { otpResendSeconds, otpMaxPerHour, otpTtlSeconds, otpProvider } = config.AUTH;
      if (perClient >= PER_CLIENT_PER_HOUR) return tooMany(res, 3600, "Too many code requests. Please try again later.");
      if (sinceLast !== null && sinceLast < otpResendSeconds) {
        return tooMany(res, otpResendSeconds - sinceLast, `Please wait ${otpResendSeconds - sinceLast} s before requesting a new code.`);
      }
      if (perEmail >= otpMaxPerHour) return tooMany(res, 3600, "Too many codes for this email. Please try again in an hour.");

      // Every valid email gets the same response, so the API never reveals which emails can sign in;
      // a code is only generated and sent for an owner email.
      const id = newChallengeId();
      const allowed = ownerHashes().has(emailHash);
      const code = newCode();
      await store.createChallenge({ id, emailHash, codeHash: codeHash(id, allowed ? code : newCode() + "x"), ttlSeconds: otpTtlSeconds, clientHash: client });
      if (allowed) {
        try {
          await sendCode(otpProvider, email, code, otpTtlSeconds);
        } catch (exc) {
          await store.cancelChallenge(id).catch(() => {});
          logger.error(`Sign-in code could not be emailed to ${maskEmail(email)} (${exc?.code ?? exc?.responseCode ?? exc?.message ?? "error"})`);
          throw new HttpError(502, "The code could not be emailed right now. Please try again in a minute.");
        }
      } else logger.info(`Code requested for an email that cannot sign in (${maskEmail(email)}); nothing sent`);
      return sendJson(res, 200, {
        status: "success",
        message: "If this email can open this room, a code has been sent.",
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
      });
      const code = body.code.trim();
      if (!/^[0-9a-f]{32}$/.test(body.challenge_id) || !/^\d{6}$/.test(code)) throw new HttpError(422, "Enter the 6-digit code.");
      const { status, row } = await store.useAttempt(body.challenge_id, config.AUTH.otpMaxAttempts);
      if (status === "missing" || status === "expired") throw new HttpError(400, "This code has expired. Please request a new one.");
      if (status === "locked") throw new HttpError(429, "Too many wrong codes. Please request a new one.");
      if (!codeMatches(body.challenge_id, code, row.code_hash) || !row.email_hash || !ownerHashes().has(row.email_hash)) {
        const left = config.AUTH.otpMaxAttempts - row.attempts;
        throw new HttpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Please request a new one.");
      }
      if (!(await store.consume(body.challenge_id))) throw new HttpError(400, "This code has already been used. Please request a new one.");

      const email = ownerEmailFor(row.email_hash);
      if (!email) throw new HttpError(400, "This code has expired. Please request a new one.");
      const user = await store.upsertOwner({ email, displayName: config.AUTH.ownerName });
      if (user.status !== "active") throw new HttpError(403, "This account is disabled.");
      const token = await store.createSession({ userId: user.id, days: config.AUTH.sessionDays, clientHash: clientHash(clientAddress(req)), userAgent: req.headers["user-agent"] });
      setSessionCookie(res, token, config.AUTH.sessionDays * 86400);
      logger.info(`Signed in: user ${user.id}`);
      return sendJson(res, 200, { status: "success", user: publicUser(user) });
    }),
  );

  route(
    "GET",
    "/api/auth/me",
    h(async (req, res) => {
      if (!config.authEnabled()) return sendJson(res, 200, { status: "success", auth_enabled: false, user: null });
      await requireReady();
      const u = await store.sessionUser(readCookie(req));
      return sendJson(res, 200, { status: "success", auth_enabled: true, user: u ? publicUser(u) : null });
    }),
  );

  // --- The signed-in owner's profile: account, room counts, signed-in devices, sign-in settings.
  route(
    "GET",
    "/api/auth/profile",
    h(async (req, res) => {
      const { user } = await signedIn(req);
      const [info, sessions, room] = await Promise.all([store.userInfo(user.id), store.listSessions(user.id), roomStats().catch(() => null)]);
      return sendJson(res, 200, {
        status: "success",
        user: { ...publicUser(user), ...info },
        room, // null when the people tables are not available
        sessions: sessions.map((s) => ({ id: s.id, device: deviceLabel(s.user_agent), signed_in_at: s.signed_in_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at, current: s.id === user.sessionId })),
        security: { method: "Email + one-time code", code_delivery: config.AUTH.otpProvider === "console" ? "console" : "email", session_days: config.AUTH.sessionDays, code_minutes: Math.round(config.AUTH.otpTtlSeconds / 60) },
      });
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
      if (config.authEnabled() && (await store.ready().catch(() => false))) await store.revokeSession(readCookie(req));
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

/** The owner email with this hash (the emails that may sign in are only in backend/.env). */
function ownerEmailFor(emailHash) {
  for (const e of config.AUTH.ownerEmails) {
    const email = normalizeEmail(e);
    if (email && hashEmail(email) === emailHash) return email;
  }
  return null;
}

/**
 * Protects every API when login is on: a valid session is required (except the login routes,
 * /health and the API docs), and state-changing requests must come from an allowed origin.
 */
export function requireAuth(req, res, next) {
  if (!config.authEnabled() || req.method === "OPTIONS" || PUBLIC_PATHS.test(req.path)) return next();
  const origin = req.headers.origin;
  if (req.method !== "GET" && req.method !== "HEAD" && origin && !config.FRONTEND_ORIGINS.includes(origin)) {
    return sendJson(res, 403, { status: "error", message: "Request blocked: unknown origin." });
  }
  store
    .sessionUser(readCookie(req))
    .then((user) => {
      if (!user) return sendJson(res, 401, { status: "error", message: "Please sign in." });
      req.user = user;
      return next();
    })
    .catch((e) => {
      logger.error("Session check failed", e);
      sendJson(res, 503, { status: "error", message: "Sign-in could not be checked right now. Please try again." });
    });
}
