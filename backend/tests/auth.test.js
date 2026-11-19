// Accounts: sign-up and sign-in (email + one-time code), and one room per account. MySQL test
// database only (teemly_db_test, verified before any write). The code provider is "console": codes are
// captured from the backend's terminal output and no email is sent. The addresses here are test
// addresses, not real users.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const OWNER = "Owner.Test@Example.com"; // any case and spaces are accepted; stored lower case
const SANJAY = "sanjay.tl@example.com";
const NEWBIE = "new.person@example.com";
Object.assign(process.env, {
  DB_NAME: "teemly_db_test",
  DB_ENABLED: "true",
  OWNER_EMAIL: OWNER,
  OWNER_PHONE: "",
  OWNER_NAME: "Prem Kumar",
  OTP_PROVIDER: "console",
  RATE_LIMIT_PER_MINUTE: "1000",
  UPLOAD_RETENTION_HOURS: "0",
  SIGNUP_ENABLED: "true",
  SIGNUP_ALLOWED: "",
});

const config = await import("../src/config.js");
const db = await import("../src/db/pool.js");
const { migrate } = await import("../src/db/migrate.js");
const { createApp } = await import("../src/app.js");
const phone = await import("../src/auth/phone.js");
const emailLib = await import("../src/auth/email.js");
const otp = await import("../src/auth/otp.js");
const { deleteUsers } = await import("./helpers/db-user.js");

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

