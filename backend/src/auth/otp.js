// One-time codes: generation, hashing, and delivery by email.
//
// Codes are 6 random digits (crypto.randomInt), stored only as an HMAC with a key that exists only
// in this process (a restart simply invalidates codes that were not used yet; they expire in minutes
// anyway). Delivery goes through a provider: "smtp" emails the code (e.g. Gmail with an App Password);
// "console" prints it in the backend terminal for development and is refused in production.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";

import * as config from "../config.js";
import { getLogger } from "../util.js";
import { maskEmail } from "./email.js";

const logger = getLogger("app.auth.otp");
const PROCESS_KEY = randomBytes(32);

export const newChallengeId = () => randomBytes(16).toString("hex");
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const codeHash = (challengeId, code) => createHmac("sha256", PROCESS_KEY).update(`${challengeId}:${code}`).digest("hex");

/** Constant-time comparison of a submitted code against the stored hash. */
export function codeMatches(challengeId, code, storedHash) {
  const a = Buffer.from(codeHash(challengeId, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The sign-in email (plain text and HTML). The code is the only secret in it. `name`: the account's, if known. */
export function codeEmail(code, ttlSeconds, name = null) {
  const minutes = Math.round(ttlSeconds / 60);
  const subject = `${code} is your Teemly sign-in code`;
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = [
    hi,
    "",
    `Your Teemly sign-in code is: ${code}`,
    "",
    `It expires in ${minutes} minutes and works once. If you did not try to sign in, you can ignore this email; nobody can sign in without the code.`,
    "",
    "Teemly Opportunity Room",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e6e9ee;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#138d8f;font-weight:700">Teemly Opportunity Room</p>
<p style="margin:0 0 16px;font-size:15px">${escapeHtml(hi)} your sign-in code is:</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;color:#14213d">${code}</p>
<p style="margin:0;font-size:13px;color:#6b7280">It expires in ${minutes} minutes and works once. If you did not try to sign in, ignore this email: nobody can sign in without the code.</p>
</div></body></html>`;
  return { subject, text, html };
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let transport = null;
const smtpTransport = () =>
  (transport ??= nodemailer.createTransport({
    host: config.SMTP.host,
    port: config.SMTP.port,
    secure: config.SMTP.port === 465, // 465: TLS from the start; 587: STARTTLS (required below)
    requireTLS: config.SMTP.port !== 465,
    auth: { user: config.SMTP.user, pass: config.SMTP.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }));

const PROVIDERS = {
  /** Development: print the code in the backend terminal. No email is sent. */
  console: {
    async send(email, code, ttlSeconds) {
      process.stdout.write(`\n  DEV CODE for ${maskEmail(email)}: ${code}  (expires in ${Math.round(ttlSeconds / 60)} min)\n\n`);
      return { delivered: true, channel: "console" };
    },
  },
  /** Email through SMTP (Gmail: smtp.gmail.com, port 465, the account and an App Password). */
  smtp: {
    async send(email, code, ttlSeconds, name) {
      const { subject, text, html } = codeEmail(code, ttlSeconds, name);
      await smtpTransport().sendMail({ from: config.SMTP.from || `Teemly <${config.SMTP.user}>`, to: email, subject, text, html });
      return { delivered: true, channel: "email" };
    },
  },
};

/** Check the configured provider at startup; the console provider is never allowed in production. */
export function assertProviderAllowed(name, env = process.env.NODE_ENV) {
  if (!PROVIDERS[name]) throw new Error(`Unknown OTP_PROVIDER '${name}'. Available: auto, ${Object.keys(PROVIDERS).join(", ")}.`);
  if (name === "console" && env === "production") {
    throw new Error("OTP_PROVIDER=console prints codes in the terminal and cannot be used in production. Set SMTP_USER and SMTP_PASS to email the codes.");
  }
  if (name === "smtp" && (!config.SMTP.user || !config.SMTP.pass)) {
    throw new Error("Email codes need SMTP_USER and SMTP_PASS in backend/.env (for Gmail: the address and a 16-letter App Password).");
  }
}

/** Send a code. Throws when the email could not be sent (the caller tells the user to try again). */
export async function sendCode(provider, email, code, ttlSeconds, name = null) {
  assertProviderAllowed(provider);
  const r = await PROVIDERS[provider].send(email, code, ttlSeconds, name);
  logger.info(`Sign-in code sent to ${maskEmail(email)} via ${r.channel}`); // never the code itself
  return r;
}
