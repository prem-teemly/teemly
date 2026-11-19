// People and the new-person inbox in MySQL, through the API, on the TEST database (teemly_db_test)
// with a fake Gemini. Synthetic conversations only.
//
// Run from backend/:  npm run test:db

import "./helpers/no-login.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DB_NAME = "teemly_db_test";
process.env.DB_ENABLED = "true";
process.env.OWNER_NAME = "Prem";
// Every request (and every job below) runs as test user 1, "Prem" (tests/helpers/no-login.js).
process.env.TEST_USER_ID = "1";
process.env.TEST_USER_NAME = "Prem";
const OWNER = { id: 1, name: "Prem" };
// Recordings for playback go to a temporary folder, never backend/uploads.
const UPLOADS = mkdtempSync(path.join(tmpdir(), "teemly-people-"));
process.env.UPLOAD_DIR = UPLOADS;

const config = await import("../src/config.js");
const db = await import("../src/db/pool.js");
const { migrate } = await import("../src/db/migrate.js");
const gemini = await import("../src/services/gemini.js");
const { afterJob, peopleDone } = await import("../src/services/peopleJob.js");
const { createApp } = await import("../src/app.js");
const { asTestUser, ensureTestUser } = await import("./helpers/db-user.js");
const notes = await asTestUser(await import("../src/db/notifications.js"));

// The fake model answers with whatever the current test puts in `answer`.
let answer = { people: [] };
const reply = (body) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] }, finishReason: "STOP" }], text: JSON.stringify(body) });
const fake = { models: { generateContent: async () => reply(answer) } };

let server;
let base;
const q = async (sql, params = []) => (await db.getPool().query(sql, params))[0];

const seg = (i, speaker, text, english) => ({ start: i * 3, end: i * 3 + 2, speaker, text, english });
function call(id, segments) {
  return {
    id,
    owner: OWNER,
    kind: "audio",
    status: "completed",
    result: { tamil_segments: segments.map(({ english, ...s }) => s), english_segments: segments.map((s) => ({ ...s, text: s.english })) },
  };
}
const msg = (index, sender, text) => ({ index, kind: "text", sender, timestamp: `2026-11-13T10:${String(index).padStart(2, "0")}:00`, text, english: text });
const chat = (id, messages) => ({ id, owner: OWNER, kind: "whatsapp", status: "completed", result: { messages } });

const JOBS = { A: "a".repeat(32), B: "b".repeat(32), C: "c".repeat(32), D: "d".repeat(32), E: "e".repeat(32), F: "1".repeat(32), G: "2".repeat(32), H: "3".repeat(32), I: "4".repeat(32), J: "5".repeat(32), K: "6".repeat(32), L: "7".repeat(32), M: "8".repeat(32), N: "9".repeat(32), O: "0".repeat(31) + "a", P: "0".repeat(31) + "b", Q: "0".repeat(31) + "c", R: "0".repeat(31) + "d", S: "0".repeat(31) + "e", T: "0".repeat(30) + "2a", U: "0".repeat(30) + "1a" };
async function seedJob(id, name, kind = "audio") {
  const [r] = await db.getPool().execute(
    "INSERT INTO audio_files (user_id, stored_name, original_name, kind, file_format, size_bytes, sha256, duration_seconds) VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
    [`${id}.${kind === "audio" ? "wav" : "txt"}`, name, kind, kind === "audio" ? "wav" : "txt", "0".repeat(64), kind === "audio" ? 55.5 : null],
  );
  await db.getPool().execute("INSERT INTO processing_jobs (user_id, id, audio_file_id, kind, status, stage) VALUES (1, ?, ?, ?, 'completed', 'done')", [id, r.insertId, kind]);
}
async function cleanup() {
  const ids = Object.values(JOBS);
  await q("DELETE FROM processing_jobs WHERE id IN (?)", [ids]); // mentions and suggestions cascade
  await q("DELETE FROM person_suggestions"); // test database: start from an empty inbox
  await q("UPDATE people SET introduced_by_id = NULL");
  await q("DELETE FROM people");
  await q("DELETE FROM department_suggestions"); // test database: start from an empty inbox
  await q("DELETE FROM departments WHERE built_in = 0"); // departments added by the tests
  await q("DELETE FROM audio_files WHERE stored_name IN (?)", [ids.flatMap((i) => [`${i}.wav`, `${i}.txt`])]);
}

const run = async (job) => {
  afterJob(job, Promise.resolve());
  return peopleDone(job.id);
};
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const inbox = async (status = "pending") => (await api("GET", `/api/inbox?status=${status}`)).body;
const people = async () => (await api("GET", "/api/people")).body.people;

const person = (over) => ({
  name: "Vimal", relation: "mentioned", category: "Expert", role_title: "AI developer", organisation: null, city: null,
  departments: ["Tech & AI"], interest: "high", introduced_by: null, context: "Interested in this product.", quote: null, evidence_ids: [1], ...over,
});

// Call A: Prem (owner) and his brother Sanjay talk; Vimal is talked about.
const CALL_A = call(JOBS.A, [
  seg(0, "Prem", "ஆமா, ஆமா", "Yes, yes"),
  seg(1, "Sanjay", "Sanjay here. Vimal-உம் இந்த product-ல interested-ஆ இருக்காரு, AI developer", "Vimal is also interested in this product, he is an AI developer"),
  seg(2, "Prem", "சரி, பேசலாம். Kavin Coimbatore-ல vendor, packaging பண்றாரு", "OK, let's talk. Kavin is a vendor in Coimbatore, he does packaging"),
]);

before(async () => {
  const [[{ name }]] = await db.getPool().query("SELECT DATABASE() AS name");
  if (name !== "teemly_db_test") throw new Error(`refusing to run: connected to ${name}, not teemly_db_test`);
  await migrate({ log: () => {} });
  await ensureTestUser(db.getPool(), OWNER);
  await cleanup();
  await seedJob(JOBS.A, "Call with Sanjay.m4a");
  await seedJob(JOBS.B, "Call with Arun.m4a");
  await seedJob(JOBS.C, "WhatsApp Chat with Arun.txt", "whatsapp");
  await seedJob(JOBS.D, "Call with Deepa.m4a");
  await seedJob(JOBS.E, "Call with Ravi.m4a");
  await seedJob(JOBS.F, "Lakshmi GST call.mp3");
  await seedJob(JOBS.G, "WhatsApp Chat with Lakshmi.txt", "whatsapp");
  await seedJob(JOBS.H, "Lakshmi follow-up.mp3");
  await seedJob(JOBS.I, "Ramesh distribution call.wav");
  await seedJob(JOBS.J, "Investors and logistics call.wav");
  await seedJob(JOBS.K, "Ramesh follow-up call.wav");
  await seedJob(JOBS.L, "Bala advisor call.wav");
  await seedJob(JOBS.M, "Bala printing call.wav");
  await seedJob(JOBS.N, "Bala visiting cards call.wav");
  await seedJob(JOBS.O, "Tender and agency call.wav");
  await seedJob(JOBS.P, "Investor advice call.wav");
  await seedJob(JOBS.Q, "Department edit call.wav");
  await seedJob(JOBS.R, "Bala ink call.wav");
  await seedJob(JOBS.S, "Premnath tech call.wav");
  await seedJob(JOBS.T, "Commitra first call.wav");
  await seedJob(JOBS.U, "Commitra second call.wav");
  gemini.setClientForTests(fake);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  gemini.setClientForTests(null);
  await cleanup();
  await db.closePool();
  rmSync(UPLOADS, { recursive: true, force: true });
});

test("a third person talked about goes to the inbox, not People; speakers are not suggested", async () => {
  assert.equal(config.AUTH.ownerName, "Prem");
  answer = {
    people: [
      person(),
      person({ name: "Kavin", category: "Vendor", role_title: "Packaging vendor", city: "Coimbatore", departments: ["Vendors"], interest: "unknown", context: "Packaging vendor in Coimbatore.", evidence_ids: [2] }),
      person({ name: "Sanjay", relation: "participant", category: "unclear", role_title: null, departments: [], context: "Owner's brother.", evidence_ids: [1] }),
      person({ name: "Prem", relation: "participant" }), // the owner: never anything
    ],
  };
  const found = await run(CALL_A);
  assert.deepEqual(found.map((p) => p.name).sort(), ["Kavin", "Sanjay", "Vimal"]);

  assert.deepEqual(await people(), [], "nobody is added to People without approval");
  const box = await inbox();
  assert.equal(box.pending, 2);
  assert.deepEqual(box.items.map((i) => i.name).sort(), ["Kavin", "Vimal"], "Sanjay is a speaker, not a suggestion");
  const vimal = box.items.find((i) => i.name === "Vimal");
  assert.equal(vimal.relation, "mentioned");
  assert.equal(vimal.category, "Expert");
  assert.deepEqual(vimal.departments, ["Tech & AI"]);
  assert.equal(vimal.context, "Interested in this product.");
  assert.deepEqual(vimal.matches, [], "no one in People has this name");
  assert.deepEqual(vimal.source, { job_id: JOBS.A, kind: "audio", file_name: "Call with Sanjay.m4a", duration_seconds: 55.5 });
  assert.equal(vimal.evidence.length, 1);
  assert.deepEqual([vimal.evidence[0].id, vimal.evidence[0].speaker, vimal.evidence[0].time_label], [1, "Sanjay", "00:03"]);
  assert.match(vimal.evidence[0].text, /Vimal/);
  assert.equal((await api("GET", "/api/inbox/count")).body.pending, 2);
});

test("processing the same call again does not duplicate inbox items", async () => {
  await run(CALL_A);
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM person_suggestions WHERE job_id = ?", [JOBS.A]);
  assert.equal(n, 2);
});

