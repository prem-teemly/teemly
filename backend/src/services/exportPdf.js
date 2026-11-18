// "Export" — the full conversation context as a Teemly-branded PDF report.
//
// The report is built only from the job result held by the backend (nothing is taken from the
// client except a display title, which is escaped). It is rendered by the installed Microsoft Edge
// (or Chrome) in headless mode with JavaScript disabled and all network access blocked, so Tamil,
// Hindi and Telugu text is shaped correctly and the HTML cannot load anything.

import * as config from "../config.js";
import { getLogger } from "../util.js";
import { pulseByPerson } from "./pulseWave.js";

const logger = getLogger("app.services.export");

/** Export cannot run (no browser available). The message is safe to show. */
export class ExportUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportUnavailable";
  }
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtTime(t) {
  if (t === null || t === undefined) return "";
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const OVERALL = { high: "High interest", medium: "Medium interest", low: "Low interest", none: "No product interest", not_enough_evidence: "Not enough evidence" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;

/** Everyone who spoke, in order of first line, with talk time. */
function talkTime(r) {
  const people = new Map();
  for (const x of r.tamil_segments ?? []) {
    if (!x.text || !x.speaker) continue;
    const p = people.get(x.speaker) ?? { name: x.speaker, seconds: 0, lines: 0, first: x.start };
    p.seconds += Math.max(0, x.end - x.start);
    p.lines += 1;
    people.set(x.speaker, p);
  }
  const total = [...people.values()].reduce((a, p) => a + p.seconds, 0) || 1;
  return [...people.values()].map((p) => ({ ...p, share: p.seconds / total }));
}

/** Pulse, short: what each person is interested in, in plain words. */
function pulseSection(p, r) {
  if (!p?.available || !p.data) return "";
  const d = p.data;
  const chat = r.source === "whatsapp";
  const wave = pulseByPerson(d, {
    speakers: chat ? r.participants ?? [] : talkTime(r).map((x) => x.name),
    duration: chat ? 0 : r.audio_duration_seconds,
    lineCount: chat ? r.messages?.length ?? 0 : 0,
  });
  const people = wave.people
    .filter((x) => x.beats.length)
    .map((x) => `<div class="person-pulse"><div><strong>${esc(x.person)}</strong> <span class="tag${x.level ? "" : " tag-outline"}">${esc(x.interest)}</span></div>
      ${x.interests.length ? `<p><b>Interested in:</b> ${esc(x.interests.join(", "))}</p>` : ""}
      ${x.statements.length ? `<ul>${x.statements.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${x.concerns.length ? `<p class="concern"><b>Concerns:</b> ${esc(x.concerns.join(" "))}</p>` : ""}</div>`)
    .join("");
  return section("Pulse", `<p><span class="pill">${esc(OVERALL[d.overall_interest] ?? d.overall_interest)}</span> ${esc(d.overview)}</p>${people || `<p class="muted">No interest signals were found.</p>`}`);
}

/** Short summary (chats, and calls processed before key moments existed). */
function summarySection(a) {
  if (!a?.available || !a.data) return "";
  const d = a.data;
  const next = d.action_items.map((x) => `${x.task}${x.responsible_person ? ` (${x.responsible_person})` : ""}`);
  return section("Summary", `<p>${esc(d.summary)}</p>${next.length ? `<h3>Next steps</h3><ul>${next.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}`);
}

/** The main context: what was discussed (overview), and each part of the call with its time. */
function discussionSection(r) {
  const c = r.context?.available ? r.context.data : null;
  if (!c) return "";
  const overview = c.overview ? `<p>${esc(c.overview)}</p>` : "";
  const parts = c.sections?.length
    ? `<table class="parts"><tbody>${c.sections
        .map((x) => `<tr><td class="nowrap km-time">${esc(x.time_label)}</td><td><strong>${esc(x.title)}</strong><br>${esc(x.summary)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  return overview || parts ? section("What was discussed", overview + (c.sections?.length > 1 ? `<h3>Discussion, part by part</h3>${parts}` : parts)) : "";
}

/** Decisions and next steps (who will do what, by when), from the same analysis the web shows. */
function nextStepsSection(a) {
  if (!a?.available || !a.data) return "";
  const d = a.data;
  const decisions = d.decisions.map((x) => `${x.decision}${x.made_by ? ` (${x.made_by})` : ""}`);
  const actions = d.action_items.map((x) => {
    const when = [x.deadline, x.date, x.time].filter(Boolean).join(" · ");
    return `${x.task}${x.responsible_person ? ` — ${x.responsible_person}` : ""}${when ? `, ${when}` : ""}`;
  });
  const ul = (xs) => `<ul>${xs.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  if (!decisions.length && !actions.length && !d.follow_ups.length) return "";
  return section(
    "Decisions and next steps",
    `${decisions.length ? `<h3>Decisions</h3>${ul(decisions)}` : ""}${actions.length ? `<h3>Next steps</h3>${ul(actions)}` : ""}${d.follow_ups.length ? `<h3>Follow-ups</h3>${ul(d.follow_ups)}` : ""}`,
  );
}

const TAG = { commitment: "Commitment", hedging: "Hedging", new_person: "New person", interest: "Interest", concern: "Concern", decision: "Decision", question: "Question" };

/** The short transcript: only the moments that carry the conversation, with exact time and speaker. */
function keyMomentsSection(r) {
  const m = r.context?.available ? r.context.data?.key_moments ?? [] : [];
  if (!m.length) return "";
  const total = (r.tamil_segments ?? []).filter((x) => x.text).length;
  const rows = m
    .map((x) => {
      const en = x.text;
      const tag = x.tag ? ` <span class="tag km-${esc(x.tag)}">${esc(TAG[x.tag] ?? x.tag)}</span>` : "";
      return `<tr><td class="nowrap km-time">${fmtTime(x.start)}</td><td class="nowrap km-who">${esc(x.speaker ?? "Unknown")}</td><td><span class="${x.tag ? `km-hl km-${esc(x.tag)}` : ""}">${esc(en)}</span>${tag}</td></tr>`;
    })
    .join("");
  return section("Key moments", `<p class="muted small">Showing ${m.length} key moments · ${total} lines. Time = position in the recording.</p><table class="moments"><tbody>${rows}</tbody></table>`);
}

function transcriptSection(result) {
  if (result.source === "whatsapp") {
    const rows = result.messages
      .filter((m) => m.kind !== "system")
      .map((m) => `<tr><td class="nowrap">${esc(m.timestamp.replace("T", " ").slice(0, 16))}</td><td>${esc(m.sender ?? "")}</td><td>${esc(m.kind === "media" ? "(media)" : m.text)}${m.english && m.english !== m.text ? `<br><span class="muted">${esc(m.english)}</span>` : ""}</td></tr>`)
      .join("");
    return section("Conversation", `<table class="transcript"><thead><tr><th>Time</th><th>Sender</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  const rows = result.tamil_segments
    .map((s, i) => {
      const en = result.english_segments[i]?.text;
      if (!s.text) return "";
      return `<tr><td class="nowrap">${fmtTime(s.start)}</td><td><strong>${esc(s.speaker ?? "Unknown")}:</strong> ${esc(s.text)}${s.emotion && s.emotion !== "neutral" ? ` <span class="tag emo-${esc(s.emotion)}">${esc(cap(s.emotion))}</span>` : ""}${en && en !== s.text ? `<br><span class="muted">${esc(en)}</span>` : ""}</td></tr>`;
    })
    .join("");
  return section("Transcript", `<p class="muted small">Every line with its time in the recording, the person who said it, and the English translation.</p><table class="transcript"><thead><tr><th>Time</th><th>Who said what (original · English)</th></tr></thead><tbody>${rows}</tbody></table>`);
}

const CSS = `
@page { size: A4; margin: 12mm 12mm 16mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", "Nirmala UI", "Noto Sans Tamil", "Noto Sans", Arial, sans-serif; font-size: 10pt; line-height: 1.45; color: #18181b; }
.brand { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 3px solid #5b4fe9; }
.logo { width: 34px; height: 34px; border-radius: 9px; background: #5b4fe9; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 18pt; }
.brand-name { font-size: 16pt; font-weight: 700; color: #5b4fe9; letter-spacing: -0.01em; }
.brand-sub { margin-left: auto; text-align: right; color: #71717a; font-size: 9pt; }
h1 { font-size: 17pt; margin: 16px 0 4px; }
h2 { font-size: 12.5pt; color: #5b4fe9; margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #e8e8ed; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 12px 0 6px; color: #3f3f46; break-after: avoid; }
p { margin: 4px 0; }
ul { margin: 4px 0; padding-left: 18px; }
.muted { color: #71717a; } .small { font-size: 8.5pt; } .nowrap { white-space: nowrap; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
.fact { background: #f7f7f9; border: 1px solid #e8e8ed; border-radius: 8px; padding: 8px 10px; }
.fact b { display: block; font-size: 8pt; color: #71717a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.callout { background: #efedfe; border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.pill, .tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 8.5pt; font-weight: 600; background: #efedfe; color: #4c40da; }
.tag-outline { background: #fff; border: 1px solid #dcdce3; color: #71717a; }
.card { border: 1px solid #e8e8ed; border-radius: 8px; padding: 8px 12px; margin: 8px 0; break-inside: avoid; }
.card-head { display: flex; gap: 6px; align-items: center; }
.card-head strong { flex: 1; }
blockquote { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid #5b4fe9; background: #fafafb; }
table { width: 100%; border-collapse: collapse; margin: 6px 0; }
th, td { text-align: left; vertical-align: top; padding: 5px 6px; border-bottom: 1px solid #e8e8ed; }
th { font-size: 8.5pt; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em; }
tr { break-inside: avoid; }
.transcript td:first-child { width: 1%; }
.bars { margin: 8px 0; }
.bar { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.bar-label { width: 90px; } .bar-pct { width: 40px; text-align: right; color: #71717a; }
.bar-track { flex: 1; height: 8px; background: #f3f3f6; border-radius: 999px; overflow: hidden; }
.bar-fill { display: block; height: 100%; background: #a1a1aa; }
.emo-friendly, .emo-happy, .emo-excited, .emo-interested, .emo-calm { background: #ecfdf3; color: #15803d; }
.bar-fill.emo-friendly, .bar-fill.emo-happy, .bar-fill.emo-excited, .bar-fill.emo-interested, .bar-fill.emo-calm { background: #16a34a; }
.emo-hesitant, .emo-concerned, .emo-confused { background: #fffbeb; color: #b45309; }
.bar-fill.emo-hesitant, .bar-fill.emo-concerned, .bar-fill.emo-confused { background: #d97706; }
.emo-frustrated, .emo-angry, .emo-sad { background: #fef2f2; color: #b91c1c; }
.bar-fill.emo-frustrated, .bar-fill.emo-angry, .bar-fill.emo-sad { background: #dc2626; }
.bar-fill.emo-neutral { background: #a1a1aa; }
.moments td, .parts td { padding: 4px 6px; }
.km-time { color: #71717a; font-variant-numeric: tabular-nums; width: 1%; }
.km-who { font-weight: 700; color: #0e9384; width: 1%; }
.km-hl { padding: 1px 4px; border-radius: 4px; }
.km-hl.km-commitment, .km-hl.km-decision { background: #e6f6f3; } .tag.km-commitment, .tag.km-decision { background: #e6f6f3; color: #0e7a6e; }
.km-hl.km-hedging, .km-hl.km-concern { background: #fff4e5; } .tag.km-hedging, .tag.km-concern { background: #fff4e5; color: #b45309; }
.km-hl.km-new_person { background: #efedfe; } .tag.km-new_person { background: #efedfe; color: #4c40da; }
.km-hl.km-interest { background: #ecfdf3; } .tag.km-interest { background: #ecfdf3; color: #15803d; }
.km-hl.km-question { background: #f1f5ff; } .tag.km-question { background: #f1f5ff; color: #1d4ed8; }
.person-pulse p { margin: 4px 0 0; } .person-pulse .concern { color: #b45309; }
.person-pulse { border: 1px solid #e8e8ed; border-radius: 8px; padding: 8px 12px; margin: 8px 0; break-inside: avoid; }
.person-pulse ul { margin: 4px 0 0; }
`;

/** Build the report HTML for a finished job. */
export function buildReportHtml(job, title) {
  const r = job.result;
  const chat = job.kind === "whatsapp";
  const generated = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const facts = chat
    ? [["Messages", r.message_count], ["Participants", r.participants.length], ["From", r.first_message_at.replace("T", " ").slice(0, 16)], ["Interest", OVERALL[r.pulse?.data?.overall_interest] ?? "—"]]
    : [["Duration", fmtTime(r.audio_duration_seconds)], ["People", talkTime(r).map((p) => p.name).join(", ") || "—"], ["Languages", r.language || "—"], ["Interest", OVERALL[r.pulse?.data?.overall_interest] ?? "—"]];
  // Main context first: what it is about, what was discussed (by part, with times), the key moments,
  // decisions and next steps, and what each person is interested in.
  const about = r.context?.available ? r.context.data?.main_topic : r.analysis?.data?.final_summary;
  const moments = chat ? "" : keyMomentsSection(r);
  const discussion = chat ? "" : discussionSection(r);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
  <header class="brand"><div class="logo">T</div><div class="brand-name">Teemly</div>
    <div class="brand-sub">Conversation report<br>${esc(generated)}</div></header>
  <h1>${esc(title)}</h1>
  <p class="muted">${chat ? "WhatsApp conversation" : "Call recording"}${chat && r.participants.length ? ` · ${esc(r.participants.join(", "))}` : ""}</p>
  <div class="facts">${facts.map(([k, v]) => `<div class="fact"><b>${esc(k)}</b>${esc(v)}</div>`).join("")}</div>
  ${about ? `<div class="callout"><strong>What this conversation is about:</strong> ${esc(about)}</div>` : ""}
  ${discussion || summarySection(r.analysis)}
  ${moments}
  ${discussion ? nextStepsSection(r.analysis) : ""}
  ${pulseSection(r.pulse, chat ? { ...r, source: "whatsapp" } : r)}
  ${moments || chat ? "" : transcriptSection(r)}
  </body></html>`;
}

/** Render HTML to a PDF with the installed Edge/Chrome; JavaScript and network access are disabled. */
export async function renderPdf(html) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new ExportUnavailable("PDF export is not installed on the backend (playwright-core is missing).");
  }
  let browser = null;
  const errors = [];
  const attempts = config.EXPORT_BROWSER_PATH ? [{ executablePath: config.EXPORT_BROWSER_PATH }] : [{ channel: "msedge" }, { channel: "chrome" }];
  for (const opts of attempts) {
    try {
      browser = await chromium.launch({ ...opts, headless: true });
      break;
    } catch (exc) {
      errors.push(exc.message.split("\n")[0]);
    }
  }
  if (!browser) {
    logger.warning(`No browser for PDF export: ${errors.join(" | ")}`);
    throw new ExportUnavailable("PDF export needs Microsoft Edge or Google Chrome on the backend machine (or set EXPORT_BROWSER_PATH).");
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort()); // the report may not load anything
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#71717a;padding:0 14mm;display:flex;justify-content:space-between;font-family:Segoe UI,Arial,sans-serif">' +
        '<span>Teemly · Confidential conversation report</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
  } finally {
    await browser.close();
  }
}
