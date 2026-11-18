// People extraction rules (no database, no Gemini): what the model says is kept only when the
// transcript supports it.

import "./helpers/no-login.js";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_ENABLED = "false";
const people = await import("../src/services/people.js");

const L = (id, speaker, original, english = null) => ({ id, speaker, original, english, time_label: `00:0${id}` });
const LINES = [
  L(0, "Prem", "ஹலோ Sanjay", "Hello Sanjay"),
  L(1, "Sanjay", "நான் நேத்து Deepan sir-ஐ meet பண்ணேன். அவர் Chennai-ல இருக்கிற angel investor.", "I met Deepan sir yesterday. He is an angel investor in Chennai."),
  L(2, "Prem", "Super", "Super"),
  L(3, "Sanjay", "Naveen கிட்ட கூட பேசினேன்", "I also spoke to Naveen"),
  L(4, "Sanjay", "Ramesh பையன் Ashok meeting-க்கு வருவாரு. Meeting Coimbatore-ல.", "Ramesh's son Ashok will come to the meeting. The meeting is in Coimbatore."),
  L(5, "Prem", "சரி", "OK"),
  L(6, "Prem", "Bangalore-ல ஒரு client இருக்காங்க", "There is a client in Bangalore"),
];
const P = (over) => ({
  name: "Deepan", relation: "mentioned", category: "Investor", role_title: "Angel investor", organisation: null, city: "Chennai",
  departments: ["Investment"], interest: "high", introduced_by: "Sanjay", context: "Angel investor in Chennai.", quote: null, evidence_ids: [1], ...over,
});

test("names: honorifics removed, matching key, initials", () => {
  assert.equal(people.cleanName("Deepan sir"), "Deepan");
  assert.equal(people.cleanName("Dr. senthil"), "Senthil");
  assert.equal(people.cleanName("Raghavan  Sir!"), "Raghavan");
  assert.equal(people.nameKey("Mr. Ramesh Gounder"), "ramesh gounder");
  assert.equal(people.initialsOf("Ramesh Gounder"), "RG");
  assert.equal(people.initialsOf("Deepan"), "DE");
  assert.equal(people.canonicalCity("bangalore"), "Bengaluru");
  assert.equal(people.canonicalCity("Kovai"), "Coimbatore");
});

test("a supported person is kept with category, city, departments and who introduced them", () => {
  const [d] = people.validatePeople([P()], LINES, "Prem");
  assert.deepEqual(
    { name: d.name, key: d.key, category: d.category, city: d.city, departments: d.departments, introduced_by: d.introduced_by, relation: d.relation, evidence: d.evidence },
    { name: "Deepan", key: "deepan", category: "Investor", city: "Chennai", departments: ["Investment"], introduced_by: "Sanjay", relation: "mentioned", evidence: [1] },
  );
});

test("the owner, unnamed people and names not in the conversation are never added", () => {
  const out = people.validatePeople(
    [P({ name: "Prem" }), P({ name: "Prem Kumar" }), P({ name: "Person 2" }), P({ name: "Karthik", evidence_ids: [1] }), P({ name: "Deepan", evidence_ids: [99] })],
    LINES,
    "Prem",
  );
  assert.deepEqual(out.map((p) => p.name), []);
});

test("a city is kept only when it is said about that person", () => {
  const out = people.validatePeople(
    [
      P({ name: "Ashok", city: "Coimbatore", evidence_ids: [4], category: "unclear" }), // said on the same line -> kept
      P({ name: "Naveen", city: "Chennai", evidence_ids: [3], category: "unclear" }), // Chennai is said about Deepan, 2 lines away
      P({ name: "Deepan", city: "Mumbai" }), // never said
    ],
    LINES,
    "Prem",
  );
  const city = Object.fromEntries(out.map((p) => [p.name, p.city]));
  assert.deepEqual(city, { Ashok: "Coimbatore", Naveen: null, Deepan: null });
  assert.equal(out.find((p) => p.name === "Ashok").category, null, "'unclear' is stored as no category");
});

test("participants: a speaker is a participant even without cited lines; their own lines count for their city", () => {
  const out = people.validatePeople([P({ name: "Sanjay", relation: "mentioned", city: "Chennai", evidence_ids: [], category: "Business partner", introduced_by: null })], LINES, "Prem");
  assert.equal(out.length, 1);
  assert.equal(out[0].relation, "participant");
  assert.equal(out[0].city, "Chennai");
});

test("invalid values are dropped: unknown departments and categories, introducer = owner or self", () => {
  const [d] = people.validatePeople([P({ departments: ["Investment", "Space"], category: "Astronaut", introduced_by: "Prem" })], LINES, "Prem");
  assert.deepEqual(d.departments, ["Investment"]);
  assert.equal(d.category, null);
  assert.equal(d.introduced_by, null);
  const [self] = people.validatePeople([P({ introduced_by: "Deepan" })], LINES, "Prem");
  assert.equal(self.introduced_by, null);
});

test("the same person listed twice becomes one entry with merged facts", () => {
  const out = people.validatePeople(
    [P({ name: "Deepan sir", city: null, departments: [], evidence_ids: [1] }), P({ name: "deepan", category: "unclear", departments: ["Investment"], evidence_ids: [1, 2] })],
    LINES,
    "Prem",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "Investor");
  assert.deepEqual(out[0].departments, ["Investment"]);
  assert.deepEqual(out[0].evidence, [1, 2]);
});