test("add: the owner's edits are saved; the person is in People with the call on their timeline", async () => {
  const vimal = (await inbox()).items.find((i) => i.name === "Vimal");
  const r = await api("POST", `/api/inbox/${vimal.id}/add`, {
    name: "Vimal", city: "Chennai", phone: "98765 43210", category: "Business partner", departments: ["Tech & AI", "Sales"], consent: "Ask", context: "AI developer, interested in this product.",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const all = await people();
  assert.equal(all.length, 1);
  const p = all[0];
  assert.equal(p.id, r.body.person_id);
  assert.deepEqual([p.name, p.city, p.phone, p.category, p.category_locked], ["Vimal", "Chennai", "+919876543210", "Business partner", true]);
  assert.deepEqual(p.departments.sort(), ["Sales", "Tech & AI"]);
  assert.equal(p.summary, "AI developer, interested in this product.");
  const detail = (await api("GET", `/api/people/${p.id}`)).body;
  assert.deepEqual(detail.mentions.map((m) => [m.job_id, m.kind, m.relation]), [[JOBS.A, "audio", "mentioned"]]);
  const [row] = await q("SELECT evidence_lines FROM person_mentions WHERE person_id = ?", [p.id]);
  assert.deepEqual(row.evidence_lines, [1]);

  const box = await inbox();
  assert.deepEqual(box.items.map((i) => i.name), ["Kavin"]);
  assert.equal((await inbox("added")).items[0].person_id, p.id);
  assert.equal((await api("POST", `/api/inbox/${vimal.id}/add`, { name: "Vimal" })).status, 409, "an item is decided once");
  const [audit] = await q("SELECT event FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1", [vimal.id]);
  assert.equal(audit.event, "inbox.added");
});

test("ignore: not added; the same call never suggests them again", async () => {
  const kavin = (await inbox()).items.find((i) => i.name === "Kavin");
  assert.equal((await api("POST", `/api/inbox/${kavin.id}/ignore`)).status, 200);
  assert.equal((await api("POST", `/api/inbox/${kavin.id}/ignore`)).status, 409);
  assert.ok(!(await people()).some((p) => p.name === "Kavin"));
  await run(CALL_A); // processed again: Kavin stays ignored, Vimal (now in People) gets this call once
  assert.equal((await inbox()).pending, 0);
  assert.equal((await inbox("ignored")).items[0].name, "Kavin");
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM person_mentions WHERE job_id = ?", [JOBS.A]);
  assert.equal(n, 1);
});

test("someone already in People is not suggested again: the call joins their timeline; the owner's category is kept", async () => {
  answer = { people: [person({ category: "Investor", city: null, organisation: "Vimal Tech", interest: "medium", context: "Asked for the pricing deck.", evidence_ids: [0] })] };
  await run(call(JOBS.B, [seg(0, "Arun", "Vimal pricing deck கேட்டாரு", "Vimal asked for the pricing deck"), seg(1, "Prem", "சரி", "OK")]));
  assert.equal((await inbox()).pending, 0);
  const [p] = await people();
  assert.equal(p.mention_count, 2);
  assert.equal(p.category, "Business partner", "a category the owner chose is not changed by the AI");
  assert.equal(p.city, "Chennai", "a conversation that does not say the city keeps it");
  assert.equal(p.organisation, "Vimal Tech", "new facts are added");
  assert.equal(p.score, 78, "the latest call (medium, 65) half, the earlier (high, 90) half: 77.5");
});

test("interest in words: the latest call weighs half; no call that shows it is 'not clear yet', never a guess", async () => {
  const { interestScore, interestLevel } = await import("../src/services/people.js");
  assert.equal(interestScore([]), null);
  assert.equal(interestScore(["unknown", "unknown"]), null, "only calls that do not show it: not clear yet");
  assert.equal(interestScore(["high"]), 90);
  assert.equal(interestScore(["unknown", "medium", "unknown"]), 65, "unknown calls do not count");
  assert.equal(interestScore(["high", "high", "low"]), 65, "keen before, hesitant now: down to Interested");
  assert.equal(interestScore(["low", "high"]), 65, "warming up");
  assert.equal(interestScore(["none"]), 10);
  assert.deepEqual([90, 75, 74, 55, 54, 30, 29, 10, null].map(interestLevel), ["very", "very", "interested", "interested", "slight", "slight", "not", "not", "unclear"]);
  // A person added by hand (no call yet) has no score: "Not clear yet", not 50.
  const r = await api("POST", "/api/people", { name: "Zzinterest Nobody", phone: "+91 90000 31313" });
  assert.equal(r.status, 201);
  assert.equal((await api("GET", `/api/people/${r.body.person_id}`)).body.person.score, null);
  await q("DELETE FROM people WHERE id = ?", [r.body.person_id]);
});

test("WhatsApp: senders are participants; the person talked about joins the same profile (Audio + WhatsApp timeline)", async () => {
  answer = {
    people: [
      person({ name: "Vimal", category: "unclear", departments: [], interest: "high", context: "Wants a demo on Friday.", evidence_ids: [1] }),
      person({ name: "Meena", category: "HNI", role_title: null, city: null, departments: ["Investment"], interest: "medium", introduced_by: "Vimal", context: "Vimal's friend, may invest.", evidence_ids: [2] }),
    ],
  };
  await run(chat(JOBS.C, [msg(0, "Prem", "Hi Arun"), msg(1, "Arun", "Vimal wants a demo on Friday"), msg(2, "Arun", "Vimal's friend Meena may invest too")]));
  const [p] = (await people()).filter((x) => x.name === "Vimal");
  const detail = (await api("GET", `/api/people/${p.id}`)).body;
  assert.deepEqual(detail.mentions.map((m) => m.kind).sort(), ["audio", "audio", "whatsapp"], "one profile, both sources");
  assert.equal(detail.person.last_contact_kind, "whatsapp");

  const meena = (await inbox()).items.find((i) => i.name === "Meena");
  assert.equal(meena.source.kind, "whatsapp");
  assert.deepEqual(meena.evidence.map((e) => [e.id, e.speaker, e.text]), [[2, "Arun", "Vimal's friend Meena may invest too"]]);
  assert.deepEqual(meena.introduced_by, { name: "Vimal", person: { id: p.id, name: "Vimal" } }, "the introducer is a known person");
  const r = await api("POST", `/api/inbox/${meena.id}/add`, { name: "Meena" });
  assert.equal(r.status, 200);
  const added = (await api("GET", `/api/people/${r.body.person_id}`)).body.person;
  assert.deepEqual([added.category, added.category_locked, added.introduced_by?.name], ["HNI", false, "Vimal"], "untouched AI category stays open to later updates");
});

test("profile timeline: upload time, length, summary line, evidence lines; commitments can be ticked; the recording plays", async () => {
  assert.equal(config.UPLOAD_DIR, UPLOADS);
  // What the call analysis stored for call A: a decision, two commitments, Pulse interest and a concern.
  const [sm] = await db.getPool().execute("INSERT INTO summaries (job_id, available) VALUES (?, 1)", [JOBS.A]);
  await q("INSERT INTO decisions (summary_id, seq, decision) VALUES (?, 0, 'Send Vimal the API docs')", [sm.insertId]);
  await q(
    "INSERT INTO action_items (summary_id, seq, task, responsible_person, deadline_text) VALUES (?, 0, 'Send API docs to Vimal', 'Prem', 'Friday'), (?, 1, 'Book the Coimbatore office', 'Sanjay', NULL)",
    [sm.insertId, sm.insertId],
  );
  await q("INSERT INTO pulse_insights (job_id, row_type, seq, overall_interest) VALUES (?, 'overview', 0, 'medium')", [JOBS.A]);
  await q("INSERT INTO pulse_insights (job_id, row_type, seq, category, level) VALUES (?, 'signal', 1, 'question_concern', 'high')", [JOBS.A]);

  const vimal = (await people()).find((p) => p.phone === "+919876543210"); // the first Vimal (call A)
  const d = (await api("GET", `/api/people/${vimal.id}`)).body;
  const call = d.mentions.find((m) => m.job_id === JOBS.A);
  const [[up]] = await db.getPool().query("SELECT UNIX_TIMESTAMP(f.created_at) AS t FROM processing_jobs j JOIN audio_files f ON f.id = j.audio_file_id WHERE j.id = ?", [JOBS.A]);
  assert.equal(Date.parse(call.at), Math.round(Number(up.t) * 1000), "the time shown is when the recording was uploaded");
  assert.ok(Math.abs(Date.parse(call.at) - Date.now()) < 10 * 60_000, `upload time is now, not shifted by the time zone (${call.at})`);
  assert.equal(call.duration_seconds, 55.5);
  assert.deepEqual([call.tone, call.commitment_count, call.new_people, call.headline, call.concern], ["Interested", 2, 2, "Send Vimal the API docs", "high"]);
  assert.deepEqual(call.evidence_lines, [1], "the lines where he is talked about");
  assert.equal(call.introduced_by_name, null);
  const chatMention = d.mentions.find((m) => m.kind === "whatsapp");
  assert.equal(typeof chatMention.message_count, "number");
  assert.equal(call.message_count, null);
  const times = d.mentions.map((m) => Date.parse(m.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest upload first");

  // Commitments: the one that names him (he only was talked about in call A); the owner's shows as "You".
  assert.deepEqual(d.commitments.map((c) => [c.task, c.who, c.due, c.done]), [["Send API docs to Vimal", "You", "Friday", false]]);
  const cid = d.commitments[0].id;
  assert.equal((await api("POST", `/api/commitments/${cid}`, { done: true })).status, 200);
  const afterPage = (await api("GET", `/api/people/${vimal.id}`)).body;
  assert.equal(afterPage.commitments.length, 0, "ticked off: no longer in the open list");
  assert.deepEqual(afterPage.commitments_page.counts, { open: 0, theirs: 0, yours: 0, done: 1 });
  const after = (await api("GET", `/api/people/${vimal.id}/commitments?view=done`)).body.items[0];
  assert.equal(after.done, true);
  assert.ok(after.done_at);
  assert.equal((await api("POST", `/api/commitments/${cid}`, { done: "yes" })).status, 422);
  assert.equal((await api("POST", "/api/commitments/abc", { done: true })).status, 404);
  assert.equal((await api("POST", "/api/commitments/999999999", { done: true })).status, 404);

  // Playback: the stored recording, with seeking (Range); chats and unknown ids have none.
  assert.equal((await api("GET", `/api/conversations/${JOBS.A}/audio`)).status, 404, "file not stored yet");
  writeFileSync(path.join(UPLOADS, `${JOBS.A}.wav`), Buffer.from("RIFF0000WAVEfmt fake-audio-bytes"));
  const full = await fetch(`${base}/api/conversations/${JOBS.A}/audio`);
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-type"), /audio\/(wav|x-wav|wave)/);
  assert.equal(full.headers.get("cache-control"), "private, no-store");
  const part = await fetch(`${base}/api/conversations/${JOBS.A}/audio`, { headers: { Range: "bytes=0-3" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "RIFF");
  assert.equal((await fetch(`${base}/api/conversations/${JOBS.C}/audio`)).status, 404, "a chat has no recording");
  assert.equal((await fetch(`${base}/api/conversations/..%2F..%2Fetc/audio`)).status, 404);
  assert.equal((await fetch(`${base}/api/conversations/${"f".repeat(32)}/audio`)).status, 404);
});

test("same name, different people: never merged; the owner chooses who it is", async () => {
  // A second, different Vimal (a vendor in Madurai) is added from another call.
  answer = { people: [person({ name: "Vimal", category: "Vendor", role_title: "Printer", city: "Madurai", departments: ["Vendors"], interest: "unknown", context: "Printing vendor in Madurai.", evidence_ids: [0] })] };
  await q("UPDATE people SET name_key = 'vimal-temp' WHERE name = 'Vimal'"); // hide the first Vimal so this call suggests a new one
  await run(call(JOBS.D, [seg(0, "Deepa", "Madurai Vimal printing பண்றாரு", "Vimal in Madurai does printing"), seg(1, "Prem", "ok", "ok")]));
  await q("UPDATE people SET name_key = 'vimal' WHERE name_key = 'vimal-temp'");
  const item = (await inbox()).items.find((i) => i.source.job_id === JOBS.D);
  assert.equal(item.matches.length, 1, "the inbox shows the existing Vimal as a possible match");
  const unconfirmed = await api("POST", `/api/inbox/${item.id}/add`, { name: "Vimal", city: "Madurai", phone: "+91 90000 00455" });
  assert.equal(unconfirmed.status, 409, "a Vimal is in People: a new one only once the owner says it is someone else");
  assert.equal(unconfirmed.body.code, "same_name");
  assert.equal(unconfirmed.body.existing[0].name, "Vimal");
  const second = await api("POST", `/api/inbox/${item.id}/add`, { name: "Vimal", city: "Madurai", phone: "+91 90000 00455", same_name_ok: true });
  assert.equal(second.status, 200);
  assert.equal((await people()).filter((p) => p.name === "Vimal").length, 2, "a second person with the same name");

  // A later call mentions "Vimal": two people match, so it goes to the inbox to choose.
  answer = { people: [person({ name: "Vimal", category: "unclear", departments: [], interest: "low", context: "Sent the invoice.", evidence_ids: [0] })] };
  await run(call(JOBS.E, [seg(0, "Ravi", "Vimal invoice அனுப்பிட்டாரு", "Vimal sent the invoice"), seg(1, "Prem", "ok", "ok")]));
  const choose = (await inbox()).items.find((i) => i.source.job_id === JOBS.E);
  assert.equal(choose.matches.length, 2);
  assert.ok(choose.matches.every((m) => m.id && m.name === "Vimal" && typeof m.mention_count === "number"));
  const r = await api("POST", `/api/inbox/${choose.id}/add`, { person_id: second.body.person_id });
  assert.equal(r.status, 200);
  assert.equal(r.body.person_id, second.body.person_id);
  const madurai = (await api("GET", `/api/people/${second.body.person_id}`)).body;
  assert.deepEqual(madurai.mentions.map((m) => m.job_id).sort(), [JOBS.D, JOBS.E]);
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM person_mentions WHERE job_id = ?", [JOBS.E]);
  assert.equal(n, 1, "only the chosen Vimal gets the call");
});

test("validation and conflicts: bad input is 422, a phone number belongs to one person, bad ids are 404", async () => {
  const two = [
    person({ name: "Hari", context: "Hari runs a design studio.", evidence_ids: [0] }),
    person({ name: "Gopi", context: "Gopi knows the collector.", evidence_ids: [1] }),
  ];
  answer = { people: two };
  await q("DELETE FROM person_suggestions WHERE job_id = ?", [JOBS.B]);
  await run(call(JOBS.B, [seg(0, "Arun", "Hari design studio வச்சிருக்காரு", "Hari runs a design studio"), seg(1, "Arun", "Gopi collector-ஐ தெரியும்", "Gopi knows the collector")]));
  const items = (await inbox()).items.filter((i) => i.source.job_id === JOBS.B);
  const hari = items.find((i) => i.name === "Hari");
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { name: "Hari", phone: "12ab" })).status, 422);
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { name: "Hari", category: "Friend" })).status, 422);
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { name: "Hari", departments: ["Nope"] })).status, 422);
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { name: "" })).status, 422);
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { person_id: "../x" })).status, 422);
  assert.equal((await api("POST", `/api/inbox/${hari.id}/add`, { person_id: "f".repeat(32) })).status, 404);
  const dup = await api("POST", `/api/inbox/${hari.id}/add`, { name: "Hari", phone: "9876543210" }); // Vimal's number
  assert.equal(dup.status, 409);
  assert.equal((await inbox()).items.find((i) => i.id === hari.id).status, "pending", "a failed add changes nothing");
  assert.equal((await api("POST", `/api/inbox/${"f".repeat(32)}/add`, { name: "X" })).status, 404);
  assert.equal((await api("POST", "/api/inbox/zzz/ignore")).status, 404);
});

test("two adds of the same item at once: exactly one person is created", async () => {
  const gopi = (await inbox()).items.find((i) => i.name === "Gopi");
  const before = (await people()).length;
  const results = await Promise.all([1, 2, 3].map(() => api("POST", `/api/inbox/${gopi.id}/add`, { name: "Gopi" })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await people()).length, before + 1);
});

test("a model failure is logged, never thrown; nothing is stored", async () => {
  gemini.setClientForTests({ models: { generateContent: async () => { throw Object.assign(new Error("boom"), { status: 400 }); } } });
  const pending = (await inbox()).pending;
  assert.equal(await run(call(JOBS.E, [seg(0, "Prem", "Hi Kumar", "Hi Kumar")])), null);
  gemini.setClientForTests(fake);
  assert.equal((await inbox()).pending, pending);
});

