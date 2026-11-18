"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatClock, type KeyMoment, type MomentTag } from "../lib/api";
import type { TranscriptLine } from "../lib/callView";
import { EmptyText, type PanelState, Skeleton } from "./shared";

type Props = {
  state: PanelState;
  lines: TranscriptLine[];
  /** Key moments (short transcript); null while the analysis is still running. */
  moments: KeyMoment[] | null;
  currentTime: number;
  playing: boolean;
  onSeek: (seconds: number) => void;
  /** Top-bar search: shows the matching lines. */
  query: string;
  /** Download the call's Teemly PDF report (shown once the analysis is ready). */
  onReport?: () => void;
  reporting?: boolean;
};

/** Tamil, Hindi or Telugu script, so those lines get the right font. */
const INDIC = /[஀-௿ऀ-ॿఀ-౿]/;

const TAG_LABEL: Record<MomentTag, string> = {
  commitment: "Commitment",
  hedging: "Hedging",
  new_person: "New person",
  interest: "Interest",
  concern: "Concern",
  decision: "Decision",
  question: "Question",
};

/** One row: time · person · what was said (with the key-moment highlight and tag, if any). */
type Row = { key: string; start: number; timeLabel?: string | null; speaker: string | null; text: string; tag?: MomentTag | null; end: number };

function Rows({ rows, order, currentTime, onSeek, listRef }: { rows: Row[]; order: Map<string, number>; currentTime: number; onSeek: (s: number) => void; listRef: React.RefObject<HTMLOListElement | null> }) {
  return (
    <ol className="km-list" ref={listRef}>
      {rows.map((r) => {
        const indic = INDIC.test(r.text);
        const active = currentTime > 0 && !r.timeLabel && r.start <= currentTime && currentTime <= r.end + 0.5;
        return (
          <li key={r.key} className={`km-row ${active ? "km-row-active" : ""}`}>
            {r.timeLabel ? (
              <span className="km-time km-time-static">{r.timeLabel}</span>
            ) : (
              <button type="button" className="km-time" onClick={() => onSeek(r.start)} aria-label={`Play from ${formatClock(r.start)}`}>
                {formatClock(r.start)}
              </button>
            )}
            <span className={`km-who spk-text-${r.speaker ? (order.get(r.speaker) ?? 0) % 6 + 1 : 0}`}>{r.speaker ?? "Unknown"}</span>
            <p className={`km-text ${indic ? "tamil" : ""}`} lang={indic ? undefined : "en"}>
              <span className={r.tag ? `km-hl km-${r.tag}` : undefined}>{r.text}</span>
              {r.tag && <span className={`km-tag km-${r.tag}`}>{TAG_LABEL[r.tag]}</span>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export default function TranscriptPanel({ state, lines, moments, currentTime, playing, onSeek, query, onReport, reporting = false }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const [lang, setLang] = useState<"en" | "orig">("en");
  const [showAll, setShowAll] = useState(false);
  const spoken = lines.filter((l) => l.text);
  const q = query.trim().toLowerCase();
  const hasMoments = state === "ready" && !!moments?.length;

  const rows: Row[] = useMemo(() => {
    const lineRow = (l: TranscriptLine, i: number): Row => ({
      key: `l${i}`,
      start: l.start,
      end: l.end,
      timeLabel: l.timeLabel,
      speaker: l.speaker,
      text: lang === "en" ? (l.translation ?? l.text) : l.text,
    });
    if (q) {
      return lines
        .map(lineRow)
        .filter((r, i) => r.text && `${lines[i].text} ${lines[i].translation ?? ""} ${lines[i].speaker ?? ""}`.toLowerCase().includes(q));
    }
    if (hasMoments && !showAll) {
      return moments!.map((m) => ({ key: `m${m.line}`, start: m.start, end: m.end, speaker: m.speaker, text: lang === "en" ? m.text : m.original, tag: m.tag }));
    }
    return lines.map(lineRow).filter((r) => r.text);
  }, [lines, moments, lang, q, hasMoments, showAll]);

  // Colour people by order of first appearance (first teal, second navy, ...), as in the design.
  const order = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.speaker && !m.has(l.speaker)) m.set(l.speaker, m.size);
    return m;
  }, [lines]);

  // Keep the playing line in view.
  const activeIndex = currentTime > 0 ? rows.findIndex((r) => !r.timeLabel && r.start <= currentTime && currentTime <= r.end + 0.5) : -1;
  useEffect(() => {
    if (!playing || activeIndex < 0) return;
    (listRef.current?.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex, playing]);

  const count = q
    ? `${rows.length} ${rows.length === 1 ? "match" : "matches"} · ${spoken.length} lines`
    : hasMoments && !showAll
      ? `Showing ${moments!.length} key moments · ${spoken.length} lines`
      : `${spoken.length} lines`;

  return (
    <section className="card transcript-panel" aria-label="Transcript">
      <header className="km-head">
        <div className="km-tabs" role="tablist" aria-label="Transcript language">
          {(["en", "orig"] as const).map((l) => (
            <button key={l} type="button" role="tab" aria-selected={lang === l} className={`km-tab ${lang === l ? "km-tab-on" : ""}`} onClick={() => setLang(l)}>
              {l === "en" ? "English" : "Original"}
            </button>
          ))}
          {onReport && state === "ready" && (
            <button type="button" className="km-report" onClick={onReport} disabled={reporting} title="Download this conversation's full context as a Teemly PDF report">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4v11" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
              {reporting ? "Preparing…" : "Report"}
            </button>
          )}
        </div>
        {state === "ready" &&
          (hasMoments && !q ? (
            <button
              type="button"
              className="km-count km-count-btn"
              onClick={() => setShowAll((v) => !v)}
              title={showAll ? "Show the key moments only" : "Show every line of the transcript"}
            >
              {count}
            </button>
          ) : (
            <span className="km-count">{count}</span>
          ))}
      </header>

      <div className="transcript-body">
        {state === "empty" && <EmptyText>Upload a call recording to generate the transcript.</EmptyText>}
        {state === "loading" && (
          <div className="transcript-skeleton">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="km-row km-row-skeleton">
                <Skeleton lines={1} />
              </div>
            ))}
          </div>
        )}
        {state === "failed" && <EmptyText>No transcript is available for this recording.</EmptyText>}
        {state === "ready" && !spoken.length && <EmptyText>No speech was transcribed.</EmptyText>}
        {state === "ready" && q && !rows.length && <EmptyText>No line matches “{query.trim()}”.</EmptyText>}
        {state === "ready" && rows.length > 0 && <Rows rows={rows} order={order} currentTime={currentTime} onSeek={onSeek} listRef={listRef} />}
      </div>
    </section>
  );
}
