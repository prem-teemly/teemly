"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon } from "./components/Icons";
import RightRail from "./components/RightRail";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import TranscriptPanel from "./components/TranscriptPanel";
import WaveformPlayer, { type PlayerStatus } from "./components/WaveformPlayer";
import type { PanelState } from "./components/shared";
import {
  ApiError,
  type AudioMetadata,
  describeAudio,
  exportReportPdf,
  type Job,
  MAX_UPLOAD_MB,
  SUPPORTED_EXTENSIONS,
  getJob,
  startAnalysis,
  uploadAudio,
} from "./lib/api";
import { toCallView } from "./lib/callView";
import { useAudioPlayer } from "./lib/useAudioPlayer";
import { useWaveformPeaks } from "./lib/useWaveformPeaks";

type Phase = "idle" | "uploading" | "processing" | "completed" | "failed";

const POLL_MS = 1000; // results appear in stages (transcript first), so check often

function extensionOf(file: File): string {
  return file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
}

function validateFile(file: File): string | null {
  const ext = extensionOf(file);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return `Unsupported file type${ext ? ` ".${ext}"` : ""}. Use an audio file (${SUPPORTED_EXTENSIONS.join(", ").toUpperCase()}).`;
  }
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `File is larger than ${MAX_UPLOAD_MB} MB.`;
  return null;
}