test("notes: add, pin, edit, delete; stored in MySQL and shown pinned first", async () => {
  const vimal = (await people()).find((p) => p.phone === "+919876543210"); // the first Vimal (call A)
  const a = await api("POST", `/api/people/${vimal.id}/notes`, { body: "  Prefers calls after 6 PM.\r\nSpeaks Tamil.  " });
  assert.equal(a.status, 201);
  assert.equal(a.body.note.body, "Prefers calls after 6 PM.\nSpeaks Tamil.");
  assert.equal(a.body.note.pinned, false);
  await new Promise((r) => setTimeout(r, 5));
  const b = await api("POST", `/api/people/${vimal.id}/notes`, { body: "Met at the Chennai AI meetup." });
  let notes = (await api("GET", `/api/people/${vimal.id}`)).body.notes;
  assert.deepEqual(notes.map((n) => n.id), [b.body.note.id, a.body.note.id], "newest first");

  const pinnedNote = await api("POST", `/api/notes/${a.body.note.id}`, { pinned: true });
  assert.equal(pinnedNote.status, 200);
  assert.equal(pinnedNote.body.note.updated_at, pinnedNote.body.note.created_at, "pinning is not an edit");
  const edited = await api("POST", `/api/notes/${b.body.note.id}`, { body: "Met at the Chennai AI meetup in Oct." });
  assert.equal(edited.body.note.body, "Met at the Chennai AI meetup in Oct.");
  assert.ok(Date.parse(edited.body.note.updated_at) >= Date.parse(edited.body.note.created_at));
  notes = (await api("GET", `/api/people/${vimal.id}`)).body.notes;
  assert.deepEqual(notes.map((n) => [n.id, n.pinned]), [[a.body.note.id, true], [b.body.note.id, false]], "pinned first");

  assert.equal((await api("POST", `/api/people/${vimal.id}/notes`, { body: "   " })).status, 422);
  assert.equal((await api("POST", `/api/people/${vimal.id}/notes`, { body: "x".repeat(4001) })).status, 422);
  assert.equal((await api("POST", `/api/notes/${a.body.note.id}`, { pinned: "yes" })).status, 422);
  assert.equal((await api("POST", `/api/notes/${a.body.note.id}`, {})).status, 422);
  assert.equal((await api("POST", `/api/people/${"f".repeat(32)}/notes`, { body: "x" })).status, 404);
  assert.equal((await api("POST", `/api/notes/${"f".repeat(32)}`, { body: "x" })).status, 404);
  assert.equal((await api("DELETE", `/api/notes/${b.body.note.id}`)).status, 200);
  assert.equal((await api("DELETE", `/api/notes/${b.body.note.id}`)).status, 404);
  assert.deepEqual((await api("GET", `/api/people/${vimal.id}`)).body.notes.map((n) => n.id), [a.body.note.id]);
  // Audit rows are written in the background: wait briefly for this one.
  let deletedRows = [];
  for (let i = 0; i < 20 && !deletedRows.length; i++) {
    deletedRows = await q("SELECT event FROM audit_logs WHERE entity_id = ? AND event = 'note.deleted'", [b.body.note.id]);
    if (!deletedRows.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(deletedRows.length, 1, "note.deleted is in the audit log");
});

test("opportunities: create from a call, move through stages, edit, delete; validated and stored", async () => {
  const vimal = (await people()).find((p) => p.phone === "+919876543210"); // the first Vimal (call A)
  const r = await api("POST", `/api/people/${vimal.id}/opportunities`, {
    title: "Speech model prototype", department: "Tech & AI", value_inr: "2,50,000", next_step: "Share API docs", due_date: "2026-11-20", source_job_id: JOBS.A,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = r.body.opportunity;
  assert.deepEqual(
    [o.title, o.stage, o.department, o.value_inr, o.next_step, o.due_date, o.closed_at],
    ["Speech model prototype", "Identified", "Tech & AI", 250000, "Share API docs", "2026-11-20", null],
  );
  assert.deepEqual([o.source.job_id, o.source.kind, o.source.file_name], [JOBS.A, "audio", "Call with Sanjay.m4a"]);
  assert.ok(Math.abs(Date.parse(o.source.at) - Date.now()) < 10 * 60_000, `source upload time is now (${o.source.at})`);
  const second = (await api("POST", `/api/people/${vimal.id}/opportunities`, { title: "Referral to his ML company" })).body.opportunity;
  assert.deepEqual([second.stage, second.value_inr, second.due_date, second.source], ["Identified", null, null, null]);

  // Stages: Won closes it (closed_at set once); moving back reopens it.
  const won = (await api("POST", `/api/opportunities/${o.id}`, { stage: "Won" })).body.opportunity;
  assert.equal(won.stage, "Won");
  assert.ok(won.closed_at);
  const again = (await api("POST", `/api/opportunities/${o.id}`, { stage: "Lost" })).body.opportunity;
  assert.equal(again.closed_at, won.closed_at, "already closed: the date is kept");
  const reopened = (await api("POST", `/api/opportunities/${o.id}`, { stage: "In discussion", value_inr: 300000, due_date: null })).body.opportunity;
  assert.deepEqual([reopened.stage, reopened.closed_at, reopened.value_inr, reopened.due_date, reopened.title], ["In discussion", null, 300000, null, "Speech model prototype"]);

  const list = (await api("GET", `/api/people/${vimal.id}`)).body.opportunities;
  assert.deepEqual(list.map((x) => x.id).sort(), [o.id, second.id].sort());

  // Validation.
  const bad = async (body) => (await api("POST", `/api/people/${vimal.id}/opportunities`, body)).status;
  assert.equal(await bad({}), 422, "title is required");
  assert.equal(await bad({ title: "  " }), 422);
  assert.equal(await bad({ title: "x".repeat(161) }), 422);
  assert.equal(await bad({ title: "X", stage: "Maybe" }), 422);
  assert.equal(await bad({ title: "X", department: "HR" }), 422);
  assert.equal(await bad({ title: "X", value_inr: -5 }), 422);
  assert.equal(await bad({ title: "X", value_inr: "lots" }), 422);
  assert.equal(await bad({ title: "X", due_date: "2026-02-30" }), 422);
  assert.equal(await bad({ title: "X", due_date: "20/11/2026" }), 422);
  assert.equal(await bad({ title: "X", source_job_id: "../x" }), 422);
  assert.equal(await bad({ title: "X", source_job_id: JOBS.D }), 422, "a call that is not on his timeline");
  assert.equal((await api("POST", `/api/opportunities/${o.id}`, { title: null })).status, 422);
  assert.equal((await api("POST", `/api/opportunities/${"f".repeat(32)}`, { stage: "Won" })).status, 404);
  assert.equal((await api("POST", `/api/people/${"f".repeat(32)}/opportunities`, { title: "X" })).status, 404);

  assert.equal((await api("DELETE", `/api/opportunities/${second.id}`)).status, 200);
  assert.equal((await api("DELETE", `/api/opportunities/${second.id}`)).status, 404);
  // Audit rows are written in the background: wait for the last update's row.
  let fields = [];
  for (let i = 0; i < 20 && fields.length !== 3; i++) {
    const rows = await q("SELECT detail FROM audit_logs WHERE entity_id = ? AND event = 'opportunity.updated'", [o.id]);
    fields = rows.map((r) => r.detail.fields).find((f) => f.length === 3) ?? [];
    if (fields.length !== 3) await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual([...fields].sort(), ["due_date", "stage", "value_inr"]);

  // Deleting the source conversation keeps the opportunity; deleting the person removes it.
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM opportunities WHERE person_id = ?", [vimal.id]);
  assert.equal(n, 1);
});

test("phone number: set (normalised), change, clear; one person per number", async () => {
  const vimal = (await people()).find((p) => p.phone === "+919876543210");
  const other = (await people()).find((p) => p.name === "Meena");
  assert.equal((await api("POST", `/api/people/${other.id}/phone`, { phone: "098400 11122" })).body.phone, "+919840011122");
  assert.equal((await api("GET", `/api/people/${other.id}`)).body.person.phone, "+919840011122");
  assert.equal((await api("POST", `/api/people/${other.id}/phone`, { phone: "+91 98765 43210" })).status, 409, "Vimal's number");
  assert.equal((await api("POST", `/api/people/${other.id}/phone`, { phone: "12ab" })).status, 422);
  assert.equal((await api("POST", `/api/people/${other.id}/phone`, { phone: 42 })).status, 422);
  assert.equal((await api("POST", `/api/people/${other.id}/phone`, { phone: null })).body.phone, null);
  assert.equal((await api("GET", `/api/people/${other.id}`)).body.person.phone, null);
  assert.equal((await api("POST", `/api/people/${"f".repeat(32)}/phone`, { phone: "9840011122" })).status, 404);
  assert.equal((await api("GET", `/api/people/${vimal.id}`)).body.person.phone, "+919876543210");
});

test("Add file on a person's page: the call or chat goes on THEIR timeline (named or not, same name or not, AI or no AI)", async () => {
  // Lakshmi is in People; a second, different Lakshmi too.
  const mk = async (name, city) => {
    const [r] = await db.getPool().execute(
      "INSERT INTO people (user_id, id, name, name_key, city, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, ?, 'lakshmi', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'audio')",
      [name, "Lakshmi", city],
    );
    return r;
  };
  const L1 = "4".repeat(32);
  const L2 = "5".repeat(32);
  await mk(L1, "Madurai");
  await mk(L2, "Salem");
  const job = (id, kind, extra) => ({ ...(kind === "whatsapp" ? chat(id, extra.messages) : call(id, extra.segments)), personId: L1 });

  // 1. A call where her name is never said: added as a participant, with the call's summary.
  answer = { people: [person({ name: "Ravi", context: "Ravi will send the bank statements.", evidence_ids: [0] })] };
  const j1 = job(JOBS.F, "audio", { segments: [seg(0, "Speaker 2", "Ravi bank statements அனுப்புவாரு", "Ravi will send the bank statements"), seg(1, "Prem", "சரி", "OK")] });
  j1.result.analysis = { available: true, data: { summary: "GST filing for October: documents needed from Ravi." } };
  await run(j1);
  let d = (await api("GET", `/api/people/${L1}`)).body;
  const m1 = d.mentions.find((m) => m.job_id === JOBS.F);
  assert.ok(m1, "the call is on Lakshmi's timeline");
  assert.deepEqual([m1.relation, m1.context], ["participant", "GST filing for October: documents needed from Ravi."]);
  assert.ok((await inbox()).items.some((i) => i.source.job_id === JOBS.F && i.name === "Ravi"), "other new people still go to the inbox");

  // 2. A chat that names "Lakshmi": two people have that name, but it is the one whose page it was added on.
  answer = { people: [person({ name: "Lakshmi", relation: "participant", category: "Vendor", role_title: "Chartered accountant", city: "Madurai", departments: ["Accounts"], interest: "medium", context: "Will file GST by the 20th.", evidence_ids: [1] })] };
  await run(job(JOBS.G, "whatsapp", { messages: [msg(0, "Prem", "Hi Lakshmi"), msg(1, "Lakshmi", "Madurai office la irundhu GST file pannidren by 20th")] }));
  d = (await api("GET", `/api/people/${L1}`)).body;
  const m2 = d.mentions.find((m) => m.job_id === JOBS.G);
  assert.deepEqual([m2?.kind, m2?.context, d.person.role_title], ["whatsapp", "Will file GST by the 20th.", "Chartered accountant"]);
  assert.ok(!(await inbox()).items.some((i) => i.source.job_id === JOBS.G), "no 'which Lakshmi?' question for a file added on her page");
  assert.equal((await api("GET", `/api/people/${L2}`)).body.mentions.length, 0, "the other Lakshmi gets nothing");

  // 3. The AI fails: the file is still on her timeline.
  gemini.setClientForTests({ models: { generateContent: async () => { throw Object.assign(new Error("boom"), { status: 400 }); } } });
  await run(job(JOBS.H, "audio", { segments: [seg(0, "Prem", "ok", "ok")] }));
  gemini.setClientForTests(fake);
  d = (await api("GET", `/api/people/${L1}`)).body;
  assert.equal(d.mentions.find((m) => m.job_id === JOBS.H)?.context, "Call added to Lakshmi's timeline.");
  assert.equal(d.mentions.length, 3);

  // Uploads: person_id is checked before anything starts.
  assert.equal((await api("POST", "/api/analysis", { filename: "x.mp3", person_id: "../x" })).status, 422);
  assert.equal((await api("POST", "/api/analysis", { filename: "x.mp3", person_id: "f".repeat(32) })).status, 404);
  assert.equal((await api("POST", "/api/analysis", { filename: "x.mp3", person_id: 7 })).status, 422);
  // Chat upload was removed (the chat above stands for one analysed before that): no route takes one.
  assert.ok([404, 405].includes((await api("POST", "/api/whatsapp/process", { filename: "x.txt", person_id: L1 })).status));
  await q("DELETE FROM people WHERE id IN (?, ?)", [L1, L2]);
});

test("deleting a person keeps the inbox history; deleted people are 404", async () => {
  const vimalNow = (await people()).find((p) => p.phone === "+919876543210");
  assert.equal((await api("DELETE", `/api/people/${vimalNow.id}`)).status, 200);
  const [{ n: left }] = await q("SELECT (SELECT COUNT(*) FROM opportunities WHERE person_id = ?) + (SELECT COUNT(*) FROM person_notes WHERE person_id = ?) AS n", [vimalNow.id, vimalNow.id]);
  assert.equal(Number(left), 0, "a deleted person's notes and opportunities are deleted too");
  const kept = (await people()).find((p) => p.name === "Meena");
  assert.equal((await api("DELETE", `/api/people/${kept.id}`)).status, 200);
  assert.equal((await api("GET", `/api/people/${kept.id}`)).status, 404);
  const item = (await inbox("added")).items.find((i) => i.name === "Meena");
  assert.equal(item.person_id, null);
  assert.equal((await api("GET", "/api/people/../../etc")).status, 404);
});

test("opportunities found in a call: wait on the inbox item, are added with the person, link the call and its lines, never twice", async () => {
  const CALL_I = call(JOBS.I, [
    // Sanjay talks about Ramesh Kumar (someone talked about, not a speaker, so he is suggested).
    seg(0, "Prem", "Hello Sanjay", "Hello Sanjay"),
    seg(1, "Sanjay", "Ramesh Kumar Madurai-ல distributor. South Tamil Nadu-ல Teemly sell பண்ணலாம்", "Ramesh Kumar is a distributor in Madurai. He can sell Teemly in south Tamil Nadu"),
    seg(2, "Sanjay", "Ramesh first order fifty licences, five lakh rupees", "Ramesh's first order is fifty licences, five lakh rupees"),
    seg(3, "Prem", "Demo Monday", "Demo on Monday"),
  ]);
  const opp = (over) => ({ title: "South TN distribution of Teemly", stage: "In discussion", department: "Channel partners", value_inr: 500000, next_step: "Demo on Monday", evidence_ids: [1, 2], ...over });
  answer = {
    people: [
      person({
        name: "Ramesh Kumar", relation: "mentioned", category: "Business partner", role_title: "Distributor", city: "Madurai", departments: ["Channel partners"],
        context: "Distributor in Madurai.", evidence_ids: [1],
        opportunities: [
          opp(),
          opp({ title: "south tn distribution of teemly" }), // the same one again: kept once
          opp({ title: "Made-up deal", evidence_ids: [99] }), // no real line: dropped
          opp({ title: "Odd values", stage: "Pitch / bid shared", department: "unclear", value_inr: 0, next_step: "  ", evidence_ids: [3, 99] }), // cleaned
        ],
      }),
    ],
  };
  await run(CALL_I);

  // New person: the opportunities wait on the inbox item; nothing is created yet.
  const item = (await inbox()).items.find((i) => i.name === "Ramesh Kumar");
  assert.deepEqual(item.opportunities.map((o) => o.title), ["South TN distribution of Teemly", "Odd values"]);
  const odd = item.opportunities[1];
  assert.deepEqual([odd.stage, odd.department, odd.value_inr, odd.next_step], ["Pitch / bid shared", null, null, null], "no department, amount or step unless one was said");
  assert.equal(Number((await q("SELECT COUNT(*) AS n FROM opportunities WHERE source_job_id = ?", [JOBS.I]))[0].n), 0);

  // Approved: the person gets them, linked to the call, with the lines that say so.
  const added = await api("POST", `/api/inbox/${item.id}/add`, { name: "Ramesh Kumar" });
  assert.equal(added.status, 200);
  const id = added.body.person_id;
  let d = (await api("GET", `/api/people/${id}`)).body;
  assert.equal(d.opportunities.length, 2);
  const o = d.opportunities.find((x) => x.title === "South TN distribution of Teemly");
  assert.equal(o.origin, "ai");
  assert.deepEqual([o.stage, o.department, o.value_inr, o.next_step], ["In discussion", "Channel partners", 500000, "Demo on Monday"]);
  assert.equal(o.source.job_id, JOBS.I);
  assert.equal(o.source.file_name, "Ramesh distribution call.wav");
  assert.equal(o.source.duration_seconds, 55.5);
  assert.deepEqual(o.evidence.map((e) => [e.id, e.speaker, e.time_label, e.start]), [[1, "Sanjay", "00:03", 3], [2, "Sanjay", "00:06", 6]]);
  assert.match(o.evidence[1].english, /five lakh/);
  assert.equal(d.mentions.find((m) => m.job_id === JOBS.I).opportunity_count, 2, "the timeline shows the call's opportunities");

  // The same call processed again (Ramesh is now in People): nothing is duplicated, even when the AI
  // words the title differently the second time.
  await run(CALL_I);
  d = (await api("GET", `/api/people/${id}`)).body;
  assert.equal(d.opportunities.length, 2);
  answer.people[0].opportunities = [opp({ title: "Distribution partnership for south Tamil Nadu" })];
  await run(CALL_I);
  d = (await api("GET", `/api/people/${id}`)).body;
  assert.equal(d.opportunities.length, 2, "reworded title: still captured once per conversation");

  // A later call talks about the same deal again (worded differently): it moves on, no copy is added.
  // A new deal in that call is added.
  const CALL_K = call(JOBS.K, [
    seg(0, "Prem", "Hi Sanjay", "Hi Sanjay"),
    seg(1, "Sanjay", "Ramesh is ready for the distribution partnership, five lakh, send the proposal", "Ramesh is ready for the distribution partnership, five lakh, send the proposal"),
    seg(2, "Sanjay", "Ramesh also wants a billing app for his shop for one lakh", "Ramesh also wants a billing app for his shop for one lakh"),
  ]);
  answer = { people: [person({ name: "Ramesh Kumar", relation: "mentioned", category: "Business partner", departments: ["Channel partners"], evidence_ids: [1],
    opportunities: [
      opp({ title: "Distribution partnership in south Tamil Nadu", stage: "Pitch / bid shared", next_step: "Send the proposal", evidence_ids: [1] }),
      opp({ title: "Billing app for his shop", stage: "Identified", department: "Sales", value_inr: 100000, next_step: null, evidence_ids: [2] }),
    ] })] };
  await run(CALL_K);
  d = (await api("GET", `/api/people/${id}`)).body;
  assert.equal(d.opportunities.filter((x) => x.value_inr === 500000).length, 1, "the same deal from another call is not copied");
  const moved = d.opportunities.find((x) => x.id === o.id);
  assert.deepEqual([moved.stage, moved.next_step], ["Pitch / bid shared", "Send the proposal"], "it moves on to the stage and next step said later");
  assert.ok(d.opportunities.some((x) => x.title === "Billing app for his shop" && x.source.job_id === JOBS.K), "a new deal in the later call is added");

  // Opportunities added by hand stay "manual"; the owner can still edit an AI one.
  const manual = await api("POST", `/api/people/${id}/opportunities`, { title: "Billing integration", source_job_id: JOBS.I });
  assert.equal(manual.body.opportunity.origin, "manual");
  const renamed = (await api("POST", `/api/opportunities/${o.id}`, { stage: "Proposal" })).body.opportunity; // an older client
  assert.deepEqual([renamed.stage, renamed.origin], ["Pitch / bid shared", "ai"], "\"Proposal\" is read as \"Pitch / bid shared\"");
  await q("DELETE FROM people WHERE id = ?", [id]);
});

test("departments: the owner adds one; the AI sorts people and opportunities into it; panel and pages show only real members and money", async () => {
  // Built-in eight are there; adding is validated.
  let r = await api("GET", "/api/departments");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departments.filter((d) => d.built_in).map((d) => d.name), ["Investment", "Sales", "Channel partners", "Accounts", "Marketing", "Tech & AI", "Govt tenders", "Vendors"]);
  for (const bad of [{}, { name: "x" }, { name: "A,B" }, { name: "Logistics", color: "red" }, { name: "Investment" }]) {
    assert.ok([409, 422].includes((await api("POST", "/api/departments", bad)).status), JSON.stringify(bad));
  }
  const made = await api("POST", "/api/departments", { name: "Logistics", color: "#0f8b8d", description: "Courier, transport and delivery partners" });
  assert.equal(made.status, 201);
  const logistics = made.body.department;
  assert.deepEqual([logistics.slug, logistics.built_in], ["logistics", false]);
  assert.equal((await api("POST", "/api/departments", { name: "logistics" })).status, 409, "names are unique");

  // The AI now gets "Logistics" in its choices; a call sorts two new people into departments.
  const CALL_J = call(JOBS.J, [
    seg(0, "Prem", "Sanjay, any update?", "Sanjay, any update?"),
    seg(1, "Sanjay", "Meena Iyer will invest twenty five lakh in Teemly", "Meena Iyer will invest twenty five lakh in Teemly"),
    seg(2, "Sanjay", "Rajiv Menon's fund can put one crore after the demo", "Rajiv Menon's fund can put one crore after the demo"),
    seg(3, "Sanjay", "Selvam runs Speed Couriers, he can deliver our kits for forty thousand a month", "Selvam runs Speed Couriers, he can deliver our kits for forty thousand a month"),
  ]);
  const investor = (name, value, ids, stage = "In discussion") => person({
    name, category: "Investor", role_title: "Angel investor", departments: ["Investment"], evidence_ids: ids, interest: "high",
    opportunities: [{ title: `${name.split(" ")[0]} investment in Teemly`, stage, department: "Investment", value_inr: value, next_step: null, evidence_ids: ids }],
  });
  answer = {
    people: [
      investor("Meena Iyer", 2500000, [1]),
      investor("Rajiv Menon", 10000000, [2], "Identified"),
      person({ name: "Selvam", category: "Vendor", role_title: "Courier owner", organisation: "Speed Couriers", departments: [], evidence_ids: [3],
        opportunities: [{ title: "Kit delivery contract", stage: "Identified", department: "Logistics", value_inr: 40000, next_step: null, evidence_ids: [3] }] }),
    ],
  };
  await run(CALL_J);
  const box = (await inbox()).items.filter((i) => i.source.job_id === JOBS.J);
  assert.deepEqual(box.map((i) => i.name).sort(), ["Meena Iyer", "Rajiv Menon", "Selvam"]);
  assert.deepEqual(box.find((i) => i.name === "Selvam").departments, ["Logistics"], "an opportunity's department puts the person in it");
  const ids = {};
  for (const i of box) ids[i.name] = (await api("POST", `/api/inbox/${i.id}/add`, { name: i.name, departments: i.departments })).body.person_id;
  assert.ok(Object.values(ids).every(Boolean));

  // Panel: only real members and money.
  const ov = (await api("GET", "/api/department-overview")).body;
  const card = (n) => ov.departments.find((d) => d.name === n);
  assert.equal(card("Investment").open_value_inr, 12500000);
  assert.equal(card("Investment").open_opportunities, 2);
  assert.ok(card("Investment").key_people.some((p) => p.name === "Meena Iyer"));
  assert.deepEqual([card("Logistics").people, card("Logistics").open_value_inr, card("Logistics").open_opportunities], [1, 40000, 1]);
  assert.equal(card("Accounts").open_value_inr, 0);
  assert.ok(ov.facts.length > 0);

  // Investment page: total and each investor's own amount; nobody from another department.
  let page = (await api("GET", "/api/department-pages/investment")).body;
  assert.equal(page.totals.open_value_inr, 12500000);
  const inv = Object.fromEntries(page.people.map((p) => [p.name, p]));
  assert.equal(inv["Rajiv Menon"].open_value_inr, 10000000);
  assert.equal(inv["Meena Iyer"].open_value_inr, 2500000);
  assert.equal(inv["Selvam"], undefined, "Selvam is not in Investment");
  assert.deepEqual(page.funnel.filter((f) => f.count).map((f) => [f.stage, f.count, f.value_inr]), [["Identified", 1, 10000000], ["In discussion", 1, 2500000]]);
  assert.equal(page.opportunities[0].source.file_name, "Investors and logistics call.wav", "each opportunity links its call");
  // The call's speakers, as a finished analysis stores them (for "via Sanjay").
  const [tr] = await db.getPool().execute("INSERT INTO transcripts (job_id, source) VALUES (?, 'audio')", [JOBS.J]);
  await db.getPool().execute("INSERT INTO speakers (transcript_id, label, total_seconds) VALUES (?, 'Sanjay', 9), (?, 'Prem', 3)", [tr.insertId, tr.insertId]);
  page = (await api("GET", "/api/department-pages/investment")).body;
  const inv2 = Object.fromEntries(page.people.map((p) => [p.name, p]));
  // Investor dashboard numbers: weighted = amount × stage chance (In discussion 30%, Identified 10%).
  assert.equal(page.totals.weighted_inr, 2500000 * 0.3 + 10000000 * 0.1);
  assert.equal(page.totals.closest.person.name, "Meena Iyer", "the most advanced open deal is closest");
  assert.equal(page.totals.won_value_inr, 0);
  assert.deepEqual(inv2["Meena Iyer"].interest_trend, [90], "interest per conversation (high = 90)");
  assert.equal(inv2["Meena Iyer"].last_contact_via, "Sanjay", "talked about by Sanjay (not the owner): 'via Sanjay'");
  assert.ok(page.insights.some((t) => /Rajiv Menon is the largest ticket \(₹1 Cr, 80% of the open pipeline\)/.test(t)), page.insights.join(" | "));
  // The owner's round and target.
  const invDept = r.body.departments.find((x) => x.slug === "investment");
  assert.equal((await api("POST", `/api/departments/${invDept.id}`, { goal_label: "Seed round", target_inr: "₹2,00,00,000" })).status, 200);
  assert.equal((await api("POST", `/api/departments/${invDept.id}`, { target_inr: -5 })).status, 422);
  page = (await api("GET", "/api/department-pages/investment")).body;
  assert.deepEqual([page.department.goal_label, page.department.target_inr], ["Seed round", 20000000]);
  assert.ok(page.insights.some((t) => /Pipeline is 63% of the ₹2 Cr target; nothing committed yet/.test(t)), page.insights.join(" | "));
  await api("POST", `/api/departments/${invDept.id}`, { goal_label: null, target_inr: null });

  // Logistics page.
  page = (await api("GET", "/api/department-pages/logistics")).body;
  assert.deepEqual(page.people.map((p) => p.name), ["Selvam"]);
  assert.equal(page.opportunities[0].title, "Kit delivery contract");
  assert.equal((await api("GET", "/api/department-pages/nope")).status, 404);

  // Manual opportunities can use the new department; bad names are refused.
  assert.equal((await api("POST", `/api/people/${ids.Selvam}/opportunities`, { title: "Return pickups", department: "Logistics" })).status, 201);
  assert.equal((await api("POST", `/api/people/${ids.Selvam}/opportunities`, { title: "X", department: "Nowhere" })).status, 422);

  // Deleting Logistics takes it off people and opportunities (built-in ones can be deleted too: tests/auth.test.js).
  assert.equal((await api("DELETE", `/api/departments/${logistics.id}`)).status, 200);
  const selvam = (await api("GET", `/api/people/${ids.Selvam}`)).body;
  assert.deepEqual(selvam.person.departments, []);
  assert.ok(selvam.opportunities.every((o) => o.department === null));
  assert.equal((await api("GET", "/api/department-pages/logistics")).status, 404);
  await q("DELETE FROM people WHERE id IN (?)", [Object.values(ids)]);
});

test("same name, two people: a different city or company asks first; a call on the wrong timeline can be moved (to someone, or to the inbox as someone new)", async () => {
  const say = (id, line) => call(id, [seg(0, "Prem", "Hi Sanjay", "Hi Sanjay"), seg(1, "Sanjay", line, line)]);
  const bala = (over) => person({ name: "Bala", relation: "mentioned", interest: "medium", evidence_ids: [1], ...over });
  const pending = async (job) => (await inbox()).items.find((i) => i.source.job_id === job);

  // 1. Bala, a tech advisor at Zoho in Chennai, is added from the inbox.
  answer = { people: [bala({ category: "Expert", role_title: "Tech advisor", organisation: "Zoho", city: "Chennai", departments: ["Tech & AI"] })] };
  await run(say(JOBS.L, "Bala in Chennai is our tech advisor at Zoho"));
  let item = await pending(JOBS.L);
  const b1 = (await api("POST", `/api/inbox/${item.id}/add`, { name: "Bala", city: "Chennai", organisation: "Zoho", category: "Expert", departments: ["Tech & AI"] })).body.person_id;

  // 2a. A call about Bala in another department only (Vendors, he is Tech & AI): maybe another Bala -> asked.
  answer = { people: [bala({ category: "Vendor", role_title: null, organisation: null, city: null, departments: ["Vendors"], context: "Sells printer ink." })] };
  await run(say(JOBS.R, "Bala sells printer ink"));
  item = await pending(JOBS.R);
  assert.ok(item, "a different department: not added to the Tech & AI Bala, asked instead");
  assert.deepEqual(item.matches.map((m) => [m.id, m.departments]), [[b1, ["Tech & AI"]]], "the match shows his department");
  await api("POST", `/api/inbox/${item.id}/ignore`);

  // 2b. A call that says nothing against it joins his timeline (one Bala, a department he is in)…
  //     …even though it is really about another Bala (a printer): the wrong timeline.
  answer = { people: [bala({ category: "Vendor", role_title: null, organisation: null, city: null, departments: ["Tech & AI", "Vendors"], context: "Will print visiting cards.",
    opportunities: [{ title: "Visiting cards", stage: "Identified", department: "Vendors", value_inr: 5000, next_step: null, evidence_ids: [1] }] })] };
  await run(say(JOBS.N, "Bala will print our visiting cards for five thousand"));
  let d1 = (await api("GET", `/api/people/${b1}`)).body;
  assert.equal(d1.mentions.length, 2, "no conflict said: it joins the one Bala");
  assert.ok(d1.person.departments.includes("Vendors"));

  // 3. A call about Bala in Madurai with a print shop: different city and company -> asked in the inbox.
  answer = { people: [bala({ category: "Vendor", role_title: "Printer", organisation: "Bala Prints", city: "Madurai", departments: ["Vendors"], context: "Runs a print shop in Madurai.",
    opportunities: [{ title: "Flyer printing", stage: "Identified", department: "Vendors", value_inr: 30000, next_step: null, evidence_ids: [1] }] })] };
  await run(say(JOBS.M, "Bala from Madurai runs Bala Prints, flyers for thirty thousand"));
  item = await pending(JOBS.M);
  assert.ok(item, "different city and company: not added to the Chennai Bala, asked instead");
  assert.deepEqual(item.matches.map((m) => [m.id, m.city, m.organisation]), [[b1, "Chennai", "Zoho"]], "the existing Bala is shown as a possible match");
  assert.equal((await api("GET", `/api/people/${b1}`)).body.mentions.length, 2, "the Chennai Bala did not get this call");
  const b2 = (await api("POST", `/api/inbox/${item.id}/add`, { name: "Bala", city: "Madurai", organisation: "Bala Prints", category: "Vendor", departments: ["Vendors"], same_name_ok: true })).body.person_id;
  assert.notEqual(b2, b1, "someone new: a second Bala");
  let d2 = (await api("GET", `/api/people/${b2}`)).body;
  assert.ok(d2.opportunities.some((o) => o.title === "Flyer printing" && o.value_inr === 30000), "his deal comes with him");

  // 4. Move the visiting-cards call from the Chennai Bala to the Madurai Bala.
  assert.equal((await api("POST", `/api/people/${b1}/mentions/${JOBS.N}/move`, { person_id: b1 })).status, 422, "not to the same person");
  assert.equal((await api("POST", `/api/people/${b1}/mentions/${JOBS.N}/move`, {})).status, 422);
  assert.equal((await api("POST", `/api/people/${b1}/mentions/${"f".repeat(32)}/move`, { person_id: b2 })).status, 404);
  const moved = await api("POST", `/api/people/${b1}/mentions/${JOBS.N}/move`, { person_id: b2 });
  assert.equal(moved.status, 200);
  d1 = (await api("GET", `/api/people/${b1}`)).body;
  d2 = (await api("GET", `/api/people/${b2}`)).body;
  assert.deepEqual(d1.mentions.map((m) => m.job_id), [JOBS.L], "the call left the Chennai Bala");
  assert.deepEqual(d1.person.departments, ["Tech & AI"], "the Vendors department it brought is taken off him");
  assert.equal(d1.opportunities.length, 0, "its deal left with it");
  assert.deepEqual([d1.person.city, d1.person.organisation], ["Chennai", "Zoho"], "his own facts stay");
  assert.ok(d2.mentions.some((m) => m.job_id === JOBS.N) && d2.opportunities.some((o) => o.title === "Visiting cards"), "the Madurai Bala has the call and the deal");

  // 5. Move the flyer call off the Madurai Bala to the inbox ("someone new"): it waits there again, with its deal.
  const back = await api("POST", `/api/people/${b2}/mentions/${JOBS.M}/move`, { to: "inbox" });
  assert.equal(back.status, 200);
  item = await pending(JOBS.M);
  assert.equal(item.id, back.body.suggestion_id);
  assert.deepEqual(item.opportunities.map((o) => o.title), ["Flyer printing"]);
  assert.ok(item.evidence.length === 0 || item.evidence[0].speaker === "Sanjay");
  assert.equal(item.matches.length, 2, "both Balas are offered as possible matches");
  d2 = (await api("GET", `/api/people/${b2}`)).body;
  assert.deepEqual(d2.mentions.map((m) => m.job_id), [JOBS.N]);
  assert.ok(!d2.opportunities.some((o) => o.title === "Flyer printing"), "its deal waits on the inbox item");
  assert.deepEqual([d2.person.city, d2.person.organisation], [null, null], "the city and company only that call said are taken off");
  const b3 = (await api("POST", `/api/inbox/${item.id}/add`, { name: "Bala", city: "Madurai", same_name_ok: true })).body.person_id;
  assert.ok((await api("GET", `/api/people/${b3}`)).body.opportunities.some((o) => o.title === "Flyer printing"));

  // 6. "Vimal Raj" is a new name, but "Vimal" (first name only) is shown as a possible match.
  answer = { people: [person({ name: "Hari Raj", relation: "mentioned", evidence_ids: [1] })] };
  await run(say(JOBS.L, "Hari Raj called"));
  const hr = (await inbox()).items.find((i) => i.name === "Hari Raj");
  if (hr) assert.ok(hr.matches.every((m) => m.name.split(" ")[0] === "Hari" && !m.name.includes(" ")), "only a first-name-only Hari can match Hari Raj");
  await q("DELETE FROM people WHERE id IN (?)", [[b1, b2, b3]]);
});
test("two people, one name, different departments: a call about the other department asks, and shows what tells them apart", async () => {
  // Premnath in Sales is in People (with a phone number).
  const sales = await api("POST", "/api/people", { name: "Premnath", city: "Chennai", phone: "+91 98450 71111", category: "Business partner", departments: ["Sales"] });
  assert.equal(sales.status, 201);
  const p1 = sales.body.person_id;

  // A call about Premnath, an AI engineer (Tech & AI): not put on the Sales Premnath's timeline.
  answer = { people: [person({ name: "Premnath", relation: "mentioned", category: "Expert", role_title: "AI engineer", city: null, departments: ["Tech & AI"], context: "AI engineer who can fix speaker detection.", evidence_ids: [1] })] };
  await run(call(JOBS.S, [seg(0, "Prem", "Any AI people?", "Any AI people?"), seg(1, "Sanjay", "Premnath is an AI engineer", "Premnath is an AI engineer")]));
  assert.equal((await api("GET", `/api/people/${p1}`)).body.mentions.length, 0, "the Sales Premnath did not get this call");
  const item = (await inbox()).items.find((i) => i.source.job_id === JOBS.S);
  assert.ok(item, "asked in the inbox");
  assert.deepEqual(item.matches.map((m) => [m.id, m.departments, m.phone_end]), [[p1, ["Sales"], "1111"]], "the match: his department and the last 4 digits");
  assert.ok(!JSON.stringify(item).includes("9845071111"), "never the full number");
  const check = (await api("GET", "/api/people-check?name=Premnath&city=Chennai&department=Tech%20%26%20AI")).body;
  assert.equal(check.name_matches[0].phone_end, "1111");
  assert.equal(check.name_matches[0].level, "likely", "same name and city, other department");

  // Someone new: refused until the owner says it is a different person, then added.
  const form = { name: "Premnath", phone: "+91 99001 72222", category: "Expert", departments: ["Tech & AI"] };
  assert.equal((await api("POST", `/api/inbox/${item.id}/add`, form)).status, 409);
  const added = await api("POST", `/api/inbox/${item.id}/add`, { ...form, same_name_ok: true });
  assert.equal(added.status, 200);
  const p2 = added.body.person_id;
  assert.notEqual(p2, p1);
  assert.deepEqual((await api("GET", `/api/people/${p2}`)).body.person.departments, ["Tech & AI"]);
  assert.equal((await api("GET", `/api/people/${p1}`)).body.mentions.length, 0, "still nothing on the Sales Premnath");
  await q("DELETE FROM people WHERE id IN (?)", [[p1, p2]]);
});
test("a person's commitments: 5 at first, most pressing first, real due days, one line per promise, paged by view", async () => {
  const pid = "c".repeat(31) + "7";
  const now = new Date();
  await q("INSERT INTO people (user_id, id, name, name_key, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Commitra', 'commitra', 50, ?, ?, 'audio')", [pid, now, now]);
  for (const job of [JOBS.T, JOBS.U]) await q("INSERT INTO person_mentions (person_id, job_id, relation, context, evidence_lines) VALUES (?, ?, 'participant', 'Talked.', '[]')", [pid, job]);
  // The first call was 5 days ago: its "today" was 5 days ago, not today.
  await q("UPDATE audio_files f JOIN processing_jobs j ON j.audio_file_id = f.id SET f.created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 DAY) WHERE j.id = ?", [JOBS.T]);
  const [s1] = await db.getPool().execute("INSERT INTO summaries (job_id, available) VALUES (?, 1)", [JOBS.T]);
  const [s2] = await db.getPool().execute("INSERT INTO summaries (job_id, available) VALUES (?, 1)", [JOBS.U]);
  const rows = [
    [s1.insertId, 0, "Send the price list to Prem", "Commitra", "today"],
    [s1.insertId, 1, "Call Commitra about the margin", "Prem", null],
    ...[1, 2, 3, 4, 5, 6].map((n) => [s1.insertId, 1 + n, `Share sample ${n}`, "Commitra", "tomorrow"]),
    // The second call says the price list again (or the same call was uploaded twice): one line.
    [s2.insertId, 0, "Send the price list to Prem.", "Commitra", "today"],
    [s2.insertId, 1, "Share the deck", "Prem", "within 3 days"],
  ];
  for (const r of rows) await q("INSERT INTO action_items (summary_id, seq, task, responsible_person, deadline_text) VALUES (?, ?, ?, ?, ?)", r);

  const d = (await api("GET", `/api/people/${pid}`)).body;
  assert.equal(d.commitments.length, 5, "five at first");
  assert.deepEqual(d.commitments_page.counts, { open: 9, theirs: 7, yours: 2, done: 0 }, "the price list once: 9 promises, not 10");
  assert.equal(d.commitments_page.total, 9);
  assert.equal(d.commitments_page.has_more, true);
  // "tomorrow" said in the call 5 days ago: 4 days late (not "due tomorrow" forever).
  assert.ok(d.commitments.every((c) => c.due_in_days === -4 && c.task.startsWith("Share sample") && c.due === "tomorrow"), "the late ones first");

  const more = (await api("GET", `/api/people/${pid}/commitments?view=open&offset=5&limit=10`)).body;
  assert.equal(more.has_more, false);
  assert.ok(!more.items.some((c) => d.commitments.some((x) => x.id === c.id)), "no repeats across pages");
  assert.deepEqual(more.items.map((c) => c.task), ["Share sample 6", "Send the price list to Prem.", "Share the deck", "Call Commitra about the margin"], "then today, in 3 days, no day");
  const top = more.items[1];
  // Said again in today's call: one line, its newest wording and due day ("today" of the newest call).
  assert.deepEqual([top.who, top.due, top.due_in_days, top.calls, top.ids.length], ["Commitra", "today", 0, 2, 2]);
  assert.equal(more.items.at(-1).due_date, null);
  const yours = (await api("GET", `/api/people/${pid}/commitments?view=yours`)).body;
  assert.deepEqual(yours.items.map((c) => [c.who, c.yours]), [["You", true], ["You", true]]);
  assert.equal(yours.items[0].due_in_days, 3, "within 3 days of today's call");
  assert.equal((await api("GET", `/api/people/${pid}/commitments?view=theirs`)).body.total, 7);

  // Ticking the price list off (both of its rows): done once, out of the open views.
  for (const id of top.ids) assert.equal((await api("POST", `/api/commitments/${id}`, { done: true })).status, 200);
  const after = (await api("GET", `/api/people/${pid}/commitments?view=done`)).body;
  assert.deepEqual([after.total, after.items[0].task, after.items[0].done], [1, "Send the price list to Prem.", true]);
  assert.deepEqual(after.counts, { open: 8, theirs: 6, yours: 2, done: 1 });

  assert.equal((await api("GET", `/api/people/${pid}/commitments?view=all`)).status, 422);
  assert.equal((await api("GET", `/api/people/${pid}/commitments?limit=0`)).status, 422);
  assert.equal((await api("GET", `/api/people/${pid}/commitments?limit=51`)).status, 422);
  assert.equal((await api("GET", `/api/people/${pid}/commitments?offset=-1`)).status, 422);
  assert.equal((await api("GET", `/api/people/${"d".repeat(32)}/commitments`)).status, 404);
  await q("DELETE FROM people WHERE id = ?", [pid]);
});
test("inbox: the AI suggests each new person's department, with why (reason, confidence, the lines), to route them", async () => {
  const CALL_O = call(JOBS.O, [
    seg(0, "Prem", "Any leads, Sanjay?", "Any leads, Sanjay?"),
    seg(1, "Sanjay", "Priya Nair works in the Industries department, she said the school tablet tender opens next month", "Priya Nair works in the Industries department, she said the school tablet tender opens next month"),
    seg(2, "Sanjay", "And Anand runs a digital marketing agency in Coimbatore", "And Anand runs a digital marketing agency in Coimbatore"),
  ]);
  answer = {
    people: [
      person({ name: "Priya Nair", category: "Govt official", role_title: "Industries department", departments: ["Govt tenders"], evidence_ids: [1],
        department_reasons: [
          { department: "Govt tenders", reason: "Works in the Industries department; told us about the school tablet tender", confidence: "high", evidence_ids: [1] },
          { department: "Marketing", reason: "not in departments: dropped", confidence: "low", evidence_ids: [1] },
        ] }),
      person({ name: "Anand", category: "Vendor", role_title: "Digital marketing agency", city: "Coimbatore", departments: ["Marketing", "Vendors"], evidence_ids: [2],
        department_reasons: [{ department: "Marketing", reason: "Runs a digital marketing agency", confidence: "medium", evidence_ids: [2, 99] }] }),
    ],
  };
  await run(CALL_O);
  const items = (await inbox()).items.filter((i) => i.source.job_id === JOBS.O);
  const priya = items.find((i) => i.name === "Priya Nair");
  const anand = items.find((i) => i.name === "Anand");
  assert.deepEqual(priya.department_suggestions.map((s) => [s.department, s.confidence]), [["Govt tenders", "high"]], "only departments the person is in");
  assert.match(priya.department_suggestions[0].reason, /school tablet tender/);
  assert.deepEqual(priya.department_suggestions[0].evidence.map((e) => [e.id, e.speaker, e.time_label]), [[1, "Sanjay", "00:03"]]);
  // Anand: Marketing has a reason (bad line id dropped); Vendors had none -> kept, low, no reason. Most certain first.
  assert.deepEqual(anand.department_suggestions.map((s) => [s.department, s.confidence, s.reason]), [["Marketing", "medium", "Runs a digital marketing agency"], ["Vendors", "low", null]]);
  assert.deepEqual(anand.department_suggestions[0].evidence.map((e) => e.id), [2]);
  // The owner routes Priya to the suggested department.
  const r = await api("POST", `/api/inbox/${priya.id}/add`, { name: "Priya Nair", departments: priya.department_suggestions.map((s) => s.department) });
  assert.deepEqual((await api("GET", `/api/people/${r.body.person_id}`)).body.person.departments, ["Govt tenders"]);
  await api("POST", `/api/inbox/${anand.id}/ignore`);
  await q("DELETE FROM people WHERE id = ?", [r.body.person_id]);
});
test("inbox: a new department someone says to create is suggested (with why and who said it); existing ones never are; create or ignore", async () => {
  const CALL_P = call(JOBS.P, [
    seg(0, "Prem", "Meena, any advice before the round?", "Meena, any advice before the round?"),
    seg(1, "Meena", "You need a customer success team for all these shops", "You need a customer success team for all these shops"),
    seg(2, "Meena", "And set up a legal department before the term sheet. Your marketing team is fine", "And set up a legal department before the term sheet. Your marketing team is fine"),
  ]);
  answer = {
    people: [],
    department_ideas: [
      { name: "Customer Success", description: "Support staff who keep shops happy after they buy", reason: "Meena said 200 shops need looking after", said_by: "Meena", evidence_ids: [1] },
      { name: "Legal Department", description: "Lawyers for contracts and the term sheet", reason: "Needed before the term sheet", said_by: "Meena", evidence_ids: [2] },
      { name: "Marketing team", description: "x", reason: "exists already", said_by: "Meena", evidence_ids: [2] },
      { name: "Made up", description: "x", reason: "no line", said_by: null, evidence_ids: [42] },
    ],
  };
  await run(CALL_P);
  let box = await inbox();
  const ideas = box.departments.filter((d) => d.source.job_id === JOBS.P);
  assert.deepEqual(ideas.map((d) => d.name).sort(), ["Customer Success", "Legal"], "Marketing exists; a line-less idea is dropped; 'Department' is taken off the name");
  const cs = ideas.find((d) => d.name === "Customer Success");
  assert.deepEqual([cs.said_by, cs.reason, cs.evidence[0].speaker, cs.evidence[0].time_label], ["Meena", "Meena said 200 shops need looking after", "Meena", "00:03"]);
  assert.ok(box.pending >= 2, "new departments count in the inbox badge");

  // Processed again: not suggested twice.
  await run(CALL_P);
  assert.equal((await inbox()).departments.filter((d) => d.source.job_id === JOBS.P).length, 2);

  // Create Customer Success (the owner edits the description and picks a colour): it is a real department now.
  const made = await api("POST", `/api/department-ideas/${cs.id}/create`, { description: "Support for shops after they buy", color: "#0f8b8d" });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.department.name, made.body.department.slug, made.body.department.description], ["Customer Success", "customer-success", "Support for shops after they buy"]);
  assert.ok((await api("GET", "/api/departments")).body.departments.some((d) => d.name === "Customer Success"));
  assert.equal((await api("POST", `/api/department-ideas/${cs.id}/create`, {})).status, 409, "decided once");
  const added = (await inbox("added")).departments.find((d) => d.id === cs.id);
  assert.equal(added.department.slug, "customer-success");

  // Ignore Legal. A later call suggesting Customer Success again is not suggested (it exists now).
  const legal = ideas.find((d) => d.name === "Legal");
  assert.equal((await api("POST", `/api/department-ideas/${legal.id}/ignore`)).status, 200);
  assert.equal((await inbox("ignored")).departments[0].name, "Legal");
  assert.equal((await api("POST", `/api/department-ideas/${"f".repeat(32)}/ignore`)).status, 404);
  answer = { people: [], department_ideas: [{ name: "Customer success team", description: "x", reason: "again", said_by: "Meena", evidence_ids: [1] }] };
  await run(call(JOBS.O, [seg(0, "Prem", "hi", "hi"), seg(1, "Meena", "Customer success team please", "Customer success team please")]));
  box = await inbox();
  assert.ok(!box.departments.some((d) => /customer success/i.test(d.name)), "an existing department is never suggested");
  await q("DELETE FROM departments WHERE name = 'Customer Success'");
});
test("opportunity panel: every deal by stage with its chance; moving a card is saved and logged; nudges come from real facts", async () => {
  const now = new Date();
  const old = new Date(Date.now() - 30 * 86_400_000);
  const pid = "e".repeat(31) + "1";
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Board Tester', 'board tester', 'Investment', 70, ?, ?, 'audio')", [pid, now, now]);
  const mk = async (body) => (await api("POST", `/api/people/${pid}/opportunities`, body)).body.opportunity;
  const a = await mk({ title: "Seed round", department: "Investment", value_inr: 1000000, stage: "Identified" });
  const b = await mk({ title: "Bulk order", department: "Sales", value_inr: 200000, stage: "Pitch / bid shared", next_step: "Send quote", due_date: "2020-01-15" });
  const c = await mk({ title: "Old win", value_inr: 50000, stage: "Won" });

  let board = (await api("GET", "/api/opportunity-board")).body;
  assert.deepEqual(board.stages.map((s) => [s.stage, s.chance]), [["Identified", 0.1], ["First contact", 0.2], ["In discussion", 0.3], ["Pitch / bid shared", 0.5], ["Negotiation", 0.7], ["Committed", 0.9], ["Won", 1], ["Lost", 0]]);
  const card = (id) => board.opportunities.find((o) => o.id === id);
  assert.deepEqual([card(a.id).chance, card(a.id).person.name, card(a.id).person.score], [0.1, "Board Tester", 70]);
  assert.equal(card(b.id).overdue, true, "next step past its due date");
  assert.equal(card(c.id).overdue, false, "a won deal is never overdue");
  const n = board.nudges.find((x) => x.opportunity_id === b.id);
  assert.equal(n.kind, "overdue");
  assert.equal(n.move_to, "In discussion", "suggests one step back");

  // Drag a card: saved, and every move is logged (created at a stage, then moved).
  const moved = await api("POST", `/api/opportunities/${a.id}`, { stage: "Negotiation" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.opportunity.stage, "Negotiation");
  const log = await q("SELECT from_stage, to_stage, changed_by FROM opportunity_stage_changes WHERE opportunity_id = ? ORDER BY id", [a.id]);
  assert.deepEqual(log.map((r) => [r.from_stage, r.to_stage, r.changed_by]), [[null, "Identified", "owner"], ["Identified", "Negotiation", "owner"]]);
  board = (await api("GET", "/api/opportunity-board")).body;
  assert.equal(card(a.id).chance, 0.7, "the chance follows the stage");
  assert.equal(board.opportunities.find((o) => o.id === a.id).chance, 0.7);
  assert.equal((await api("POST", `/api/opportunities/${a.id}`, { stage: "Pitch" })).status, 422, "only real stages");

  // Quiet: no call or chat with the person for 30 days -> a nudge to follow up or move back.
  await q("UPDATE people SET last_contact_at = ? WHERE id = ?", [old, pid]);
  await api("POST", `/api/opportunities/${b.id}`, { due_date: null });
  board = (await api("GET", "/api/opportunity-board")).body;
  const quiet = board.nudges.find((x) => x.opportunity_id === a.id);
  assert.equal(quiet.kind, "quiet");
  assert.match(quiet.text, /No call with Board Tester for 30 days/);
  assert.equal(quiet.move_to, "Pitch / bid shared");
  await q("DELETE FROM people WHERE id = ?", [pid]);
});
test("opportunity page: the deal, its person, every move, the introduction path; the owner's chance replaces the stage's until the stage changes", async () => {
  const now = new Date();
  const ids = { intro: "e".repeat(31) + "2", inv: "e".repeat(31) + "3" };
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Page Introducer', 'page introducer', '', 60, ?, ?, 'audio')", [ids.intro, now, now]);
  await q("INSERT INTO people (user_id, id, name, name_key, category, role_title, city, departments, score, introduced_by_id, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Page Investor', 'page investor', 'Investor', 'Angel investor', 'Chennai', 'Investment', 78, ?, ?, ?, 'audio')", [ids.inv, ids.intro, now, now]);
  const o = (await api("POST", `/api/people/${ids.inv}/opportunities`, { title: "Seed investment", department: "Investment", value_inr: 5000000, stage: "First contact", next_step: "Meeting on Monday" })).body.opportunity;

  let d = await api("GET", `/api/opportunities/${o.id}`);
  assert.equal(d.status, 200);
  d = d.body;
  assert.deepEqual([d.opportunity.title, d.opportunity.value_inr, d.opportunity.stage, d.opportunity.chance, d.opportunity.chance_pct], ["Seed investment", 5000000, "First contact", 0.2, null]);
  assert.deepEqual([d.person.name, d.person.city, d.person.score, d.person.introduced_by.name], ["Page Investor", "Chennai", 78, "Page Introducer"]);
  assert.equal(d.department.slug, "investment");
  assert.equal(d.stages.length, 8);
  assert.deepEqual(d.history.map((h) => [h.from, h.to, h.by]), [[null, "First contact", "owner"]]);
  assert.deepEqual(d.path.map((x) => x.name), ["Prem", "Page Introducer", "Page Investor"], "You -> introducer -> the person");
  assert.equal(d.insight, null);
  assert.equal(d.can_analyse, false, "no conversation with them yet");
  assert.equal((await api("POST", `/api/opportunities/${o.id}/insight`)).status, 503, "nothing to read: a clear 503");
  assert.equal((await api("GET", `/api/opportunities/${"f".repeat(32)}`)).status, 404);

  // Accept a chance (25%): it replaces the stage's 20% for this deal, on the panel too.
  assert.equal((await api("POST", `/api/opportunities/${o.id}`, { chance_pct: 25 })).body.opportunity.chance, 0.25);
  assert.equal((await api("POST", `/api/opportunities/${o.id}`, { chance_pct: 120 })).status, 422);
  assert.equal((await api("GET", "/api/opportunity-board")).body.opportunities.find((x) => x.id === o.id).chance, 0.25);
  // A new stage brings its own chance.
  const moved = (await api("POST", `/api/opportunities/${o.id}`, { stage: "Negotiation" })).body.opportunity;
  assert.deepEqual([moved.chance_pct, moved.chance], [null, 0.7]);
  d = (await api("GET", `/api/opportunities/${o.id}`)).body;
  assert.deepEqual(d.history.map((h) => h.to), ["First contact", "Negotiation"]);
  await q("DELETE FROM people WHERE id IN (?)", [[ids.inv, ids.intro]]);
});
test("today: needs attention, AI insights (only those already made), net stage moves, department goals and the inbox, from the database", async () => {
  const now = new Date();
  const since = new Date(Date.now() - 3600_000).toISOString();
  const pid = "e".repeat(31) + "4";
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Today Tester', 'today tester', 'Investment', 82, ?, ?, 'audio')", [pid, now, now]);
  const mk = async (body) => (await api("POST", `/api/people/${pid}/opportunities`, body)).body.opportunity;
  const a = await mk({ title: "Today seed", department: "Investment", value_inr: 2000000, stage: "Identified", next_step: "Send the deck", due_date: "2020-01-15" });
  const b = await mk({ title: "Today order", department: "Sales", value_inr: 300000, stage: "First contact" });
  const c = await mk({ title: "Today wobble", department: "Sales", value_inr: 100000, stage: "Identified" });
  await api("POST", `/api/opportunities/${b.id}`, { stage: "In discussion" });
  await api("POST", `/api/opportunities/${b.id}`, { stage: "Negotiation" });
  await api("POST", `/api/opportunities/${c.id}`, { stage: "Negotiation" });
  await api("POST", `/api/opportunities/${c.id}`, { stage: "Identified" });
  // An AI view saved earlier on the deal's page (Today never makes one).
  const insight = { factors: [{ label: "Interest", level: "high", reason: "Asked for the deck", evidence: [] }], would_change: "Would move up after the deck is sent.", suggested_chance_pct: 40, details: {} };
  await q("INSERT INTO opportunity_insights (opportunity_id, data, based_on, model, created_at) VALUES (?, ?, '[]', 'test', ?)", [a.id, JSON.stringify(insight), now]);
  // The goal is set the way the owner sets it (Settings), so the department cache is refreshed too.
  const [dept] = await q("SELECT id, goal_label, target_inr FROM departments WHERE user_id = 1 AND slug = 'investment'");
  assert.equal((await api("POST", `/api/departments/${dept.id}`, { goal_label: "Seed round", target_inr: 10000000 })).status, 200);
  try {
    const r = await api("GET", `/api/today?since=${encodeURIComponent(since)}`);
    assert.equal(r.status, 200);
    const t = r.body;

    const n = t.attention.find((x) => x.opportunity_id === a.id);
    assert.equal(n.kind, "overdue", "a next step past its date needs attention");
    assert.deepEqual([n.title, n.person.name], ["Today seed", "Today Tester"]);

    const i = t.insights.items.find((x) => x.id === a.id);
    assert.deepEqual([i.chance, i.suggested_chance_pct, i.factor.level, i.would_change, i.stale], [0.1, 40, "high", "Would move up after the deck is sent.", false]);
    assert.ok(!t.insights.items.some((x) => x.id === b.id), "no AI view is made up for a deal");
    assert.ok(t.insights.not_read >= 2);
    assert.equal(t.insights.not_read_top.length, t.insights.not_read, "every unread deal is named (the page shows 3, then 'and N more')");

    // Order: at risk first (the AI's chance below the stage's), then the biggest rupee rise; stale last.
    //   b: ₹3 L in Negotiation, AI 30%  -> at risk;  a: ₹20 L, 10% -> 40% = +₹6 L;  c: ₹1 L, AI 90% but stale.
    const view = (pct) => JSON.stringify({ factors: [], would_change: "x", suggested_chance_pct: pct, details: {} });
    await q("INSERT INTO opportunity_insights (opportunity_id, data, based_on, model, created_at) VALUES (?, ?, '[]', 'test', ?), (?, ?, '[\"0000\"]', 'test', ?)", [b.id, view(30), now, c.id, view(90), now]);
    const t2 = (await api("GET", `/api/today?since=${encodeURIComponent(since)}`)).body;
    const all = [...t2.insights.items];
    for (let off = all.length; off < t2.insights.total; off += 4) all.push(...(await api("GET", `/api/insights?offset=${off}&limit=4`)).body.items);
    assert.equal(all.length, t2.insights.total, "Load more reaches every insight");
    assert.equal(new Set(all.map((x) => x.id)).size, all.length, "no repeats across pages");
    const ours = all.filter((x) => [a.id, b.id, c.id].includes(x.id));
    assert.deepEqual(ours.map((x) => x.id), [b.id, a.id, c.id], "at risk, then the biggest rise, stale last");
    const ib = ours[0];
    assert.equal(ib.impact_inr, Math.round((0.3 - ib.chance) * 300000));
    assert.ok(ib.impact_inr < 0);
    assert.equal(ours[1].impact_inr, 600000, "₹20 L × (40% − 10%)");
    assert.equal(ours[2].stale, true);
    const p1 = (await api("GET", "/api/insights?offset=0&limit=1")).body;
    assert.deepEqual([p1.items.length, p1.total, p1.has_more], [1, t2.insights.total, t2.insights.total > 1]);
    assert.equal((await api("GET", "/api/insights?limit=500")).body.items.length, Math.min(20, t2.insights.total), "a page is at most 20");

    const mb = t.moves.items.find((x) => x.id === b.id);
    assert.deepEqual([mb.from, mb.to, mb.direction, mb.steps, mb.by], ["First contact", "Negotiation", "forward", 2, "owner"], "net move over the period");
    assert.ok(!t.moves.items.some((x) => x.id === c.id), "moved and moved back: no net change");
    assert.ok(t.moves.unchanged >= 1);

    const g = t.goals.find((x) => x.slug === "investment");
    assert.equal(g.target_inr, 10000000);
    assert.equal(g.goal_label, "Seed round");
    assert.ok(g.open_value_inr >= 2000000 && g.weighted_inr >= 200000);

    const [[pending]] = [await q("SELECT COUNT(*) AS n FROM person_suggestions WHERE status = 'pending'")];
    assert.equal(t.inbox.people, Number(pending.n));
    assert.equal(typeof t.inbox.departments, "number");

    // A bad "since" falls back to the start of today, never an error.
    assert.equal((await api("GET", "/api/today?since=nonsense")).status, 200);
  } finally {
    await api("POST", `/api/departments/${dept.id}`, { goal_label: dept.goal_label, target_inr: dept.target_inr === null ? null : Number(dept.target_inr) });
    await q("DELETE FROM opportunity_insights WHERE opportunity_id IN (?)", [[a.id, b.id, c.id]]);
    await q("DELETE FROM people WHERE id = ?", [pid]);
  }
});
test("notifications: facts from the room, each once; read / all read; settings switch kinds off; day-end digest; analysed and failed calls", async () => {
  const now = new Date();
  const pid = "e".repeat(31) + "5";
  const ymd = notes.localYmd();
  const yesterday = notes.localYmd(Date.now() - 86_400_000);
  await q("DELETE FROM notifications WHERE dedupe_key <> 'installed'"); // start from an empty bell
  await q("DELETE FROM app_settings");
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Notify Tester', 'notify tester', 'Investment', 80, ?, ?, 'audio')", [pid, now, now]);
  // From a call: a new opportunity, and a later call moving it on.
  const oppId = "f".repeat(31) + "1";
  await q("INSERT INTO opportunities (user_id, id, person_id, title, stage, department, value_inr, origin, evidence, created_at, updated_at) VALUES (1, ?, ?, 'Notify seed', 'Negotiation', 'Investment', 2500000, 'ai', '[]', ?, ?)", [oppId, pid, now, now]);
  await q("INSERT INTO opportunity_stage_changes (opportunity_id, from_stage, to_stage, changed_by, created_at) VALUES (?, 'In discussion', 'Negotiation', 'ai', ?)", [oppId, now]);
  // The owner's own deals with dates: one due today, one overdue (and the owner's moves are not announced).
  const mk = async (body) => (await api("POST", `/api/people/${pid}/opportunities`, body)).body.opportunity;
  const due = await mk({ title: "Notify due", value_inr: 100000, stage: "First contact", next_step: "Send the quote", due_date: ymd });
  const late = await mk({ title: "Notify late", stage: "In discussion", next_step: "Call back", due_date: yesterday });
  // Someone new found in a call, waiting in the inbox.
  await q("INSERT INTO person_suggestions (user_id, id, job_id, name, name_key, relation, context, evidence, created_at) VALUES (1, ?, ?, 'Notify Newbie', 'notify newbie', 'mentioned', 'Talked about.', '[]', ?)", ["d".repeat(31) + "1", JOBS.P, now]);

  notes.resetForTests();
  let r = await api("GET", "/api/notifications");
  assert.equal(r.status, 200);
  const titles = () => r.body.items.map((n) => n.title);
  assert.ok(titles().includes("New opportunity: Notify Tester"));
  assert.ok(titles().includes("Notify Tester moved to Negotiation"), "the AI's move from a call");
  assert.ok(titles().includes("Due today: Notify Tester"));
  assert.ok(titles().includes("Overdue: Notify Tester"));
  assert.ok(r.body.items.some((n) => n.kind === "inbox" && /Notify Newbie/.test(n.body)));
  assert.ok(!titles().some((t) => /moved to First contact|moved to In discussion/.test(t)), "the owner's own moves are not announced");
  const opp = r.body.items.find((n) => n.title === "New opportunity: Notify Tester");
  assert.deepEqual([opp.kind, opp.link, opp.read, opp.body], ["opportunity", `/opportunities/${oppId}`, false, "Notify seed · ₹25 L · Negotiation"]);
  assert.equal(r.body.items.find((n) => n.title === "Due today: Notify Tester").link, `/opportunities/${due.id}`);
  assert.equal(r.body.items.find((n) => n.title === "Overdue: Notify Tester").link, `/opportunities/${late.id}`);
  const count = r.body.items.length;
  assert.equal(r.body.unread, count);
  assert.equal(typeof r.body.active_jobs, "number");

  // Again: nothing is announced twice.
  notes.resetForTests();
  r = await api("GET", "/api/notifications");
  assert.equal(r.body.items.length, count, "dedupe: each fact once");

  // Read one, then all.
  assert.equal((await api("POST", "/api/notifications/read", { ids: [opp.id] })).body.changed, 1);
  r = await api("GET", "/api/notifications");
  assert.equal(r.body.unread, count - 1);
  assert.equal(r.body.items.find((n) => n.id === opp.id).read, true);
  assert.equal((await api("POST", "/api/notifications/read", { ids: ["x"] })).status, 422);
  await api("POST", "/api/notifications/read", { all: true });
  assert.equal((await api("GET", "/api/notifications")).body.unread, 0);

  // Settings: validated; a kind switched off is not made.
  assert.equal((await api("POST", "/api/notification-settings", { digest_hour: 25 })).status, 422);
  assert.equal((await api("POST", "/api/notification-settings", { loud: true })).status, 422);
  const s = await api("POST", "/api/notification-settings", { due: false, digest_hour: 20 });
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.settings.due, s.body.settings.digest_hour, s.body.settings.opportunity], [false, 20, true]);
  assert.equal((await api("GET", "/api/notification-settings")).body.settings.due, false);
  await mk({ title: "Notify muted", stage: "First contact", next_step: "Ping", due_date: ymd });
  notes.resetForTests();
  r = await api("GET", "/api/notifications");
  assert.ok(!r.body.items.some((n) => /Notify muted/.test(n.body ?? "")), "due reminders are off");

  // Day-end digest: once a day, only after the chosen hour.
  const at = (h) => new Date(new Date().setHours(h, 5, 0, 0)).getTime();
  // (a run after 20:00 has just made today's: forget it, row and fact, so the clock below decides)
  await q("DELETE FROM notification_facts WHERE fact_key LIKE 'digest:%'");
  await q("DELETE FROM notifications WHERE kind = 'digest'");
  await notes.sweep({ now: at(19) });
  assert.equal((await q("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'digest'"))[0].n, 0, "not before 20:00");
  await notes.sweep({ now: at(21) });
  await notes.sweep({ now: at(22) });
  const digests = await q("SELECT title, body, link FROM notifications WHERE kind = 'digest'");
  assert.equal(digests.length, 1, "once a day");
  assert.equal(digests[0].link, "/today");
  assert.match(digests[0].body, /analysed · \d+ new opportunit(y|ies).* · \d+ follow-ups? open/);

  // A call analysed (announced when its people are known) and a call that failed.
  await q("UPDATE processing_jobs SET finished_at = ? WHERE id = ?", [new Date(), JOBS.P]);
  await notes.conversationDone(JOBS.P);
  // The call's new person was announced first (its own row); the call's row takes that row over.
  const [fact] = await q("SELECT notification_id FROM notification_facts WHERE fact_key = ?", [`job:${JOBS.P}:analysed`]);
  const analysed = (await q("SELECT kind, title, items, group_key FROM notifications WHERE id = ?", [fact.notification_id]))[0];
  assert.deepEqual([analysed.kind, analysed.title, analysed.group_key], ["analysis", "Call analysed: Investor advice call.wav", `call:${JOBS.P}`]);
  assert.ok((typeof analysed.items === "string" ? JSON.parse(analysed.items) : analysed.items).some((i) => /Notify Newbie/.test(i.text)), "the new person is inside the call's row");
  assert.equal((await q("SELECT COUNT(*) AS n FROM notifications WHERE group_key = ?", [`call:${JOBS.P}`]))[0].n, 1, "one row for the call");
  await q("UPDATE processing_jobs SET status = 'failed', error_message = 'Audio too short.', finished_at = ? WHERE id = ?", [new Date(), JOBS.O]);
  notes.resetForTests();
  r = await api("GET", "/api/notifications");
  const failed = r.body.items.find((n) => n.kind === "failed");
  assert.deepEqual([failed.title, failed.body], ["Could not analyse Tender and agency call.wav", "Audio too short."]);

  // The same deal moving again: one row, updated, counted, unread again and on top.
  await api("POST", "/api/notifications/read", { all: true });
  await q("INSERT INTO opportunity_stage_changes (opportunity_id, from_stage, to_stage, changed_by, created_at) VALUES (?, 'Negotiation', 'Committed', 'ai', ?)", [oppId, new Date()]);
  notes.resetForTests();
  r = await api("GET", "/api/notifications");
  const moves = r.body.items.filter((n) => n.kind === "stage" && n.link === `/opportunities/${oppId}`);
  assert.equal(moves.length, 1, "one row per deal");
  assert.deepEqual([moves[0].title, moves[0].count, moves[0].read, moves[0].grouped], ["Notify Tester moved to Committed", 2, false, "deal"]);
  assert.equal(moves[0].items[0].text, "Negotiation → Committed", "latest first, history kept");
  // (the digest above was made with a pretend 10 PM clock, so it is left out)
  assert.ok(r.body.items.filter((n) => n.kind !== "digest").every((n) => Date.parse(n.at) <= Date.parse(moves[0].at)), "an updated row comes back to the top (latest update)");
  assert.ok(Date.parse(moves[0].at) > Date.parse(moves[0].created_at), "updated after it was made");

  // Seen (bell opened) is not read: the number goes, the dot stays.
  assert.ok(r.body.unseen >= 1);
  assert.equal((await api("POST", "/api/notifications/seen")).status, 200);
  r = await api("GET", "/api/notifications");
  assert.equal(r.body.unseen, 0, "the bell's number is 0 once opened");
  assert.ok(r.body.unread >= 1, "still unread until opened");
  // Unread again, on request; and the Unread filter.
  await api("POST", "/api/notifications/read", { all: true });
  assert.equal((await api("POST", "/api/notifications/unread", { ids: [moves[0].id] })).body.changed, 1);
  r = await api("GET", "/api/notifications?filter=unread");
  assert.deepEqual(r.body.items.map((n) => n.id), [moves[0].id]);
  assert.equal((await api("POST", "/api/notifications/unread", { ids: [0] })).status, 422);

  // Many at once (5 deals overdue in one sweep): one summary row with the list inside.
  await api("POST", "/api/notification-settings", { due: true }); // switched off earlier in this test
  const old = notes.localYmd(Date.now() - 3 * 86_400_000);
  for (let i = 1; i <= 5; i++) await mk({ title: `Notify bulk ${i}`, stage: "In discussion", next_step: "Send it", due_date: old });
  notes.resetForTests();
  r = await api("GET", "/api/notifications");
  const bulk = r.body.items.find((n) => n.title === "5 deals overdue");
  assert.ok(bulk, r.body.items.map((n) => n.title).join(" | "));
  assert.deepEqual([bulk.kind, bulk.count, bulk.items.length, bulk.grouped], ["overdue", 5, 5, "bulk"]);
  assert.ok(!r.body.items.some((n) => /Notify bulk/.test(n.body ?? "") && n.id !== bulk.id), "not five rows");
  // Paging for "View all".
  const page1 = (await api("GET", "/api/notifications?limit=2")).body;
  const page2 = (await api("GET", "/api/notifications?limit=2&offset=2")).body;
  assert.equal(page1.items.length, 2);
  assert.equal(page1.has_more, true);
  assert.ok(!page2.items.some((n) => page1.items.some((m) => m.id === n.id)));

  await q("DELETE FROM notification_facts WHERE fact_key <> 'installed'");
  await q("DELETE FROM notifications WHERE dedupe_key <> 'installed'");
  await q("DELETE FROM app_settings");
  await q("DELETE FROM person_suggestions WHERE id = ?", ["d".repeat(31) + "1"]);
  await q("DELETE FROM people WHERE id = ?", [pid]);
});
test("person's departments: the owner adds and removes them; a later call never puts back one the owner removed", async () => {
  const now = new Date();
  const pid = "e".repeat(31) + "6";
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Deptedit Tester', 'deptedit tester', 'Investment', 60, ?, ?, 'audio')", [pid, now, now]);
  const set = (departments) => api("POST", `/api/people/${pid}/departments`, { departments });
  const stored = async () => (await q("SELECT departments, departments_removed FROM people WHERE id = ?", [pid]))[0];

  // Add one, then take the first one away.
  let r = await set(["Investment", "Sales"]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departments, ["Investment", "Sales"]);
  r = await set(["Sales"]);
  assert.deepEqual(r.body.departments, ["Sales"]);
  assert.deepEqual(await stored(), { departments: "Sales", departments_removed: "Investment" });
  assert.deepEqual((await api("GET", `/api/people/${pid}`)).body.person.departments, ["Sales"]);
  const inSales = (await api("GET", "/api/department-pages/sales")).body.people.map((p) => p.id);
  assert.ok(inSales.includes(pid), "shows on the Sales page at once");
  assert.ok(!(await api("GET", "/api/department-pages/investment")).body.people.some((p) => p.id === pid), "not on Investment any more");

  // A later call says Investment and Marketing: Marketing is added, Investment is not put back.
  answer = { people: [person({ name: "Deptedit Tester", relation: "participant", category: "Investor", departments: ["Investment", "Marketing"], context: "Talked about investing and a campaign.", evidence_ids: [0] })] };
  await run(call(JOBS.Q, [seg(0, "Deptedit Tester", "Investment-உம் campaign-உம் பேசலாம்", "Let us talk about investment and a campaign"), seg(1, "Prem", "சரி", "OK")]));
  // Neither is a department they are in now (Sales), so the owner is asked; they say it is them.
  const ask = (await inbox()).items.find((i) => i.source.job_id === JOBS.Q);
  assert.ok(ask, "other departments only: asked, not added by guess");
  assert.equal((await api("POST", `/api/inbox/${ask.id}/add`, { person_id: pid })).status, 200);
  assert.deepEqual((await stored()).departments.split(",").sort(), ["Marketing", "Sales"], "the owner's removal holds");

  // The owner puts Investment back: it stays, and is no longer remembered as removed.
  r = await set(["Sales", "Marketing", "Investment"]);
  assert.deepEqual(r.body.departments, ["Sales", "Marketing", "Investment"]);
  assert.equal((await stored()).departments_removed, "");
  r = await set([]);
  assert.deepEqual(r.body.departments, [], "no department is allowed");

  // Validation.
  assert.equal((await set(["Nope"])).status, 422, "only departments that exist");
  assert.equal((await api("POST", `/api/people/${pid}/departments`, { departments: "Sales" })).status, 422);
  assert.equal((await api("POST", `/api/people/${"f".repeat(32)}/departments`, { departments: ["Sales"] })).status, 404);
  await q("DELETE FROM people WHERE id = ?", [pid]);
});
test("add person by hand: saved with who introduced them, why, consent and a first opportunity; same name asks first; no call is made up", async () => {
  const now = new Date();
  const intro = "e".repeat(31) + "7";
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Handadd Naveen', 'handadd naveen', '', 60, ?, ?, 'audio')", [intro, now, now]);
  const body = {
    name: "Handadd Ramesh",
    city: "Madurai",
    phone: "98765 11111",
    category: "Business partner",
    departments: ["Channel partners"],
    introduced_by_id: intro,
    context: "Distributor for south Tamil Nadu",
    consent: "Ask",
    opportunity: { title: "South TN distribution", stage: "Identified", department: "Channel partners", value_inr: 300000 },
  };
  const r = await api("POST", "/api/people", body);
  assert.equal(r.status, 201);
  const pid = r.body.person_id;
  const d = (await api("GET", `/api/people/${pid}`)).body;
  const p = d.person;
  assert.deepEqual([p.name, p.city, p.phone, p.category, p.departments, p.consent], ["Handadd Ramesh", "Madurai", "+919876511111", "Business partner", ["Channel partners"], "Ask"]);
  assert.equal(p.introduced_by.name, "Handadd Naveen");
  assert.equal(p.last_contact_kind, "added", "no call or chat is made up");
  assert.equal(d.mentions.length, 0);
  assert.equal(d.opportunities.length, 1);
  assert.deepEqual([d.opportunities[0].title, d.opportunities[0].stage, d.opportunities[0].value_inr, d.opportunities[0].id], ["South TN distribution", "Identified", 300000, r.body.opportunity_id]);
  assert.ok((await people()).some((x) => x.id === pid), "listed in People");
  const [row] = await q("SELECT summary, category_locked FROM people WHERE id = ?", [pid]);
  assert.deepEqual([row.summary, row.category_locked], ["Distributor for south Tamil Nadu", 1], "the owner's category is never changed by calls");

  // Same name: asks first (shows who), then adds as a different person when told to.
  const again = await api("POST", "/api/people", { name: "Handadd Ramesh" });
  assert.equal(again.status, 409);
  assert.equal(again.body.existing[0].id, pid);
  assert.equal(again.body.existing[0].city, "Madurai");
  const second = await api("POST", "/api/people", { name: "Handadd Ramesh", city: "Salem", same_name_ok: true });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.person_id, pid);

  // Duplicate check while typing: a phone number blocks; a name warns, by how much else matches.
  const check = async (qs) => (await api("GET", `/api/people-check?${new URLSearchParams(qs)}`)).body;
  let c = await check({ name: "Handadd Ramesh", city: "madurai", department: "Channel partners" });
  assert.equal(c.name_matches[0].id, pid);
  assert.equal(c.name_matches[0].level, "strong", "same name + city (any case) + department");
  assert.equal(c.name_matches.find((m) => m.id === second.body.person_id).level, "weak", "the Salem one: other city");
  assert.equal((await check({ name: "Handadd Ramesh", city: "Madurai", department: "Sales" })).name_matches[0].level, "likely", "same name + city, other department");
  assert.ok((await check({ name: "Handadd Ramesh" })).name_matches.every((m) => m.level === "weak"), "no city yet: only a hint");
  assert.deepEqual((await check({ name: "Someone Else" })).name_matches, []);
  c = await check({ name: "Anybody", phone: "+91 98765 11111" });
  assert.equal(c.phone_match?.id, pid, "the phone number is Handadd Ramesh's");
  assert.equal((await check({ name: "Anybody", phone: "98765" })).phone_match, null, "an unfinished number matches nobody");
  // Saving with that number: refused with who has it, whatever the name (even with same_name_ok).
  const taken = await api("POST", "/api/people", { name: "Other Person", phone: "+919876511111", same_name_ok: true });
  assert.deepEqual([taken.status, taken.body.code, taken.body.phone_owner?.id], [409, "phone_taken", pid]);
  // The 409 for a same name says how strong the match is.
  assert.equal((await api("POST", "/api/people", { name: "Handadd Ramesh", city: "Madurai", departments: ["Channel partners"] })).body.existing[0].level, "strong");

  // A number from another country (the dialog's country code + number) is saved as given.
  const abroad = await api("POST", "/api/people", { name: "Handadd Faisal", phone: "+971501234567" });
  assert.equal(abroad.status, 201);
  assert.equal((await api("GET", `/api/people/${abroad.body.person_id}`)).body.person.phone, "+971501234567");
  await q("DELETE FROM people WHERE id = ?", [abroad.body.person_id]);

  // Validation: nothing is saved when something is wrong.
  const count = (await people()).length;
  assert.equal((await api("POST", "/api/people", {})).status, 422, "a name is required");
  assert.equal((await api("POST", "/api/people", { name: "X Y", phone: "12" })).status, 422);
  assert.equal((await api("POST", "/api/people", { name: "X Y", phone: "+91 98765 4321" })).status, 422, "+91 needs 10 digits (9 here)");
  assert.equal((await api("POST", "/api/people", { name: "X Y", phone: "+91 98765 432100" })).status, 422, "+91 needs 10 digits (11 here)");
  assert.equal((await api("POST", "/api/people", { name: "X Y", departments: ["Nope"] })).status, 422);
  assert.equal((await api("POST", "/api/people", { name: "X Y", opportunity: { title: "", stage: "Identified" } })).status, 422);
  assert.equal((await api("POST", "/api/people", { name: "X Y", opportunity: { title: "A deal", stage: "Identified" } })).status, 422, "a deal needs a department");
  assert.equal((await api("POST", "/api/people", { name: "X Y", opportunity: { title: "A deal", stage: "Identified", department: "Nope" } })).status, 422, "an existing department");
  assert.equal((await api("POST", "/api/people", { name: "12345" })).status, 422, "a name has letters");
  assert.equal((await api("POST", "/api/people", { name: "X Y", introduced_by_id: "f".repeat(32) })).status, 422);
  assert.equal((await api("POST", "/api/people", { name: "X Y", phone: "98765 11111" })).status, 409, "a phone number belongs to one person");
  assert.equal((await people()).length, count);

  await q("UPDATE people SET introduced_by_id = NULL WHERE id IN (?)", [[pid, second.body.person_id]]);
  await q("DELETE FROM people WHERE id IN (?)", [[pid, second.body.person_id, intro]]);
});
test("referral network: who introduced whom (levels), top connectors with second-level value, and a thank-you moment when an introduced person's deal moves on", async () => {
  const now = new Date();
  const ids = { a: "e".repeat(31) + "a", b: "e".repeat(31) + "b", c: "e".repeat(31) + "c" };
  const add = (id, name, intro, depts) =>
    q("INSERT INTO people (user_id, id, name, name_key, departments, score, introduced_by_id, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, ?, ?, ?, 70, ?, ?, ?, 'audio')", [id, name, name.toLowerCase(), depts, intro, now, now]);
  await add(ids.a, "Net Sanjay", null, "");
  await add(ids.b, "Net Meena", ids.a, "Investment");
  await add(ids.c, "Net Rajiv", ids.b, "Investment");
  const mk = async (pid, body) => (await api("POST", `/api/people/${pid}/opportunities`, body)).body.opportunity;
  await mk(ids.b, { title: "Net angel", department: "Investment", value_inr: 500000, stage: "In discussion" });
  const seed = await mk(ids.c, { title: "Net seed", department: "Investment", value_inr: 1000000, stage: "First contact" });
  await q("DELETE FROM notifications WHERE dedupe_key <> 'installed'");

  // The owner moves Rajiv's deal on: a moment to thank Meena, who introduced him.
  await api("POST", `/api/opportunities/${seed.id}`, { stage: "Pitch / bid shared" });
  const r = await api("GET", "/api/network");
  assert.equal(r.status, 200);
  const n = r.body;
  const node = (id) => n.nodes.find((x) => x.id === id);
  assert.deepEqual([node(ids.a).level, node(ids.b).level, node(ids.c).level], [1, 2, 3]);
  assert.deepEqual([node(ids.b).introduced_by, node(ids.c).introduced_by], [ids.a, ids.b]);
  assert.deepEqual([node(ids.c).stage, node(ids.c).open_value_inr, node(ids.c).deal.title], ["Pitch / bid shared", 1000000, "Net seed"]);
  assert.equal(node(ids.a).introduced, 1);
  const sanjay = n.connectors.find((c) => c.id === ids.a);
  assert.deepEqual([sanjay.direct, sanjay.second_level, sanjay.active, sanjay.value_inr], [1, 1, 2, 1500000], "second-level introductions count too");
  const meena = n.connectors.find((c) => c.id === ids.b);
  assert.deepEqual([meena.direct, meena.value_inr, meena.introduced[0].name], [1, 1000000, "Net Rajiv"]);
  const t = n.thanks.find((x) => x.opportunity.id === seed.id);
  assert.deepEqual([t.connector.name, t.person.name, t.from, t.to], ["Net Meena", "Net Rajiv", "First contact", "Pitch / bid shared"]);

  // The bell says it too.
  notes.resetForTests();
  const bell = (await api("GET", "/api/notifications")).body.items.find((x) => x.kind === "thanks");
  assert.equal(bell.title, "Say thank you to Net Meena");
  assert.equal(bell.link, `/people/${ids.b}`);

  await q("DELETE FROM notifications WHERE dedupe_key <> 'installed'");
  await q("UPDATE people SET introduced_by_id = NULL WHERE id IN (?)", [Object.values(ids)]);
  await q("DELETE FROM people WHERE id IN (?)", [Object.values(ids)]);
});
test("department dashboards: each department gets the dashboard for its work (chosen in Settings, or from its name); sales, partners and tenders numbers come from the data", async () => {
  const depts = (await api("GET", "/api/departments")).body.departments;
  const view = (slug) => depts.find((d) => d.slug === slug)?.view;
  assert.deepEqual(
    ["investment", "sales", "channel-partners", "vendors", "govt-tenders", "marketing"].map(view),
    ["investors", "sales", "partners", "suppliers", "tenders", "standard"],
    "built-in departments get a dashboard from their name",
  );
  const sales = depts.find((d) => d.slug === "sales");
  assert.equal(sales.view_type, null, "nothing chosen yet");
  assert.equal((await api("POST", `/api/departments/${sales.id}`, { view_type: "rocket" })).status, 422);
  assert.equal((await api("POST", `/api/departments/${sales.id}`, { view_type: "partners" })).body.department.view, "partners", "the owner's choice wins");
  assert.equal((await api("POST", `/api/departments/${sales.id}`, { view_type: null })).body.department.view, "sales", "null goes back to the name");
  const made = await api("POST", "/api/departments", { name: "Dealer network" });
  assert.equal(made.body.department.view, "partners", "a new department gets one from its name too");
  await api("DELETE", `/api/departments/${made.body.department.id}`);

  // Sales data: a won deal, a lost one, one closing soon, one stalled for 30 days.
  const now = new Date();
  const ids = { a: "e".repeat(31) + "d", b: "e".repeat(31) + "e", c: "e".repeat(31) + "f" };
  await q("INSERT INTO people (user_id, id, name, name_key, departments, city, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Dash Buyer', 'dash buyer', 'Sales', 'Madurai', 80, ?, ?, 'audio')", [ids.a, now, now]);
  await q("INSERT INTO people (user_id, id, name, name_key, departments, city, score, introduced_by_id, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Dash Client', 'dash client', 'Sales', 'Chennai', 60, ?, ?, ?, 'audio')", [ids.b, ids.a, now, new Date(Date.now() - 20 * 86_400_000)]);
  await q("INSERT INTO people (user_id, id, name, name_key, departments, score, first_seen_at, last_contact_at, last_contact_kind) VALUES (1, ?, 'Dash Officer', 'dash officer', 'Govt tenders', 50, ?, ?, 'audio')", [ids.c, now, now]);
  const mk = async (pid, body) => (await api("POST", `/api/people/${pid}/opportunities`, body)).body.opportunity;
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const ymd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  const w = await mk(ids.a, { title: "Dash won order", department: "Sales", value_inr: 400000, stage: "Pitch / bid shared" });
  await api("POST", `/api/opportunities/${w.id}`, { stage: "Won" });
  await mk(ids.a, { title: "Dash lost order", department: "Sales", value_inr: 100000, stage: "Lost" });
  const s = await mk(ids.b, { title: "Dash soon order", department: "Sales", value_inr: 200000, stage: "Negotiation", next_step: "Final price", due_date: ymd });
  const st = await mk(ids.b, { title: "Dash stalled order", department: "Sales", value_inr: 300000, stage: "First contact" });
  await q("UPDATE opportunity_stage_changes SET created_at = ? WHERE opportunity_id = ?", [new Date(Date.now() - 30 * 86_400_000), st.id]);
  const t = await mk(ids.c, { title: "Dash road tender", department: "Govt tenders", value_inr: 5000000, stage: "Pitch / bid shared", due_date: "2020-02-01" });
  try {
    const x = (await api("GET", "/api/department-pages/sales")).body;
    assert.equal(x.department.view, "sales");
    const e = x.extras;
    assert.deepEqual([e.won_count, e.lost_count, e.win_rate], [1, 1, 50], "win rate from closed deals");
    assert.equal(e.avg_deal_inr, 300000, "average of deals with a value (lost ones left out)");
    assert.deepEqual(e.closing_soon.map((o) => [o.id, o.days_left]), [[s.id, 3]]);
    assert.ok(e.stalled.some((o) => o.id === st.id && o.days_in_stage >= 29), "no move for 30 days");
    const reached = Object.fromEntries(e.reached.map((r) => [r.stage, r.count]));
    assert.equal(reached.Won, 1);
    assert.ok(reached["Pitch / bid shared"] >= 2, "the won deal got past pitch, and so did the one in negotiation");
    assert.deepEqual(e.cities.filter((c) => c.known).map((c) => c.city).sort(), ["Chennai", "Madurai"]);
    assert.equal(e.introduced[ids.a].count, 1, "who they brought in");
    assert.equal(e.introduced[ids.a].open_value_inr, 500000);
    assert.ok(e.quiet.some((q2) => q2.id === ids.b && q2.days >= 19));
    assert.ok(Array.isArray(e.commitments));

    const tx = (await api("GET", "/api/department-pages/govt-tenders")).body.extras;
    assert.equal(tx.view, "tenders");
    const dl = tx.deadlines.find((o) => o.id === t.id);
    assert.ok(dl.days_left < 0, "a passed deadline is negative (overdue)");
  } finally {
    await q("UPDATE people SET introduced_by_id = NULL WHERE id IN (?)", [Object.values(ids)]);
    await q("DELETE FROM people WHERE id IN (?)", [Object.values(ids)]);
  }
});
test("startup housekeeping: uploads interrupted by a restart are marked failed (with why); old sign-in codes and long-ended sessions are removed", async () => {
  const repo = await import("../src/db/repository.js");
  const authStore = await import("../src/auth/store.js");
  // A job that was "processing" when the server stopped.
  const id = "0".repeat(31) + "f";
  const [f] = await db.getPool().execute("INSERT INTO audio_files (user_id, stored_name, original_name, kind, file_format, size_bytes, sha256) VALUES (1, ?, 'Interrupted call.wav', 'audio', 'wav', 1, ?)", [`${id}.wav`, "0".repeat(64)]);
  await q("INSERT INTO processing_jobs (user_id, id, audio_file_id, kind, status, stage) VALUES (1, ?, ?, 'audio', 'processing', 'transcribing')", [id, f.insertId]);
  try {
    assert.ok((await repo.failInterruptedJobs()) >= 1);
    const [j] = await q("SELECT status, stage, error_message, finished_at FROM processing_jobs WHERE id = ?", [id]);
    assert.deepEqual([j.status, j.stage], ["failed", "failed"]);
    assert.match(j.error_message, /restarted/);
    assert.ok(j.finished_at instanceof Date);
    assert.equal((await q("SELECT COUNT(*) AS n FROM processing_jobs WHERE status IN ('queued', 'processing')"))[0].n, 0, "nothing left running");
    assert.equal((await q("SELECT COUNT(*) AS n FROM processing_jobs WHERE status = 'completed'"))[0].n > 0, true, "finished jobs are not touched");

    // Housekeeping: a 2-day-old code and a session that ended 40 days ago go; a live session stays.
    await q("INSERT INTO otp_challenges (id, email_hash, code_hash, expires_at, created_at) VALUES (?, ?, ?, NOW(3) - INTERVAL 2 DAY, NOW(3) - INTERVAL 2 DAY)", ["a".repeat(32), "b".repeat(64), "c".repeat(64)]);
    const [u] = await db.getPool().execute("INSERT INTO users (email, display_name, role) VALUES ('housekeeping@example.com', 'HK', 'member')");
    await q("INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at) VALUES (?, ?, NOW(3) - INTERVAL 40 DAY, NOW(3) - INTERVAL 40 DAY)", ["d".repeat(64), u.insertId]);
    await q("INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at) VALUES (?, ?, NOW(3) + INTERVAL 5 DAY, NOW(3))", ["e".repeat(64), u.insertId]);
    assert.ok((await authStore.purgeOld()) >= 2);
    assert.equal((await q("SELECT COUNT(*) AS n FROM otp_challenges WHERE id = ?", ["a".repeat(32)]))[0].n, 0);
    assert.deepEqual((await q("SELECT token_hash FROM sessions WHERE user_id = ?", [u.insertId])).map((r) => r.token_hash), ["e".repeat(64)], "only the live session stays");
    await q("DELETE FROM users WHERE id = ?", [u.insertId]);
  } finally {
    await q("DELETE FROM processing_jobs WHERE id = ?", [id]);
    await q("DELETE FROM audio_files WHERE id = ?", [f.insertId]);
  }
});
test("Today follow-ups are paged on the server: real total, five at a time, late first, no gaps or repeats", async () => {
  const pid = (await api("POST", "/api/people", { name: "Pager Kannan", city: "Erode", role_title: "Distributor", organisation: "Kannan Traders", same_name_ok: true })).body.person_id;
  const ymd = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const plan = [["Late step", -2], ["Soon step", 1], ["Later step", 9], ["Undated A", null], ["Undated B", null], ["Mid step", 4], ["Undated C", null]];
  const ids = [];
  for (const [step, days] of plan) {
    const o = await api("POST", `/api/people/${pid}/opportunities`, { title: `Pager ${step}`, stage: "In discussion", department: "Sales", value_inr: 50000, next_step: `PAGER ${step}`, due_date: days === null ? null : ymd(days) });
    ids.push(o.body.opportunity.id);
  }
  try {
    const first = (await api("GET", "/api/follow-ups?offset=0&limit=5")).body;
    const today = (await api("GET", "/api/today")).body;
    assert.equal(today.follow_ups.length, Math.min(5, first.total), "Today sends the first page only");
    assert.equal(today.numbers.follow_ups, first.total, "Today's count is the real total");
    assert.ok(first.total >= 7);
    // Every page in turn = the whole list once, in order.
    const all = [];
    for (let offset = 0; ; ) {
      const p = (await api("GET", `/api/follow-ups?offset=${offset}&limit=5`)).body;
      assert.ok(p.items.length <= 5);
      all.push(...p.items);
      offset += p.items.length;
      if (!p.has_more) break;
    }
    const keys = all.map((f) => `${f.kind}-${f.id}`);
    assert.equal(all.length, first.total, "pages add up to the total");
    assert.equal(new Set(keys).size, keys.length, "no follow-up twice");
    const mine = all.filter((f) => f.kind === "deal" && String(f.text).startsWith("PAGER "));
    assert.deepEqual(mine.slice(0, 4).map((f) => f.text), ["PAGER Late step", "PAGER Soon step", "PAGER Mid step", "PAGER Later step"], "late first, then by due date");
    assert.deepEqual(new Set(mine.slice(4).map((f) => f.text)), new Set(["PAGER Undated A", "PAGER Undated B", "PAGER Undated C"]), "undated after the dated ones");
    assert.equal(mine[0].text, "PAGER Late step");
    assert.equal(mine[0].overdue, true);
    assert.deepEqual([mine[0].person.name, mine[0].person.role_title, mine[0].person.organisation, mine[0].person.city], ["Pager Kannan", "Distributor", "Kannan Traders", "Erode"], "who they are");
    assert.equal(mine[0].deal_info.title, "Pager Late step", "why: the deal");
    // Limits are kept safe.
    assert.equal((await api("GET", "/api/follow-ups?offset=0&limit=500")).body.items.length, Math.min(50, first.total), "at most 50 a page");
    assert.equal((await api("GET", "/api/follow-ups?offset=-3&limit=0")).body.offset, 0, "a bad offset reads from the start");
    assert.equal((await api("GET", "/api/follow-ups?offset=0&limit=abc")).body.items.length, Math.min(5, first.total), "a bad limit is 5");
    const past = (await api("GET", `/api/follow-ups?offset=${first.total + 5}&limit=5`)).body;
    assert.deepEqual([past.items.length, past.has_more], [0, false], "past the end: empty");
  } finally {
    await q("DELETE FROM people WHERE id = ?", [pid]);
  }
});

