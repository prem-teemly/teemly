"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { type ChatJob, type Job, exportReportPdf, getChatJob, getJob } from "../lib/api";
import { sidebarFor, useOrigin, withFrom } from "../lib/origin";
import { toCallView, toChatView } from "../lib/callView";
import { type Mention, type PersonDetail, getPerson, recordingUrl, rupees, stageClass, whenLabel } from "../lib/people";
import { useAudioPlayer } from "../lib/useAudioPlayer";
import { useWaveformPeaks } from "../lib/useWaveformPeaks";
import { CheckIcon, ChevronRightIcon, SparkleIcon } from "./Icons";
import PeopleChrome from "./PeopleChrome";
import RightRail from "./RightRail";
import TranscriptPanel from "./TranscriptPanel";
import WaveformPlayer from "./WaveformPlayer";
import type { PanelState } from "./shared";

/**
 * One call or chat of a person, opened from their timeline: the same player, transcript and analysis
 * as the call screen, for a conversation already stored (recording played back from the server).
 * Breadcrumb: People › <person> › Call · today 6:12 PM (or Departments › … when opened from there).
 */
export default function PersonCall({ personId, jobId }: { personId: string; jobId: string }) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [job, setJob] = useState<Job | ChatJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const origin = useOrigin(); // opened from Departments: the breadcrumb leads back there

  /** Download this conversation's full context as a Teemly PDF report (built by the backend). */
  async function downloadReport() {
    if (!mention || reporting) return;
    setReporting(true);
    setReportError(null);
    const title = mention.file_name.replace(/\.[^.]+$/, "") || `${person?.person.name ?? "Conversation"} call`;
    try {
      const pdf = await exportReportPdf(jobId, title);
      const url = URL.createObjectURL(pdf);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title} - Teemly report.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "The report could not be made.");
    } finally {
      setReporting(false);
    }
  }

  // The person, and this conversation on their timeline (a conversation of someone else is not shown here).
  useEffect(() => {
    let alive = true;
    getPerson(personId)
      .then(async (p) => {
        if (!alive) return;
        const m = p.mentions.find((x) => x.job_id === jobId);
        if (!m) throw new Error("This conversation is not on this person's timeline.");
        setPerson(p);
        setMention(m);
        const j = await (m.kind === "whatsapp" ? getChatJob(jobId) : getJob(jobId));
        if (!alive) return;
        if (j.status !== "completed" || !j.result) throw new Error(j.error ?? "This conversation has no transcript.");
        setJob(j);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load this conversation."));
    return () => {
      alive = false;
    };
  }, [personId, jobId]);

  // The stored recording: fetched once, played locally and drawn as a waveform.
  useEffect(() => {
    if (mention?.kind !== "audio") return;
    let alive = true;
    let url: string | null = null;
    fetch(recordingUrl(jobId), { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "The recording is no longer stored." : `Could not load the recording (HTTP ${r.status}).`);
        const blob = await r.blob();
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setFile(new File([blob], mention.file_name, { type: blob.type }));
        setAudioUrl(url);
      })
      .catch((e) => alive && setAudioError(e instanceof Error ? e.message : "Could not load the recording."));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [mention, jobId]);

  const player = useAudioPlayer(audioUrl);
  const waveform = useWaveformPeaks(file);
  const seekAndPlay = useCallback((s: number) => player.seek(s, true), [player]);

  const view = useMemo(() => {
    if (!job?.result) return null;
    return job.kind === "whatsapp" ? toChatView((job as ChatJob).result!) : toCallView((job as Job).result!);
  }, [job]);
  const state: PanelState = error ? "failed" : view ? "ready" : "loading";
  const kind = mention?.kind === "whatsapp" ? "Chat" : "Call";
  const secs = Math.max(1, Math.round(job?.elapsed_seconds ?? 0));
  // Opportunities that came from this conversation (each opens its own page).
  const fromCall = (person?.opportunities ?? []).filter((o) => o.source?.job_id === jobId);

  return (
    <PeopleChrome search={query} onSearch={setQuery} placeholder="Search this transcript..." active={sidebarFor(origin.from)}>
      <div className="crumb-row">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          {origin.crumbs.map((c) => (
            <Fragment key={c.href}>
              <Link href={c.href} className="crumb">
                {c.label}
              </Link>
              <ChevronRightIcon size={14} className="crumb-sep" />
            </Fragment>
          ))}
          {person ? (
            <Link href={withFrom(`/people/${personId}`, origin.from)} className="crumb">
              {person.person.name}
            </Link>
          ) : (
            <span className="crumb">…</span>
          )}
          <ChevronRightIcon size={14} className="crumb-sep" />
          <span className="crumb crumb-current" aria-current="page" title={mention?.file_name}>
            {mention ? `${kind} · ${whenLabel(mention.at)}` : kind}
          </span>
        </nav>
        <div className="crumb-pills">
          {job?.status === "completed" && (
            <span className="pill pill-green">
              <CheckIcon size={12} strokeWidth={2.4} /> Analysed in {secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}
            </span>
          )}
          {view?.languages && <span className="pill pill-grey">{view.languages}</span>}
        </div>
      </div>

      {error ? (
        <div className="card pl-state" role="alert">
          <p>{error}</p>
          <Link href={withFrom(`/people/${personId}`, origin.from)} className="pl-view">
            Back to {person?.person.name ?? "the person"}
          </Link>
        </div>
      ) : (
        <>
          {fromCall.length > 0 && (
            <section className="pc-opps" aria-label={`Opportunities from this ${kind.toLowerCase()}`}>
              <span className="pc-opps-label">
                <SparkleIcon size={12} /> {fromCall.length === 1 ? "Opportunity" : `${fromCall.length} opportunities`} from this {kind.toLowerCase()}
              </span>
              {fromCall.map((o) => (
                <Link key={o.id} href={withFrom(`/opportunities/${o.id}`, "person")} className="pc-opp" title="View this opportunity">
                  <span className="pc-opp-title">{o.title}</span>
                  {o.value_inr !== null && <span className="pc-opp-value">{rupees(o.value_inr)}</span>}
                  <span className={`pw-stage pw-stage-${stageClass(o.stage)} dd-stage`}>{o.stage}</span>
                  <span className="pc-opp-go">View →</span>
                </Link>
              ))}
            </section>
          )}
          {mention?.kind === "audio" &&
            (audioError ? (
              <p className="pc-audio-error" role="alert">
                {audioError} The transcript and analysis are below.
              </p>
            ) : (
              <WaveformPlayer
                player={player}
                src={audioUrl}
                peaks={waveform.peaks}
                peaksLoading={!audioUrl || waveform.loading}
                peaksError={waveform.error}
                lines={view?.source === "audio" ? view.transcript : []}
              />
            ))}
          {reportError && (
            <p className="pc-audio-error" role="alert">
              {reportError}
            </p>
          )}
          <div className="analysis-grid">
            <TranscriptPanel
              state={state}
              lines={view?.transcript ?? []}
              moments={view?.context?.key_moments ?? null}
              currentTime={player.currentTime}
              playing={player.playing}
              onSeek={seekAndPlay}
              query={query}
              onReport={() => void downloadReport()}
              reporting={reporting}
            />
            <RightRail state={state} view={view} onSeek={seekAndPlay} />
          </div>
        </>
      )}
    </PeopleChrome>
  );
}
