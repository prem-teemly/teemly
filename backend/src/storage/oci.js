// Oracle Cloud Infrastructure Object Storage, through the official OCI SDK (oci-objectstorage).
//
// Backend only: credentials come from environment variables (API key file path, an OCI config file,
// or the instance principal of an OCI compute instance) and never reach the frontend. The bucket is
// expected to be private; objects are never made public and no pre-authenticated URLs are created.
//
// Integrity: every upload sends Content-MD5 (OCI rejects corrupted bytes) and the SHA-256 as object
// metadata, then a HEAD request confirms size and checksum. Downloads are written to a temporary file,
// SHA-256-checked, and only then moved into place. Uploads use If-None-Match: * so a repeated request
// never overwrites an object; an identical existing object counts as success (idempotent).

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import * as common from "oci-common";
import * as objectstorage from "oci-objectstorage";

import * as config from "../config.js";
import { getLogger } from "../util.js";

const logger = getLogger("app.storage.oci");

/** Storage failed; the message is safe to log (no secrets, no local paths). */
export class StorageError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Which settings are missing for the chosen authentication mode (empty = complete). */
export function missingSettings(o = config.OCI) {
  const need = { namespace: "OCI_NAMESPACE", bucket: "OCI_BUCKET" };
  if (o.auth === "api_key") Object.assign(need, { tenancy: "OCI_TENANCY_OCID", user: "OCI_USER_OCID", fingerprint: "OCI_FINGERPRINT", privateKeyPath: "OCI_PRIVATE_KEY_PATH", region: "OCI_REGION" });
  if (o.auth === "instance_principal" && !o.endpoint) need.region = "OCI_REGION";
  const missing = Object.entries(need).filter(([k]) => !o[k]).map(([, v]) => v);
  if (!["api_key", "config_file", "instance_principal"].includes(o.auth)) missing.push("OCI_AUTH (api_key, config_file or instance_principal)");
  return missing;
}

export const isConfigured = () => missingSettings().length === 0;

let clientPromise = null;
let clientKey = null;

async function authProvider(o) {
  if (o.auth === "config_file") return new common.ConfigFileAuthenticationDetailsProvider(o.configFile || undefined, o.configProfile);
  if (o.auth === "instance_principal") return new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  let key;
  try {
    key = readFileSync(o.privateKeyPath, "utf8");
  } catch {
    throw new StorageError("The OCI private key file could not be read (check OCI_PRIVATE_KEY_PATH).");
  }
  return new common.SimpleAuthenticationDetailsProvider(o.tenancy, o.user, o.fingerprint, key, o.privateKeyPassphrase, common.Region.fromRegionId(o.region));
}

/** The Object Storage client (created once per configuration). */
export function getClient() {
  const o = config.OCI;
  const missing = missingSettings(o);
  if (missing.length) return Promise.reject(new StorageError(`OCI Object Storage is not configured: missing ${missing.join(", ")}.`));
  const key = JSON.stringify([o.auth, o.tenancy, o.user, o.fingerprint, o.privateKeyPath, o.configFile, o.configProfile, o.region, o.endpoint]);
  if (!clientPromise || clientKey !== key) {
    clientKey = key;
    clientPromise = (async () => {
      // Retries are done here (withRetry), so the SDK's own retries are off: one clear policy.
      const client = new objectstorage.ObjectStorageClient(
        { authenticationDetailsProvider: await authProvider(o) },
        { retryConfiguration: common.NoRetryConfigurationDetails },
      );
      if (o.endpoint) client.endpoint = o.endpoint;
      else if (o.region) client.regionId = o.region;
      return client;
    })();
    clientPromise.catch(() => (clientPromise = null));
  }
  return clientPromise;
}

/** Tests: forget the cached client (after changing config.OCI). */
export function resetClientForTests() {
  clientPromise = null;
  clientKey = null;
}

const statusOf = (e) => e?.statusCode ?? e?.status ?? null;
const isRetryable = (e) => {
  const s = statusOf(e);
  if (s === null || s === undefined) return !(e instanceof StorageError) || e.retryable; // network errors
  // InvalidDigest: the bytes were damaged in transit (OCI rejected them by Content-MD5) - send again.
  return s === 408 || s === 429 || s >= 500 || (s === 400 && e?.serviceCode === "InvalidDigest");
};

/** Run an OCI call with bounded retries (network errors, 408, 429, 5xx) and exponential backoff. */
export async function withRetry(what, fn) {
  const attempts = Math.max(1, config.OCI.maxAttempts);
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts || !isRetryable(e)) break;
      const wait = config.OCI.retryDelayMs * 2 ** (i - 1);
      logger.warning(`OCI ${what} failed (${statusOf(e) ?? e.code ?? e.name}); retry ${i}/${attempts - 1} in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw toStorageError(what, last);
}

function toStorageError(what, e) {
  if (e instanceof StorageError) return e;
  const status = statusOf(e);
  const code = e?.serviceCode ?? e?.code ?? null;
  const reason =
    status === 401 || status === 403 ? "access denied (check the OCI user/policy for this bucket)"
    : status === 404 ? "bucket or object not found"
    : status === 412 ? "an object with this name already exists"
    : status ? `HTTP ${status}${code ? ` ${code}` : ""}`
    : e?.message?.split("\n")[0] ?? "network error";
  return new StorageError(`OCI ${what} failed: ${reason}.`, { status, code, retryable: isRetryable(e) });
}

/** Object name for a stored upload: <prefix><yyyy>/<mm>/<stored name>; stored names are random and unique. */
export function objectNameFor(storedName, when = new Date()) {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, "0");
  return `${config.OCI.prefix}${y}/${m}/${storedName}`;
}

/** storage_path value for MySQL: oci://<namespace>/<bucket>/<object> (no secrets). */
export const storagePath = (objectName) => `oci://${config.OCI.namespace}/${config.OCI.bucket}/${objectName}`;

/** Parse an oci:// storage_path. */
export function parseStoragePath(p) {
  const m = /^oci:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(p ?? "");
  return m ? { namespace: m[1], bucket: m[2], objectName: m[3] } : null;
}

function fileDigests(file) {
  return new Promise((resolve, reject) => {
    const md5 = createHash("md5");
    const sha = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => (md5.update(c), sha.update(c)))
      .on("error", reject)
      .on("end", () => resolve({ md5: md5.digest("base64"), sha256: sha.digest("hex") }));
  });
}

