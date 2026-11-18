"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { deptStyle, refreshDepartments, useDepartments } from "../lib/departments";
import { CATEGORIES, type Category, type Consent, type DupCheck, type Person, type SameName, STAGES, STAGE_CHANCE, type Stage, addOpportunity, checkDuplicates, createPerson, getPeople, rupees, whoLabel } from "../lib/people";
import { COUNTRIES, type Country, NAME_LIKE, phoneDigits } from "../lib/formRules";
import SelectMenu from "./SelectMenu";

// "+ Add" → Add person (design: Add person dialog). The owner adds someone by hand before any call:
// name, city, phone, category, departments, who introduced them and why, recording consent, and
// optionally a first opportunity. Nothing is made up: no call is shown until one is uploaded. Someone
// with the same name already in People is shown first, to open them or add a different person.

const OPEN_STAGES = STAGES.filter((s) => s !== "Won" && s !== "Lost");
const CONSENTS: { value: Consent; label: string }[] = [
  { value: "Yes", label: "Yes" },
  { value: "Ask", label: "Not asked yet" },
  { value: "No", label: "No" },
];
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const MAX_VALUE = 1e13; // the backend's limit (rupees)

// Every field is required except "Introduced by" (and the opportunity, which is a switch; when it is
// on, its fields are required too). Add person stays disabled until all are filled in correctly.
type Field = "name" | "city" | "phone" | "dupConfirm" | "category" | "dept" | "purpose" | "oppTitle" | "oppDept" | "oppValue";
/** Order on the form: the "Fill in" list follows it, and its first field gets the focus. */
const FIELD_ORDER: Field[] = ["name", "city", "phone", "dupConfirm", "category", "dept", "purpose", "oppTitle", "oppDept", "oppValue"];
const FIELD_LABEL: Record<Field, string> = {
  dupConfirm: "Confirm a different person",
  name: "Name",
  city: "City",
  phone: "Phone",
  category: "Category",
  dept: "Department",
  purpose: "Who they are",
  oppTitle: "Opportunity",
  oppDept: "Deal department",
  oppValue: "Value",
};