const TEST_ACCOUNTS = "email IS NULL OR (email LIKE '%@example.com' AND email NOT LIKE 'test-user-%') OR email LIKE '%@teemly.example'";
let legacyId;
let legacyPerson;
before(async () => {
  const [[{ name }]] = await db.getPool().query("SELECT DATABASE() AS name");
  if (name !== "teemly_db_test") throw new Error(`refusing to run: connected to ${name}`);
  await migrate({ log: () => {} }); // test database only
  await q("DELETE FROM otp_challenges");
  await q("DELETE FROM audit_logs WHERE event LIKE 'auth.password%'"); // per-address wrong-password limit starts fresh
  await deleteUsers(db.getPool(), TEST_ACCOUNTS);
  // The room from before accounts: kept on an account without an email (migration 023), with a person in it.
  const [r] = await db.getPool().query("INSERT INTO users (phone_hash, phone_last4, display_name, role, last_login_at) VALUES (?, '3210', 'Owner', 'owner', NOW(3))", ["f".repeat(64)]);
  legacyId = r.insertId;
  legacyPerson = "e".repeat(31) + "1";
  await q("INSERT INTO people (id, user_id, name, name_key, first_seen_at, last_contact_at, last_contact_kind) VALUES (?, ?, 'Legacy Person', 'legacy person', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'audio')", [legacyPerson, legacyId]);
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
const get = async (p, cookie) => json(await fetch(base + p, { headers: cookie ? { cookie } : {} }));
const requestCode = async (email = OWNER, extra = {}) => json(await post("/api/auth/otp/request", { email, ...extra }));
const verify = async (email, c, extra = {}) => json(await post("/api/auth/otp/verify", { challenge_id: c.challenge_id, code: c.code, email, ...extra }));
const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];

/** A fresh code for an email (the code table is emptied first, so limits from other tests don't apply). */
async function codeFor(email, extra = {}) {
  await q("DELETE FROM otp_challenges");
  const r = await requestCode(email, extra);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { challenge_id: r.body.challenge_id, code: printed.at(-1).code };
}
/** Sign up (with a name) or sign in; returns the session cookie. */
async function signIn(email, name = null) {
  const c = await codeFor(email, name ? { intent: "signup", name } : {});
  const v = await verify(email, c, name ? { name } : {});
  assert.ok(v.status === 200 || v.status === 201, JSON.stringify(v.body));
  return cookieOf(v);
}

test("emails: normalised to lower case; anything else is rejected; display is masked; the email holds the code", () => {
  for (const [ok, want] of [[" Owner.Test@Example.com ", "owner.test@example.com"], ["ownername.sample@gmail.com", "ownername.sample@gmail.com"], ["a+b@x.co.in", "a+b@x.co.in"]]) assert.equal(emailLib.normalizeEmail(ok), want, ok);
  for (const bad of ["", "abc", "a@b", "a b@x.com", "a@@x.com", "<a@x.com>", ".a@x.com", "a.@x.com", "a..b@x.com", `${"a".repeat(65)}@x.com`, "9876543210"]) assert.equal(emailLib.normalizeEmail(bad), null, bad);
  assert.equal(emailLib.maskEmail("ownername.sample@gmail.com"), "own•••••••••••••@gmail.com");
  assert.equal(emailLib.maskEmail("ab@x.com"), "a•••@x.com");
  const mail = otp.codeEmail("123456", 300, "Prem");
  assert.equal(mail.subject, "123456 is your Teemly sign-in code");
  assert.match(mail.text, /^Hi Prem,/);
  assert.match(mail.text, /Your Teemly sign-in code is: 123456/);
  assert.match(mail.text, /expires in 5 minutes/);
  assert.match(otp.codeEmail("123456", 300).text, /^Hi,/, "a new email is greeted without a name");
  assert.throws(() => otp.assertProviderAllowed("console", "production"), /cannot be used in production/);
  assert.doesNotThrow(() => otp.assertProviderAllowed("console", "development"));
  assert.throws(() => otp.assertProviderAllowed("sms"), /Unknown OTP_PROVIDER/);
  for (const weak of ["", "change-me", "CHANGE_ME", "short-key"]) assert.throws(() => phone.assertStrongHashKey(weak), /strong AUDIT_HASH_KEY/, weak);
  assert.doesNotThrow(() => phone.assertStrongHashKey("a".repeat(16) + "b".repeat(16)));
  assert.equal(config.testUser(), null, "no test-user shortcut outside NODE_ENV=test");
});

test("sign-in is always required: APIs need a session; /health and the account routes stay open", async () => {
  assert.equal((await fetch(base + "/health")).status, 200);
  const me = await get("/api/auth/me");
  assert.deepEqual(me.body, { status: "success", auth_enabled: true, user: null, signup: { enabled: true, restricted: false } });
  const r = await get("/api/db/status");
  assert.equal(r.status, 401);
  assert.equal(r.body.message, "Please sign in.");
  for (const p of ["/api/analysis/" + "a".repeat(32), "/api/people", "/api/today", "/api/notifications", "/api/inbox"]) assert.equal((await fetch(base + p)).status, 401, p);
});

test("code request: bad emails, phone numbers and sign-ups without a name are refused; any valid email gets a code", async () => {
  assert.equal((await requestCode("not-an-email")).status, 422);
  assert.equal((await json(await post("/api/auth/otp/request", { phone: "+91 98765 43210" }))).status, 422, "phone sign-in is gone");
  assert.equal((await requestCode(NEWBIE, { intent: "signup" })).status, 422, "sign-up needs a name");
  assert.equal((await requestCode(NEWBIE, { intent: "signup", name: "<b>x</b>" })).status, 422);
  await q("DELETE FROM otp_challenges");
  const before = printed.length;
  const other = await requestCode(NEWBIE);
  assert.equal(other.status, 200, "the same answer whether or not the email has an account");
  assert.equal(other.body.message, "A code has been sent to this email.");
  assert.match(other.body.challenge_id, /^[0-9a-f]{32}$/);
  assert.equal(printed.length, before + 1, "the code is sent: the person may create an account with it");
  // The code only works for the email it was sent to.
  const c = { challenge_id: other.body.challenge_id, code: printed.at(-1).code };
  assert.equal((await verify(SANJAY, c)).status, 400);
});

test("code: wrong codes are counted and lock the challenge; resend is rate-limited; nothing sensitive is stored", async () => {
  await q("DELETE FROM otp_challenges");
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
    const r = await verify(OWNER, { challenge_id: first.body.challenge_id, code: wrong });
    assert.equal(r.status, 400);
    assert.match(r.body.message, i < 5 ? new RegExp(`${5 - i} attempt`) : /request a new one/);
  }
  const locked = await verify(OWNER, { challenge_id: first.body.challenge_id, code: sent.code });
  assert.equal(locked.status, 429, "even the right code is refused after 5 wrong attempts");
  config.AUTH.otpResendSeconds = 0;
});

