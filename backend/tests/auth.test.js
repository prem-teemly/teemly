// Login (email + one-time code) tests. MySQL test database only (teemly_db_test, verified before any
// write). The code provider is "console": codes are captured from the backend's terminal output and
// no email is sent. The addresses here are test addresses, not real users.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const OWNER = "Owner.Test@Example.com"; // any case and spaces are accepted; stored lower case
const OTHER = "someone.else@example.com";
Object.assign(process.env, {
  DB_NAME: "teemly_db_test",
  DB_ENABLED: "true",
  OWNER_EMAIL: OWNER,
  OWNER_PHONE: "",
  OWNER_NAME: "Prem Kumar",
  OTP_PROVIDER: "console",
  RATE_LIMIT_PER_MINUTE: "1000",
  UPLOAD_RETENTION_HOURS: "0",
});

const config = await import("../src/config.js");
const db = await import("../src/db/pool.js");
const { migrate } = await import("../src/db/migrate.js");
const { createApp } = await import("../src/app.js");
const phone = await import("../src/auth/phone.js");
const emailLib = await import("../src/auth/email.js");
const otp = await import("../src/auth/otp.js");

let server;
let base;
const q = async (sql, p = []) => (await db.getPool().query(sql, p))[0];

// Capture codes printed by the console provider.
const printed = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const m = /DEV CODE for (\S+): (\d{6})/.exec(String(chunk));
  if (m) printed.push({ to: m[1], code: m[2] });
  return realWrite(chunk, ...rest);
};

let phoneOwnerId;
before(async () => {
  const [[{ name }]] = await db.getPool().query("SELECT DATABASE() AS name");
  if (name !== "teemly_db_test") throw new Error(`refusing to run: connected to ${name}`);
  await migrate({ log: () => {} }); // test database only
  await db.getPool().query("DELETE FROM sessions");
  await db.getPool().query("DELETE FROM otp_challenges");
  await db.getPool().query("DELETE FROM users");
  // The owner as they were before email sign-in: an account that signed in by phone.
  const [r] = await db.getPool().query("INSERT INTO users (phone_hash, phone_last4, display_name, role, last_login_at) VALUES (?, '3210', 'Prem', 'owner', NOW(3))", ["f".repeat(64)]);
  phoneOwnerId = r.insertId;
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  process.stdout.write = realWrite;
  server.close();
  await db.closePool();
});

const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json(), headers: r.headers });
const requestCode = async (email = OWNER) => json(await post("/api/auth/otp/request", { email }));
const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];

test("emails: normalised to lower case; anything else is rejected; display is masked; the email holds the code", () => {
  for (const [ok, want] of [[" Owner.Test@Example.com ", "owner.test@example.com"], ["ownername.sample@gmail.com", "ownername.sample@gmail.com"], ["a+b@x.co.in", "a+b@x.co.in"]]) assert.equal(emailLib.normalizeEmail(ok), want, ok);
  for (const bad of ["", "abc", "a@b", "a b@x.com", "a@@x.com", "<a@x.com>", ".a@x.com", "a.@x.com", "a..b@x.com", `${"a".repeat(65)}@x.com`, "9876543210"]) assert.equal(emailLib.normalizeEmail(bad), null, bad);
  assert.equal(emailLib.maskEmail("ownername.sample@gmail.com"), "own•••••••••••••@gmail.com");
  assert.equal(emailLib.maskEmail("ab@x.com"), "a•••@x.com");
  const mail = otp.codeEmail("123456", 300, "Prem");
  assert.equal(mail.subject, "123456 is your Teemly sign-in code");
  assert.match(mail.text, /Your Teemly sign-in code is: 123456/);
  assert.match(mail.text, /expires in 5 minutes/);
  assert.throws(() => otp.assertProviderAllowed("console", "production"), /cannot be used in production/);
  assert.doesNotThrow(() => otp.assertProviderAllowed("console", "development"));
  assert.throws(() => otp.assertProviderAllowed("sms"), /Unknown OTP_PROVIDER/);
  for (const weak of ["", "change-me", "CHANGE_ME", "short-key"]) assert.throws(() => phone.assertStrongHashKey(weak), /strong AUDIT_HASH_KEY/, weak);
  assert.doesNotThrow(() => phone.assertStrongHashKey("a".repeat(16) + "b".repeat(16)));
});

test("login on: APIs need a session; /health and the login routes stay open", async () => {
  assert.equal(config.authEnabled(), true);
  assert.equal((await fetch(base + "/health")).status, 200);
  const me = await json(await fetch(base + "/api/auth/me"));
  assert.deepEqual(me.body, { status: "success", auth_enabled: true, user: null });
  const r = await json(await fetch(base + "/api/db/status"));
  assert.equal(r.status, 401);
  assert.equal(r.body.message, "Please sign in.");
  assert.equal((await fetch(base + "/api/analysis/" + "a".repeat(32))).status, 401);
});

