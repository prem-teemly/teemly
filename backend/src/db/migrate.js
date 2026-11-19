// Version-controlled schema migrations: backend/db/migrations/NNN_name.sql, applied in order.
//
// Applied migrations are recorded in schema_migrations with a SHA-256 checksum; a migration file that
// changed after being applied is reported instead of re-run. Before the first migration, the runner
// checks that none of its tables already exist in the database, so existing data is never touched.
//
//   npm run db:migrate            apply pending migrations
//   npm run db:migrate -- --status show applied / pending migrations

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../config.js"; // loads backend/.env
import { dbSettings, describeError, migrationConnection } from "./pool.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(path.join(dir, file), "utf8");
      const sha = (s) => createHash("sha256").update(s).digest("hex");
      // Git may check a file out with LF or CRLF line endings (Windows vs Linux): the same migration is
      // the same migration either way, so a checksum recorded with either ending matches.
      const lf = sql.replace(/\r\n/g, "\n");
      const variants = new Set([sha(sql), sha(lf), sha(lf.replace(/\n/g, "\r\n"))]);
      return { version: parseInt(file.slice(0, 3), 10), name: file, sql, checksum: sha(sql), checksums: variants };
    });
}

/** Split a migration file into statements (comments removed; no procedures in these files). */
export function splitStatements(sql) {
  const noComments = sql
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n");
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const createdTables = (sql) => [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1]);

export async function migrate({ statusOnly = false, log = console.log } = {}) {
  const conn = await migrationConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INT UNSIGNED NOT NULL,
      name        VARCHAR(255) NOT NULL,
      checksum    CHAR(64)     NOT NULL,
      applied_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [appliedRows] = await conn.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    const applied = new Map(appliedRows.map((r) => [r.version, r]));
    const migrations = listMigrations();

    for (const m of migrations) {
      const done = applied.get(m.version);
      if (done && !m.checksums.has(done.checksum)) {
        throw new Error(`${m.name} was changed after it was applied (checksum mismatch). Add a new migration instead of editing it.`);
      }
    }
    const pending = migrations.filter((m) => !applied.has(m.version));
    log(`Database ${dbSettings().database}: ${applied.size} applied, ${pending.length} pending`);
    for (const m of migrations) log(`  ${applied.has(m.version) ? "applied " : "pending "} ${m.name}`);
    if (statusOnly || !pending.length) return { applied: [...applied.keys()], pending: pending.map((m) => m.name) };

    const [existing] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    const existingNames = new Set(existing.map((r) => r.t.toLowerCase()));

    for (const m of pending) {
      const clash = createdTables(m.sql).filter((t) => existingNames.has(t.toLowerCase()));
      if (clash.length) {
        throw new Error(`${m.name} would create tables that already exist (${clash.join(", ")}). Nothing was changed; resolve this manually so existing data is not touched.`);
      }
      const statements = splitStatements(m.sql);
      log(`Applying ${m.name} (${statements.length} statements)...`);
      for (const [i, stmt] of statements.entries()) {
        try {
          await conn.query(stmt);
        } catch (exc) {
          throw new Error(`${m.name}, statement ${i + 1}: ${describeError(exc)}`);
        }
      }
      await conn.execute("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)", [m.version, m.name, m.checksum]);
      createdTables(m.sql).forEach((t) => existingNames.add(t.toLowerCase()));
      log(`Applied ${m.name}`);
    }
    return { applied: migrations.map((m) => m.version), pending: [] };
  } finally {
    await conn.end();
  }
}

// CLI: node src/db/migrate.js [--status]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate({ statusOnly: process.argv.includes("--status") })
    .then(() => process.exit(0))
    .catch((exc) => {
      console.error(`Migration failed: ${exc.code ? describeError(exc) : exc.message}`);
      process.exit(1);
    });
}
