// HTTP plumbing that reproduces the previous API's wire behaviour: JSON error shapes, request
// validation errors ({"detail": [...]}, 422), CORS, 404/405 handling and access logs.

import Busboy from "busboy";
import path from "node:path";

import * as config from "./config.js";
import { HttpError, ValidationError } from "./util.js";

// Reason phrases as the previous server sent them (current HTTP wording, RFC 9110).
const REASON = { 413: "Content Too Large", 422: "Unprocessable Content" };

/** Set the status code and the same reason phrase as before. */
export function setStatus(res, status) {
  res.statusCode = status;
  if (REASON[status]) res.statusMessage = REASON[status];
}

/** Send JSON with the same headers as before (Content-Type: application/json, no charset parameter). */
export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  setStatus(res, status);
  res.setHeader("Content-Type", "application/json"); // raw setHeader: Express would append a charset
  res.setHeader("Content-Length", String(data.length));
  res.end(data);
}

// JavaScript JSON.parse messages -> the wording of the previous backend's JSON decoder.
const JSON_ERRORS = [
  [/Expected property name or '}'/, "Expecting property name enclosed in double quotes"],
  [/Expected ',' or '[}\]]' after/, "Expecting ',' delimiter"],
  [/Expected ':' after property name/, "Expecting ':' delimiter"],
  [/Unexpected non-whitespace character after JSON/, "Extra data"],
  [/Unterminated string/, "Unterminated string starting at"],
  [/Bad control character/, "Invalid control character at"],
  [/Bad (escaped character|Unicode escape)/, "Invalid \\escape"],
];
function jsonErrorText(message) {
  for (const [re, text] of JSON_ERRORS) if (re.test(message)) return text;
  return "Expecting value";
}

// ------------------------------------------------------------------------------ CORS

// Same policy and responses as Starlette's CORSMiddleware(allow_origins, ["GET", "POST"], ["Content-Type"]).
const ALLOW_METHODS = "GET, POST, DELETE";
const ALLOW_HEADERS = ["Accept", "Accept-Language", "Content-Language", "Content-Type"];

const plainIp = (a) => String(a ?? "").trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
const ipv4 = (a) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m && m.slice(1).every((x) => Number(x) <= 255) ? m.slice(1).reduce((n, x) => n * 256 + Number(x), 0) : null;
};
/** A proxy we trust to report the client: this machine, or an address / IPv4 range in TRUSTED_PROXIES. */
export function isTrustedProxy(addr, trusted = config.TRUSTED_PROXIES) {
  const a = plainIp(addr);
  if (a === "127.0.0.1" || a === "::1") return true;
  for (const t of trusted) {
    const [base, bits] = t.split("/");
    if (bits === undefined) {
      if (plainIp(base) === a) return true;
      continue;
    }
    const n = ipv4(a);
    const b = ipv4(base);
    const k = Number(bits);
    if (n === null || b === null || !Number.isInteger(k) || k < 0 || k > 32) continue;
    const block = 2 ** (32 - k); // same network = same quotient
    if (Math.floor(n / block) === Math.floor(b / block)) return true;
  }
  return false;
}

/**
 * The client address. Proxies append the address they saw to X-Forwarded-For, so the list is read from
 * the right: trusted proxies (this machine; TRUSTED_PROXIES, e.g. a load balancer) are skipped and the
 * first address that is not one is the client. A client cannot fake it by sending its own header.
 */
export function clientAddress(req) {
  const peer = plainIp(req.socket.remoteAddress) || null;
  if (!peer || !isTrustedProxy(peer)) return peer;
  const chain = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map(plainIp)
    .filter((a) => /^[0-9a-fA-F:.]{2,45}$/.test(a));
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i])) return chain[i];
  }
  return chain[0] ?? peer; // every hop is trusted (e.g. a request from this machine)
}