test("code request: invalid emails and phone numbers rejected; unknown emails get the same answer but no code", async () => {
  assert.equal((await requestCode("not-an-email")).status, 422);
  assert.equal((await json(await post("/api/auth/otp/request", { phone: "+91 98765 43210" }))).status, 422, "phone sign-in is gone");
  const before = printed.length;
  const other = await requestCode(OTHER);
  assert.equal(other.status, 200);
  assert.equal(other.body.message, "If this email can open this room, a code has been sent.");
  assert.match(other.body.challenge_id, /^[0-9a-f]{32}$/);
  assert.equal(printed.length, before, "no code is generated or sent for an email that cannot sign in");
  const v = await json(await post("/api/auth/otp/verify", { challenge_id: other.body.challenge_id, code: "000000" }));
  assert.equal(v.status, 400);
});

test("code: wrong codes are counted and lock the challenge; resend is rate-limited; nothing sensitive is stored", async () => {
  config.AUTH.otpResendSeconds = 30;
  const first = await requestCode();
  assert.equal(first.status, 200);
  assert.equal(first.body.delivery, "console");
  const sent = printed.at(-1);
  assert.equal(sent.to, "own•••••••@example.com", "terminal shows a masked email");

  const again = await requestCode(" OWNER.test@example.com ");
  assert.equal(again.status, 429, "the same email in another case is the same email");
  assert.ok(Number(again.headers.get("retry-after")) > 0);

  // The code table holds neither the email nor the code.
  const dump = JSON.stringify(await q("SELECT * FROM otp_challenges"));
  assert.doesNotMatch(dump, /example\.com/i);
  assert.equal(dump.includes(`"${sent.code}"`), false);

  const wrong = sent.code === "111111" ? "222222" : "111111";
  for (let i = 1; i <= 5; i++) {
    const r = await json(await post("/api/auth/otp/verify", { challenge_id: first.body.challenge_id, code: wrong }));
    assert.equal(r.status, 400);
    assert.match(r.body.message, i < 5 ? new RegExp(`${5 - i} attempt`) : /request a new one/);
  }
  const locked = await json(await post("/api/auth/otp/verify", { challenge_id: first.body.challenge_id, code: sent.code }));
  assert.equal(locked.status, 429, "even the right code is refused after 5 wrong attempts");
  config.AUTH.otpResendSeconds = 0;
});

