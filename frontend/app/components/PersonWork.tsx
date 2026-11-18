"use client";

import Link from "next/link";
import { useState } from "react";
import { useDepartments } from "../lib/departments";
import { type From, withFrom } from "../lib/origin";
import {
  type Department,
  type Mention,
  type Note,
  type Opportunity,
  type OpportunityEvidence,
  type OpportunityInput,
  STAGES,
  stageClass,
  type Stage,
  addNote,
  addOpportunity,
  deleteNote,
  deleteOpportunity,
  dueLabel,
  isPast,
  rupees,
  updateNote,
  updateOpportunity,
  whenLabel,
} from "../lib/people";
import { formatClock } from "../lib/api";
import { PhoneIcon, SparkleIcon, WhatsAppIcon } from "./Icons";
import { DeptTag } from "./PeopleBits";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// ---------------------------------------------------------------------------- notes

/** The owner's notes about a person: add, pin, edit, delete (saved in MySQL). */
export function NotesTab({ personId, notes, onChange }: { personId: string; notes: Note[]; onChange: (n: Note[]) => void }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = (xs: Note[]) => [...xs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at));

  async function add() {
    if (saving || !draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const n = await addNote(personId, draft);
      onChange(sorted([n, ...notes]));
      setDraft("");
    } catch (e) {
      setError(message(e, "Could not save the note."));
    } finally {
      setSaving(false);
    }
  }
  async function change(id: string, c: { body?: string; pinned?: boolean }) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const n = await updateNote(id, c);
      onChange(sorted(notes.map((x) => (x.id === id ? n : x))));
      setEditing(null);
    } catch (e) {
      setError(message(e, "Could not save the note."));
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string) {
    if (busy || !window.confirm("Delete this note?")) return;
    setBusy(id);
    setError(null);
    try {
      await deleteNote(id);
      onChange(notes.filter((x) => x.id !== id));
    } catch (e) {
      setError(message(e, "Could not delete the note."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pw">
      <div className="pw-compose">
        <textarea
          value={draft}
          maxLength={4000}
          rows={3}
          placeholder="Write a note… (Ctrl + Enter to save)"
          aria-label="New note"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && void add()}
        />
        <button type="button" className="pa-btn pa-btn-primary pw-btn" disabled={saving || !draft.trim()} onClick={() => void add()}>
          {saving ? "Saving…" : "Add note"}
        </button>
      </div>
      {error && (
        <p className="pw-error" role="alert">
          {error}
        </p>
      )}
      {!notes.length ? (
        <p className="pa-empty">No notes yet. Notes are only for you.</p>
      ) : (
        <ul className="pw-notes">
          {notes.map((n) => (
            <li key={n.id} className={`pw-note ${n.pinned ? "pw-note-pinned" : ""}`}>
              {editing?.id === n.id ? (
                <>
                  <textarea value={editing.body} maxLength={4000} rows={3} aria-label="Edit note" autoFocus onChange={(e) => setEditing({ id: n.id, body: e.target.value })} />
                  <div className="pw-row-actions">
                    <button type="button" className="pa-btn pw-btn" onClick={() => setEditing(null)} disabled={busy === n.id}>
                      Cancel
                    </button>
                    <button type="button" className="pa-btn pa-btn-primary pw-btn" disabled={busy === n.id || !editing.body.trim()} onClick={() => void change(n.id, { body: editing.body })}>
                      {busy === n.id ? "Saving…" : "Save"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="pw-note-body">{n.body}</p>
                  <div className="pw-note-foot">
                    <span>
                      {n.pinned && <strong className="pw-pin">Pinned · </strong>}
                      {whenLabel(n.created_at)}
                      {n.updated_at !== n.created_at ? " · edited" : ""}
                    </span>
                    <span className="pw-row-actions">
                      <button type="button" className="pw-link" disabled={busy === n.id} onClick={() => void change(n.id, { pinned: !n.pinned })}>
                        {n.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button type="button" className="pw-link" disabled={busy === n.id} onClick={() => setEditing({ id: n.id, body: n.body })}>
                        Edit
                      </button>
                      <button type="button" className="pw-link pw-link-danger" disabled={busy === n.id} onClick={() => void remove(n.id)}>
                        Delete
                      </button>
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- opportunities

type Form = { title: string; stage: Stage; department: Department | ""; value: string; next_step: string; due_date: string; source_job_id: string };
const emptyForm: Form = { title: "", stage: "Identified", department: "", value: "", next_step: "", due_date: "", source_job_id: "" };
const formOf = (o: Opportunity): Form => ({
  title: o.title,
  stage: o.stage,
  department: o.department ?? "",
  value: o.value_inr === null ? "" : String(o.value_inr),
  next_step: o.next_step ?? "",
  due_date: o.due_date ?? "",
  source_job_id: o.source?.job_id ?? "",
});
const inputOf = (f: Form): OpportunityInput => ({
  title: f.title.trim(),
  stage: f.stage,
  department: f.department || null,
  value_inr: f.value.replace(/[,\s₹]/g, "") ? Number(f.value.replace(/[,\s₹]/g, "")) : null,
  next_step: f.next_step.trim() || null,
  due_date: f.due_date || null,
  source_job_id: f.source_job_id || null,
});

function OpportunityForm({ initial, mentions, submitLabel, onSubmit, onCancel }: { initial: Form; mentions: Mention[]; submitLabel: string; onSubmit: (f: Form) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { departments } = useDepartments();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const valueOk = !f.value.replace(/[,\s₹]/g, "") || /^\d+$/.test(f.value.replace(/[,\s₹]/g, ""));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!f.title.trim()) return setError("Give the opportunity a title.");
    if (!valueOk) return setError("Value should be a number of rupees, e.g. 250000.");
    setSaving(true);
    setError(null);
    try {
      await onSubmit(f);
    } catch (err) {
      setError(message(err, "Could not save."));
      setSaving(false);
    }
  }
  return (
    <form className="pw-form" onSubmit={(e) => void submit(e)}>
      <label className="ib-field">
        <span>Title</span>
        <input value={f.title} maxLength={160} required placeholder="e.g. South TN distribution" autoFocus onChange={(e) => set("title", e.target.value)} />
      </label>
      <div className="ib-row">
        <label className="ib-field">
          <span>Stage</span>
          <select value={f.stage} onChange={(e) => set("stage", e.target.value as Stage)}>
            {STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="ib-field">
          <span>Department</span>
          <select value={f.department} onChange={(e) => set("department", e.target.value as Department | "")}>
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.slug}>{d.name}</option>
            ))}
            {f.department && !departments.some((d) => d.name === f.department) && <option>{f.department}</option>}
          </select>
        </label>
      </div>
      <div className="ib-row">
        <label className="ib-field">
          <span>Value (₹)</span>
          <input value={f.value} inputMode="numeric" placeholder="e.g. 250000" onChange={(e) => set("value", e.target.value)} aria-invalid={!valueOk} />
        </label>
        <label className="ib-field">
          <span>Due date</span>
          <input type="date" value={f.due_date} onChange={(e) => set("due_date", e.target.value)} />
        </label>
      </div>
      <label className="ib-field">
        <span>Next step</span>
        <input value={f.next_step} maxLength={300} placeholder="e.g. Send deck v3 + traction note" onChange={(e) => set("next_step", e.target.value)} />
      </label>
      <label className="ib-field">
        <span>From conversation</span>
        <select value={f.source_job_id} onChange={(e) => set("source_job_id", e.target.value)}>
          <option value="">—</option>
          {mentions.map((m) => (
            <option key={m.job_id} value={m.job_id}>
              {m.kind === "whatsapp" ? "WhatsApp" : "Call"} · {whenLabel(m.at)} · {m.file_name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="pw-error" role="alert">
          {error}
        </p>
      )}
      <div className="pw-row-actions">
        <button type="button" className="pa-btn pw-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="pa-btn pa-btn-primary pw-btn" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** "🎧 Ramesh_call.wav · 1:19 · today 12:30 PM": the recording (or chat) it came from; opens that call. */
function SourceLine({ personId, source, from }: { personId: string; source: NonNullable<Opportunity["source"]>; from: From }) {
  const audio = source.kind !== "whatsapp";
  return (
    <Link href={withFrom(`/people/${personId}/calls/${source.job_id}`, from)} className="pw-source-line" title={`Open this ${audio ? "call" : "chat"}`}>
      {audio ? <PhoneIcon size={12} /> : <WhatsAppIcon size={12} />}
      <span className="pw-source-file">{source.file_name || (audio ? "Call recording" : "WhatsApp chat")}</span>
      {audio && source.duration_seconds ? <span>· {formatClock(source.duration_seconds)}</span> : null}
      <span>· {whenLabel(source.at)}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

/** What was said: the cited lines (time · speaker · English), first two, the rest on request. */
function EvidenceLines({ lines }: { lines: OpportunityEvidence[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 2);
  return (
    <ul className="pw-evidence" aria-label="What was said">
      {shown.map((l) => (
        <li key={l.id}>
          <span className="pw-ev-when">
            {l.time_label ?? ""}
            {l.speaker ? ` · ${l.speaker}` : ""}
          </span>
          <span className="pw-ev-text">“{l.english || l.text}”</span>
        </li>
      ))}
      {lines.length > 2 && (
        <li>
          <button type="button" className="pw-link" onClick={() => setAll((x) => !x)}>
            {all ? "Show less" : `Show ${lines.length - 2} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Opportunities (deals) with a person: add, move through stages, edit, delete (saved in MySQL). */
export function OpportunitiesTab({ personId, items, mentions, onChange, from = null }: { personId: string; items: Opportunity[]; mentions: Mention[]; onChange: (o: Opportunity[]) => void; from?: From }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replace = (o: Opportunity) => onChange(items.map((x) => (x.id === o.id ? o : x)));

  async function setStage(o: Opportunity, stage: Stage) {
    if (busy || stage === o.stage) return;
    setBusy(o.id);
    setError(null);
    try {
      replace(await updateOpportunity(o.id, { stage }));
    } catch (e) {
      setError(message(e, "Could not change the stage."));
    } finally {
      setBusy(null);
    }
  }
  async function remove(o: Opportunity) {
    if (busy || !window.confirm(`Delete "${o.title}"?`)) return;
    setBusy(o.id);
    setError(null);
    try {
      await deleteOpportunity(o.id);
      onChange(items.filter((x) => x.id !== o.id));
    } catch (e) {
      setError(message(e, "Could not delete."));
    } finally {
      setBusy(null);
    }
  }

  const open = items.filter((o) => o.stage !== "Won" && o.stage !== "Lost");
  const openValue = open.reduce((s, o) => s + (o.value_inr ?? 0), 0);
  return (
    <div className="pw">
      <div className="pw-head">
        <span className="pw-sum">
          {open.length} open{openValue ? ` · ${rupees(openValue)}` : ""}
          {items.length > open.length ? ` · ${items.length - open.length} closed` : ""}
        </span>
        {!adding && (
          <button type="button" className="pa-btn pa-btn-primary pw-btn" onClick={() => setAdding(true)}>
            + Add opportunity
          </button>
        )}
      </div>
      {adding && (
        <OpportunityForm
          initial={{ ...emptyForm, source_job_id: mentions[0]?.job_id ?? "" }}
          mentions={mentions}
          submitLabel="Add opportunity"
          onCancel={() => setAdding(false)}
          onSubmit={async (f) => {
            const o = await addOpportunity(personId, inputOf(f));
            onChange([o, ...items]);
            setAdding(false);
          }}
        />
      )}
      {error && (
        <p className="pw-error" role="alert">
          {error}
        </p>
      )}
      {!items.length && !adding ? (
        <p className="pa-empty">No opportunities yet. They are found automatically when a call talks about a deal, a partnership or an investment with this person, or you can add one yourself.</p>
      ) : (
        <ul className="pw-opps">
          {items.map((o) =>
            editing === o.id ? (
              <li key={o.id} className="pw-opp">
                <OpportunityForm
                  initial={formOf(o)}
                  mentions={mentions}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (f) => {
                    replace(await updateOpportunity(o.id, inputOf(f)));
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={o.id} className={`pw-opp ${o.stage === "Won" || o.stage === "Lost" ? "pw-opp-closed" : ""}`}>
                <div className="pw-opp-top">
                  <Link href={withFrom(`/opportunities/${o.id}`, "person")} className="pw-opp-title pw-opp-link" title="View this opportunity">
                    {o.title}
                  </Link>
                  {o.value_inr !== null && <span className="pw-opp-value">{rupees(o.value_inr)}</span>}
                </div>
                <div className="pw-opp-meta">
                  <select className={`pw-stage pw-stage-${stageClass(o.stage)}`} value={o.stage} aria-label={`Stage of ${o.title}`} disabled={busy === o.id} onChange={(e) => void setStage(o, e.target.value as Stage)}>
                    {STAGES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  {o.department && <DeptTag dept={o.department} />}
                  {o.origin === "ai" && (
                    <span className="pw-ai" title="Captured by the AI from this conversation">
                      <SparkleIcon size={11} /> Found in {o.source?.kind === "whatsapp" ? "chat" : "call"}
                    </span>
                  )}
                </div>
                {o.source && <SourceLine personId={personId} source={o.source} from={from} />}
                {o.origin === "ai" && !!o.evidence?.length && <EvidenceLines lines={o.evidence} />}
                {(o.next_step || o.due_date) && (
                  <p className="pw-next">
                    {o.next_step && (
                      <>
                        <strong>Next:</strong> {o.next_step}
                      </>
                    )}
                    {o.due_date && <span className={`pw-due ${isPast(o.due_date) && !o.closed_at ? "pw-due-late" : ""}`}> · Due {dueLabel(o.due_date)}</span>}
                  </p>
                )}
                <div className="pw-note-foot">
                  <span>{o.closed_at ? `${o.stage} ${whenLabel(o.closed_at)}` : `Added ${whenLabel(o.created_at)}`}</span>
                  <span className="pw-row-actions">
                    <Link href={withFrom(`/opportunities/${o.id}`, "person")} className="pw-link pw-view-opp">
                      View opportunity →
                    </Link>
                    <button type="button" className="pw-link" disabled={busy === o.id} onClick={() => setEditing(o.id)}>
                      Edit
                    </button>
                    <button type="button" className="pw-link pw-link-danger" disabled={busy === o.id} onClick={() => void remove(o)}>
                      Delete
                    </button>
                  </span>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