let cookie; // the owner's session
test("the owner's first sign-in takes over the room from before accounts; secure cookie; a code works once", async () => {
  const c = await codeFor(OWNER);
  const ok = await verify(OWNER, c);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.created, false);
  assert.deepEqual(ok.body.user, { name: "Prem Kumar", initials: "PK", email_masked: "own•••••••@example.com", role: "owner" });
  assert.match(ok.headers.get("set-cookie"), /^teemly_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
  cookie = cookieOf(ok);
  const [u] = await q("SELECT id, email, phone_hash FROM users WHERE email = 'owner.test@example.com'");
  assert.deepEqual([u.id, u.phone_hash], [legacyId, "f".repeat(64)], "same account: the room and its history continue");
  const people = await get("/api/people", cookie);
  assert.deepEqual(people.body.people.map((p) => p.name), ["Legacy Person"], "the existing room is theirs");
  const depts = await get("/api/departments", cookie);
  assert.equal(depts.body.departments.length, 8, "a room without departments gets the built-in eight");

  const token = cookie.split("=")[1];
  assert.equal(JSON.stringify(await q("SELECT * FROM sessions")).includes(token), false, "only a hash of the token is stored");
  assert.equal((await verify(OWNER, c)).status, 400, "a code works once");
  assert.equal((await get("/api/auth/me", cookie)).body.user.name, "Prem Kumar");
  assert.equal((await fetch(base + "/api/db/status", { headers: { cookie } })).status, 200, "signed in: APIs work");

  // Signing in again finds the same account by its email.
  await signIn(OWNER);
  assert.equal((await q("SELECT COUNT(*) AS n FROM users WHERE email = 'owner.test@example.com'"))[0].n, 1);
});

let sanjay; // a second account's session
test("sign-in with an email that has no account: the name is asked, then a new, empty room is created", async () => {
  const c = await codeFor(SANJAY);
  const ask = await verify(SANJAY, c);
  assert.equal(ask.status, 409);
  assert.equal(ask.body.code, "name_required");
  assert.equal(ask.headers.get("set-cookie"), null, "not signed in yet");
  assert.equal((await q("SELECT COUNT(*) AS n FROM users WHERE email = ?", [SANJAY]))[0].n, 0, "no account until the name is given");
  const made = await verify(SANJAY, c, { name: "  Sanjay   TL " }); // the same code, now with the name
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.created, true);
  assert.equal(made.body.user.name, "Sanjay TL");
  sanjay = cookieOf(made);
  const [acct] = await q("SELECT id FROM users WHERE email = ?", [SANJAY]);
  const events = (await q("SELECT event, client_hash FROM audit_logs WHERE user_id = ? ORDER BY id", [acct.id]));
  assert.deepEqual(events.map((e) => e.event), ["auth.signup", "auth.signin"], "sign-up and sign-in are in the audit log");
  assert.ok(events.every((e) => /^[0-9a-f]{64}$/.test(e.client_hash)), "the address only as a hash");
  assert.deepEqual((await get("/api/people", sanjay)).body.people, [], "a new room starts empty");
  const depts = (await get("/api/departments", sanjay)).body.departments;
  assert.equal(depts.length, 8);
  assert.ok(depts.every((d) => d.built_in));
  assert.equal((await get("/api/today", sanjay)).body.owner, "Sanjay TL", "the dashboard greets its own user");
});

