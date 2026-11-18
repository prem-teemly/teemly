// OCI Object Storage commands (run from backend/):
//   npm run storage:check                      connectivity: namespace, bucket, private access
//   npm run storage:migrate -- --dry-run       what would move to OCI (nothing changes)
//   npm run storage:migrate -- --batch 20 [--limit 100] [--confirm-production]
// Secrets are never printed.

import { closePool } from "../db/pool.js";
import { migrateLocalToOci } from "./migrate-audio.js";
import * as oci from "./oci.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isFinite(v) || v < 1) throw new Error(`${name} must be a positive number`);
  return v;
};

async function main() {
  const command = args[0];
  if (command === "check") {
    const missing = oci.missingSettings();
    if (missing.length) throw new Error(`OCI is not configured: missing ${missing.join(", ")}.`);
    const r = await oci.checkConnection();
    console.log(`Namespace matches: ${r.namespace_matches}`);
    console.log(`Bucket: ${r.bucket} · public access: ${r.public_access ?? "NoPublicAccess"} · private: ${r.private}`);
    if (!r.private) console.log("WARNING: the bucket allows public access. Teemly expects a private bucket.");
    return r.namespace_matches && r.private ? 0 : 1;
  }
  if (command === "migrate") {
    const report = await migrateLocalToOci({
      dryRun: flag("--dry-run"),
      batchSize: value("--batch", 20),
      limit: args.includes("--limit") ? value("--limit") : Infinity,
      allowProduction: flag("--confirm-production"),
    });
    console.log(`\nDatabase ${report.database}${report.dry_run ? " (dry run)" : ""}: ${JSON.stringify(report.totals)}`);
    console.log(`Report: ${report.report_file}`);
    return report.totals.failed ? 1 : 0;
  }
  console.log("Usage: node src/storage/cli.js check | migrate [--dry-run] [--batch N] [--limit N] [--confirm-production]");
  return 2;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));