test("Today top opportunities are ranked and paged on the server: value x chance x urgency, real total, no gaps", async () => {
  const pid = (await api("POST", "/api/people", { name: "Ranker Selva", city: "Salem", same_name_ok: true })).body.person_id;
  const ymd = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  // value, stage (chance), due: the expected rank = value x chance x urgency.
  const plan = [
    ["RANK big late", 1_000_000, "Negotiation", -1], //   1,000,000 x 0.7 x 1.5  = 1,050,000
    ["RANK big", 1_000_000, "Negotiation", null], //      1,000,000 x 0.7         =   700,000
    ["RANK soon", 1_000_000, "Pitch / bid shared", 1], // 1,000,000 x 0.5 x 1.3  =   650,000
    ["RANK week", 1_000_000, "Pitch / bid shared", 5], // 1,000,000 x 0.5 x 1.15 =   575,000
    ["RANK small", 100_000, "Committed", null], //          100,000 x 0.9         =    90,000
    ["RANK none", null, "Identified", null], //                    0
  ];
  for (const [title, value, stage, days] of plan) {
    await api("POST", `/api/people/${pid}/opportunities`, { title, stage, department: "Sales", value_inr: value, due_date: days === null ? null : ymd(days) });
  }
  try {
    const all = [];
    let total = 0;
    for (let offset = 0; ; ) {
      const p = (await api("GET", `/api/top-opportunities?offset=${offset}&limit=5`)).body;
      total = p.total;
      all.push(...p.items);
      offset += p.items.length;
      if (!p.has_more) break;
    }
    assert.equal(all.length, total, "pages add up to every open deal");
    assert.equal(new Set(all.map((o) => o.id)).size, all.length, "no deal twice");
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].rank >= all[i].rank, "ranked high to low");
    const mine = all.filter((o) => o.title.startsWith("RANK "));
    assert.deepEqual(mine.map((o) => [o.title, o.rank]), [["RANK big late", 1050000], ["RANK big", 700000], ["RANK soon", 650000], ["RANK week", 575000], ["RANK small", 90000], ["RANK none", 0]]);
    assert.deepEqual([mine[0].overdue, mine[0].urgency, mine[2].urgency], [true, "Overdue", "Tomorrow"]);
    const today = (await api("GET", "/api/today")).body;
    assert.equal(today.top.length, Math.min(5, total), "Today sends the first page");
    assert.equal(today.top_total, total, "with the real total");
    assert.deepEqual(today.top.map((o) => o.id), all.slice(0, 5).map((o) => o.id), "the same order as the pages");
    assert.equal((await api("GET", "/api/top-opportunities?offset=0&limit=999")).body.items.length, Math.min(50, total), "at most 50 a page");
  } finally {
    await q("DELETE FROM people WHERE id = ?", [pid]);
  }
});
