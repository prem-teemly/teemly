// Login persistence in MySQL (migration 003). All statements are parameterized. Times are computed by
// MySQL itself (NOW(3) + INTERVAL), so expiry checks never depend on time-zone settings.

import { createHash, randomBytes } from "node:crypto";

import { getPool, withTransaction } from "../db/pool.js";

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

/** The login tables exist with email sign-in (migrations 003 and 019 applied). */
export async function ready() {
  const db = getPool();
  if (!db) return false;
  const [[r]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users','otp_challenges','sessions')) AS tables,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email') AS email`,
  );
  return Number(r.tables) === 3 && Number(r.email) === 1;
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

/**
 * The owner's user row for a sign-in email; the display name follows OWNER_NAME. The first email
 * sign-in takes over the owner account that signed in by phone before (same account: its devices and
 * history continue); otherwise the account is created.
 */
export async function upsertOwner({ email, displayName }) {
  return withTransaction(async (conn) => {
    const [[byEmail]] = await conn.execute("SELECT id FROM users WHERE email = ? FOR UPDATE", [email]);
    let id = byEmail?.id ?? null;
    if (!id) {
      const [[earlier]] = await conn.execute("SELECT id FROM users WHERE email IS NULL AND role = 'owner' ORDER BY id LIMIT 1 FOR UPDATE");
      if (earlier) {
        id = earlier.id;
        await conn.execute("UPDATE users SET email = ? WHERE id = ?", [email, id]);
      } else {
        const [r] = await conn.execute("INSERT INTO users (email, display_name, role) VALUES (?, ?, 'owner')", [email, displayName]);
        id = r.insertId;
      }
    }
    await conn.execute("UPDATE users SET display_name = ?, last_login_at = NOW(3) WHERE id = ?", [displayName, id]);
    const [[u]] = await conn.execute("SELECT id, email, display_name, role, status FROM users WHERE id = ?", [id]);
    return u;
  });
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
  const [[u]] = await getPool().execute("SELECT UNIX_TIMESTAMP(created_at) AS created, UNIX_TIMESTAMP(last_login_at) AS last_login FROM users WHERE id = ?", [userId]);
  return u ? { member_since: isoOf(u.created), last_login_at: isoOf(u.last_login) } : null;
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