test("opportunity insight: only factors with real lines; chance rounded and kept in 0-100; details only when said", async () => {
  const { validateInsight } = await import("../src/services/opportunityInsight.js");
  const lines = [
    { gid: 1001, id: 1, job_id: "j1", speaker: "Naveen", time_label: "00:42", start: 42, original: "TD is open to meet", english: "TD is open to meet" },
    { gid: 2003, id: 3, job_id: "j2", speaker: "TD", time_label: "01:10", start: 70, original: "Send the deck", english: "Send the deck" },
  ];
  const out = validateInsight(
    {
      factors: [
        { label: "First meeting", level: "high", reason: "Agreed to meet via Naveen", evidence_ids: [1001, 9999] },
        { label: "Investment", level: "medium", reason: "Asked for the deck", evidence_ids: [2003] },
        { label: "Made up", level: "low", reason: "No line", evidence_ids: [42] },
        { label: "Bad level", level: "great", reason: "x", evidence_ids: [1001] },
      ],
      would_change: "  Would move to High if the traction note lands  ",
      suggested_chance_pct: 27,
      details: { instrument: "Equity", decision_by: null, expected: "" },
    },
    lines,
  );
  assert.deepEqual(out.factors.map((f) => [f.label, f.level, f.evidence.map((e) => [e.job_id, e.time_label])]), [["First meeting", "high", [["j1", "00:42"]]], ["Investment", "medium", [["j2", "01:10"]]]]);
  assert.equal(out.would_change, "Would move to High if the traction note lands");
  assert.equal(out.suggested_chance_pct, 25, "rounded to 5");
  assert.deepEqual(out.details, { instrument: "Equity", decision_by: null, expected: null });
  assert.equal(validateInsight({ factors: [], suggested_chance_pct: 90, details: {} }, lines).suggested_chance_pct, null, "no grounded factor: no number");
  assert.equal(validateInsight({ factors: [{ label: "A", level: "low", reason: "r", evidence_ids: [1001] }], suggested_chance_pct: 400, details: {} }, lines).suggested_chance_pct, 100);
});

test("a date said in a call is kept only when it is a real day near the call; nothing is guessed", () => {
  const { dueDateOf } = people;
  assert.equal(dueDateOf("2026-11-25", "2026-11-17"), "2026-11-25");
  assert.equal(dueDateOf("2026-11-14", "2026-11-17"), "2026-11-14", "a few days before is kept (late, overdue)");
  for (const bad of [null, "", "next Friday", "25/11/2026", "2026-02-30", "2026-13-01", "2020-01-01", "2030-01-01"]) assert.equal(dueDateOf(bad, "2026-11-17"), null, String(bad));
});

test("the same deal said again in a later call is recognised (word forms too); different deals are not merged", async () => {
  const { sameDeal } = await import("../src/db/people.js");
  const d = (title, value_inr = null, department = "Channel partners") => ({ title, value_inr, department });
  // Same deal: the follow-up call words it differently.
  assert.ok(sameDeal(d("Teemly software distribution partnership", 500000), d("Distributor agreement for 50 licenses", 500000)));
  assert.ok(sameDeal(d("Teemly launch campaign", 200000, "Marketing"), d("Launch campaign for Teemly", 200000, "Marketing")));
  assert.ok(sameDeal(d("Teemly software distribution partnership", 500000), d("Distribution to the 200 shops")));
  // Different deals with the same person.
  assert.ok(!sameDeal(d("Teemly software distribution partnership", 500000), d("Annual support contract for shops", 200000)));
  assert.ok(!sameDeal(d("Customer support WhatsApp chatbot development", 100000, "Tech & AI"), d("Annual support contract for shops", 200000, "Tech & AI")));
  assert.ok(!sameDeal(d("Seed investment in Teemly", 3000000, "Investment"), d("Angel investment in Teemly", 2500000, "Investment")));
  assert.ok(!sameDeal(d("Bulk order", 200000, "Sales"), d("Bulk printing order", 500000, "Sales")));
});
test("follow-ups: when a promise from a call is due, from the words said (counted from the call's day)", async () => {
  const { dueFromWords } = await import("../src/db/today.js");
  const wed = "2026-11-18"; // a Wednesday
  const cases = [
    ["today", "2026-11-18"],
    ["Send it today itself", "2026-11-18"],
    ["by tomorrow", "2026-11-19"],
    ["naalaikku", "2026-11-19"],
    ["day after tomorrow", "2026-11-20"],
    ["by this Friday", "2026-11-20"],
    ["Friday", "2026-11-20"],
    ["by Wednesday", "2026-11-18"],
    ["Mon", "2026-11-23"],
    ["next Monday", "2026-11-23"],
    ["next Friday", "2026-11-27"],
    ["this week", "2026-11-20"],
    ["by end of the week", "2026-11-20"],
    ["next week", "2026-11-27"],
    ["within 3 days", "2026-11-21"],
    ["in 2 weeks", "2026-12-02"],
    ["by the 25th", "2026-11-25"],
    ["on the 5th", "2026-12-05"],
    ["month end", "2026-11-30"],
    ["soon", null],
    ["later", null],
    ["50 licenses", null],
    ["", null],
    [null, null],
  ];
  for (const [words, want] of cases) assert.equal(dueFromWords(words, wed), want, `"${words}" said on Wed 18 Nov`);
  assert.equal(dueFromWords("this week", "2026-11-21"), "2026-11-22", "said on a Saturday: this week ends on Sunday");
  assert.equal(dueFromWords("on the 31st", "2026-11-18"), null, "no 31 November");
  assert.equal(dueFromWords("today", null), null, "no call day, no date");
});
