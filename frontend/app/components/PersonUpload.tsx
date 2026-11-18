"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_UPLOAD_MB, SUPPORTED_EXTENSIONS, getJob, uploadAudio } from "../lib/api";
import { call, getPerson } from "../lib/people";

type Step =
  | { kind: "uploading"; progress: number }
  | { kind: "processing"; label: string; progress: number }
  | { kind: "linking" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const POLL_MS = 2000;
const ext = (f: File) => (f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "");
/** "Add file" on a person's page takes call recordings only (no chat exports or other files). */
export const ACCEPT = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(",");

function invalid(f: File): string | null {
  const e = ext(f);
  if (!SUPPORTED_EXTENSIONS.includes(e)) return `Only audio recordings can be added here${e ? ` (".${e}" is not supported)` : ""}. Use ${SUPPORTED_EXTENSIONS.join(", ").toUpperCase()}.`;
  if (!f.size) return "This file is empty.";
  return f.size > MAX_UPLOAD_MB * 1024 * 1024 ? `File is larger than ${MAX_UPLOAD_MB} MB.` : null;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * "Add file" on a person's page: uploads a call recording for this person, shows the processing
 * live, and calls `onAdded` once the call is on their timeline.
 */
export default function PersonUpload({ personId, personName, file, onAdded, onClose }: { personId: string; personName: string; file: File; onAdded: () => void; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "uploading", progress: 0 });
  const started = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (started.current) return;
    started.current = true;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const bad = invalid(file);
      if (bad) return setStep({ kind: "failed", message: bad });
      try {
        const up = await uploadAudio(file, (p) => alive.current && setStep({ kind: "uploading", progress: p }));
        const job = await call<{ job_id: string }>("/api/analysis", json({ filename: up.filename, person_id: personId }));
        // Processing: transcript, translation, analysis (the same pipeline as the call screen).
        for (;;) {
          if (!alive.current) return;
          const j = await getJob(job.job_id);
          if (j.status === "failed") throw new Error(j.error ?? "Processing failed.");
          if (j.status === "completed") break;
          setStep({ kind: "processing", label: j.stage_label || "Processing", progress: j.progress });
          await sleep(POLL_MS);
        }
        // People are found right after the results are saved; wait until it is on the timeline.
        setStep({ kind: "linking" });
        for (let i = 0; i < 60; i++) {
          if (!alive.current) return;
          const p = await getPerson(personId);
          if (p.mentions.some((m) => m.job_id === job.job_id)) {
            setStep({ kind: "done" });
            onAdded();
            return;
          }
          await sleep(POLL_MS);
        }
        throw new Error("Processed, but it is taking long to appear on the timeline. Refresh in a minute.");
      } catch (e) {
        if (alive.current) setStep({ kind: "failed", message: e instanceof Error ? e.message : "Upload failed." });
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [file, personId, onAdded]);

  const pct = step.kind === "uploading" || step.kind === "processing" ? Math.round(step.progress * 100) : step.kind === "linking" || step.kind === "done" ? 100 : 0;
  const label =
    step.kind === "uploading"
      ? `Uploading · ${pct}%`
      : step.kind === "processing"
        ? `${step.label} · ${pct}%`
        : step.kind === "linking"
          ? `Adding to ${personName}'s timeline…`
          : step.kind === "done"
            ? `Added to ${personName}'s timeline`
            : step.message;
  return (
    <div className={`pu ${step.kind === "failed" ? "pu-failed" : step.kind === "done" ? "pu-done" : ""}`} role="status" aria-live="polite">
      <div className="pu-row">
        <span className="pu-name" title={file.name}>
          {file.name}
        </span>
        <span className="pu-label">{label}</span>
        {(step.kind === "done" || step.kind === "failed") && (
          <button type="button" className="pu-close" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {step.kind !== "failed" && step.kind !== "done" && (
        <div className="pu-bar" aria-hidden="true">
          <span style={{ width: `${step.kind === "linking" ? 100 : Math.max(3, pct)}%` }} className={step.kind === "linking" ? "pu-bar-busy" : ""} />
        </div>
      )}
    </div>
  );
}
