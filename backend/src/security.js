// Security and data-protection measures for the API.
//
// - Security headers on every response (no MIME sniffing, no framing, no referrer leaks, strict CSP).
// - Rate limiting of the expensive endpoints (uploads, job starts, Gemini calls) per client address.
// - Retention (opt-in): uploads are deleted after UPLOAD_RETENTION_HOURS, if set; never while in use.
// Google credentials never leave the backend (ADC); responses and logs contain no secrets, and
// logs contain no conversation content.

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import * as config from "./config.js";
import { clientAddress, sendJson } from "./http.js";
import { getLogger } from "./util.js";
import { markFilesDeleted } from "./db/repository.js";
import { filesInUse } from "./services/pipeline.js";

const logger = getLogger("app.security");

// Swagger UI / ReDoc pages load their scripts and styles from jsDelivr, like before.
const DOCS_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data: https://cdn.redoc.ly; " +
  "connect-src 'self'; worker-src blob:; frame-ancestors 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store"); // results contain private conversation data
  res.setHeader("Content-Security-Policy", req.path === "/docs" || req.path === "/redoc" ? DOCS_CSP : API_CSP);
  next();
}

// Small edits the owner makes on a person's page or in the inbox (no upload, no AI): not limited, so
// writing notes or moving an opportunity never hits "Too many requests".
const LIGHT_EDITS =
  /^\/api\/(people|people\/[0-9a-f]{32}\/(notes|opportunities|phone|departments)|people\/[0-9a-f]{32}\/mentions\/[0-9a-f]{32}\/move|notes\/[0-9a-f]{32}|opportunities\/[0-9a-f]{32}|commitments\/\d+|inbox\/[0-9a-f]{32}\/(add|ignore)|department-ideas\/[0-9a-f]{32}\/(create|ignore)|departments(\/[0-9a-f]{32})?|notifications\/(read|unread|seen)|notification-settings)$/;

/**
 * Fixed-window rate limit per client address for POST requests (uploads, job starts, AI calls).
 * Status polling (GET) and small edits (LIGHT_EDITS) are not limited.
 */
export function rateLimit() {
  const windowMs = 60_000;
  const limit = config.RATE_LIMIT_PER_MINUTE;
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    if (req.method !== "POST" || limit <= 0 || LIGHT_EDITS.test(req.path)) return next();
    const key = clientAddress(req) ?? "unknown";
    const t = Date.now();
    let entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      entry = { start: t, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((entry.start + windowMs - t) / 1000)));
      return sendJson(res, 429, { status: "error", message: "Too many requests. Please wait a minute and try again." });
    }
    return next();
  };
}

/**
 * Delete uploaded recordings and chats older than UPLOAD_RETENTION_HOURS (0, the default, keeps
 * them forever). Files that a queued or processing job still reads are never deleted.
 */
export async function purgeOldUploads(hours = config.UPLOAD_RETENTION_HOURS, inUse = filesInUse(), dir = config.UPLOAD_DIR) {
  if (!(hours > 0)) return 0;
  const cutoff = Date.now() - hours * 3600_000;
  const removedNames = [];
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no uploads yet
  }
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.[a-z0-9]+$/.test(name)) continue; // only files created by the upload endpoints
    if (inUse.has(name)) continue; // a job is still reading it
    const file = path.join(dir, name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) {
        await unlink(file);
        removedNames.push(name);
      }
    } catch {
      /* in use or already gone */
    }
  }
  if (removedNames.length) {
    logger.info(`Retention: deleted ${removedNames.length} upload(s) older than ${hours} h`);
    await markFilesDeleted(removedNames); // database rows are kept, marked with deleted_at
  }
  return removedNames.length;
}

export function startRetention() {
  purgeOldUploads();
  setInterval(purgeOldUploads, 3600_000).unref();
}
