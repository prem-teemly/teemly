"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DeptIdea, type InboxItem, type InboxStatus, addAsNewPerson, addToExisting, createFromIdea, getInbox, ignoreIdea, ignoreItem, inboxChanged, momentLabel, styleOf } from "../lib/inbox";
import { refreshDepartments, useDepartments } from "../lib/departments";
import { CATEGORY_FROM_DEPARTMENT, COUNTRIES, type Country, NAME_LIKE, phoneDigits } from "../lib/formRules";
import { CATEGORIES, type Category, type Consent, type Department, type DupLevel, type SameName, checkDuplicates, dayLabel, rupees, whoLabel } from "../lib/people";
import { PhoneIcon, SparkleIcon, UsersIcon, WhatsAppIcon } from "./Icons";
import SelectMenu from "./SelectMenu";
import PeopleChrome from "./PeopleChrome";
import { DeptTag, PersonAvatar } from "./PeopleBits";

const TABS: { id: InboxStatus; label: string }[] = [
  { id: "pending", label: "To review" },
  { id: "added", label: "Added" },
  { id: "ignored", label: "Ignored" },
];

function sourceLine(item: InboxItem) {
  const where = item.source.kind === "whatsapp" ? "WhatsApp chat" : "call";
  return `From ${where} “${item.source.file_name}” · ${dayLabel(item.found_at)}`;
}

