// Move existing local audio originals to OCI Object Storage, safely.
//
// - Dry run (--dry-run): reports what would happen; nothing is uploaded or changed.
// - Batches (--batch, default 20) and an optional --limit on the number of files.
// - Every file's SHA-256 is checked against MySQL before upload; the upload is verified in OCI
//   (MD5 + SHA-256 + size), and only then is MySQL updated (storage_provider/storage_path).
// - Resume: files already moved are skipped (MySQL says "oci"); a file uploaded by an interrupted
//   run is recognised in OCI (identical object) and simply recorded. Uploads retry on temporary errors.
// - Local files are NEVER deleted. A JSON report is written to backend/storage-reports/.
// - Refuses to run against any database other than teemly_db_test unless --confirm-production is given.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as config from "../config.js";
import { getPool } from "../db/pool.js";
import * as repo from "../db/repository.js";
import * as oci from "./oci.js";

const MIME = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", flac: "audio/flac", aac: "audio/aac", amr: "audio/amr", "3gp": "audio/3gpp", ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm" };

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });

/** Only teemly_db_test may be migrated without explicit approval (--confirm-production). */
export function assertMigrationAllowed(database, allowProduction) {
  if (database !== "teemly_db_test" && !allowProduction) {
    throw new Error(`Refusing to migrate audio for database '${database}'. This needs explicit approval: re-run with --confirm-production.`);
  }
}

/**
 * Run the migration. Returns the report object (also written to disk unless writeReport is false).
 */
export async function migrateLocalToOci({ dryRun = false, batchSize = 20, limit = Infinity, allowProduction = false, writeReport = true, log = console.log } = {}) {
  const db = getPool();
  if (!db) throw new Error("MySQL is not configured (DB_* settings).");
  const [[{ name: database }]] = await db.query("SELECT DATABASE() AS name");
  assertMigrationAllowed(database, allowProduction);
  if (!dryRun && !oci.isConfigured()) throw new Error(`OCI is not configured: missing ${oci.missingSettings().join(", ")}.`);

  const started = new Date();
  const report = {
    started_at: started.toISOString(),
    finished_at: null,
    database,
    dry_run: dryRun,
    bucket: config.OCI.bucket || null,
    totals: { checked: 0, migrated: 0, already_in_oci: 0, would_migrate: 0, missing_local: 0, checksum_mismatch: 0, failed: 0 },
    files: [],
  };
  const add = (row, status, detail = null, objectName = null) => {
    report.totals[status] += 1;
    report.files.push({ id: row.id, stored_name: row.stored_name, status, object: objectName, detail });
    log(`${status.padEnd(18)} #${row.id} ${row.stored_name}${detail ? ` — ${detail}` : ""}`);
  };

  let afterId = 0;
  while (report.totals.checked < limit) {
    const rows = await repo.localAudioBatch({ afterId, limit: Math.min(batchSize, limit - report.totals.checked) });
    if (!rows.length) break;
    for (const row of rows) {
      afterId = row.id;
      report.totals.checked += 1;
      const local = path.join(config.UPLOAD_DIR, row.stored_name);
      const objectName = oci.objectNameFor(row.stored_name, row.created_epoch ? new Date(Number(row.created_epoch) * 1000) : new Date());
      if (!existsSync(local)) {
        add(row, "missing_local", "local file not found; nothing to upload");
        continue;
      }
      if ((await sha256File(local)) !== row.sha256) {
        add(row, "checksum_mismatch", "local file differs from the SHA-256 recorded at upload; not uploaded");
        continue;
      }
      if (dryRun) {
        const existing = oci.isConfigured() ? await oci.headObject(objectName).catch(() => null) : null;
        add(row, "would_migrate", existing ? "an object already exists (would be verified and recorded)" : null, objectName);
        continue;
      }
      try {
        const up = await oci.uploadFile(local, objectName, { sha256: row.sha256, contentType: MIME[row.file_format] ?? "application/octet-stream" });
        const recorded = await repo.setStorage(row.id, { provider: "oci", path: up.path, expectedSha: row.sha256 });
        if (!recorded) {
          add(row, "failed", "uploaded and verified, but MySQL was not updated (row changed meanwhile); safe to re-run", objectName);
        } else add(row, up.existed ? "already_in_oci" : "migrated", up.existed ? "identical object found from an earlier run; recorded" : null, objectName);
      } catch (e) {
        add(row, "failed", e.message, objectName);
      }
    }
  }
  report.finished_at = new Date().toISOString();
  if (writeReport) {
    const dir = path.join(config.BACKEND_DIR, "storage-reports");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `oci-migration-${started.toISOString().replace(/[:.]/g, "-")}${dryRun ? "-dry-run" : ""}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    report.report_file = path.relative(config.BACKEND_DIR, file);
  }
  return report;
}
