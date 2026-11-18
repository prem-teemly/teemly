// MySQL connection pool (mysql2/promise), configured only through environment variables.
//
// The application connects as a least-privilege user (DB_USER: SELECT/INSERT/UPDATE/DELETE on the
// application database). Schema changes use a separate migration user (DB_MIGRATION_USER). Root
// credentials are never used by the application.
// The database is optional at runtime: when it is not configured or not reachable, the API keeps
// working from memory exactly as before and logs why persistence is off.

import mysql from "mysql2/promise";

import { getLogger } from "../util.js";

const logger = getLogger("app.db");

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();

export function dbSettings() {
  return {
    host: env("DB_HOST", "127.0.0.1"),
    port: parseInt(env("DB_PORT", "3306"), 10),
    database: env("DB_NAME", "teemly_db"),
    user: env("DB_USER"),
    password: process.env.DB_PASSWORD ?? "",
    migrationUser: env("DB_MIGRATION_USER"),
    migrationPassword: process.env.DB_MIGRATION_PASSWORD ?? "",
    connectionLimit: parseInt(env("DB_CONNECTION_LIMIT", "10"), 10),
    enabled: env("DB_ENABLED", "true").toLowerCase() !== "false",
  };
}

const BASE_OPTIONS = {
  charset: "utf8mb4_0900_ai_ci",
  timezone: "Z", // all DATETIME values are stored in UTC
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true, // DECIMAL columns come back as numbers
  multipleStatements: false, // one statement per query: no stacked-query injection
  connectTimeout: 5_000,
};

let pool = null;
let disabledReason = null;

/** True when DB settings are present and not switched off. */
export function isConfigured() {
  const s = dbSettings();
  if (!s.enabled) {
    disabledReason = "DB_ENABLED=false";
    return false;
  }
  if (!s.user) {
    disabledReason = "DB_USER is not set in backend/.env";
    return false;
  }
  return true;
}

/** The shared application pool, or null when the database is not configured. */
export function getPool() {
  if (pool) return pool;
  if (!isConfigured()) return null;
  const s = dbSettings();
  pool = mysql.createPool({
    ...BASE_OPTIONS,
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: s.database,
    connectionLimit: s.connectionLimit,
    waitForConnections: true,
    queueLimit: 100,
    enableKeepAlive: true,
  });
  pool.on("connection", (conn) => {
    // Strict SQL mode: invalid data is an error instead of being silently truncated.
    conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
  });
  return pool;
}

/** A single connection for migrations, as the migration user. */
export async function migrationConnection() {
  const s = dbSettings();
  const user = s.migrationUser || s.user;
  if (!user) throw new Error("DB_MIGRATION_USER (or DB_USER) is not set in backend/.env");
  return mysql.createConnection({
    ...BASE_OPTIONS,
    host: s.host,
    port: s.port,
    user,
    password: s.migrationUser ? s.migrationPassword : s.password,
    database: s.database,
  });
}

/** Run fn(connection) inside a transaction; rolls back on any error. */
export async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error(`Database is not configured (${disabledReason})`);
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (exc) {
    await conn.rollback().catch(() => {});
    throw exc;
  } finally {
    conn.release();
  }
}

/** Connection / schema status for GET /api/db/status. Never includes credentials. */
export async function status() {
  const s = dbSettings();
  const out = { enabled: isConfigured(), connected: false, host: s.host, port: s.port, database: s.database, user: s.user || null, server_version: null, migrations: [], error: null };
  if (!out.enabled) {
    out.error = disabledReason;
    return out;
  }
  try {
    const [[v]] = await getPool().query("SELECT VERSION() AS version");
    out.connected = true;
    out.server_version = v.version;
    const [rows] = await getPool().query("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").catch(() => [[]]);
    out.migrations = rows.map((r) => ({ version: r.version, name: r.name, applied_at: r.applied_at }));
  } catch (exc) {
    out.error = describeError(exc);
  }
  return out;
}

/** A safe, specific description of a database error (no credentials). */
export function describeError(exc) {
  const code = exc?.code ?? "";
  if (code === "ECONNREFUSED") return "MySQL is not reachable (connection refused). Is the MySQL80 service running?";
  if (code === "ER_ACCESS_DENIED_ERROR") return "MySQL rejected the user name or password (check DB_USER / DB_PASSWORD).";
  if (code === "ER_BAD_DB_ERROR") return "The database does not exist (check DB_NAME).";
  if (code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_TABLEACCESS_DENIED_ERROR") return `The database user lacks a required privilege (${code}).`;
  if (code === "ER_NO_SUCH_TABLE") return "Tables are missing: run `npm run db:migrate` in backend/.";
  return `${code || exc?.name || "Error"}: ${String(exc?.message ?? exc).slice(0, 200)}`;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export { logger as dbLogger };
