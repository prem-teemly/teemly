// Accounts and sign-in persistence in MySQL (migrations 003, 019, 023). All statements are
// parameterized. Times are computed by MySQL itself (NOW(3) + INTERVAL), so expiry checks never depend
// on time-zone settings.

import { createHash, randomBytes } from "node:crypto";

import { getPool, withTransaction } from "../db/pool.js";
import { seedDepartments } from "../db/departments.js";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Housekeeping: sign-in codes older than a day (only the last hour is needed for limits) and sessions
 * that ended more than 30 days ago (expired or signed out). Returns how many rows were removed.
 */
export async function purgeOld() {
  const db = getPool();
  if (!db) return 0;
  const [a] = await db.execute("DELETE FROM otp_challenges WHERE created_at < NOW(3) - INTERVAL 1 DAY");
  const [b] = await db.execute("DELETE FROM sessions WHERE expires_at < NOW(3) - INTERVAL 30 DAY OR (revoked_at IS NOT NULL AND revoked_at < NOW(3) - INTERVAL 30 DAY)");
  return a.affectedRows + b.affectedRows;
}

/** Accounts are set up: login tables with email sign-in, rooms per user and passwords (migrations 003, 019, 023, 024). */
let readyOnce = false;
export async function ready() {
  if (readyOnce) return true;
  const db = getPool();
  if (!db) return false;
  const [[r]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users','otp_challenges','sessions')) AS tables,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email') AS email,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'people' AND COLUMN_NAME = 'user_id') AS rooms,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash') AS passwords`,
  );
  readyOnce = Number(r.tables) === 3 && Number(r.email) === 1 && Number(r.rooms) === 1 && Number(r.passwords) === 1;
  return readyOnce;
}

/** Code requests for an email (and from a client) in the last hour, and seconds since the latest. */
export async function recentRequests(emailHash, clientHash) {
  const [[r]] = await getPool().execute(
    `SELECT
       (SELECT COUNT(*) FROM otp_challenges WHERE email_hash = ? AND created_at > NOW(3) - INTERVAL 1 HOUR) AS per_email,
       (SELECT COUNT(*) FROM otp_challenges WHERE client_hash <=> ? AND created_at > NOW(3) - INTERVAL 1 HOUR) AS per_client,
       (SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), NOW(3)) FROM otp_challenges WHERE email_hash = ?) AS since_last`,
    [emailHash, clientHash, emailHash],
  );
  return { perEmail: Number(r.per_email), perClient: Number(r.per_client), sinceLast: r.since_last === null ? null : Number(r.since_last) };
}

/** Create a challenge; any earlier open challenge for the same email stops working. */
export function createChallenge({ id, emailHash, codeHash, ttlSeconds, clientHash }) {
  return withTransaction(async (conn) => {
    await conn.execute("UPDATE otp_challenges SET consumed_at = NOW(3) WHERE email_hash = ? AND consumed_at IS NULL", [emailHash]);
    await conn.execute(
      "INSERT INTO otp_challenges (id, email_hash, code_hash, expires_at, client_hash) VALUES (?, ?, ?, NOW(3) + INTERVAL ? SECOND, ?)",
      [id, emailHash, codeHash, ttlSeconds, clientHash],
    );
  });
}

/** A challenge that was never sent (the email could not be delivered): it stops working at once. */
export async function cancelChallenge(id) {
  await getPool().execute("UPDATE otp_challenges SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL", [id]);
}

/**
 * Atomically count one verification attempt and return the challenge state:
 * { status: "ok" | "expired" | "locked" | "missing", row }.
 */
export function useAttempt(id, maxAttempts) {
  return withTransaction(async (conn) => {
    const [[row]] = await conn.execute(
      "SELECT id, email_hash, code_hash, attempts, consumed_at, expires_at <= NOW(3) AS expired FROM otp_challenges WHERE id = ? FOR UPDATE",
      [id],
    );
    if (!row || row.consumed_at) return { status: "missing", row: null };
    if (row.expired) return { status: "expired", row: null };
    if (row.attempts >= maxAttempts) {
      await conn.execute("UPDATE otp_challenges SET consumed_at = NOW(3) WHERE id = ?", [id]);
      return { status: "locked", row: null };
    }
    await conn.execute("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?", [id]);
    return { status: "ok", row: { ...row, attempts: row.attempts + 1 } };
  });
}

export async function consume(id) {
  const [r] = await getPool().execute("UPDATE otp_challenges SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL", [id]);
  return r.affectedRows === 1; // false if a parallel request already used it
}

// ----------------------------------------------------------------------------- accounts

const USER_COLS = "id, email, display_name, role, status";

