// Indian mobile numbers: normalise to E.164 (+91XXXXXXXXXX), hash for storage, mask for display.

import { createHmac } from "node:crypto";

/** "+91 98765 43210", "098765 43210", "9876543210", "919876543210" -> "+919876543210"; null if invalid. */
export function normalizeIndianMobile(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length > 20 || /[^\d\s()+-]/.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    if (!digits.startsWith("91")) return null; // only Indian numbers for now
    digits = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/**
 * Keyed hash of a normalised number. Numbers are never stored in plain text; the key (AUDIT_HASH_KEY)
 * stays in backend/.env, so the hashes cannot be reversed by guessing numbers without it.
 */
export function hashPhone(e164) {
  const key = process.env.AUDIT_HASH_KEY;
  if (!key) throw new Error("AUDIT_HASH_KEY is not set (needed to protect phone numbers).");
  return createHmac("sha256", key).update(`phone:${e164}`).digest("hex");
}

/**
 * Login stores phone hashes, and there are only ~10^10 Indian mobile numbers, so a weak key would
 * let anyone with the database recover them. Refuse to turn login on without a strong key.
 */
export function assertStrongHashKey(key = process.env.AUDIT_HASH_KEY) {
  if (!key || key.length < 32 || /^change[-_]?me$/i.test(key)) {
    throw new Error(
      "Login needs a strong AUDIT_HASH_KEY (32+ random characters) in backend/.env. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
}

export const last4 =(e164) => e164.slice(-4);

/** "+91 98•••••210" style display (first 2 and last 3 digits only). */
export function maskPhone(e164) {
  const d = e164.replace(/^\+91/, "");
  return `+91 ${d.slice(0, 2)}••• ••${d.slice(-3)}`;
}
