"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type AnalysisResult, type ChatResult, formatTime, getChatJob, getJob } from "../lib/api";
import { type Mention, nameKey, recordingUrl } from "../lib/people";

export type PanelTab = "transcript" | "analysis";

type Line = { id: number; start: number | null; label: string; speaker: string | null; text: string; english: string | null };

const same = (a: string, b: string | null) => !b || a.trim().toLowerCase() === b.trim().toLowerCase();

function linesOf(kind: Mention["kind"], result: AnalysisResult | ChatResult): Line[] {
  if (kind === "whatsapp") {
    const r = result as ChatResult;
    const fmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    return r.messages
      .filter((m) => m.kind !== "system")
      .map((m) => ({ id: m.index, start: null, label: fmt.format(new Date(m.timestamp)), speaker: m.sender, text: m.kind === "media" ? "(media)" : m.text, english: m.kind === "text" && !same(m.text, m.english) ? m.english : null }));
  }
  const r = result as AnalysisResult;
  return r.tamil_segments
    .map((s, i) => ({ id: i, start: s.start, label: formatTime(s.start), speaker: s.speaker, text: s.text, english: same(s.text, r.english_segments[i]?.text ?? null) ? null : (r.english_segments[i]?.text ?? null) }))
    .filter((l) => l.text);
}

/**
 * One conversation opened from a person's timeline: the recording (calls), the full transcript or
 * chat with the lines about this person highlighted (and the line where they were introduced), and
 * the call's analysis. While the recording plays, the line being spoken is highlighted.
 */
export default function ConversationPanel({ mention, personName, tab, autoplay, onTab }: { mention: Mention; personName: string; tab: PanelTab; autoplay: boolean; onTab: (t: PanelTab) => void }) {
  const [result, setResult] = useState<AnalysisResult | ChatResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let alive = true;
    (mention.kind === "whatsapp" ? getChatJob(mention.job_id) : getJob(mention.job_id))
      .then((j) => {
        if (!alive) return;
        if (j.status !== "completed" || !j.result) setError(j.error ?? "This conversation's transcript is not available.");
        else setResult(j.result);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load the transcript."));
    return () => {
      alive = false;
    };
  }, [mention.job_id, mention.kind]);

  const lines = useMemo(() => (result ? linesOf(mention.kind, result) : []), [result, mention.kind]);
  const about = useMemo(() => new Set(mention.evidence_lines ?? []), [mention.evidence_lines]);
  const introKey = mention.introduced_by_name ? nameKey(mention.introduced_by_name).split(" ")[0] : null;
  // The first line where the introducer talks about this person.
  const introLine = lines.find((l) => !!introKey && about.has(l.id) && nameKey(l.speaker ?? "").split(" ")[0] === introKey) ?? null;
  const isIntro = (l: Line) => l.id === introLine?.id;
  const active = playing || now >= 0 ? [...lines].reverse().find((l) => l.start !== null && l.start <= now + 0.05)?.id : undefined;

  // Keep the spoken line in view while playing.
  useEffect(() => {
    if (!playing || active === undefined) return;
    list.current?.querySelector<HTMLElement>(`[data-line="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active, playing]);

  function jump(l: Line) {
    list.current?.querySelector<HTMLElement>(`[data-line="${l.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (l.start !== null && audio.current) {
      audio.current.currentTime = l.start;
      void audio.current.play().catch(() => {});
    }
  }

  const analysis = result?.analysis;
  return (
    <div className="cv-panel">
      {mention.kind === "audio" && (
        <audio
          ref={audio}
          className="cv-audio"
          controls
          preload="metadata"
          autoPlay={autoplay}
          src={recordingUrl(mention.job_id)}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setError((e) => e ?? "The recording could not be played. It may no longer be stored.")}
        />
      )}
      <div className="cv-tabs" role="tablist">
        {(["transcript", "analysis"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`cv-tab ${tab === t ? "cv-tab-on" : ""}`} onClick={() => onTab(t)}>
            {t === "transcript" ? (mention.kind === "whatsapp" ? "Chat" : "Transcript") : "Analysis"}
          </button>
        ))}
      </div>

      {error && <p className="cv-error">{error}</p>}
      {!result && !error && (
        <div className="cv-loading" aria-busy="true">
          <span className="auth-spinner" />
        </div>
      )}

      {result && tab === "transcript" && (
        <>
          {introLine && (
            <button type="button" className="cv-intro" onClick={() => jump(introLine)}>
              <strong>Introduced by {mention.introduced_by_name}</strong>
              <span>
                {introLine.label} · “{introLine.english ?? introLine.text}”
              </span>
            </button>
          )}
          {!introLine && mention.introduced_by_name && (
            <p className="cv-intro cv-intro-static">
              <strong>Introduced by {mention.introduced_by_name}</strong>
            </p>
          )}
          <ol className="cv-lines" ref={list} aria-label="Transcript">
            {lines.map((l) => (
              <li key={l.id} data-line={l.id} className={`cv-line ${about.has(l.id) ? "cv-line-about" : ""} ${active === l.id ? "cv-line-now" : ""}`}>
                <button type="button" className="cv-time" onClick={() => jump(l)} disabled={l.start === null} title={l.start === null ? undefined : "Play from here"}>
                  {l.label}
                </button>
                <span className="cv-body">
                  <span className="cv-who">
                    {l.speaker ?? "Unknown"}
                    {isIntro(l) && <span className="cv-tag cv-tag-intro">Introduces {personName}</span>}
                    {about.has(l.id) && !isIntro(l) && <span className="cv-tag">About {personName}</span>}
                  </span>
                  <span className="cv-text">{l.text}</span>
                  {l.english && <span className="cv-en">{l.english}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      {result && tab === "analysis" &&
        (analysis?.available && analysis.data ? (
          <div className="cv-analysis">
            {(analysis.data.final_summary || analysis.data.summary) && <p className="cv-summary">{analysis.data.final_summary || analysis.data.summary}</p>}
            {analysis.data.decisions.length > 0 && (
              <>
                <h4>Decisions</h4>
                <ul>
                  {analysis.data.decisions.map((d, i) => (
                    <li key={i}>
                      {d.decision}
                      {d.made_by ? <span className="cv-meta"> · {d.made_by}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {analysis.data.action_items.length > 0 && (
              <>
                <h4>Commitments</h4>
                <ul>
                  {analysis.data.action_items.map((a, i) => (
                    <li key={i}>
                      {a.responsible_person ? <strong>{a.responsible_person}: </strong> : null}
                      {a.task}
                      {a.deadline || a.date ? <span className="cv-meta"> · due {a.deadline || a.date}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {analysis.data.key_takeaways.length > 0 && (
              <>
                <h4>Key takeaways</h4>
                <ul>
                  {analysis.data.key_takeaways.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <p className="cv-error">{analysis?.reason ?? "No analysis for this conversation."}</p>
        ))}
    </div>
  );
}