/** The account for a (normalised) email, or null. */
export async function userByEmail(email) {
  const [[u]] = await getPool().execute(`SELECT ${USER_COLS} FROM users WHERE email = ?`, [email]);
  return u ?? null;
}

/**
 * Everything a room needs to start (inside the caller's transaction; safe to run again): its built-in
 * departments (only when it has none), and the "installed" row from which its bell announces things.
 */
async function prepareRoom(conn, userId) {
  const [[{ n }]] = await conn.execute("SELECT COUNT(*) AS n FROM departments WHERE user_id = ?", [userId]);
  if (!Number(n)) await seedDepartments(conn, userId);
  await conn.execute(
    `INSERT IGNORE INTO notifications (user_id, kind, title, body, link, dedupe_key, read_at, created_at, updated_at)
     VALUES (?, 'system', 'Notifications are on', NULL, NULL, 'installed', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [userId],
  );
}

/**
 * Create an account and its empty room, in one transaction. If the email was registered meanwhile
 * (two sign-ups at once), that account is returned instead.
 */
export async function createAccount({ email, name, passwordHash = null }) {
  try {
    return await withTransaction(async (conn) => {
      const [r] = await conn.execute(
        "INSERT INTO users (email, password_hash, password_set_at, display_name, role, status, last_login_at) VALUES (?, ?, IF(? IS NULL, NULL, NOW(3)), ?, 'owner', 'active', NOW(3))",
        [email, passwordHash, passwordHash, name],
      );
      await prepareRoom(conn, r.insertId);
      const [[u]] = await conn.execute(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [r.insertId]);
      return u;
    });
  } catch (exc) {
    if (exc?.code === "ER_DUP_ENTRY") return userByEmail(email);
    throw exc;
  }
}

/**
 * The room that existed before accounts (migration 023 kept it on an account without an email): the
 * owner's email takes it over on their first sign-in. Returns the account, or null when there is none.
 */
export async function claimLegacyAccount({ email, name }) {
  return withTransaction(async (conn) => {
    const [[legacy]] = await conn.execute("SELECT id FROM users WHERE email IS NULL AND role = 'owner' ORDER BY id LIMIT 1 FOR UPDATE");
    if (!legacy) return null;
    await conn.execute("UPDATE users SET email = ?, display_name = COALESCE(?, display_name), last_login_at = NOW(3) WHERE id = ?", [email, name, legacy.id]);
    await prepareRoom(conn, legacy.id);
    const [[u]] = await conn.execute(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [legacy.id]);
    return u;
  });
}

/** Record a sign-in (and, when given, a new display name). Clears wrong-password counts and any lock. */
export async function markSignedIn(userId, { name = null } = {}) {
  await getPool().execute("UPDATE users SET display_name = COALESCE(?, display_name), last_login_at = NOW(3), failed_logins = 0, locked_until = NULL WHERE id = ?", [name, userId]);
}

// ---------------------------------------------------------------------------- passwords

/**
 * What a password sign-in needs for an email: the account, its password hash, and whether password
 * sign-in is locked (and for how many seconds). Null when there is no account.
 */
export async function credentialsByEmail(email) {
  const [[u]] = await getPool().execute(
    `SELECT ${USER_COLS}, password_hash, locked_until > NOW(3) AS locked, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(3), locked_until)) AS locked_for
       FROM users WHERE email = ?`,
    [email],
  );
  return u ? { ...u, locked: Boolean(u.locked), locked_for: Number(u.locked_for ?? 0) } : null;
}

/**
 * One more wrong password. The `maxFails`-th in a row locks password sign-in for `lockMinutes` (and
 * starts the count again). Returns true when this one locked it.
 */
export async function recordFailedLogin(userId, { maxFails = 5, lockMinutes = 15 } = {}) {
  // MySQL applies SET left to right: locked_until is decided from the count before this attempt.
  await getPool().execute(
    `UPDATE users SET locked_until = IF(failed_logins + 1 >= ?, NOW(3) + INTERVAL ? MINUTE, locked_until),
                      failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
      WHERE id = ?`,
    [maxFails, lockMinutes, maxFails, userId],
  );
  const [[u]] = await getPool().execute("SELECT locked_until > NOW(3) AS locked FROM users WHERE id = ?", [userId]);
  return Boolean(u?.locked);
}

/** Wrong passwords from one client (keyed address hash) in the last `minutes` (from the audit log). */
export async function recentPasswordFailures(clientHash, minutes = 15) {
  if (!clientHash) return 0;
  const [[r]] = await getPool().execute(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE event = 'auth.password_failed' AND client_hash = ? AND created_at > NOW(3) - INTERVAL ? MINUTE",
    [clientHash, minutes],
  );
  return Number(r.n);
}

/** The account's password hash (to check the current password before a change), or null. */
export async function passwordHashOf(userId) {
  const [[u]] = await getPool().execute("SELECT password_hash FROM users WHERE id = ?", [userId]);
  return u?.password_hash ?? null;
}

/** Set or change the password (a hash from password.js); clears wrong-password counts and any lock. */
export async function setPasswordHash(userId, hash) {
  await getPool().execute("UPDATE users SET password_hash = ?, password_set_at = NOW(3), failed_logins = 0, locked_until = NULL WHERE id = ?", [hash, userId]);
}

/** Store a stronger hash of the same password (cost raised since it was set); the set date stays. */
export async function upgradePasswordHash(userId, hash) {
  await getPool().execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
}

/** Change an account's display name (shown in the room and used by the AI as "the owner"). */
export async function setDisplayName(userId, name) {
  await getPool().execute("UPDATE users SET display_name = ? WHERE id = ?", [name, userId]);
}

/** New session: returns the raw token (for the cookie); only its hash is stored. */
export async function createSession({ userId, days, clientHash, userAgent }) {
  const token = randomBytes(32).toString("base64url");
  await getPool().execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, client_hash, user_agent) VALUES (?, ?, NOW(3) + INTERVAL ? DAY, NOW(3), ?, ?)",
    [sha256(token), userId, days, clientHash, userAgent ? userAgent.slice(0, 255) : null],
  );
  return token;
}

/** The signed-in user for a session token, or null (expired, revoked, disabled user). */
export async function sessionUser(token) {
  if (!token || typeof token !== "string" || token.length > 100) return null;
  const db = getPool();
  const [[s]] = await db.execute(
    `SELECT s.id AS session_id, TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW(3)) AS idle, u.id, u.display_name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW(3) AND u.status = 'active'`,
    [sha256(token)],
  );
  if (!s) return null;
  if (Number(s.idle) > 300) await db.execute("UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ?", [s.session_id]);
  return { id: s.id, sessionId: Number(s.session_id), name: s.display_name, email: s.email, role: s.role };
}

export async function revokeSession(token) {
  if (!token) return;
  await getPool().execute("UPDATE sessions SET revoked_at = NOW(3) WHERE token_hash = ? AND revoked_at IS NULL", [sha256(token)]);
}

// ----------------------------------------------------------------------------- profile
// Times are read with UNIX_TIMESTAMP (NOW(3) is written in the session time zone) and sent as ISO.
const isoOf = (epoch) => (epoch === null || epoch === undefined ? null : new Date(Math.round(Number(epoch) * 1000)).toISOString());

/** When the user was first created and last signed in. */
export async function userInfo(userId) {
  const [[u]] = await getPool().execute(
    "SELECT UNIX_TIMESTAMP(created_at) AS created, UNIX_TIMESTAMP(last_login_at) AS last_login, password_hash IS NOT NULL AS has_password, UNIX_TIMESTAMP(password_set_at) AS password_set FROM users WHERE id = ?",
    [userId],
  );
  return u ? { member_since: isoOf(u.created), last_login_at: isoOf(u.last_login), has_password: Boolean(u.has_password), password_set_at: isoOf(u.password_set) } : null;
}

/** The user's signed-in devices (sessions not expired or revoked), most recently active first. */
export async function listSessions(userId) {
  const [rows] = await getPool().execute(
    `SELECT id, user_agent, UNIX_TIMESTAMP(created_at) AS created, UNIX_TIMESTAMP(last_seen_at) AS seen, UNIX_TIMESTAMP(expires_at) AS expires
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW(3)
      ORDER BY last_seen_at DESC, id DESC LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({ id: Number(r.id), user_agent: r.user_agent, signed_in_at: isoOf(r.created), last_seen_at: isoOf(r.seen), expires_at: isoOf(r.expires) }));
}

/** Sign out one of the user's own sessions. Returns false if it is not theirs or already ended. */
export async function revokeUserSession(userId, sessionId) {
  const [r] = await getPool().execute("UPDATE sessions SET revoked_at = NOW(3) WHERE id = ? AND user_id = ? AND revoked_at IS NULL", [sessionId, userId]);
  return r.affectedRows > 0;
}

/** Sign out every other session of the user (keeps `keepSessionId`). Returns how many. */
export async function revokeOtherSessions(userId, keepSessionId) {
  const [r] = await getPool().execute("UPDATE sessions SET revoked_at = NOW(3) WHERE user_id = ? AND id <> ? AND revoked_at IS NULL AND expires_at > NOW(3)", [userId, keepSessionId]);
  return r.affectedRows;
}
