// Small shared helpers: logging, rounding, errors, bounded concurrency.

import { randomUUID } from "node:crypto";

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}

/** Logger with the same line format as the previous backend: "<time> <LEVEL> <name>: <message>". */
export function getLogger(name) {
  const write = (level, stream) => (msg, err) => {
    stream.write(`${stamp()} ${level} ${name}: ${msg}\n`);
    if (err?.stack) stream.write(`${err.stack}\n`);
  };
  return {
    info: write("INFO", process.stdout),
    warning: write("WARNING", process.stderr),
    error: write("ERROR", process.stderr),
  };
}

/**
 * Round to `digits` decimals using the exact binary value, like Python's round() (e.g. 2.675 -> 2.67).
 * The only difference is an exact binary tie (e.g. 0.125), where Python rounds half to even.
 */
export function round(x, digits = 0) {
  return Number(x.toFixed(digits));
}

export const hexId = () => randomUUID().replaceAll("-", "");

/** Error whose message is returned to the client as {"status": "error", "message": ...}. */
export class HttpError extends Error {
  /** `code`: optional machine-readable reason for the client (e.g. "name_required"). */
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 422 validation error in the API's established format: {"detail": [...]}. */
export class ValidationError extends Error {
  constructor(detail) {
    super("Request validation failed");
    this.detail = detail;
  }
}

/**
 * Run fn over items with at most `limit` in flight. Like Python's ThreadPoolExecutor.map inside a
 * `with` block: results keep input order, every task finishes before returning, and the first
 * error (in input order) is then re-raised.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  const errors = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        errors[i] = e;
      }
    }
  });
  await Promise.all(workers);
  const firstError = errors.find((e) => e !== undefined);
  if (firstError !== undefined) throw firstError;
  return results;
}

/** Python-style sorted() for strings (code point order). */
export const sortStrings = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const now = () => Date.now() / 1000;
export const perf = () => performance.now() / 1000;