export default function CallAnalysisPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Metadata of the uploaded file as stored on the server (from the upload, then from the job).
  const [uploadedMeta, setUploadedMeta] = useState<AudioMetadata | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState("");

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runId = useRef(0); // ignores responses from a previous upload

  const player = useAudioPlayer(audioUrl);
  const waveform = useWaveformPeaks(file);

  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  /** Local playback URL for the chosen file; the previous one is released. */
  function setPlaybackFile(f: File | null) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = f ? URL.createObjectURL(f) : null;
    setFile(f);
    setAudioUrl(urlRef.current);
  }

  const poll = useCallback((jobId: string, id: number) => {
    const tick = () => {
      getJob(jobId)
        .then((j) => {
          if (id !== runId.current) return;
          setJob(j);
          if (j.status === "completed") setPhase("completed");
          else if (j.status === "failed") {
            setPhase("failed");
            setError(j.error ?? "Processing failed.");
          } else pollTimer.current = setTimeout(tick, POLL_MS);
        })
        .catch((e: unknown) => {
          if (id !== runId.current) return;
          setPhase("failed");
          setError(e instanceof ApiError ? e.message : "Lost contact with the backend while processing.");
        });
    };
    tick();
  }, []);

  async function onFileSelected(f: File) {
    const id = ++runId.current;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setJob(null);
    setUploadedMeta(null);
    setUploadProgress(0);
    setFileName(f.name);

    const invalid = validateFile(f);
    if (invalid) {
      setPlaybackFile(null);
      setPhase("failed");
      setError(invalid);
      return;
    }

    setPlaybackFile(f);
    setError(null);
    setPhase("uploading");
    try {
      const onProgress = (p: number) => id === runId.current && setUploadProgress(p);
      const uploaded = await uploadAudio(f, onProgress);
      if (id !== runId.current) return;
      setUploadedMeta(uploaded.metadata ?? null);
      setPhase("processing");
      const started = await startAnalysis(uploaded.filename, null);
      if (id !== runId.current) return;
      setJob(started);
      poll(started.job_id, id);
    } catch (e) {
      if (id !== runId.current) return;
      setPhase("failed");
      setError(e instanceof Error ? e.message : "Upload failed.");
    }
  }

  const busy = phase === "uploading" || phase === "processing";

  const status: PlayerStatus =
    phase === "uploading"
      ? { kind: "uploading", label: "Uploading", progress: uploadProgress }
      : phase === "processing"
        ? { kind: "processing", label: job?.stage_label ?? "Processing", progress: job?.progress ?? 0 }
        : phase === "completed"
          ? { kind: "completed" }
          : phase === "failed"
            ? { kind: "failed", message: error ?? "Something went wrong." }
            : { kind: "idle" };

  const view = useMemo(() => {
    if (!job?.result) return null;
    return toCallView(job.result);
  }, [job]);

  const panelState: PanelState = busy
    ? "loading"
    : phase === "completed" && view
      ? "ready"
      : phase === "failed"
        ? "failed"
        : "empty";

  // The transcript is shown as soon as the backend has it; summary and Pulse keep loading until done.
  const transcriptState: PanelState =
    phase === "processing" && view && view.transcript.length ? "ready" : panelState;

  const seekAndPlay = useCallback((s: number) => player.seek(s, true), [player]);
  const audioMeta = (job && "audio" in job ? job.audio : null) ?? uploadedMeta;
  const callTitle = fileName ? fileName.replace(/\.[^.]+$/, "") : "New call";

  /** Download the full context as a Teemly PDF report (built by the backend from the finished job). */
  async function onExport() {
    if (!job || job.status !== "completed" || exporting) return;
    setExporting(true);
    try {
      const pdf = await exportReportPdf(job.job_id, callTitle);
      const url = URL.createObjectURL(pdf);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${callTitle} - Teemly report.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }
  const cardProps = { state: panelState, view, onSeek: seekAndPlay };

  // Breadcrumb: People > the first person in the call > "Call · today 6:12 PM" (upload time).
  const person = view?.talk.find((t) => !/^Person \d+$/.test(t.name))?.name ?? view?.talk[0]?.name ?? null;
  const crumbTitle = fileName ? `Call${audioMeta?.uploaded_at ? " · " + whenLabel(audioMeta.uploaded_at) : ""}` : "New call";
  const crumbTip = [audioMeta?.original_filename ?? fileName, audioMeta ? describeAudio(audioMeta).join(" · ") : null].filter(Boolean).join("\n");

  return (
    <div className="shell">
      <Sidebar active="people" />
      <div className="app">
        <TopBar
          onFileSelected={onFileSelected}
          disabled={busy}
          onExport={onExport}
          canExport={phase === "completed" && job?.status === "completed"}
          exporting={exporting}
          query={query}
          onQuery={setQuery}
        />

        <main className="content">
          <div className="crumb-row">
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <Link href="/people" className="crumb">
                People
              </Link>
              {person && (
                <>
                  <ChevronRightIcon size={14} className="crumb-sep" />
                  <span className="crumb">{person}</span>
                </>
              )}
              <ChevronRightIcon size={14} className="crumb-sep" />
              <span className="crumb crumb-current" aria-current="page" title={crumbTip || callTitle}>
                {crumbTitle}
              </span>
            </nav>
            <div className="crumb-pills" aria-live="polite">
              <StatusPill status={status} elapsed={job?.elapsed_seconds ?? null} />
              {view?.languages && <span className="pill pill-grey">{view.languages}</span>}
            </div>
          </div>

          <WaveformPlayer
            player={player}
            src={audioUrl}
            peaks={waveform.peaks}
            peaksLoading={waveform.loading}
            peaksError={waveform.error}
            lines={view?.source === "audio" ? view.transcript : []}
          />

          <div className="analysis-grid">
            <TranscriptPanel
              state={transcriptState}
              lines={view?.transcript ?? []}
              moments={view?.context?.key_moments ?? null}
              currentTime={player.currentTime}
              playing={player.playing}
              onSeek={seekAndPlay}
              query={query}
              onReport={phase === "completed" && job?.status === "completed" ? () => void onExport() : undefined}
              reporting={exporting}
            />
            <RightRail {...cardProps} />
          </div>
        </main>
      </div>
    </div>
  );
}

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** "today 6:12 PM", "yesterday 9:03 AM" or "12 Nov, 4:40 PM" (upload time stored on the server). */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  const time = timeFmt.format(d).toUpperCase();
  return diff === 0 ? `today ${time}` : diff === 1 ? `yesterday ${time}` : `${dayFmt.format(d)}, ${time}`;
}

/** Processing status: live stage while working, "Analysed in N min" when done, the error if it failed. */
function StatusPill({ status, elapsed }: { status: PlayerStatus; elapsed: number | null }) {
  if (status.kind === "idle") return null;
  if (status.kind === "failed") {
    return (
      <span className="pill pill-red" role="alert" title={status.message}>
        {status.message}
      </span>
    );
  }
  if (status.kind === "completed") {
    const secs = Math.max(1, Math.round(elapsed ?? 0));
    return (
      <span className="pill pill-green">
        <CheckIcon size={12} strokeWidth={2.4} /> Analysed in {secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}
      </span>
    );
  }
  return (
    <span className="pill pill-teal">
      {status.label} · {Math.round(status.progress * 100)}%
    </span>
  );
}