test("sign-up: the name comes first; SIGNUP_ALLOWED and SIGNUP_ENABLED decide who may create an account", async () => {
  // Open sign-up: name + email -> code -> account.
  const cookieNew = await signIn(NEWBIE, "New Person");
  assert.equal((await get("/api/auth/me", cookieNew)).body.user.name, "New Person");

  // "Create account" again with the same email: told at once, no code sent, no second account.
  await q("DELETE FROM otp_challenges");
  const sentBefore = printed.length;
  const again = await requestCode(" New.Person@Example.com ", { intent: "signup", name: "Someone Else" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "account_exists");
  assert.match(again.body.message, /already exists/);
  assert.equal(printed.length, sentBefore, "no code is sent");
  assert.equal((await q("SELECT COUNT(*) AS n FROM users WHERE email = ?", [NEWBIE]))[0].n, 1, "still one account");
  assert.equal((await q("SELECT display_name FROM users WHERE email = ?", [NEWBIE]))[0].display_name, "New Person", "its name is unchanged");

  config.AUTH.signupAllowed = ["@teemly.example", "guest@example.com"];
  try {
    assert.equal((await get("/api/auth/me")).body.signup.restricted, true);
    const closed = await requestCode("stranger@example.com", { intent: "signup", name: "Stranger" });
    assert.equal(closed.status, 403);
    assert.equal(closed.body.code, "signup_closed");
    // Sign-in with an email that may not sign up: the code proves the email, then the answer is clear.
    const c = await codeFor("stranger@example.com");
    const v = await verify("stranger@example.com", c, { name: "Stranger" });
    assert.equal(v.status, 403);
    assert.equal(v.body.code, "signup_closed");
    // An allowed domain and an allowed email may.
    await signIn("ravi@teemly.example", "Ravi");
    await signIn("guest@example.com", "Guest");
  } finally {
    config.AUTH.signupAllowed = [];
  }
  config.AUTH.signupEnabled = false;
  try {
    assert.equal((await requestCode("late@example.com", { intent: "signup", name: "Late" })).status, 403);
    // Existing accounts still sign in.
    assert.ok(await signIn(SANJAY));
  } finally {
    config.AUTH.signupEnabled = true;
  }
  assert.equal((await q("SELECT COUNT(*) AS n FROM users WHERE email IN ('stranger@example.com', 'late@example.com')"))[0].n, 0);
});

test("password rules and hashing: salted scrypt, constant-time check, weak passwords refused", async () => {
  const pw = await import("../src/auth/password.js");
  for (const [bad, why] of [["short", /at least 8/], ["aaaaaaaaaa", /repeated/], ["Password123", /too common/], ["pw.user.secret", /email/], ["x".repeat(129), /at most/]]) {
    assert.match(pw.passwordProblem(bad, { email: "pw.user@example.com" }) ?? "", why, bad);
  }
  assert.equal(pw.passwordProblem("Mango-Rain-42", { email: "pw.user@example.com" }), null);
  const a = await pw.hashPassword("Mango-Rain-42");
  const b = await pw.hashPassword("Mango-Rain-42");
  assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
  assert.notEqual(a, b, "a new random salt every time");
  assert.equal(await pw.verifyPassword("Mango-Rain-42", a), true);
  assert.equal(await pw.verifyPassword("mango-rain-42", a), false);
  assert.equal(await pw.verifyPassword("Mango-Rain-42", "scrypt$1$1$1$x$y"), false, "malformed hashes never match");
  assert.equal(pw.needsRehash(a), false);
});

test("passwords: sign up with one, sign in with it; wrong ones are counted and lock, the email code always works", async () => {
  const PW = "pw.user@example.com";
  const GOOD = "Mango-Rain-42";
  // Sign up with a password: a weak one is refused before the code is used, then the same code works.
  const c = await codeFor(PW, { intent: "signup", name: "Pw User" });
  const weak = await verify(PW, c, { name: "Pw User", password: "password123" });
  assert.equal(weak.status, 422);
  assert.equal(weak.body.code, "weak_password");
  const made = await verify(PW, c, { name: "Pw User", password: GOOD });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const [row] = await q("SELECT password_hash, password_set_at FROM users WHERE email = ?", [PW]);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(row.password_set_at);
  assert.ok(!JSON.stringify(await q("SELECT * FROM users WHERE email = ?", [PW])).includes(GOOD), "the password itself is never stored");

  const login = async (email, password) => json(await post("/api/auth/password/login", { email, password }));
  const ok = await login(" PW.User@Example.com ", GOOD);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.headers.get("set-cookie"), /^teemly_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
  const pwCookie = cookieOf(ok);
  assert.equal((await get("/api/auth/me", pwCookie)).body.user.name, "Pw User");

  // Wrong password, unknown email, and an account without a password: one answer, nothing revealed.
  const wrong = await login(PW, "Wrong-Pass-1");
  const nobody = await login("nobody.here@example.com", "Wrong-Pass-1");
  const noPassword = await login(SANJAY, "Wrong-Pass-1");
  for (const r of [wrong, nobody, noPassword]) {
    assert.equal(r.status, 400);
    assert.equal(r.body.message, wrong.body.message);
    assert.equal(r.headers.get("set-cookie"), null);
  }

  // 5 wrong in a row lock password sign-in (even the right password), not the email code.
  for (let i = 2; i <= 4; i++) assert.equal((await login(PW, `Wrong-Pass-${i}`)).status, 400);
  const locked = await login(PW, "Wrong-Pass-5");
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, "password_locked");
  assert.equal((await login(PW, GOOD)).status, 429, "locked: the right password waits too");
  const byCode = await verify(PW, await codeFor(PW));
  assert.equal(byCode.status, 200, "the emailed code still signs in");
  assert.equal((await login(PW, GOOD)).status, 200, "and it clears the lock");

  const [{ id: pwId }] = await q("SELECT id FROM users WHERE email = ?", [PW]);
  const events = (await q("SELECT event, detail FROM audit_logs WHERE user_id = ? ORDER BY id", [pwId])).map((r) => r.event);
  for (const e of ["auth.signup", "auth.signin", "auth.password_failed", "auth.password_locked"]) assert.ok(events.includes(e), e);
  const methods = (await q("SELECT JSON_UNQUOTE(JSON_EXTRACT(detail, '$.method')) AS m FROM audit_logs WHERE user_id = ? AND event = 'auth.signin'", [pwId])).map((r) => r.m);
  assert.ok(methods.includes("password") && methods.includes("code"), "how each sign-in happened is recorded");
  assert.ok(!JSON.stringify(await q("SELECT * FROM audit_logs WHERE user_id = ?", [pwId])).includes(GOOD), "never in the audit log");

  // Change it: the current password is needed; other devices are signed out, this one stays.
  const here = cookieOf(await login(PW, GOOD));
  assert.equal((await json(await post("/api/auth/password", { new_password: "Second-Pass-77" }, { cookie: here }))).status, 400, "current password needed");
  assert.equal((await json(await post("/api/auth/password", { current_password: GOOD, new_password: GOOD }, { cookie: here }))).status, 422, "must be different");
  const changed = await json(await post("/api/auth/password", { current_password: GOOD, new_password: "Second-Pass-77" }, { cookie: here }));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.signed_out >= 1);
  assert.equal((await get("/api/auth/me", pwCookie)).body.user, null, "the other device is signed out");
  assert.equal((await get("/api/auth/me", here)).body.user.name, "Pw User", "this device stays");
  assert.equal((await login(PW, GOOD)).status, 400);
  assert.equal((await login(PW, "Second-Pass-77")).status, 200);

  // Forgot password: a code, then a new password; every device is signed out.
  const r = await codeFor(PW, { intent: "reset" });
  const reset = await verify(PW, r, { password: "Third-Pass-99" });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.password_set, true);
  assert.equal((await get("/api/auth/me", here)).body.user, null, "reset signs out the old devices");
  assert.equal((await login(PW, "Second-Pass-77")).status, 400);
  assert.equal((await login(PW, "Third-Pass-99")).status, 200);

  // An account made with a code only can set its first password (no current one needed).
  const first = await json(await post("/api/auth/password", { new_password: "Sanjay-Pass-55" }, { cookie: sanjay }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const prof = await get("/api/auth/profile", sanjay);
  assert.equal(prof.body.user.has_password, true);
  assert.ok(prof.body.user.password_set_at);
  assert.equal(prof.body.security.method, "Email + password, or email + one-time code");
});

