// Passwords: rules, hashing and checking.
//
// Hashing is scrypt (Node's built-in, memory-hard) with a random 16-byte salt per password and a
// 64-byte key, stored as "scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>" so the cost can be raised later
// without breaking older hashes (needsRehash). Comparison is constant-time. Passwords are never stored,
// logged or returned.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// Cost: N = 2^15, r = 8, p = 1 (about 32 MB and ~50-100 ms per hash on a server).
const COST = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_LEN = 64;
const maxmem = (N, r) => 128 * N * r * 2; // scrypt needs 128*N*r bytes; leave room

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

// The most common passwords (and ones that only look different): refused.
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop",
  "11111111", "00000000", "abcd1234", "abc12345", "iloveyou", "welcome1", "welcome123", "admin123", "letmein1",
  "sunshine", "princess", "football", "baseball", "monkey123", "dragon123", "teemly123", "opportunity", "india123",
]);

/**
 * Why a password is not acceptable, or null when it is. `email`: the account's email (the password
 * may not be the email or its name part).
 */
export function passwordProblem(password, { email = null } = {}) {
  if (typeof password !== "string") return "Enter a password.";
  const len = [...password].length;
  if (len < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (len > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
  if (/^(.)\1+$/u.test(password)) return "Use more than one repeated character.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "This password is too common. Choose another.";
  const local = String(email ?? "").toLowerCase().split("@")[0];
  if (email && (lower === String(email).toLowerCase() || (local.length >= 4 && lower.includes(local)))) return "Don't use your email in the password.";
  return null;
}

/** A new hash for a password (random salt). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = COST;
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Does `password` match `stored` (a hash from hashPassword)? Constant-time; false for anything malformed. */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || typeof password !== "string") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!salt.length || expected.length !== KEY_LEN) return false;
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N, r, p, maxmem: maxmem(N, r) });
  return timingSafeEqual(key, expected);
}

/** True when a stored hash uses a lower cost than today's (re-hash it at the next correct sign-in). */
export function needsRehash(stored) {
  const [, N, r, p] = String(stored ?? "").split("$").map(Number);
  return N !== COST.N || r !== COST.r || p !== COST.p;
}

// Checked when the email has no account (or no password), so a wrong email takes as long as a wrong
// password and the answer time does not tell which emails have one.
let dummy = null;
export async function burnTime(password) {
  dummy ??= await hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(String(password ?? ""), dummy);
}