/** Who introduced them: type to find someone in People. */
function IntroPicker({ people, value, onChange }: { people: Person[] | null; value: Person | null; onChange: (p: Person | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !t || p.name.toLowerCase().includes(t) || (p.organisation ?? "").toLowerCase().includes(t)).slice(0, 8);
  }, [people, q]);

  if (value)
    return (
      <div className="ap-intro-on">
        <span className="ap-av" aria-hidden="true">
          {value.initials}
        </span>
        <span className="ap-intro-name">{value.name}</span>
        {value.role_title && <span className="ap-intro-sub">{value.role_title}</span>}
        <button type="button" className="ap-x" aria-label={`Remove ${value.name}`} onClick={() => onChange(null)}>
          ×
        </button>
      </div>
    );
  return (
    <div className="ap-intro" ref={box}>
      <input
        value={q}
        placeholder={people ? "Type a name from People (optional)" : "Loading People…"}
        aria-label="Introduced by"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && open && matches[0]) {
            e.preventDefault();
            onChange(matches[0]);
            setOpen(false);
          }
        }}
      />
      {open && people && (
        <ul className="ap-intro-list" role="listbox" aria-label="People">
          {matches.length ? (
            matches.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                  }}
                >
                  <span className="ap-av" aria-hidden="true">
                    {p.initials}
                  </span>
                  <span className="ap-intro-name">{p.name}</span>
                  <span className="ap-intro-sub">{[p.role_title, p.city].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="ap-intro-none">No one in People matches “{q}”.</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { departments } = useDepartments();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [phone, setPhone] = useState(""); // digits only, without the country code
  const [category, setCategory] = useState<Category | "">("");
  const [dept, setDept] = useState(""); // one department (or none); more can be added on their page
  const [intro, setIntro] = useState<Person | null>(null);
  const [purpose, setPurpose] = useState("");
  const [consent, setConsent] = useState<Consent>("Ask");
  const [withOpp, setWithOpp] = useState(false);
  const [opp, setOpp] = useState({ title: "", value: "", stage: "Identified" as Stage, department: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null); // from the server
  const [same, setSame] = useState<SameName[] | null>(null);
  // Already in People? Checked while typing (name, city, department, a complete phone number).
  const [dup, setDup] = useState<(DupCheck & { key: string }) | null>(null); // key: what it was asked for
  const [differentOk, setDifferentOk] = useState<string | null>(null); // id of the match the owner said is someone else
  const dupConfirmRef = useRef<HTMLInputElement>(null);
  // A field's error shows once it has been left (blur), or after Add was pressed.
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  /**
   * Leaving a field shows its error, but only once something was typed in it (an empty field just
   * passed through is not an error yet; Add checks everything), and not when the focus goes to the
   * Add / Cancel buttons: a message appearing then would push the button away from the click.
   */
  const touch = (f: Field, filled: boolean, e?: React.FocusEvent) => {
    if (!filled || (e?.relatedTarget as HTMLElement | null)?.closest(".ib-actions")) return;
    setTouched((t) => (t[f] ? t : { ...t, [f]: true }));
  };
  const nameRef = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  const deptRef = useRef<HTMLDivElement>(null);
  const purposeRef = useRef<HTMLInputElement>(null);
  const oppTitleRef = useRef<HTMLInputElement>(null);
  const oppDeptRef = useRef<HTMLButtonElement>(null);
  const oppValueRef = useRef<HTMLInputElement>(null);
  /** Put the cursor in a field (a chip group: its first chip). */
  function focusField(f: Field) {
    const groups: Partial<Record<Field, React.RefObject<HTMLDivElement | null>>> = { category: categoryRef, dept: deptRef };
    const group = groups[f];
    if (group) {
      group.current?.querySelector<HTMLButtonElement>("button")?.focus();
      group.current?.scrollIntoView({ block: "center" });
      return;
    }
    const refs: Partial<Record<Field, React.RefObject<HTMLInputElement | HTMLButtonElement | null>>> = { name: nameRef, city: cityRef, phone: phoneRef, dupConfirm: dupConfirmRef, purpose: purposeRef, oppTitle: oppTitleRef, oppDept: oppDeptRef, oppValue: oppValueRef };
    refs[f]?.current?.focus();
  }

  // Fresh lists each time it opens: People (for "Introduced by") and departments (one just created in
  // Settings, even in another tab, is offered at once).
  useEffect(() => {
    getPeople().then(setPeople, () => setPeople([]));
    void refreshDepartments().catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const first = name.trim().split(/\s+/)[0] ?? "";
  const digits = opp.value.replace(/,/g, "");
  const amount = digits ? Number(digits) : null;
  // A department removed in Settings while the dialog is open no longer counts.
  const deptNames = departments.map((d) => d.name);
  const personDept = deptNames.includes(dept) ? dept : "";
  /** Choose one department (choosing it again clears it). The deal's department follows it unless set on its own. */
  function pickDept(d: string) {
    const next = d === personDept ? "" : d;
    setDept(next);
    setOpp((o) => (!o.department || o.department === personDept ? { ...o, department: next } : o));
  }
  const oppDept = deptNames.includes(opp.department) ? opp.department : "";

  // Duplicate check, 400 ms after the last keystroke; an older answer never overwrites a newer one.
  const fullPhone = phone.length === country.digits ? `+${country.dial}${phone}` : "";
  const dupName = /\p{L}/u.test(name) && [...name.trim()].length >= 2 ? name.trim() : "";
  const dupKey = JSON.stringify([dupName.toLowerCase(), city.trim().toLowerCase(), fullPhone, personDept]);
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      if (!dupName && !fullPhone) return setDup(null);
      checkDuplicates({ name: dupName, city: city.trim(), phone: fullPhone, department: personDept }, ctl.signal).then(
        (r) => setDup({ ...r, key: dupKey }),
        () => {
          /* not reachable: the save still asks the server */
        },
      );
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [dupKey, dupName, city, fullPhone, personDept]);
  /** The check is for exactly what is in the form now (not an answer for what was typed before). */
  const dupFresh = !!dup && dup.key === dupKey;
  const phoneOwner = dup?.phone_match ?? null;
  // Same name and same city (and department): very likely the same person. Same name only: a hint.
  const close = (dup?.name_matches ?? []).filter((m) => m.level !== "weak");
  const hints = (dup?.name_matches ?? []).filter((m) => m.level === "weak");
  const top = close[0] ?? null;
  const confirmedDifferent = !!top && differentOk === top.id;

  // Every rule in one place; null = fine.
  const n = name.trim();
  const c = city.trim();
  const t = opp.title.trim();
  const why = purpose.trim();
  const problems: Record<Field, string | null> = {
    name: !n ? "Give their name." : [...n].length < 2 ? "A name has at least 2 letters." : !NAME_LIKE.test(n) ? "Use letters only (no numbers or symbols)." : null,
    city: !c ? "Give their city." : [...c].length < 2 || !NAME_LIKE.test(c) ? "Use letters only, e.g. Madurai." : null,
    phone: !phone ? "Give their phone number." : phone.length !== country.digits ? `Enter all ${country.digits} digits of the number (${phone.length} now).` : phoneOwner ? `This number is already saved for ${phoneOwner.name}.` : null,
    dupConfirm: top && !confirmedDifferent ? "Open them, or confirm this is a different person." : null,
    category: !category ? "Choose a category." : null,
    dept: !personDept ? "Choose a department." : null,
    purpose: !why ? "Say who they are or why you are adding them." : [...why].length < 3 ? "Give a few words, e.g. Distributor for south Tamil Nadu." : null,
    oppTitle: !withOpp ? null : !t ? "Give the opportunity a title." : [...t].length < 3 ? "Give a few words, e.g. South TN distribution." : null,
    oppDept: withOpp && !oppDept ? "Choose the department this deal belongs to." : null,
    oppValue: !withOpp ? null : amount === null ? "Give the deal's value in rupees." : amount <= 0 || amount > MAX_VALUE ? "Enter the amount in rupees, e.g. 500000." : null,
  };
  const missing = FIELD_ORDER.filter((f) => problems[f]);
  const complete = missing.length === 0;
  const shown = (f: Field) => ((touched[f] || submitted) && problems[f]) || null;
  /** aria wiring for a field and its error line. */
  const errProps = (f: Field) => (shown(f) ? { "aria-invalid": true as const, "aria-describedby": `ap-err-${f}` } : {});
  const errorLine = (f: Field) =>
    shown(f) ? (
      <span id={`ap-err-${f}`} className="ap-field-error" role="alert">
        {shown(f)}
      </span>
    ) : null;

  function switchOpp() {
    const on = !withOpp;
    // Turning it on: the department follows the person's, when they have exactly one.
    if (on && !oppDept && personDept) setOpp((o) => ({ ...o, department: personDept }));
    setWithOpp(on);
  }

  async function save(sameNameOk = false) {
    if (busy) return;
    if (!complete) {
      // The button is disabled until then; Enter in a field still lands here.
      setSubmitted(true);
      focusField(missing[0]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await createPerson({
        name: n,
        city: c,
        phone: `+${country.dial}${phone}`,
        category: category || null,
        departments: [personDept],
        introduced_by_id: intro?.id ?? null,
        context: why,
        consent,
        opportunity: withOpp ? { title: t, stage: opp.stage, value_inr: amount, department: oppDept } : null,
        // A same name is fine once the check for this exact form found no close match, or the owner
        // confirmed a different person. Otherwise the server asks (409) and the box below shows who.
        same_name_ok: sameNameOk || (dupFresh && (!top || confirmedDifferent)),
      });
      if ("existing" in r) {
        setSame(r.existing);
        setBusy(false);
        return;
      }
      void refreshDepartments().catch(() => {});
      onClose();
      router.push(`/people/${r.person_id}`);
    } catch (e) {
      setError(message(e, "Could not add this person."));
      setBusy(false);
    }
  }

  /** It is someone already in People: put the deal on them instead of adding a second copy. */
  const dealReady = withOpp && !problems.oppTitle && !problems.oppDept && !problems.oppValue;
  async function addDealTo(p: SameName) {
    if (busy || !dealReady) return;
    setBusy(true);
    setError(null);
    try {
      await addOpportunity(p.id, { title: t, stage: opp.stage, department: oppDept, value_inr: amount });
      onClose();
      router.push(`/people/${p.id}`);
    } catch (e) {
      setError(message(e, "Could not add the deal."));
      setBusy(false);
    }
  }
  const where = (p: SameName) => whoLabel(p);

  return (
    <div className="ib-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="ib-dialog ap-dialog" role="dialog" aria-modal="true" aria-labelledby="ap-title">
        <div className="ib-dialog-head">
          <h2 id="ap-title" className="ib-dialog-title">
            Add person
          </h2>
          <button type="button" className="ib-close" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <form
          className="ib-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
          // Enter in a field while something is missing: the browser does not submit (the button is
          // disabled), so show every problem and go to the first one. ("Introduced by" uses Enter to
          // pick a name and marks it handled.)
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.defaultPrevented || complete || !(e.target instanceof HTMLInputElement)) return;
            e.preventDefault();
            setSubmitted(true);
            focusField(missing[0]);
          }}
        >
          <p className="ib-why">People in your calls are found automatically. Add someone here before you have talked to them.</p>
          <div className="ib-row">
            <label className="ib-field">
              <span>
                Name <span className="ap-req" aria-hidden="true">*</span>
              </span>
              <input
                ref={nameRef}
                value={name}
                maxLength={80}
                placeholder="e.g. Ramesh Kumar"
                autoFocus
                required
                autoComplete="off"
                {...errProps("name")}
                onChange={(e) => {
                  setName(e.target.value);
                  setSame(null);
                }}
                onBlur={(e) => touch("name", !!name.trim(), e)}
              />
              {errorLine("name")}
            </label>
            <label className="ib-field">
              <span>
                City <span className="ap-req" aria-hidden="true">*</span>
              </span>
              <input ref={cityRef} value={city} maxLength={60} placeholder="e.g. Madurai" required autoComplete="off" {...errProps("city")} onChange={(e) => setCity(e.target.value)} onBlur={(e) => touch("city", !!city.trim(), e)} />
              {errorLine("city")}
            </label>
          </div>
          <div className="ib-field">
            <span id="ap-phone-label">
              Phone <span className="ap-req" aria-hidden="true">*</span>
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
                aria-labelledby="ap-phone-label"
                {...errProps("phone")}
                onChange={(e) => setPhone(phoneDigits(e.target.value, country))}
                onBlur={(e) => touch("phone", !!phone, e)}
              />
            </div>
            {errorLine("phone")}
          </div>

          {/* Already in People? A phone number is one person (blocks); a name warns, by how much matches. */}
          {phoneOwner && (
            <div className="ap-dup ap-dup-block" role="alert">
              <p>
                This number is already saved for <strong>{phoneOwner.name}</strong>
                {where(phoneOwner) ? ` (${where(phoneOwner)})` : ""}. One number belongs to one person.
              </p>
              <div className="ap-dup-actions">
                <Link href={`/people/${phoneOwner.id}`} className="pa-btn pa-btn-primary pw-btn" onClick={onClose}>
                  Open {phoneOwner.name}
                </Link>
              </div>
            </div>
          )}
          {!phoneOwner && top && (
            <div className="ap-dup ap-dup-warn" role="alert">
              <p>
                <strong>{top.name}</strong>
                {where(top) ? ` · ${where(top)}` : ""} is already in People.{" "}
                {top.level === "strong" ? "Same name, city and department: very likely the same person." : "Same name and city: maybe the same person."}
              </p>
              {close.length > 1 && <p className="ap-dup-more">Also: {close.slice(1).map((p) => `${p.name} (${where(p)})`).join(", ")}</p>}
              <div className="ap-dup-actions">
                <Link href={`/people/${top.id}`} className="pa-btn pa-btn-primary pw-btn" onClick={onClose}>
                  Open {top.name}
                </Link>
                {dealReady && (
                  <button type="button" className="pa-btn pw-btn" disabled={busy} onClick={() => void addDealTo(top)}>
                    Add this deal to {top.name}
                  </button>
                )}
              </div>
              <label className="ap-dup-confirm">
                <input ref={dupConfirmRef} type="checkbox" checked={confirmedDifferent} onChange={(e) => setDifferentOk(e.target.checked ? top.id : null)} />
                It&apos;s a different person: add a new one
              </label>
            </div>
          )}
          {!phoneOwner && !top && hints.length > 0 && (
            <p className="ap-dup ap-dup-hint">
              Also in People with this name:{" "}
              {hints.slice(0, 3).map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ", "}
                  <Link href={`/people/${p.id}`} onClick={onClose}>
                    {p.name}
                    {where(p) ? ` (${where(p)})` : ""}
                  </Link>
                </span>
              ))}
              . A different city, so probably someone else.
            </p>
          )}
          <div className="ap-field">
            <span className="ap-label">
              Category <span className="ap-req" aria-hidden="true">*</span>
            </span>
            <div className="ap-chips" role="radiogroup" aria-label="Category" aria-required="true" ref={categoryRef}>
              {CATEGORIES.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={`ap-chip ${category === c ? "ap-chip-on" : ""}`} onClick={() => setCategory(category === c ? "" : c)}>
                  {c}
                </button>
              ))}
            </div>
            {errorLine("category")}
          </div>
          <div className="ap-field">
            <span className="ap-label">
              Department <span className="ap-req" aria-hidden="true">*</span> <span className="ap-optional">(pick one)</span>
            </span>
            <div className="ap-chips" role="radiogroup" aria-label="Department" aria-required="true" ref={deptRef}>
              {departments.map((d) => {
                const on = personDept === d.name;
                return (
                  <button key={d.id} type="button" role="radio" aria-checked={on} className={`ap-chip ap-dept ${on ? "ap-chip-on" : ""}`} style={on ? deptStyle(d.color) : undefined} onClick={() => pickDept(d.name)}>
                    {d.name}
                  </button>
                );
              })}
            </div>
            {errorLine("dept")}
          </div>
          <div className="ap-field">
            <span className="ap-label">
              Introduced by <span className="ap-optional">(optional)</span>
            </span>
            <IntroPicker people={people} value={intro} onChange={setIntro} />
          </div>
          <label className="ib-field">
            <span>
              {intro ? "Purpose of introduction" : "Who they are / why you are adding them"} <span className="ap-req" aria-hidden="true">*</span>
            </span>
            <input
              ref={purposeRef}
              value={purpose}
              maxLength={1000}
              placeholder="e.g. Distributor for south Tamil Nadu"
              required
              autoComplete="off"
              {...errProps("purpose")}
              onChange={(e) => setPurpose(e.target.value)}
              onBlur={(e) => touch("purpose", !!purpose.trim(), e)}
            />
            {errorLine("purpose")}
          </label>

          <div className="ap-toggle-row">
            <span>
              <strong>Also create opportunity</strong>
              <span className="ap-hint">{withOpp && t ? `“${t}” · ${opp.stage}${oppDept ? ` · ${oppDept}` : ""}` : "A deal with them, on the Opportunity panel"}</span>
            </span>
            <button type="button" role="switch" aria-checked={withOpp} aria-label="Also create opportunity" className={`st-toggle st-switch ${withOpp ? "st-toggle-on" : ""}`} onClick={switchOpp} />
          </div>
          {withOpp && (
            <div className="ap-opp">
              <label className="ib-field">
                <span>
                  Opportunity <span className="ap-req" aria-hidden="true">*</span>
                </span>
                <input
                  ref={oppTitleRef}
                  value={opp.title}
                  maxLength={160}
                  placeholder="e.g. South TN distribution"
                  required
                  autoComplete="off"
                  {...errProps("oppTitle")}
                  onChange={(e) => setOpp((o) => ({ ...o, title: e.target.value }))}
                  onBlur={(e) => touch("oppTitle", !!opp.title.trim(), e)}
                />
                {errorLine("oppTitle")}
              </label>
              <div className="ib-field">
                <span id="ap-oppdept-label">
                  Department <span className="ap-req" aria-hidden="true">*</span>
                </span>
                <SelectMenu
                  buttonRef={oppDeptRef}
                  labelledBy="ap-oppdept-label"
                  placeholder="Choose a department"
                  value={oppDept}
                  options={departments.map((d) => ({ value: d.name, label: d.name, color: d.color }))}
                  invalid={!!shown("oppDept")}
                  describedBy={shown("oppDept") ? "ap-err-oppDept" : undefined}
                  onChange={(v) => setOpp((o) => ({ ...o, department: v }))}
                  onBlur={() => touch("oppDept", !!oppDept)}
                />
                {errorLine("oppDept")}
              </div>
              <div className="ib-row">
                <label className="ib-field">
                  <span>
                    Value (₹) <span className="ap-req" aria-hidden="true">*</span>
                  </span>
                  <input
                    ref={oppValueRef}
                    value={opp.value}
                    inputMode="numeric"
                    placeholder="e.g. 500000"
                    required
                    autoComplete="off"
                    {...errProps("oppValue")}
                    // Rupees only: digits (and commas, as people write them).
                    onChange={(e) => setOpp((o) => ({ ...o, value: e.target.value.replace(/[^\d,]/g, "").slice(0, 20) }))}
                    onBlur={(e) => touch("oppValue", !!opp.value, e)}
                  />
                  {errorLine("oppValue") ?? (amount !== null && amount > 0 && amount <= MAX_VALUE && <span className="ap-value-preview">{rupees(amount)}</span>)}
                </label>
                <div className="ib-field">
                  <span id="ap-stage-label">Stage</span>
                  <SelectMenu
                    labelledBy="ap-stage-label"
                    value={opp.stage}
                    options={OPEN_STAGES.map((s) => ({ value: s, label: s, hint: `${Math.round(STAGE_CHANCE[s] * 100)}%` }))}
                    onChange={(v) => setOpp((o) => ({ ...o, stage: v as Stage }))}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="ap-toggle-row">
            <strong>Recording consent</strong>
            <div className="ap-seg" role="radiogroup" aria-label="Recording consent">
              {CONSENTS.map((c) => (
                <button key={c.value} type="button" role="radio" aria-checked={consent === c.value} className={consent === c.value ? "ap-seg-on" : ""} onClick={() => setConsent(c.value)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {same && (
            <div className="ap-same" role="alert">
              <p>
                <strong>{same[0].name}</strong> is already in People
                {same[0].city || same[0].organisation ? ` (${[same[0].organisation, same[0].city].filter(Boolean).join(", ")})` : ""}. Is this the same person?
              </p>
              <div className="ap-same-actions">
                {same.slice(0, 3).map((p) => (
                  <Link key={p.id} href={`/people/${p.id}`} className="pa-btn pw-btn" onClick={onClose}>
                    Open {p.name}
                    {p.city ? ` · ${p.city}` : ""}
                  </Link>
                ))}
                <button type="button" className="pa-btn pa-btn-primary pw-btn" disabled={busy} onClick={() => void save(true)}>
                  No, add a different person
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}
          {!complete && (
            // What is still missing, in form order; each one jumps to its field.
            <p className="ap-missing" id="ap-missing" aria-live="polite">
              <span>To add, fill in:</span>
              {missing.map((f) => (
                <button key={f} type="button" className="ap-missing-item" onClick={() => focusField(f)}>
                  {FIELD_LABEL[f]}
                </button>
              ))}
            </p>
          )}
          <div className="ib-actions">
            <button type="button" className="pa-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="pa-btn pa-btn-primary" disabled={!complete || busy || !!same} aria-describedby={complete ? undefined : "ap-missing"} title={complete ? undefined : "Fill in every field marked * first"}>
              {busy ? "Adding…" : `Add ${first || "person"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