/** Size and checksums of an object (null if it does not exist). */
export async function headObject(objectName, where = {}) {
  const client = await getClient();
  try {
    const r = await withRetry("head", () =>
      client.headObject({ namespaceName: where.namespace ?? config.OCI.namespace, bucketName: where.bucket ?? config.OCI.bucket, objectName }),
    );
    const meta = r.opcMeta ?? {};
    return { size: Number(r.contentLength), md5: r.contentMd5 ?? null, sha256: meta.sha256 ?? meta["sha256"] ?? null, eTag: r.eTag };
  } catch (e) {
    if (e instanceof StorageError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Upload a local file and verify it. Returns { objectName, path, size, sha256, eTag, existed }.
 * `existed` is true when an identical object was already there (a repeated request).
 */
export async function uploadFile(localPath, objectName, { sha256 = null, contentType = "application/octet-stream" } = {}) {
  const client = await getClient();
  const size = statSync(localPath).size;
  const digests = await fileDigests(localPath);
  if (sha256 && digests.sha256 !== sha256) {
    throw new StorageError("The local file does not match its recorded SHA-256; it was not uploaded.");
  }
  let existed = false;
  let eTag = null;
  try {
    const r = await withRetry("upload", () =>
      client.putObject({
        namespaceName: config.OCI.namespace,
        bucketName: config.OCI.bucket,
        objectName,
        putObjectBody: createReadStream(localPath), // a fresh stream per attempt
        contentLength: size,
        contentMD5: digests.md5, // OCI verifies the bytes it received
        contentType,
        ifNoneMatch: "*", // never overwrite an existing object
        opcMeta: { sha256: digests.sha256 },
      }),
    );
    eTag = r.eTag;
    if (r.opcContentMd5 && r.opcContentMd5 !== digests.md5) {
      throw new StorageError("OCI reported a different MD5 for the uploaded object.");
    }
  } catch (e) {
    if (!(e instanceof StorageError && e.status === 412)) throw e;
    existed = true; // checked below: identical object = success, different object = conflict
  }
  const head = await headObject(objectName);
  if (!head) throw new StorageError("The uploaded object could not be found afterwards.");
  if (head.size !== size || (head.sha256 && head.sha256 !== digests.sha256) || (head.md5 && head.md5 !== digests.md5)) {
    throw new StorageError(existed ? "A different object with this name already exists in the bucket." : "The uploaded object does not match the local file.");
  }
  return { objectName, path: storagePath(objectName), size, sha256: digests.sha256, eTag: eTag ?? head.eTag, existed };
}

/** Download an object to `dest`, verifying its SHA-256 before the file appears at `dest`. */
export async function downloadFile(objectName, dest, { sha256 = null, where = {} } = {}) {
  const client = await getClient();
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    await withRetry("download", async () => {
      const r = await client.getObject({ namespaceName: where.namespace ?? config.OCI.namespace, bucketName: where.bucket ?? config.OCI.bucket, objectName });
      const body = r.value;
      const readable = typeof body?.pipe === "function" ? body : (await import("node:stream")).Readable.fromWeb(body);
      await pipeline(readable, createWriteStream(tmp));
    });
    const { sha256: got } = await fileDigests(tmp);
    const expected = sha256 ?? (await headObject(objectName, where))?.sha256 ?? null;
    if (expected && got !== expected) throw new StorageError("The downloaded audio does not match its recorded SHA-256.");
    await rename(tmp, dest);
    return { sha256: got, size: statSync(dest).size };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e instanceof StorageError ? e : toStorageError("download", e);
  }
}

/** Delete an object (used only by tests and explicit maintenance; never automatically). */
export async function deleteObject(objectName) {
  const client = await getClient();
  await withRetry("delete", () => client.deleteObject({ namespaceName: config.OCI.namespace, bucketName: config.OCI.bucket, objectName }));
}

/** Connectivity check: namespace and bucket are reachable with these credentials. */
export async function checkConnection() {
  const client = await getClient();
  const ns = await withRetry("get namespace", () => client.getNamespace({}));
  const b = await withRetry("get bucket", () => client.getBucket({ namespaceName: config.OCI.namespace, bucketName: config.OCI.bucket }));
  return {
    namespace_matches: ns.value === config.OCI.namespace,
    bucket: b.bucket?.name ?? config.OCI.bucket,
    public_access: b.bucket?.publicAccessType ?? null,
    private: !b.bucket?.publicAccessType || b.bucket.publicAccessType === "NoPublicAccess",
  };
}