function Evidence({ item }: { item: InboxItem }) {
  if (!item.evidence.length) return null;
  return (
    <ul className="ib-evidence" aria-label="What was said">
      {item.evidence.map((e) => (
        <li key={e.id}>
          <span className="ib-ev-who">
            {e.speaker ?? "Someone"}
            {e.time_label ? ` · ${e.time_label}` : ""}
          </span>
          <span className="ib-ev-text">“{e.text}”</span>
          {e.english && e.english !== e.text && <span className="ib-ev-en">{e.english}</span>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ AI department suggestion

const CONF_LABEL = { high: "Sure", medium: "Likely", low: "Maybe" } as const;

/** "✦ AI suggests: [Govt tenders] Sure — 'Works in the Industries department…' · 00:12 Sanjay". */
function DeptSuggestions({ item, compact = false }: { item: InboxItem; compact?: boolean }) {
  const list = item.department_suggestions ?? item.departments.map((d) => ({ department: d, reason: null, confidence: null, evidence: [] }));
  if (!list.length) {
    return (
      <p className="ib-ai ib-ai-none">
        <SparkleIcon size={12} /> The AI could not tell the department from this {item.source.kind === "whatsapp" ? "chat" : "call"}. Choose one when adding.
      </p>
    );
  }
  return (
    <div className={`ib-ai ${compact ? "ib-ai-compact" : ""}`}>
      <p className="ib-ai-head">
        <SparkleIcon size={12} /> AI suggests {list.length === 1 ? "this department" : "these departments"}
      </p>
      <ul>
        {list.map((s) => {
          const ev = s.evidence[0];
          return (
            <li key={s.department}>
              <DeptTag dept={s.department} />
              {s.confidence && <span className={`ib-conf ib-conf-${s.confidence}`}>{CONF_LABEL[s.confidence]}</span>}
              <span className="ib-ai-why">
                {s.reason ?? "No reason given"}
                {ev && (
                  <span className="ib-ai-ev">
                    {" "}
                    · {ev.time_label ?? ""} {ev.speaker ?? ""}: “{(ev.english || ev.text).slice(0, compact ? 90 : 220)}
                    {(ev.english || ev.text).length > (compact ? 90 : 220) ? "…" : ""}”
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------- new departments from conversations

/** A suggested new department: what, why, who said it, the line; Create or Ignore. */
function IdeaCard({ idea, busy, onCreate, onIgnore }: { idea: DeptIdea; busy: boolean; onCreate: () => void; onIgnore: () => void }) {
  const ev = idea.evidence[0];
  return (
    <li className="ib-item ib-idea">
      <span className="ib-icon ib-idea-icon" aria-hidden="true">
        <SparkleIcon size={16} />
      </span>
      <div className="ib-main">
        <p className="ib-title">
          {idea.status === "pending" ? "New department suggested" : idea.status === "created" ? "Department created" : "Suggestion ignored"}: <strong>{idea.name}</strong>
        </p>
        {idea.description && <p className="ib-context">Who belongs there: {idea.description}</p>}
        {idea.reason && (
          <p className="ib-idea-why">
            <strong>Why:</strong> {idea.reason}
            {idea.said_by && <> · suggested by {idea.said_by}</>}
          </p>
        )}
        {ev && (
          <p className="ib-idea-ev">
            {ev.time_label ?? ""} {ev.speaker ?? ""}: “{ev.english || ev.text}”
          </p>
        )}
        <p className="ib-source">
          From {idea.source.kind === "whatsapp" ? "WhatsApp chat" : "call"} “{idea.source.file_name}” · {dayLabel(idea.found_at)}
          {idea.department && (
            <>
              {" "}
              · <Link href={`/departments/${idea.department.slug}`}>Open department</Link>
            </>
          )}
        </p>
      </div>
      {idea.status === "pending" && (
        <div className="ib-buttons">
          <button type="button" className="pa-btn pa-btn-primary" disabled={busy} onClick={onCreate}>
            Create department
          </button>
          <button type="button" className="pa-btn" disabled={busy} onClick={onIgnore}>
            {busy ? "…" : "Ignore"}
          </button>
        </div>
      )}
    </li>
  );
}

/** Create the suggested department: the owner can change the name and description and pick a colour. */
function IdeaForm({ idea, onDone, onCancel }: { idea: DeptIdea; onDone: (d: { slug: string; name: string }) => void; onCancel: () => void }) {
  const { departments, palette } = useDepartments();
  const colors = palette.length ? palette : ["#6c63f6", "#2fae6a", "#18a7b5", "#64748b", "#e2507a", "#3b82f6", "#d4891b", "#9a6b4b", "#0f8b8d", "#c2410c"];
  const [name, setName] = useState(idea.name);
  const [description, setDescription] = useState(idea.description ?? "");
  const [color, setColor] = useState(colors[departments.length % colors.length]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!name.trim()) return setError("Give the department a name.");
    setSaving(true);
    setError(null);
    try {
      onDone(await createFromIdea(idea.id, { name: name.trim(), description: description.trim() || null, color }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the department.");
      setSaving(false);
    }
  }
  return (
    <form className="ib-form" onSubmit={(e) => void submit(e)}>
      {idea.reason && (
        <p className="ib-why">
          <strong>Why:</strong> {idea.reason}
          {idea.said_by && <> · suggested by {idea.said_by}</>}
        </p>
      )}
      <label className="ib-field">
        <span>Name</span>
        <input value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="ib-field">
        <span>Who belongs here (the AI uses this to sort people into it)</span>
        <textarea rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="ib-field">
        <span>Colour</span>
        <div className="st-swatches" role="radiogroup" aria-label="Colour">
          {colors.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`st-swatch ${color === c ? "st-swatch-on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      <div className="ib-actions">
        <button type="button" className="pa-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="pa-btn pa-btn-primary" disabled={saving}>
          {saving ? "Creating…" : `Create ${name.trim() || "department"}`}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------- dialogs

function Dialog({ title, badge, onClose, children }: { title: string; badge?: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="ib-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ib-dialog" role="dialog" aria-modal="true" aria-labelledby="ib-dialog-title" ref={ref}>
        <div className="ib-dialog-head">
          <h2 id="ib-dialog-title" className="ib-dialog-title">
            {title}
          </h2>
          {badge && (
            <span className="ib-prefilled">
              <SparkleIcon size={11} /> {badge}
            </span>
          )}
          <button type="button" className="ib-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Inbox → Add person: everything the AI found in the call is filled in (department and category too,
// marked "AI"); the owner checks it, adds the phone number and adds them. Required: name, phone
// (country + its digits, a number no one else has), category and one department. The backend checks
// the same again (parseNewPerson) and refuses a number saved for someone else.
// Someone with the same name already in People ("Prem · Sales · ••1111") is shown with what tells them
// apart; the owner adds the call to them, or confirms this is a different person (the backend asks too).
type InboxField = "name" | "city" | "phone" | "same" | "category" | "dept";
const INBOX_ORDER: InboxField[] = ["name", "city", "phone", "same", "category", "dept"];
const INBOX_LABEL: Record<InboxField, string> = { name: "Name", city: "City", phone: "Phone", same: "Same-name check", category: "Category", dept: "Department" };
const LEVEL_TEXT: Record<DupLevel, string> = {
  strong: "Same name, city and department: very likely the same person.",
  likely: "Same name and city.",
  weak: "Same name only.",
};
const CONSENTS: { value: Consent; label: string }[] = [
  { value: "Yes", label: "Yes" },
  { value: "Ask", label: "Not asked yet" },
  { value: "No", label: "No" },
];

function AddPersonForm({
  item,
  fromChoose = false,
  onDone,
  onAddedTo,
  onCancel,
}: {
  item: InboxItem;
  /** Came from "Someone new" on the choose step: the people shown there are already answered. */
  fromChoose?: boolean;
  onDone: (personId: string, name: string) => void;
  /** The call was added to someone already in People instead. */
  onAddedTo: (personId: string, name: string) => void;
  onCancel: () => void;
}) {
  const { departments } = useDepartments();
  const deptNames = departments.map((d) => d.name);
  // The AI's department: its most certain suggestion (one department; the owner can pick another).
  const aiDept = (item.department_suggestions ?? []).map((s) => s.department).concat(item.departments).find((d) => deptNames.includes(d)) ?? "";
  // The AI's category from the call; if it could not tell, the one that goes with its department.
  const aiCategory: { value: Category | ""; from: "call" | "department" | null } = item.category
    ? { value: item.category, from: "call" }
    : aiDept && CATEGORY_FROM_DEPARTMENT[aiDept]
      ? { value: CATEGORY_FROM_DEPARTMENT[aiDept], from: "department" }
      : { value: "", from: null };

  const [name, setName] = useState(item.name);
  const [city, setCity] = useState(item.city ?? "");
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState<Category | "">(aiCategory.value);
  const [dept, setDept] = useState<string>(aiDept);
  const [role, setRole] = useState(item.role_title ?? "");
  const [company, setCompany] = useState(item.organisation ?? "");
  const [context, setContext] = useState(item.context ?? "");
  const [consent, setConsent] = useState<Consent>("Ask");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null); // from the server
  const [touched, setTouched] = useState<Partial<Record<InboxField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [phoneOwner, setPhoneOwner] = useState<{ number: string; person: SameName } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLButtonElement>(null);
  const deptRef = useRef<HTMLDivElement>(null);

  // Is this number already someone's? Asked once the number is complete (the save checks it again).
  const fullPhone = phone.length === country.digits ? `+${country.dial}${phone}` : "";
  useEffect(() => {
    if (!fullPhone) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      checkDuplicates({ phone: fullPhone }, ctl.signal).then(
        (r) => setPhoneOwner(r.phone_match ? { number: fullPhone, person: r.phone_match } : null),
        () => {},
      );
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [fullPhone]);
  const takenBy = phoneOwner && phoneOwner.number === fullPhone ? phoneOwner.person : null;

  // Someone with this name already in People? Asked while name, city and department are filled in;
  // an older answer never stands for what is in the form now.
  const checkName = /\p{L}/u.test(name) && [...name.trim()].length >= 2 ? name.trim() : "";
  const sameKey = JSON.stringify([checkName.toLowerCase(), city.trim().toLowerCase(), dept]);
  const [same, setSame] = useState<{ key: string; matches: (SameName & { level: DupLevel })[] } | null>(null);
  useEffect(() => {
    if (!checkName) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      checkDuplicates({ name: checkName, city: city.trim(), department: dept }, ctl.signal).then(
        (r) => setSame({ key: sameKey, matches: r.name_matches }),
        () => {
          // Not reachable: nothing to show (the save is checked by the server again).
          if (!ctl.signal.aborted) setSame({ key: sameKey, matches: [] });
        },
      );
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [sameKey, checkName, city, dept]);
  // The people with this name stay the same while only the city or department changes (that changes
  // how close they are, which the next answer fills in), so the list never blinks away and back. A new
  // name waits for its own answer; the save is checked by the server again (409 without the owner's OK).
  const sameName = (k: string | undefined) => (k ? (JSON.parse(k) as string[])[0] : null);
  const sameMatches = checkName && same && sameName(same.key) === checkName.toLowerCase() ? same.matches : [];
  // People already answered on the choose step ("Someone new") are not asked about again.
  const toConfirm = sameMatches.filter((m) => !(fromChoose && item.matches.some((x) => x.id === m.id)));
  const confirmIds = toConfirm.map((m) => m.id).join(",");
  const [differentFor, setDifferentFor] = useState<string | null>(null); // the people the owner said this is not
  const confirmedDifferent = !toConfirm.length || differentFor === confirmIds;
  const sameRef = useRef<HTMLInputElement>(null);

  /** Same person after all: this call goes on their timeline, nobody new is created. */
  async function addToThem(m: SameName) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await addToExisting(item.id, m.id);
      onAddedTo(r.person_id, m.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this call to them.");
      setSaving(false);
    }
  }

  const n = name.trim();
  const c = city.trim();
  const personDept = deptNames.includes(dept) ? dept : "";
  const problems: Record<InboxField, string | null> = {
    name: !n ? "Give their name." : [...n].length < 2 ? "A name has at least 2 letters." : !NAME_LIKE.test(n) ? "Use letters only (no numbers or symbols)." : null,
    city: c && !NAME_LIKE.test(c) ? "Use letters only, e.g. Coimbatore." : null,
    phone: !phone ? "Add their phone number." : phone.length !== country.digits ? `Enter all ${country.digits} digits of the number (${phone.length} now).` : takenBy ? `This number is already saved for ${takenBy.name}.` : null,
    same: !confirmedDifferent ? "Add this call to them, or confirm this is a different person." : null,
    category: !category ? "Choose a category." : null,
    dept: !personDept ? "Choose a department." : null,
  };
  const missing = INBOX_ORDER.filter((k) => problems[k]);
  const complete = missing.length === 0;
  const shown = (k: InboxField) => ((touched[k] || submitted) && problems[k]) || null;
  const errProps = (k: InboxField) => (shown(k) ? { "aria-invalid": true as const, "aria-describedby": `ib-err-${k}` } : {});
  const errorLine = (k: InboxField) =>
    shown(k) ? (
      <span id={`ib-err-${k}`} className="ap-field-error" role="alert">
        {shown(k)}
      </span>
    ) : null;
  // An error shows once something was typed and the field was left (not on the way to the buttons).
  const touch = (k: InboxField, filled: boolean, e?: React.FocusEvent) => {
    if (!filled || (e?.relatedTarget as HTMLElement | null)?.closest(".ib-actions")) return;
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  };
  function focusField(k: InboxField) {
    if (k === "dept") {
      deptRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    if (k === "same") {
      sameRef.current?.focus();
      return;
    }
    ({ name: nameRef, city: cityRef, phone: phoneRef, category: categoryRef } as const)[k].current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return; // one submission at a time
    if (!complete) {
      setSubmitted(true);
      focusField(missing[0]);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await addAsNewPerson(item.id, {
        name: n,
        city: c || null,
        phone: `+${country.dial}${phone}`,
        category: category || null,
        departments: [personDept as Department],
        role_title: role.trim() || null,
        organisation: company.trim() || null,
        consent,
        context: context.trim() || null,
        // Only reached once the owner answered for every same-name person (see `same` above).
        same_name_ok: fromChoose || sameMatches.length > 0,
      });
      onDone(r.person_id, n);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this person.");
      setSaving(false);
    }
  }

  const intro = item.introduced_by;
  const deals = item.opportunities ?? [];
  return (
    <form
      className="ib-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        // Enter while something is missing: the button is disabled, so show what is missing instead.
        if (e.key !== "Enter" || e.defaultPrevented || complete || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        setSubmitted(true);
        focusField(missing[0]);
      }}
    >
      <div className="ib-row">
        <label className="ib-field">
          <span>
            Name <span className="ap-req" aria-hidden="true">*</span>
          </span>
          <input ref={nameRef} value={name} maxLength={80} required autoComplete="off" {...errProps("name")} onChange={(e) => setName(e.target.value)} onBlur={(e) => touch("name", !!name.trim(), e)} />
          {errorLine("name")}
        </label>
        <label className="ib-field">
          <span>
            City <span className="ap-optional">(optional)</span>
          </span>
          <input ref={cityRef} value={city} maxLength={60} placeholder="Not known yet" autoComplete="off" {...errProps("city")} onChange={(e) => setCity(e.target.value)} onBlur={(e) => touch("city", !!city.trim(), e)} />
          {errorLine("city")}
        </label>
      </div>
      <div className="ib-field">
        <span id="ib-phone-label">
          Phone <span className="ap-req" aria-hidden="true">*</span>
          {intro && !phone && <span className="ap-optional"> · not said in the call: ask {intro.name}</span>}
        </span>
        <div className="ap-phone">
          <SelectMenu
            ariaLabel="Country code"
            value={country.code}
            options={COUNTRIES.map((x) => ({ value: x.code, label: `+${x.dial} ${x.name}` }))}
            onChange={(v) => {
              const next = COUNTRIES.find((x) => x.code === v) ?? COUNTRIES[0];
              setCountry(next);
              setPhone((p) => p.slice(0, next.digits));
            }}
          />
          <input
            ref={phoneRef}
            value={phone}
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={country.digits + 6 /* room for a pasted code; trimmed below */}
            placeholder={`${country.digits}-digit number`}
            required
            aria-labelledby="ib-phone-label"
            {...errProps("phone")}
            onChange={(e) => setPhone(phoneDigits(e.target.value, country))}
            onBlur={(e) => touch("phone", !!phone, e)}
          />
        </div>
        {takenBy ? (
          <span id="ib-err-phone" className="ap-field-error" role="alert">
            This number is already saved for{" "}
            <Link href={`/people/${takenBy.id}`}>
              {takenBy.name}
              {takenBy.city ? ` (${takenBy.city})` : ""}
            </Link>
            . Check the number, or add this call to {takenBy.name} instead.
          </span>
        ) : (
          errorLine("phone")
        )}
      </div>
      {sameMatches.length > 0 && (
        <div className={`ap-dup ib-same ${toConfirm.some((m) => m.level !== "weak") ? "ap-dup-warn" : "ap-dup-hint"}`}>
          <p>
            <strong>Already in People with the name {n}:</strong>
          </p>
          <ul className="ib-same-list">
            {sameMatches.map((m) => (
              <li key={m.id}>
                <span className="ib-same-who">
                  <Link href={`/people/${m.id}`} target="_blank" rel="noopener noreferrer">
                    {m.name}
                  </Link>
                  <span className="ib-same-label">{whoLabel(m) || "No details yet"}</span>
                  <span className="ib-same-level">{LEVEL_TEXT[m.level]}</span>
                </span>
                <button type="button" className="pa-btn pw-btn" disabled={saving} onClick={() => void addToThem(m)}>
                  Same person: add this call to them
                </button>
              </li>
            ))}
          </ul>
          {toConfirm.length > 0 ? (
            <label className="ap-dup-confirm">
              <input ref={sameRef} type="checkbox" checked={confirmedDifferent} {...errProps("same")} onChange={(e) => setDifferentFor(e.target.checked ? confirmIds : null)} />
              It&apos;s a different person: add {n || "them"} as new
            </label>
          ) : (
            <p className="ap-dup-more">You chose “Someone new”, so a new person will be added.</p>
          )}
          {errorLine("same")}
        </div>
      )}
      <div className="ib-row">
        <div className="ib-field">
          <span id="ib-cat-label">
            Category <span className="ap-req" aria-hidden="true">*</span>
            {aiCategory.from && category === aiCategory.value && (
              <span className="ib-ai-tag" title={aiCategory.from === "call" ? "Said in the call" : `Goes with the AI's department (${aiDept}): check it`}>
                <SparkleIcon size={10} /> AI{aiCategory.from === "department" ? " · from department" : ""}
              </span>
            )}
          </span>
          <SelectMenu
            buttonRef={categoryRef}
            labelledBy="ib-cat-label"
            placeholder="Choose a category"
            value={category}
            options={CATEGORIES.map((x) => ({ value: x, label: x }))}
            invalid={!!shown("category")}
            describedBy={shown("category") ? "ib-err-category" : undefined}
            onChange={(v) => setCategory(v as Category)}
            onBlur={() => touch("category", !!category)}
          />
          {errorLine("category")}
        </div>
        <label className="ib-field">
          <span>
            Role <span className="ap-optional">(optional)</span>
          </span>
          <input value={role} maxLength={120} placeholder="e.g. AI developer" autoComplete="off" onChange={(e) => setRole(e.target.value)} />
        </label>
      </div>
      <fieldset className="ib-field ib-depts">
        <legend>
          Department <span className="ap-req" aria-hidden="true">*</span> <span className="ap-optional">(pick one)</span>
        </legend>
        <DeptSuggestions item={item} />
        <div ref={deptRef} role="radiogroup" aria-label="Department" aria-required="true">
          {departments.map(({ name: d }) => {
            const ai = d === aiDept;
            const on = personDept === d;
            return (
              <button key={d} type="button" role="radio" aria-checked={on} className={`ib-dept ${on ? "ib-dept-on" : ""} ${ai ? "ib-dept-ai" : ""}`} onClick={() => setDept(on ? "" : d)} title={ai ? "Suggested by the AI" : undefined}>
                {ai && <SparkleIcon size={10} />} {d}
              </button>
            );
          })}
        </div>
        {errorLine("dept") ?? <span className="ib-dept-hint">{aiDept ? "The AI's department is selected. Pick another if the person belongs elsewhere." : "The AI could not tell. Pick the department they belong to."}</span>}
      </fieldset>
      <label className="ib-field">
        <span>
          Company <span className="ap-optional">(optional)</span>
        </span>
        <input value={company} maxLength={120} placeholder="Not known yet" autoComplete="off" onChange={(e) => setCompany(e.target.value)} />
      </label>
      {intro && (
        <div className="ib-field">
          <span>Introduced by</span>
          <div className="ib-intro">
            <PersonAvatar name={intro.name} initials={intro.name.slice(0, 2).toUpperCase()} />
            <strong>{intro.person ? <Link href={`/people/${intro.person.id}`}>{intro.name}</Link> : intro.name}</strong>
            <span className="ib-moment">{momentLabel(item)}</span>
          </div>
        </div>
      )}
      <label className="ib-field">
        <span>
          What was said <span className="ap-optional">(you can edit it)</span>
        </span>
        <textarea rows={2} maxLength={1000} value={context} onChange={(e) => setContext(e.target.value)} />
      </label>
      <Evidence item={item} />
      {deals.length > 0 && (
        <p className="ib-also">
          <SparkleIcon size={12} /> Also added with them:{" "}
          {deals.map((o, i) => (
            <span key={`${o.title}-${i}`}>
              {i > 0 && " · "}
              <strong>{o.title}</strong>
              {o.value_inr ? ` (${rupees(o.value_inr)})` : ""}
            </span>
          ))}
        </p>
      )}
      <div className="ap-toggle-row">
        <strong>Recording consent</strong>
        <div className="ap-seg" role="radiogroup" aria-label="Recording consent">
          {CONSENTS.map((x) => (
            <button key={x.value} type="button" role="radio" aria-checked={consent === x.value} className={consent === x.value ? "ap-seg-on" : ""} onClick={() => setConsent(x.value)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      {!complete && (
        <p className="ap-missing" id="ib-missing" aria-live="polite">
          <span>To add, fill in:</span>
          {missing.map((k) => (
            <button key={k} type="button" className="ap-missing-item" onClick={() => focusField(k)}>
              {INBOX_LABEL[k]}
            </button>
          ))}
        </p>
      )}
      <div className="ib-actions">
        <button type="button" className="pa-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="pa-btn pa-btn-primary" disabled={!complete || saving} aria-describedby={complete ? undefined : "ib-missing"} title={complete ? undefined : "Fill in every field marked * first"}>
          {saving ? "Adding…" : `Add ${n || "person"}`}
        </button>
      </div>
    </form>
  );
}

/** What this conversation says that differs from a person already in People ("Madurai" vs "Chennai"). */
function differences(item: InboxItem, m: InboxItem["matches"][number]): string[] {
  const out: string[] = [];
  const diff = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() !== b.trim().toLowerCase();
  if (diff(item.city, m.city)) out.push(`city ${item.city} vs ${m.city}`);
  if (diff(item.organisation, m.organisation)) out.push(`company ${item.organisation} vs ${m.organisation}`);
  if (diff(item.role_title, m.role_title)) out.push(`role ${item.role_title} vs ${m.role_title}`);
  if (diff(item.category, m.category)) out.push(`${item.category} vs ${m.category}`);
  // "Prem" in Sales and a call about Tech & AI: maybe the other Prem.
  const callDepts = callDepartments(item);
  const theirs = m.departments ?? [];
  if (callDepts.length && theirs.length && !callDepts.some((d) => theirs.includes(d))) out.push(`department ${callDepts[0]} vs ${theirs.join(", ")}`);
  return out;
}

/** The departments the AI gave this call's person, most certain first. */
function callDepartments(item: InboxItem): string[] {
  return [...new Set([...(item.department_suggestions ?? []).map((s) => s.department), ...item.departments])];
}

function ChooseForm({ item, onDone, onNew, onCancel }: { item: InboxItem; onDone: (personId: string, name: string) => void; onNew: () => void; onCancel: () => void }) {
  // The person in the department this call is about comes first, marked by the AI; the owner decides.
  const aiDept = callDepartments(item)[0] ?? null;
  const inAiDept = (m: InboxItem["matches"][number]) => !!aiDept && (m.departments ?? []).includes(aiDept);
  const matches = [...item.matches].sort((a, b) => Number(inAiDept(b)) - Number(inAiDept(a)));
  const aiPicks = matches.filter(inAiDept);
  const [pick, setPick] = useState<string>(aiPicks.length === 1 ? aiPicks[0].id : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (pick === "new") return onNew();
    if (!pick) return setError("Choose who this is.");
    setSaving(true);
    setError(null);
    try {
      const r = await addToExisting(item.id, pick);
      onDone(r.person_id, item.matches.find((m) => m.id === pick)?.name ?? item.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }
  return (
    <form className="ib-form" onSubmit={(e) => void submit(e)}>
      <p className="ib-why">
        {item.matches.length === 1
          ? `${item.matches[0].name} is already in People, but this ${item.source.kind === "whatsapp" ? "chat" : "call"} may be about a different ${item.name.split(" ")[0]}. Is it the same person?`
          : `${item.matches.length} people with this name are in People. Which one did this ${item.source.kind === "whatsapp" ? "chat" : "call"} talk about?`}
      </p>
      <p className="ib-said ib-this-call">
        <strong>This {item.source.kind === "whatsapp" ? "chat" : "call"}:</strong> {item.name}
        {[item.role_title, item.organisation, item.city, item.category].filter(Boolean).length ? ` · ${[item.role_title, item.organisation, item.city, item.category].filter(Boolean).join(" · ")}` : ""}
      </p>
      <div className="ib-said">
        <strong>What was said:</strong> {item.context}
      </div>
      <Evidence item={item} />
      <div className="ib-choices" role="radiogroup" aria-label="Who is this">
        {matches.map((m) => (
          <label key={m.id} className={`ib-choice ${pick === m.id ? "ib-choice-on" : ""}`}>
            <input type="radio" name="who" value={m.id} checked={pick === m.id} onChange={() => setPick(m.id)} />
            <PersonAvatar name={m.name} initials={m.initials} />
            <span className="ib-choice-main">
              <strong>
                {item.matches.length === 1 ? `Same person: ${m.name}` : m.name}
                {inAiDept(m) && (
                  <span className="ib-ai-tag" title={`This call is about ${aiDept}, and ${m.name} is in ${aiDept}`}>
                    <SparkleIcon size={10} /> AI · same department as this call
                  </span>
                )}
              </strong>
              <span className="ib-same-label">{whoLabel(m) || "No department or phone yet"}</span>
              <span>{[m.role_title, m.category].filter(Boolean).join(" · ")}</span>
              {differences(item, m).length > 0 && <span className="ib-diff">Differs: {differences(item, m).join(" · ")}</span>}
            </span>
            <span className="ib-choice-count">
              {m.mention_count} conversation{m.mention_count === 1 ? "" : "s"}
            </span>
          </label>
        ))}
        <label className={`ib-choice ${pick === "new" ? "ib-choice-on" : ""}`}>
          <input type="radio" name="who" value="new" checked={pick === "new"} onChange={() => setPick("new")} />
          <span className="ib-choice-main">
            <strong>Someone new</strong>
            <span>A different person with the same name: add them as a new person</span>
          </span>
        </label>
      </div>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      <div className="ib-actions">
        <button type="button" className="pa-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="pa-btn pa-btn-primary" disabled={saving || !pick}>
          {saving ? "Saving…" : pick === "new" ? "Next" : "Confirm"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------- page

export default function InboxPage() {
  const [tab, setTab] = useState<InboxStatus>("pending");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ item: InboxItem; mode: "add" | "choose"; fromChoose?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; personId?: string; href?: string } | null>(null);
  // New departments someone in a conversation said the owner should create.
  const [ideas, setIdeas] = useState<DeptIdea[]>([]);
  const [ideaOpen, setIdeaOpen] = useState<DeptIdea | null>(null);
  const closeIdea = useCallback(() => setIdeaOpen(null), []);
  // Routing: show the people the AI suggests for one department (or with no suggestion).
  const [route, setRoute] = useState<string>("all");
  const routes = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const it of items ?? []) {
      if (!it.departments.length) none++;
      for (const d of it.departments) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [
      { key: "all", label: "All", count: items?.length ?? 0 },
      ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d, n]) => ({ key: d, label: d, count: n })),
      ...(none ? [{ key: "none", label: "Not sure", count: none }] : []),
    ];
  }, [items]);
  const routeKey = routes.some((r) => r.key === route) ? route : "all";
  const shown = (items ?? []).filter((it) => routeKey === "all" || (routeKey === "none" ? !it.departments.length : it.departments.includes(routeKey)));

  const load = useCallback(async (status: InboxStatus) => {
    setError(null);
    setItems(null);
    try {
      const r = await getInbox(status);
      setItems(r.items);
      setIdeas(r.departments ?? []);
      setPending(r.pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the inbox.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading external data
    void load(tab);
  }, [load, tab]);

  const close = useCallback(() => setOpen(null), []);
  function decided(item: InboxItem, text: string, personId?: string) {
    setItems((xs) => xs?.filter((x) => x.id !== item.id) ?? null);
    setPending((n) => (n === null ? n : Math.max(0, n - 1)));
    setNotice({ text, personId });
    setOpen(null);
    inboxChanged();
    void refreshDepartments().catch(() => {}); // sidebar counts include the new person
  }
  function ideaDecided(idea: DeptIdea, text: string, href?: string) {
    setIdeas((xs) => xs.filter((x) => x.id !== idea.id));
    setPending((n) => (n === null ? n : Math.max(0, n - 1)));
    setNotice({ text, href });
    setIdeaOpen(null);
    inboxChanged();
    void refreshDepartments().catch(() => {}); // the new department appears in the sidebar
  }
  async function ignoreIdeaItem(idea: DeptIdea) {
    if (busy) return;
    setBusy(idea.id);
    try {
      await ignoreIdea(idea.id);
      ideaDecided(idea, `“${idea.name}” ignored. It will not be suggested from this conversation again.`);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Could not ignore." });
      void load(tab);
    } finally {
      setBusy(null);
    }
  }

  async function ignore(item: InboxItem) {
    if (busy) return;
    setBusy(item.id);
    try {
      await ignoreItem(item.id);
      decided(item, `${item.name} ignored. This ${item.source.kind === "whatsapp" ? "chat" : "call"} will not suggest them again.`);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Could not ignore." });
      void load(tab);
    } finally {
      setBusy(null);
    }
  }

  return (
    <PeopleChrome active="inbox">
      <div className="pl-head">
        <div>
          <h1 className="pl-title">Review inbox</h1>
          <p className="pl-sub">
            {pending === null ? "Loading…" : pending === 0 ? "Nothing needs a decision" : `${pending} item${pending === 1 ? " needs" : "s need"} a quick decision`}
          </p>
        </div>
        <div className="pl-views" role="tablist" aria-label="Inbox">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`pl-view ${tab === t.id ? "pl-view-on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "pending" && pending ? ` ${pending}` : ""}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div className="ib-notice" role="status">
          <span>{notice.text}</span>
          {notice.personId && <Link href={`/people/${notice.personId}`}>View profile</Link>}
          {notice.href && <Link href={notice.href}>Open department</Link>}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {!error && ideas.length > 0 && (
        <section className="ib-list-card ib-ideas" aria-label="Suggested new departments">
          <p className="ib-ideas-head">
            <SparkleIcon size={12} /> {tab === "pending" ? "Suggested new departments" : tab === "added" ? "Departments created from conversations" : "Ignored department suggestions"}
          </p>
          <ul className="ib-list">
            {ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} busy={busy === idea.id} onCreate={() => setIdeaOpen(idea)} onIgnore={() => void ignoreIdeaItem(idea)} />
            ))}
          </ul>
        </section>
      )}

      <section className="ib-list-card" aria-label="Inbox items">
        {error ? (
          <div className="pl-state" role="alert">
            <p>{error}</p>
            <button type="button" className="pl-view" onClick={() => void load(tab)}>
              Try again
            </button>
          </div>
        ) : !items ? (
          <div className="pl-state" aria-busy="true">
            <span className="auth-spinner" />
          </div>
        ) : !items.length ? (
          ideas.length ? (
            <p className="pl-empty">{tab === "pending" ? "No new people right now." : tab === "added" ? "No one added from the inbox yet." : "No people ignored."}</p>
          ) : (
            <div className="pl-state">
              <p className="pl-state-title">{tab === "pending" ? "All clear" : tab === "added" ? "No one added from the inbox yet" : "Nothing ignored"}</p>
              {tab === "pending" && <p>When a call talks about someone new, or suggests a new department, it appears here for you to decide.</p>}
            </div>
          )
        ) : (
          <>
          {tab === "pending" && routes.length > 1 && (
            <div className="ib-route" role="group" aria-label="Route by suggested department">
              <span className="ib-route-label">
                <SparkleIcon size={12} /> Route by AI department:
              </span>
              {routes.map((r) => (
                <button key={r.key} type="button" className={`ib-route-chip ${routeKey === r.key ? "ib-route-on" : ""}`} aria-pressed={routeKey === r.key} onClick={() => setRoute(r.key)}>
                  {r.label} <span>{r.count}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="ib-list">
            {shown.map((item) => {
              const style = styleOf(item);
              const choose = item.matches.length > 0;
              return (
                <li key={item.id} className="ib-item">
                  <span className="ib-icon" aria-hidden="true">
                    {item.source.kind === "whatsapp" ? <WhatsAppIcon size={16} /> : choose ? <UsersIcon size={16} /> : <PhoneIcon size={16} />}
                  </span>
                  <div className="ib-main">
                    <p className="ib-title">
                      {choose
                        ? item.matches.length === 1
                          ? `Same ${item.matches[0].name}, or someone new? ${differences(item, item.matches[0]).length ? `(${differences(item, item.matches[0]).join(", ")})` : ""}`
                          : `Who is ${item.name}? ${item.matches.length} possible matches`
                        : `New person ${item.relation === "mentioned" ? "mentioned" : "in the conversation"}: ${item.name}`}
                    </p>
                    <p className="ib-tags">
                      {style && <span className={`ib-style ib-style-${style.toLowerCase()}`}>{style}</span>}
                      {item.category && <span className="pa-tag">{item.category}</span>}
                      {item.role_title && <span className="pa-tag">{item.role_title}</span>}
                      {item.city && <span className="pa-tag">{item.city}</span>}
                    </p>
                    <p className="ib-context">{item.context}</p>
                    {tab === "pending" && <DeptSuggestions item={item} compact />}
                    {tab !== "pending" && item.departments.length > 0 && (
                      <p className="ib-tags">
                        {item.departments.map((d) => (
                          <DeptTag key={d} dept={d} />
                        ))}
                      </p>
                    )}
                    <p className="ib-source">
                      {sourceLine(item)} · <span className="ib-moment">{momentLabel(item)}</span>
                      {item.introduced_by && <> · introduced by {item.introduced_by.name}</>}
                    </p>
                    {tab !== "pending" && item.person_id && (
                      <p className="ib-source">
                        <Link href={`/people/${item.person_id}`}>Open profile</Link>
                      </p>
                    )}
                  </div>
                  {tab === "pending" && (
                    <div className="ib-buttons">
                      <button type="button" className="pa-btn pa-btn-primary" disabled={busy === item.id} onClick={() => setOpen({ item, mode: choose ? "choose" : "add" })}>
                        {choose ? "Choose" : "Add person"}
                      </button>
                      <button type="button" className="pa-btn" disabled={busy === item.id} onClick={() => void ignore(item)}>
                        {busy === item.id ? "…" : "Ignore"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {!shown.length && <p className="pl-empty">No one in this department right now.</p>}
          </>
        )}
      </section>

      <p className="ib-note">
        <strong>Why items land here:</strong> a call talked about someone who is not in People yet, or about a name that more than one person in People has, or someone said you should start a new department. Nothing is added or matched by guesswork; people
        already in People get the conversation on their timeline automatically.
      </p>

      {ideaOpen && (
        <Dialog title={`Create department: ${ideaOpen.name}`} badge="Suggested in a call" onClose={closeIdea}>
          <IdeaForm
            idea={ideaOpen}
            onCancel={closeIdea}
            onDone={(d) => ideaDecided(ideaOpen, `“${d.name}” created. It is in Departments and Settings, and new calls will sort people into it.`, `/departments/${d.slug}`)}
          />
        </Dialog>
      )}

      {open && (
        <Dialog title={open.mode === "choose" ? `Who is ${open.item.name}?` : "Add person"} badge={open.mode === "add" ? `Pre-filled from ${open.item.source.kind === "whatsapp" ? "chat" : "call"}` : undefined} onClose={close}>
          {open.mode === "add" ? (
            <AddPersonForm
              item={open.item}
              fromChoose={!!open.fromChoose}
              onCancel={close}
              onDone={(id, name) => decided(open.item, `${name} added to People.`, id)}
              onAddedTo={(id, name) => decided(open.item, `Added to ${name}'s timeline.`, id)}
            />
          ) : (
            <ChooseForm item={open.item} onCancel={close} onNew={() => setOpen({ item: open.item, mode: "add", fromChoose: true })} onDone={(id, name) => decided(open.item, `Added to ${name}'s timeline.`, id)} />
          )}
        </Dialog>
      )}
    </PeopleChrome>
  );
}