export function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = origin && config.FRONTEND_ORIGINS.includes(origin);
  const preflight = req.method === "OPTIONS" && req.headers["access-control-request-method"];
  if (!origin) return next();
  if (preflight) {
    const failures = [];
    if (!allowed) failures.push("origin");
    if (!["GET", "POST"].includes(String(req.headers["access-control-request-method"]).toUpperCase())) failures.push("method");
    const requested = String(req.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (requested.some((h) => !ALLOW_HEADERS.map((x) => x.toLowerCase()).includes(h))) failures.push("headers");
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", ALLOW_METHODS);
    res.set("Access-Control-Max-Age", "600");
    res.set("Access-Control-Allow-Headers", ALLOW_HEADERS.join(", "));
    if (allowed) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
    }
    const body = Buffer.from(failures.length ? `Disallowed CORS ${failures.join(", ")}` : "OK");
    res.statusCode = failures.length ? 400 : 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    return res.end(body);
  }
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.vary("Origin");
  }
  return next();
}

// ------------------------------------------------------------------------ access log

export function accessLog(req, res, next) {
  res.on("finish", () => {
    const addr = `${req.socket.remoteAddress?.replace(/^::ffff:/, "")}:${req.socket.remotePort}`;
    process.stdout.write(`INFO:     ${addr} - "${req.method} ${req.originalUrl} HTTP/${req.httpVersion}" ${res.statusCode} ${res.statusMessage}\n`);
  });
  next();
}

// -------------------------------------------------------------------- JSON bodies

/** Read and parse a JSON body; malformed JSON yields the same 422 json_invalid error as before. */
export function jsonBody(req, res, next) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > config.MAX_JSON_BYTES) tooLarge = true;
    else chunks.push(c);
  });
  req.on("error", next);
  req.on("end", () => {
    if (tooLarge) return next(new HttpError(413, "Request body is too large."));
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim()) {
      req.body = undefined;
      return next();
    }
    try {
      req.body = JSON.parse(text);
      next();
    } catch (exc) {
      const pos = /position (\d+)/.exec(exc.message);
      const at = pos ? Number(pos[1]) : text.length; // "unexpected end" errors point past the input
      next(
        new ValidationError([
          { type: "json_invalid", loc: ["body", at], msg: "JSON decode error", input: {}, ctx: { error: jsonErrorText(exc.message) } },
        ]),
      );
    }
  });
}

// ----------------------------------------------------------------- body validation

const missing = (field, input) => ({ type: "missing", loc: ["body", field], msg: "Field required", input });

/**
 * Validate a JSON object body against simple field rules, producing pydantic-style error details.
 * rules: { name: { type: "string" | "int" | "literal", required, nullable, min, max, minLength, maxLength, values, default } }
 */