test("one room per account: people, opportunities, departments, calls, inbox, commitments and notifications never cross", async () => {
  const [prem] = await q("SELECT id FROM users WHERE email = 'owner.test@example.com'");
  const as = (c) => ({ get: (p) => get(p, c), post: async (p, b) => json(await post(p, b, { cookie: c })), del: async (p) => json(await fetch(base + p, { method: "DELETE", headers: { cookie: c } })) });
  const P = as(cookie);
  const S = as(sanjay);

  // Prem adds a person with a deal, and a department.
  const added = await P.post("/api/people", { name: "Vimal Raj", city: "Chennai", phone: "+919876543210", departments: ["Sales"], opportunity: { title: "Billing software", department: "Sales", value_inr: 500000 } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const pid = added.body.person_id;
  const oid = added.body.opportunity_id;
  assert.equal((await P.post("/api/departments", { name: "Customer Success" })).status, 201);

  // Sanjay sees none of it, and cannot read, change or delete it by id.
  assert.deepEqual((await S.get("/api/people")).body.people.map((p) => p.name), []);
  for (const p of [`/api/people/${pid}`, `/api/opportunities/${oid}`, `/api/people/${pid}/commitments`]) assert.equal((await S.get(p)).status, 404, p);
  assert.equal((await S.post(`/api/opportunities/${oid}`, { stage: "Won" })).status, 404);
  assert.equal((await S.post(`/api/people/${pid}/notes`, { body: "hi" })).status, 404);
  assert.equal((await S.post(`/api/people/${pid}/phone`, { phone: null })).status, 404);
  assert.equal((await S.del(`/api/opportunities/${oid}`)).status, 404);
  assert.equal((await S.del(`/api/people/${pid}`)).status, 404);
  assert.equal((await S.get("/api/opportunity-board")).body.opportunities.length, 0);
  assert.equal((await S.get("/api/today")).body.numbers.open_opportunities, 0);
  assert.equal((await S.get("/api/network")).body.nodes.length, 0);
  assert.ok(!(await S.get("/api/departments")).body.departments.some((d) => d.name === "Customer Success"));
  assert.equal((await S.get("/api/department-pages/customer-success")).status, 404);
  // Per-account uniques: the same phone and department name are fine in another room.
  assert.equal((await S.get("/api/people-check?phone=%2B919876543210")).body.phone_match, null);
  assert.equal((await S.post("/api/people", { name: "Vimal Raj", phone: "+919876543210" })).status, 201);
  assert.equal((await S.post("/api/departments", { name: "Customer Success" })).status, 201);
  // Search finds only your own room: Prem's deal for Prem, nothing of it for Sanjay.
  const ps = (await P.get("/api/search?q=billing")).body;
  assert.deepEqual(ps.opportunities.map((o) => o.title), ["Billing software"]);
  assert.equal(ps.opportunities[0].link, `/opportunities/${oid}`);
  const ss = (await S.get("/api/search?q=billing")).body;
  assert.deepEqual([ss.people, ss.opportunities, ss.calls, ss.notes].map((x) => x.length), [0, 0, 0, 0]);
  assert.deepEqual((await S.get("/api/search?q=vimal")).body.people.map((p) => p.link), (await S.get("/api/people")).body.people.filter((p) => p.name === "Vimal Raj").map((p) => `/people/${p.id}`), "Sanjay's own Vimal only");
  assert.equal((await P.get("/api/search?q=v")).body.people.length, 0, "2 letters at least");
  assert.equal((await P.get("/api/search?q=%25")).status, 200, "% is searched as a character");
  assert.equal((await fetch(base + "/api/search?q=vimal")).status, 401);

  // Prem's things are unchanged.
  assert.equal((await P.get(`/api/opportunities/${oid}`)).body.opportunity.stage, "Identified");
  assert.equal((await P.get("/api/people")).body.people.filter((p) => p.name === "Vimal Raj").length, 1);

  // A call of Prem's: its analysis, recording and upload are Prem's only.
  const job = "c".repeat(31) + "9";
  const [f] = await db.getPool().execute("INSERT INTO audio_files (user_id, stored_name, original_name, kind, file_format, size_bytes, sha256) VALUES (?, ?, 'Call with Vimal.wav', 'audio', 'wav', 1, ?)", [prem.id, `${job}.wav`, "0".repeat(64)]);
  await q("INSERT INTO processing_jobs (id, user_id, audio_file_id, kind, status, stage) VALUES (?, ?, ?, 'audio', 'failed', 'failed')", [job, prem.id, f.insertId]);
  assert.equal((await P.get(`/api/analysis/${job}`)).status, 200);
  assert.equal((await S.get(`/api/analysis/${job}`)).status, 404);
  assert.equal((await S.get(`/api/conversations/${job}/audio`)).status, 404);
  assert.equal((await S.post("/api/analysis", { filename: `${job}.wav` })).status, 404, "another account's upload cannot be analysed");
  assert.equal((await S.post("/api/audio/transcribe", { filename: `${job}.wav` })).status, 404);
  assert.equal((await S.post("/api/export/pdf", { job_id: job })).status, 404);

  // Inbox and commitments from Prem's call.
  const sid = "d".repeat(31) + "9";
  await q("INSERT INTO person_suggestions (id, user_id, job_id, name, name_key, relation, context, evidence, created_at) VALUES (?, ?, ?, 'Kavin', 'kavin', 'mentioned', 'A vendor.', '[]', UTC_TIMESTAMP(3))", [sid, prem.id, job]);
  const [sm] = await db.getPool().execute("INSERT INTO summaries (job_id, available) VALUES (?, 1)", [job]);
  const [ai] = await db.getPool().execute("INSERT INTO action_items (summary_id, seq, task) VALUES (?, 0, 'Send the quote')", [sm.insertId]);
  assert.equal((await P.get("/api/inbox/count")).body.pending, 1);
  assert.equal((await S.get("/api/inbox/count")).body.pending, 0);
  assert.equal((await S.get("/api/inbox")).body.items.length, 0);
  assert.equal((await S.post(`/api/inbox/${sid}/ignore`, {})).status, 404);
  assert.equal((await S.post(`/api/inbox/${sid}/add`, { name: "Kavin" })).status, 404);
  assert.equal((await S.post(`/api/commitments/${ai.insertId}`, { done: true })).status, 404);
  assert.equal((await P.post(`/api/commitments/${ai.insertId}`, { done: true })).status, 200);

  // Notifications: Prem's bell only. Sanjay reading "all" never touches Prem's.
  await q("INSERT INTO notifications (user_id, kind, title, dedupe_key, created_at, updated_at) VALUES (?, 'analysis', 'Call analysed: Call with Vimal', 'test:prem:1', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))", [prem.id]);
  const titles = async (A) => (await A.get("/api/notifications")).body.items.map((n) => n.title);
  assert.ok((await titles(P)).includes("Call analysed: Call with Vimal"));
  assert.ok(!(await titles(S)).includes("Call analysed: Call with Vimal"));
  const [n] = await q("SELECT id FROM notifications WHERE dedupe_key = 'test:prem:1'");
  assert.equal((await S.post("/api/notifications/read", { all: true })).status, 200);
  assert.equal((await S.post("/api/notifications/read", { ids: [Number(n.id)] })).body.changed, 0);
  assert.equal((await q("SELECT read_at FROM notifications WHERE id = ?", [n.id]))[0].read_at, null, "still unread for Prem");
  assert.equal((await S.post("/api/notification-settings", { digest: false })).status, 200);
  assert.equal((await P.get("/api/notification-settings")).body.settings.digest, true, "settings are per account");

  // The legacy person is still Prem's alone.
  assert.equal((await S.get(`/api/people/${legacyPerson}`)).status, 404);
});

test("email delivery failure: a clear 502, the unsent code stops working, nothing is half signed in", async () => {
  await q("DELETE FROM otp_challenges");
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
  const c = await codeFor(OWNER);
  await new Promise((res) => setTimeout(res, 1500));
  const late = await verify(OWNER, c);
  assert.equal(late.status, 400);
  assert.match(late.body.message, /expired/);
  config.AUTH.otpTtlSeconds = 300;
});

test("profile: account, room counts and signed-in devices; the name can be changed; other devices can be signed out", async () => {
  assert.equal((await fetch(base + "/api/auth/profile")).status, 401, "needs a session");
  await q("DELETE FROM sessions WHERE token_hash <> SHA2(?, 256) AND user_id = ?", [cookie.split("=")[1], legacyId]); // only this device

  // A second device (phone) signs in.
  const c = await codeFor(OWNER);
  const phoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const second = await post("/api/auth/otp/verify", { challenge_id: c.challenge_id, code: c.code, email: OWNER }, { "user-agent": phoneUa });
  assert.equal(second.status, 200);
  const phoneCookie = cookieOf(second);

  const p = await get("/api/auth/profile", cookie);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.user.name, "Prem Kumar");
  assert.equal(p.body.user.email_masked, "own•••••••@example.com");
  assert.ok(Date.parse(p.body.user.member_since) && Date.parse(p.body.user.last_login_at));
  assert.deepEqual(Object.keys(p.body.room ?? {}).sort(), ["conversations", "inbox_pending", "open_opportunities", "open_value_inr", "people"].sort());
  assert.equal(p.body.room.people, 2, "the room counts are this account's (Legacy Person, Vimal Raj)");
  assert.deepEqual(p.body.security, { method: "Email + one-time code", code_delivery: "console", session_days: 7, code_minutes: 5 });
  assert.equal(p.body.sessions.length, 2);
  const mine = p.body.sessions.find((s) => s.current);
  const other = p.body.sessions.find((s) => !s.current);
  assert.ok(mine && other);
  assert.equal(other.device, "Safari on iPhone");
  assert.doesNotMatch(JSON.stringify(p.body), /owner\.test@example\.com|token/i, "no full email or token in the profile");

  // The name: validated, saved, shown everywhere.
  assert.equal((await json(await post("/api/auth/profile", { name: "x" }, { cookie }))).status, 422);
  assert.equal((await json(await post("/api/auth/profile", { name: "Prem K" }, { cookie }))).status, 200);
  assert.equal((await get("/api/auth/me", cookie)).body.user.name, "Prem K");
  assert.equal((await get("/api/today", cookie)).body.owner, "Prem K");
  await post("/api/auth/profile", { name: "Prem Kumar" }, { cookie });

  // Settings (read-only): signed-in only; no credentials or emails in it.
  assert.equal((await fetch(base + "/api/settings")).status, 401);
  const st = await get("/api/settings", cookie);
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.login, { enabled: true, method: "email", code_delivery: "console", session_days: 7, signup: "open" });
  assert.equal(st.body.database.connected, true);
  assert.doesNotMatch(JSON.stringify(st.body), /example\.com|PASSWORD|SMTP_PASS|OCID|project-/i);
  const dbs = await get("/api/db/status", cookie);
  assert.doesNotMatch(JSON.stringify(dbs.body), /teemly_app|127\.0\.0\.1|teemly_db_test/, "no server details for accounts");

  // This device cannot be "revoked" (that is Sign out); bad ids are 404; cross-site writes are blocked;
  // another account's device cannot be signed out.
  assert.equal((await post(`/api/auth/sessions/${mine.id}/revoke`, {}, { cookie })).status, 409);
  assert.equal((await post("/api/auth/sessions/abc/revoke", {}, { cookie })).status, 404);
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie, origin: "https://evil.example" })).status, 403);
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie: sanjay })).status, 404);

  // Sign out the phone: it is signed out, this device is not.
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie })).status, 200);
  assert.equal((await get("/api/auth/me", phoneCookie)).body.user, null);
  assert.equal((await get("/api/auth/me", cookie)).body.user.name, "Prem Kumar");
  assert.equal((await post(`/api/auth/sessions/${other.id}/revoke`, {}, { cookie })).status, 404, "already signed out");

  // "Sign out everywhere else" keeps only this device.
  await signIn(OWNER);
  const all = await json(await post("/api/auth/sessions/revoke-others", {}, { cookie }));
  assert.equal(all.body.signed_out, 1);
  const after = await get("/api/auth/profile", cookie);
  assert.deepEqual(after.body.sessions.map((s) => s.current), [true]);
});

test("logout revokes the session", async () => {
  const out = await post("/api/auth/logout", {}, { cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await get("/api/auth/me", cookie)).body.user, null);
  assert.equal((await fetch(base + "/api/db/status", { headers: { cookie } })).status, 401);
  assert.equal((await get("/api/auth/me", sanjay)).body.user.name, "Sanjay TL", "other accounts stay signed in");
});

test("hourly limit per email", async () => {
  config.AUTH.otpMaxPerHour = 3;
  await q("DELETE FROM otp_challenges");
  for (let i = 0; i < 3; i++) assert.equal((await requestCode()).status, 200);
  const blocked = await requestCode();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.message, /Too many codes for this email/);
  config.AUTH.otpMaxPerHour = 5;
});
