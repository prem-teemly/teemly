"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type Profile, getProfile } from "../lib/api";
import { DEPT_VIEWS, type DeptView, createDepartment, deleteDepartment, guessView, updateDepartment, useDepartments } from "../lib/departments";
import { type NotePrefs, PREF_LABELS, getNotePrefs, saveNotePrefs } from "../lib/notifications";
import { type RoomSettings, getSettings } from "../lib/settings";
import { DriveIcon, MailIcon, SparkleIcon, UsersIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";

// Settings: what is set up in this room, shown as it really is. Values come from the backend
// (GET /api/settings, the profile and People); anything not built yet says "Coming soon" and is
// disabled, so the page never shows a connection or a rule that is not actually working.

type Tab = "connections" | "departments" | "ai" | "digest" | "security";
const TABS: { id: Tab; label: string }[] = [
  { id: "connections", label: "Connections and privacy" },
  { id: "departments", label: "Departments" },
  { id: "ai", label: "AI and scoring" },
  { id: "digest", label: "Notifications" },
  { id: "security", label: "Security" },
];

function Status({ kind, children }: { kind: "on" | "soon" | "off"; children: React.ReactNode }) {
  return <span className={`st-status st-status-${kind}`}>{children}</span>;
}

/** A switch that shows a setting's state. Read-only here: `soon` = not built yet. */
function Toggle({ on, label }: { on: boolean; label: string }) {
  return <span className={`st-toggle ${on ? "st-toggle-on" : ""}`} role="switch" aria-checked={on} aria-disabled="true" aria-label={label} />;
}

function Row({ icon, title, sub, right }: { icon?: React.ReactNode; title: string; sub: React.ReactNode; right: React.ReactNode }) {
  return (
    <li className="st-row">
      {icon && (
        <span className="st-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="st-row-main">
        <span className="st-row-title">{title}</span>
        <span className="st-row-sub">{sub}</span>
      </span>
      <span className="st-row-right">{right}</span>
    </li>
  );
}

function Card({ title, note, children, wide }: { title: string; note?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`card st-card ${wide ? "st-wide" : ""}`} aria-label={title}>
      <div className="st-card-head">
        <h2 className="st-card-title">{title}</h2>
        {note && <span className="st-card-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function ConnectionsTab({ s, devices, profile }: { s: RoomSettings; devices: number | null; profile: Profile | null }) {
  const formats = s.upload.audio_formats.slice(0, 4).join(", ").toUpperCase();
  const email = profile?.user.email ?? profile?.user.email_masked ?? null;
  return (
    <div className="st-grid">
      <Card title="Connections">
        <ul className="st-rows">
          <Row
            icon={<UsersIcon size={17} />}
            title="Signed-in account"
            sub={profile ? `${profile.user.name} · ${email}` : "Loading…"}
            right={
              <Link href="/profile" className="pa-btn pw-btn">
                Profile
              </Link>
            }
          />
          <Row icon={<MailIcon size={17} />} title="Gmail" sub={`Read-only email sync for people in the room${email ? ` (${email})` : ""}`} right={<Status kind="soon">Coming soon</Status>} />
          <Row
            icon={<DriveIcon size={17} />}
            title="Call recordings"
            sub={`Upload from the app or a person's page (${formats}…, up to ${s.upload.max_audio_mb} MB) · Drive auto-sync coming soon`}
            right={<Status kind="on">Active</Status>}
          />
        </ul>
      </Card>

      <Card title="Recording consent">
        <ul className="st-rows">
          <Row title="Consent on every person" sub="Yes / No / Ask is kept on each profile and shown in People" right={<Status kind="on">Active</Status>} />
          <Row title="Block uploads when consent is No" sub="The recording would never be stored · coming soon" right={<Toggle on={false} label="Block uploads when consent is No (coming soon)" />} />
          <Row title="Ask me when consent is unknown" sub="One tap after each new upload · coming soon" right={<Toggle on={false} label="Ask me when consent is unknown (coming soon)" />} />
          <Row title="Keep tone analysis private" sub="Never included in exports or shares · coming soon" right={<Toggle on={false} label="Keep tone analysis private (coming soon)" />} />
        </ul>
      </Card>

      <Card title="Security">
        <ul className="st-rows">
          <Row title="Sign-in" sub={s.login.enabled ? `Email + one-time code · stay signed in ${s.login.session_days} days` : "Off: anyone who can open this app can use it"} right={<Status kind={s.login.enabled ? "on" : "off"}>{s.login.enabled ? "On" : "Off"}</Status>} />
          <Row
            title="Signed-in devices"
            sub={devices === null ? "See them on your profile" : `${devices} device${devices === 1 ? "" : "s"} signed in`}
            right={
              <Link href="/profile" className="pa-btn pw-btn">
                Manage
              </Link>
            }
          />
        </ul>
      </Card>

    </div>
  );
}

function Swatches({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div className="st-swatches" role="radiogroup" aria-label="Colour">
      {colors.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`st-swatch ${value === c ? "st-swatch-on" : ""}`} style={{ background: c }} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const viewLabel = (v: DeptView) => DEPT_VIEWS.find((x) => x.value === v)?.label ?? v;

/** The dashboard a department's page uses; "" = chosen from the department's name. */
function ViewSelect({ value, guess, onChange }: { value: DeptView | ""; guess: DeptView; onChange: (v: DeptView | "") => void }) {
  return (
    <select className="st-select" value={value} onChange={(e) => onChange(e.target.value as DeptView | "")} aria-label="Dashboard">
      <option value="">Automatic ({viewLabel(guess)})</option>
      {DEPT_VIEWS.map((v) => (
        <option key={v.value} value={v.value} title={v.hint}>
          {v.label}
        </option>
      ))}
    </select>
  );
}

function DepartmentsTab() {
  const { departments, loaded, palette } = useDepartments();
  const colors = palette.length ? palette : ["#6c63f6", "#2fae6a", "#18a7b5", "#64748b", "#e2507a", "#3b82f6", "#d4891b", "#9a6b4b", "#0f8b8d", "#c2410c"];
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; color: string; description: string; view: DeptView | "" } | null>(null);
  const pick = color ?? colors[departments.length % colors.length];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("Give the department a name.");
    setBusy("add");
    setError(null);
    setNotice(null);
    try {
      // No dashboard choice here: it follows the name (can be changed later with Edit).
      const d = await createDepartment({ name: name.trim(), color: pick, description: desc.trim() || null });
      setNotice(`“${d.name}” added. New calls will sort people into it; it is in the sidebar and the Departments panel.`);
      setName("");
      setDesc("");
      setColor(null);
    } catch (err) {
      setError(message(err, "Could not add the department."));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!editing || busy) return;
    setBusy(editing.id);
    setError(null);
    try {
      await updateDepartment(editing.id, { color: editing.color, description: editing.description.trim() || null, view_type: editing.view || null });
      setEditing(null);
    } catch (err) {
      setError(message(err, "Could not save."));
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string, deptName: string, people: number) {
    if (busy) return;
    if (!window.confirm(`Delete “${deptName}”? ${people ? `It is taken off ${people} ${people === 1 ? "person" : "people"} and their opportunities. ` : ""}People and opportunities themselves are kept. The AI will no longer sort people into it.`)) return;
    setBusy(id);
    setError(null);
    try {
      await deleteDepartment(id);
      setNotice(`“${deptName}” deleted.`);
    } catch (err) {
      setError(message(err, "Could not delete."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="st-grid">
      <Card title="Add a department" wide>
        <form className="st-add" noValidate onSubmit={(e) => void add(e)}>
          <label className="ib-field">
            <span>
              Name <span className="ap-req" aria-hidden="true">*</span>
            </span>
            <input value={name} maxLength={40} placeholder="e.g. Logistics" required onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ib-field st-add-desc">
            <span>Who belongs here (the AI uses this)</span>
            <input value={desc} maxLength={300} placeholder="e.g. Courier, transport and delivery partners" onChange={(e) => setDesc(e.target.value)} />
          </label>
          <div className="ib-field">
            <span>Colour</span>
            <Swatches colors={colors} value={pick} onPick={setColor} />
          </div>
          <button type="submit" className="pa-btn pa-btn-primary pw-btn st-add-btn" disabled={busy === "add"}>
            {busy === "add" ? "Adding…" : "+ Add department"}
          </button>
        </form>
        {error && (
          <p className="pw-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="st-ok">{notice}</p>}
      </Card>

      <Card title="Your departments" note={loaded ? `${departments.length} departments · a person can sit in more than one` : "Loading…"} wide>
        <ul className="st-dept-list">
          {departments.map((d) =>
            editing?.id === d.id ? (
              <li key={d.id} className="st-dept-row st-dept-editing">
                <span className="sb-dot" style={{ background: editing.color }} aria-hidden="true" />
                <div className="st-dept-edit">
                  <strong>{d.name}</strong>
                  <input value={editing.description} maxLength={300} placeholder="Who belongs here" aria-label={`Who belongs in ${d.name}`} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                  <Swatches colors={colors} value={editing.color} onPick={(c) => setEditing({ ...editing, color: c })} />
                  <label className="st-view-field">
                    <span>Dashboard</span>
                    <ViewSelect value={editing.view} guess={guessView(d.name)} onChange={(v) => setEditing({ ...editing, view: v })} />
                  </label>
                </div>
                <span className="pw-row-actions">
                  <button type="button" className="pa-btn pw-btn" onClick={() => setEditing(null)} disabled={busy === d.id}>
                    Cancel
                  </button>
                  <button type="button" className="pa-btn pa-btn-primary pw-btn" onClick={() => void save()} disabled={busy === d.id}>
                    {busy === d.id ? "Saving…" : "Save"}
                  </button>
                </span>
              </li>
            ) : (
              <li key={d.id} className="st-dept-row">
                <span className="sb-dot" style={{ background: d.color }} aria-hidden="true" />
                <span className="st-dept-main">
                  <Link href={`/departments/${d.slug}`} className="st-dept-name">
                    {d.name}
                  </Link>
                  <span className="st-row-sub">{d.description || "No description yet: the AI only has the name to go on."}</span>
                  <span className="st-view-tag">
                    Dashboard: {viewLabel(d.view ?? guessView(d.name))}
                    {!d.view_type && " (from the name)"}
                  </span>
                </span>
                <span className="st-dept-count">
                  {d.people} {d.people === 1 ? "person" : "people"}
                </span>
                {d.built_in ? <span className="st-status st-status-soon">Built-in</span> : <span className="st-status st-status-on">Added</span>}
                <span className="pw-row-actions">
                  <button type="button" className="pw-link" disabled={!!busy || !loaded} onClick={() => setEditing({ id: d.id, color: d.color, description: d.description ?? "", view: d.view_type ?? "" })}>
                    Edit
                  </button>
                  <button type="button" className="pw-link pw-link-danger" disabled={!!busy} onClick={() => void remove(d.id, d.name, d.people)}>
                    Delete
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      </Card>
    </div>
  );
}

function AiTab({ s }: { s: RoomSettings }) {
  return (
    <div className="st-grid">
      <Card title="AI model">
        <ul className="st-rows">
          <Row icon={<SparkleIcon size={16} />} title="Provider" sub={s.ai.provider} right={<Status kind="on">Connected</Status>} />
          <Row title="Transcription" sub={`${s.ai.transcribe_model} · Tamil, English, Tanglish, Hindi, Telugu`} right={null} />
          <Row title="Summaries, Pulse, people, opportunities" sub={`${s.ai.text_model} · region ${s.ai.location}`} right={null} />
        </ul>
      </Card>
      <Card title="What the AI does with each call">
        <ul className="st-list">
          <li>Transcribes in the original language and translates to English</li>
          <li>Works out who spoke, and their names when the call says them</li>
          <li>Writes the summary, decisions and commitments</li>
          <li>Finds interest and intent signals (Pulse), each with the exact sentence</li>
          <li>Finds people and opportunities; new people wait in the Inbox for you</li>
        </ul>
        <p className="st-fine">Every AI claim links to the moment in the call it came from. You can edit or delete anything it adds.</p>
      </Card>
    </div>
  );
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

/** Notifications (the bell) and the day-end digest: saved in the database, used at once. */
function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotePrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    getNotePrefs().then(setPrefs, (e) => setError(e instanceof Error ? e.message : "Could not load the notification settings."));
  }, []);

  async function change(key: keyof NotePrefs, value: boolean | number) {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: value }); // shows at once; goes back if it is not saved
    setSaving(key);
    setSaved(null);
    setError(null);
    try {
      setPrefs(await saveNotePrefs({ [key]: value }));
      setSaved("Saved.");
    } catch (e) {
      setPrefs(before);
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(null);
    }
  }

  if (!prefs)
    return (
      <div className="card pl-state" role={error ? "alert" : undefined} aria-busy={!error}>
        {error ? <p>{error}</p> : <span className="auth-spinner" />}
      </div>
    );
  return (
    <div className="st-grid">
      <Card title="Notifications (the bell)" note="Live">
        <ul className="st-rows">
          {PREF_LABELS.filter((p) => p.key !== "digest").map((p) => (
            <Row key={p.key} title={p.label} sub={p.hint} right={<Switch on={prefs[p.key]} label={p.label} busy={saving === p.key} onChange={(v) => void change(p.key, v)} />} />
          ))}
        </ul>
        {error && (
          <p className="pw-error" role="alert">
            {error}
          </p>
        )}
        {saved && !error && <p className="st-ok">{saved}</p>}
        <p className="st-fine">Shown in the app, on the bell. Each one is a fact from your calls and deals, made once. Switching one off stops new ones; earlier ones stay.</p>
      </Card>
      <Card title="Day-end digest" note={prefs.digest ? "On" : "Off"}>
        <ul className="st-rows">
          <Row title="Day-end digest" sub="Calls analysed, new opportunities, open follow-ups and the Inbox, once a day" right={<Switch on={prefs.digest} label="Day-end digest" busy={saving === "digest"} onChange={(v) => void change("digest", v)} />} />
          <Row
            title="Send it at"
            sub="On the bell, after this time (this computer's time)"
            right={
              <select className="st-select" value={prefs.digest_hour} disabled={!prefs.digest || saving === "digest_hour"} aria-label="Digest time" onChange={(e) => void change("digest_hour", Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            }
          />
        </ul>
        <p className="st-fine">Shown on the bell in the app.</p>
      </Card>
    </div>
  );
}

/** A switch the owner can change. */
function Switch({ on, label, busy, onChange }: { on: boolean; label: string; busy: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={`st-toggle st-switch ${on ? "st-toggle-on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={() => onChange(!on)} />;
}

function SecurityTab({ s, profile }: { s: RoomSettings; profile: Profile | null }) {
  return (
    <div className="st-grid">
      <Card title="Sign-in">
        <ul className="st-rows">
          <Row title="Method" sub="Email + password, or email + one-time code · every account has its own private room" right={<Status kind={s.login.enabled ? "on" : "off"}>{s.login.enabled ? "On" : "Off"}</Status>} />
          {s.login.signup && (
            <Row
              title="New accounts"
              sub={s.login.signup === "open" ? "Anyone with an email can create an account" : s.login.signup === "restricted" ? "Only the emails and domains in SIGNUP_ALLOWED can create an account" : "Sign-up is closed (SIGNUP_ENABLED=false)"}
              right={<Status kind={s.login.signup === "closed" ? "off" : "on"}>{s.login.signup === "open" ? "Open" : s.login.signup === "restricted" ? "Restricted" : "Closed"}</Status>}
            />
          )}
          <Row
            title="Codes"
            sub={s.login.code_delivery === "console" ? "Shown in the backend terminal (development mode, no email sent)" : "Sent to your email"}
            right={<Status kind={s.login.code_delivery === "console" ? "soon" : "on"}>{s.login.code_delivery === "console" ? "Dev mode" : "Email"}</Status>}
          />
          <Row title="Stay signed in" sub="On each device, then a new code is needed" right={<span className="st-value">{s.login.session_days} days</span>} />
          <Row
            title="Signed-in devices"
            sub={profile ? profile.sessions.map((d) => d.device + (d.current ? " (this device)" : "")).join(" · ") : "See them on your profile"}
            right={
              <Link href="/profile" className="pa-btn pw-btn">
                Manage
              </Link>
            }
          />
        </ul>
      </Card>
      <Card title="Data protection">
        <ul className="st-list">
          <li>Your phone number and sign-in codes are stored only as one-way hashes</li>
          <li>Sessions live in an httpOnly cookie; only a hash is stored</li>
          <li>Logs never contain conversation content; client addresses are hashed</li>
          <li>Uploads are checked (type, signature, size) and stored under random names</li>
          <li>Database: {s.database.connected ? `connected${s.database.migrations ? ` · ${s.database.migrations} migrations` : ""}` : "not connected"}</li>
        </ul>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("connections");
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await getSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings.");
      return;
    }
    // Extras: the page still works without them.
    void getProfile().then(setProfile, () => setProfile(null));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load();
  }, [load]);
  // /settings?tab=departments opens that tab (e.g. "+ Department" on the Departments panel).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL once on load
    if (t && TABS.some((x) => x.id === t)) setTab(t as Tab);
  }, []);

  return (
    <PeopleChrome active="settings">
      <div className="pl-head">
        <div>
          <h1 className="pl-title">Settings</h1>
          <p className="pl-sub">How your room is set up. Items marked “Coming soon” are not built yet.</p>
        </div>
      </div>
      <div className="st-tabs" role="tablist" aria-label="Settings">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`pa-tab ${tab === t.id ? "pa-tab-on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="card pl-state" role="alert">
          <p>{error}</p>
          <button type="button" className="pl-view" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !settings ? (
        <div className="card pl-state" aria-busy="true">
          <span className="auth-spinner" />
        </div>
      ) : tab === "connections" ? (
        <ConnectionsTab s={settings} devices={profile ? profile.sessions.length : null} profile={profile} />
      ) : tab === "departments" ? (
        <DepartmentsTab />
      ) : tab === "ai" ? (
        <AiTab s={settings} />
      ) : tab === "digest" ? (
        <NotificationsTab />
      ) : (
        <SecurityTab s={settings} profile={profile} />
      )}
    </PeopleChrome>
  );
}
