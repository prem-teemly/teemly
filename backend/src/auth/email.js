// Sign-in emails: normalise, hash for lookups, mask for display.

import { createHmac } from "node:crypto";

/** " Owner.Name@Gmail.com " -> "owner.name@gmail.com"; null if it is not a plausible email address. */
export function normalizeEmail(input) {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  // One @, a local part, a domain with a dot; no spaces, quotes or angle brackets.
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) return null;
  if (e.includes("..") || e.startsWith(".") || e.split("@")[0].endsWith(".")) return null;
  return e;
}

/**
 * Keyed hash of a normalised email (AUDIT_HASH_KEY), for challenge lookups and rate limits, so the
 * code table never holds the address itself.
 */
export function hashEmail(email) {
  const key = process.env.AUDIT_HASH_KEY;
  if (!key) throw new Error("AUDIT_HASH_KEY is not set (needed to protect sign-in emails).");
  return createHmac("sha256", key).update(`email:${email}`).digest("hex");
}

/** "ownername.sample@gmail.com" -> "own•••••••••••••@gmail.com" (first 3 letters and the domain). */
export function maskEmail(email) {
  const [local, domain] = String(email ?? "").split("@");
  if (!local || !domain) return "•••";
  const keep = local.slice(0, Math.min(3, Math.max(1, local.length - 2)));
  return `${keep}${"•".repeat(Math.max(3, local.length - keep.length))}@${domain}`;
}