export function validateBody(body, rules) {
  if (body === undefined) return { errors: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }] };
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { errors: [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }] };
  }
  const out = {};
  const errors = [];
  for (const [name, rule] of Object.entries(rules)) {
    const has = Object.prototype.hasOwnProperty.call(body, name);
    let v = body[name];
    if (!has) {
      if (rule.required) errors.push(missing(name, body));
      else out[name] = rule.default ?? null;
      continue;
    }
    if (v === null && rule.nullable) {
      out[name] = null;
      continue;
    }
    const loc = ["body", name];
    if (rule.type === "string") {
      if (typeof v !== "string") {
        errors.push({ type: "string_type", loc, msg: "Input should be a valid string", input: v });
        continue;
      }
      if (rule.minLength !== undefined && [...v].length < rule.minLength) {
        errors.push({ type: "string_too_short", loc, msg: `String should have at least ${rule.minLength} character${rule.minLength === 1 ? "" : "s"}`, input: v, ctx: { min_length: rule.minLength } });
        continue;
      }
      if (rule.maxLength !== undefined && [...v].length > rule.maxLength) {
        errors.push({ type: "string_too_long", loc, msg: `String should have at most ${rule.maxLength} characters`, input: v, ctx: { max_length: rule.maxLength } });
        continue;
      }
    } else if (rule.type === "int") {
      // Lax mode like pydantic: integral numbers and numeric strings are accepted.
      if (typeof v === "string") {
        if (!/^\s*[+-]?\d+\s*$/.test(v)) {
          errors.push({ type: "int_parsing", loc, msg: "Input should be a valid integer, unable to parse string as an integer", input: v });
          continue;
        }
        v = parseInt(v, 10);
      } else if (typeof v === "number") {
        if (!Number.isInteger(v)) {
          errors.push({ type: "int_from_float", loc, msg: "Input should be a valid integer, got a number with a fractional part", input: v });
          continue;
        }
      } else if (typeof v === "boolean") {
        v = v ? 1 : 0;
      } else {
        errors.push({ type: "int_type", loc, msg: "Input should be a valid integer", input: v });
        continue;
      }
      if (rule.min !== undefined && v < rule.min) {
        errors.push({ type: "greater_than_equal", loc, msg: `Input should be greater than or equal to ${rule.min}`, input: body[name], ctx: { ge: rule.min } });
        continue;
      }
      if (rule.max !== undefined && v > rule.max) {
        errors.push({ type: "less_than_equal", loc, msg: `Input should be less than or equal to ${rule.max}`, input: body[name], ctx: { le: rule.max } });
        continue;
      }
    } else if (rule.type === "literal") {
      if (!rule.values.includes(v)) {
        const expected = rule.values.map((x) => `'${x}'`).join(" or ");
        errors.push({ type: "literal_error", loc, msg: `Input should be ${expected}`, input: v, ctx: { expected } });
        continue;
      }
    }
    out[name] = v;
  }
  return errors.length ? { errors } : { value: out };
}

export function parseBody(req, rules) {
  const { value, errors } = validateBody(req.body, rules);
  if (errors) throw new ValidationError(errors);
  return value;
}

// -------------------------------------------------------------- multipart uploads

/**
 * Read the multipart "file" field fully (like the previous API did), keeping at most `maxBytes + 1`
 * bytes in memory. Resolves {filename, data, truncated, size} or null when there is no file field.
 */
export function readUpload(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, defParamCharset: "utf8" });
    } catch {
      resolve(null); // not multipart: same as a missing file field
      return;
    }
    let result = null;
    const chunks = [];
    let kept = 0;
    bb.on("file", (field, stream, info) => {
      if (field !== "file" || result) {
        stream.resume();
        return;
      }
      result = { filename: info.filename ?? "", data: Buffer.alloc(0), size: 0 };
      stream.on("data", (c) => {
        result.size += c.length;
        if (kept <= maxBytes) {
          const take = c.subarray(0, maxBytes + 1 - kept);
          chunks.push(take);
          kept += take.length;
        }
      });
    });
    bb.on("error", reject);
    // busboy emits "close" only after every file stream has ended.
    bb.on("close", () => {
      if (result) result.data = Buffer.concat(chunks);
      resolve(result);
    });
    req.pipe(bb);
  });
}

export const basename = (name) => path.win32.basename(path.posix.basename(name));

// ------------------------------------------------------------------------- errors

/** 404 for unknown paths, 405 (with Allow) for known paths with the wrong method. */
export function notFound(routes) {
  return (req, res) => {
    const methods = routes.filter((r) => r.pattern.test(req.path)).map((r) => r.method);
    if (methods.length) {
      res.set("Allow", [...new Set(methods)].join(", "));
      return sendJson(res, 405, { status: "error", message: "Method Not Allowed" });
    }
    return sendJson(res, 404, { status: "error", message: "Not Found" });
  };
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    if (err instanceof ValidationError) return sendJson(res, 422, { detail: err.detail });
    if (err instanceof HttpError) return sendJson(res, err.status, { status: "error", message: err.message, ...(err.code ? { code: err.code } : {}) });
    logger.error(`Unhandled error for ${req.method} ${req.originalUrl}`, err);
    const body = Buffer.from("Internal Server Error");
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  };
}