let cookie;
test("code success: the owner who signed in by phone keeps the same account (now with the email); secure cookie; code cannot be reused", async () => {
  const r = await requestCode();
  const { code } = printed.at(-1);
  const ok = await json(await post("/api/auth/otp/verify", { challenge_id: r.body.challenge_id, code }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.user, { name: "Prem Kumar", initials: "PK", email_masked: "own•••••••@example.com", role: "owner" });
  const setCookie = ok.headers.get("set-cookie");
  assert.match(setCookie, /^teemly_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
  cookie = cookieOf(ok);
  const users = await q("SELECT id, email, phone_hash, role FROM users");
  assert.equal(users.length, 1, "no second account");
  assert.deepEqual([users[0].id, users[0].email, users[0].phone_hash, users[0].role], [phoneOwnerId, "owner.test@example.com", "f".repeat(64), "owner"], "same account, email added, nothing deleted");

  const token = cookie.split("=")[1];
  assert.equal(JSON.stringify(await q("SELECT * FROM sessions")).includes(token), false, "only a hash of the token is stored");

  const reuse = await json(await post("/api/auth/otp/verify", { challenge_id: r.body.challenge_id, code }));
  assert.equal(reuse.status, 400);

  const me = await json(await fetch(base + "/api/auth/me", { headers: { cookie } }));
  assert.equal(me.body.user.name, "Prem Kumar");
  assert.equal((await fetch(base + "/api/db/status", { headers: { cookie } })).status, 200, "signed in: APIs work");

  // Signing in again finds the account by its email.
  const r2 = await requestCode();
  assert.equal((await post("/api/auth/otp/verify", { challenge_id: r2.body.challenge_id, code: printed.at(-1).code })).status, 200);
  assert.equal((await q("SELECT COUNT(*) AS n FROM users"))[0].n, 1);
});

test("email delivery failure: a clear 502, the unsent code stops working, nothing is half signed in", async () => {
  const saved = { ...config.SMTP, provider: config.AUTH.otpProvider };
  Object.assign(config.SMTP, { host: "127.0.0.1", port: 1, user: "x@example.com", pass: "x" }); // nothing listens there
  config.AUTH.otpProvider = "smtp";
  try {
    const r = await requestCode();
    assert.equal(r.status, 502);
    assert.match(r.body.message, /could not be emailed/);
    const ownerHash = emailLib.hashEmail(emailLib.normalizeEmail(OWNER));
    const [open] = await q("SELECT COUNT(*) AS n FROM otp_challenges WHERE email_hash = ? AND consumed_at IS NULL AND expires_at > NOW(3)", [ownerHash]);
    assert.equal(Number(open.n), 0, "the code that was not sent cannot be used");
  } finally {
    Object.assign(config.SMTP, { host: saved.host, port: saved.port, user: saved.user, pass: saved.pass });
    config.AUTH.otpProvider = saved.provider;
  }
});

test("security: cross-site writes are blocked; forged or expired sessions are refused; expired codes fail", async () => {
  const evil = await json(await post("/api/ai/translate", { text: "x" }, { cookie, origin: "https://evil.example" }));
  assert.equal(evil.status, 403);
  assert.equal((await fetch(base + "/api/db/status", { headers: { cookie: "teemly_session=" + "A".repeat(43) } })).status, 401);

  config.AUTH.otpTtlSeconds = 1;
  const r = await requestCode();
  const { code } = printed.at(-1);
  await new Promise((res) => setTimeout(res, 1500));
  const late = await json(await post("/api/auth/otp/verify", { challenge_id: r.body.challenge_id, code }));
  assert.equal(late.status, 400);
  assert.match(late.body.message, /expired/);
  config.AUTH.otpTtlSeconds = 300;
});

test("profile: account, room counts and signed-in devices; other devices can be signed out, not this one", async () => {
  assert.equal((await fetch(base + "/api/auth/profile")).status, 401, "needs a session");
  await q("DELETE FROM sessions WHERE token_hash <> SHA2(?, 256)", [cookie.split("=")[1]]); // only this device
  await q("DELETE FROM otp_challenges"); // a fresh hour for this test's sign-ins

  // A second device (phone) signs in.
  const r = await requestCode();
  const { code } = printed.at(-1);
  const phoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const second = await post("/api/auth/otp/verify", { challenge_id: r.body.challenge_id, code }, { "user-agent": phoneUa });
  assert.equal(second.status, 200);
  const phoneCookie = cookieOf(second);

  const p = await json(await fetch(base + "/api/auth/profile", { headers: { cookie } }));
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.user.name, "Prem Kumar");
  assert.equal(p.body.user.email_masked, "own•••••••@example.com");
  assert.ok(Date.parse(p.body.user.member_since) && Date.parse(p.body.user.last_login_at));
  assert.deepEqual(Object.keys(p.body.room ?? {}).sort(), ["conversations", "inbox_pending", "open_opportunities", "open_value_inr", "people"].sort());
  assert.deepEqual(p.body.security, { method: "Email + one-time code", code_delivery: "console", session_days: 7, code_minutes: 5 });
  assert.equal(p.body.sessions.length, 2);
  const mine = p.body.sessions.find((s) => s.current);
  const other = p.body.sessions.find((s) => !s.current);
  assert.ok(mine && other);
  assert.equal(other.device, "Safari on iPhone");
  assert.doesNotMatch(JSON.stringify(p.body), /owner\.test@example\.com|token/i, "no full email or token in the profile");

  // Settings (read-only): signed-in only; no credentials or emails in it.
  assert.equal((await fetch(base + "/api/settings")).status, 401);
  const st = await json(await fetch(base + "/api/settings", { headers: { cookie } }));
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.login, { enabled: true, method: "email", code_delivery: "console", session_days: 7 });
  assert.equal(st.body.database.connected, true);
  assert.doesNotMatch(JSON.stringify(st.body), /example\.com|PASSWORD|SMTP_PASS|OCID|project-/i);

  // This device cannot be "revoked" (that is Sign out); bad ids are 404; cross-site writes are blocked.
  assert.equal((await post(`/api/auth/sessions/${mine.id}/revoke`, {}, { cookie })).status, 409);
  assert.equal((await post("/api/auth/sessions/abc/revoke", {}, { cookie })).status, 404);
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie, origin: "https://evil.example" })).status, 403);

  // Sign out the phone: it is signed out, this device is not.
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie })).status, 200);
  assert.equal((await json(await fetch(base + "/api/auth/me", { headers: { cookie: phoneCookie } }))).body.user, null);
  assert.equal((await json(await fetch(base + "/api/auth/me", { headers: { cookie } }))).body.user.name, "Prem Kumar");
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie })).status, 404, "already signed out");

  // "Sign out everywhere else" keeps only this device.
  const r2 = await requestCode();
  await post("/api/auth/otp/verify", { challenge_id: r2.body.challenge_id, code: printed.at(-1).code });
  const all = await json(await post("/api/auth/sessions/revoke-others", {}, { cookie }));
  assert.equal(all.body.signed_out, 1);
  const after = await json(await fetch(base + "/api/auth/profile", { headers: { cookie } }));
  assert.deepEqual(after.body.sessions.map((s) => s.current), [true]);
});

test("logout revokes the session", async () => {
  const out = await post("/api/auth/logout", {}, { cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await json(await fetch(base + "/api/auth/me", { headers: { cookie } }))).body.user, null);
  assert.equal((await fetch(base + "/api/db/status", { headers: { cookie } })).status, 401);
});

test("hourly limit per email", async () => {
  config.AUTH.otpMaxPerHour = 3;
  await db.getPool().query("DELETE FROM otp_challenges");
  for (let i = 0; i < 3; i++) assert.equal((await requestCode()).status, 200);
  const blocked = await requestCode();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.message, /Too many codes for this email/);
  config.AUTH.otpMaxPerHour = 5;
});
