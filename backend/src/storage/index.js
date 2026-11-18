// Audio storage: which provider holds the original recording, and getting a working copy for the AI.
//
// STORAGE_PROVIDER=local (default): originals stay in backend/uploads, exactly as before.
// STORAGE_PROVIDER=oci: after the upload is saved and verified locally, the original is uploaded to
// OCI Object Storage and verified there before its metadata is written to MySQL. The local file is
// kept as a working copy; if it is missing later, it is downloaded again (checksum-verified) before
// processing. If OCI is unavailable, the upload is kept locally (never lost) and recorded as "local",
// so the migration utility can move it later.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import * as config from "../config.js";
import { getLogger } from "../util.js";
import * as oci from "./oci.js";

const logger = getLogger("app.storage");

export const provider = () => (config.STORAGE.provider === "oci" ? "oci" : "local");

/** Startup line: which storage is active, and whether OCI is configured (no secrets). */
export function describe() {
  if (provider() === "local") return "Audio storage: local (backend/uploads)";
  const missing = oci.missingSettings();
  return missing.length
    ? `Audio storage: OCI requested but not configured (missing ${missing.join(", ")}); using local storage`
    : `Audio storage: OCI Object Storage (bucket ${config.OCI.bucket}, auth ${config.OCI.auth}) + local working copy`;
}

/**
 * Store a verified upload. Returns { provider, path } for MySQL: OCI when it was uploaded and
 * verified there, otherwise local (the file is never lost because of a cloud problem).
 */
export async function storeUpload(localPath, storedName, { sha256, contentType }) {
  const local = { provider: "local", path: `uploads/${storedName}`, error: null };
  if (provider() !== "oci") return local;
  if (!oci.isConfigured()) return { ...local, error: "OCI is not configured" };
  try {
    const r = await oci.uploadFile(localPath, oci.objectNameFor(storedName), { sha256, contentType });
    return { provider: "oci", path: r.path, error: null };
  } catch (e) {
    logger.warning(`OCI upload failed for ${storedName}; kept in local storage: ${e.message}`);
    return { ...local, error: e.message };
  }
}

/**
 * Make sure the audio is available locally for processing. `record` is the MySQL storage info
 * ({ storage_provider, storage_path, sha256 }) or null. Returns the local path, or null if the file
 * exists nowhere. Downloads from OCI are SHA-256-verified before use.
 */
export async function ensureLocal(storedName, record) {
  const local = path.join(config.UPLOAD_DIR, storedName);
  if (existsSync(local)) return local;
  if (record?.storage_provider !== "oci") return null;
  const where = oci.parseStoragePath(record.storage_path);
  if (!where) return null;
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  await oci.downloadFile(where.objectName, local, { sha256: record.sha256 ?? null, where });
  logger.info(`Downloaded ${storedName} from OCI for processing`);
  return local;
}
