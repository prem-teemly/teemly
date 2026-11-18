"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "../lib/api";
import { emotionLabel, emotionTone } from "../lib/emotions";
import type { AudioPlayer } from "../lib/useAudioPlayer";
import { PauseIcon, PlayIcon } from "./Icons";

export type PlayerStatus =
  | { kind: "idle" }
  | { kind: "uploading" | "processing"; label: string; progress: number }
  | { kind: "completed" }
  | { kind: "failed"; message: string };

/** A transcript line with the emotion heard in it (colours the waveform). */
export type EmotionSpan = { start: number; end: number; emotion?: string | null };

type Props = {
  player: AudioPlayer;
  src: string | null;
  peaks: number[] | null;
  peaksLoading: boolean;
  peaksError: string | null;
  /** Lines of the transcript with their emotion; empty until the transcript exists. */
  lines: EmotionSpan[];
};

type Mood = "warm" | "cautious" | "calm";
const MOOD_OF = (emotion: string | null | undefined): Mood => {
  const t = emotionTone(emotion ?? "neutral");
  return t === "pos" ? "warm" : t === "warn" || t === "neg" ? "cautious" : "calm";
};
const MOOD_VAR: Record<Mood, [string, string]> = {
  warm: ["--wave-warm", "#0f8b8d"],
  cautious: ["--wave-cautious", "#eda23c"],
  calm: ["--wave-calm", "#5fb8b9"],
};

const BAR_W = 3;
const BAR_GAP = 3;

function cssVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Max-pool the peaks into `count` bars. */
function bucket(peaks: number[], count: number): number[] {
  if (count <= 0) return [];
  const out = new Array<number>(count).fill(0);
  const ratio = peaks.length / count;
  for (let i = 0; i < count; i++) {
    const s = Math.floor(i * ratio);
    const e = Math.max(s + 1, Math.floor((i + 1) * ratio));
    let m = 0;
    for (let j = s; j < e && j < peaks.length; j++) m = Math.max(m, peaks[j]);
    out[i] = m;
  }
  return out;
}

/** Legend from the real emotions: each mood heard, its emotions, and (for cautious) its longest stretch. */
function legendOf(lines: EmotionSpan[]) {
  const by: Record<Mood, { secs: Map<string, number>; first: number | null; stretches: [number, number][] }> = {
    warm: { secs: new Map(), first: null, stretches: [] },
    cautious: { secs: new Map(), first: null, stretches: [] },
    calm: { secs: new Map(), first: null, stretches: [] },
  };
  let prevMood: Mood | null = null;
  for (const l of lines) {
    const mood = MOOD_OF(l.emotion);
    const b = by[mood];
    const name = l.emotion && l.emotion !== "neutral" ? l.emotion : "neutral";
    b.secs.set(name, (b.secs.get(name) ?? 0) + Math.max(0, l.end - l.start));
    if (b.first === null) b.first = l.start;
    const last = b.stretches.at(-1);
    if (prevMood === mood && last) last[1] = l.end;
    else b.stretches.push([l.start, l.end]);
    prevMood = mood;
  }
  return (["warm", "cautious", "calm"] as Mood[])
    .filter((m) => by[m].first !== null)
    .map((mood) => {
      const names = [...by[mood].secs].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 2);
      const label = names.map((n, i) => (i === 0 ? emotionLabel(n) : n)).join(", ");
      const longest = [...by[mood].stretches].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
      return {
        mood,
        label: mood === "cautious" && longest ? `${label} (${formatClock(longest[0])}–${formatClock(longest[1])})` : label,
        seekTo: mood === "cautious" && longest ? longest[0] : (by[mood].first ?? 0),
      };
    });
}

export default function WaveformPlayer({ player, src, peaks, peaksLoading, peaksError, lines }: Props) {
  const { audioRef, currentTime, duration, playing, toggle, seek } = player;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const legend = useMemo(() => legendOf(lines), [lines]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const colour: Record<Mood, string> = {
      warm: cssVar(canvas, ...MOOD_VAR.warm),
      cautious: cssVar(canvas, ...MOOD_VAR.cautious),
      calm: cssVar(canvas, ...MOOD_VAR.calm),
    };
    const idle = cssVar(canvas, "--wave-idle", "#c9d3dc");
    const head = cssVar(canvas, "--wave-playhead", "#14213d");
    const count = Math.floor((width + BAR_GAP) / (BAR_W + BAR_GAP));
    const bars = peaks ? bucket(peaks, count) : new Array<number>(count).fill(0);
    const mid = height / 2;
    let li = 0;
    for (let i = 0; i < count; i++) {
      const x = i * (BAR_W + BAR_GAP);
      const t = duration > 0 ? ((i + 0.5) / count) * duration : 0;
      // The line playing at this moment (lines are in time order).
      while (li < lines.length - 1 && lines[li].end < t) li++;
      const line = lines.length && t >= lines[li].start - 1 && t <= lines[li].end + 1 ? lines[li] : null;
      ctx.fillStyle = !lines.length ? (peaks ? colour.calm : idle) : colour[MOOD_OF(line?.emotion)];
      const h = Math.max(3, bars[i] * height * 0.8);
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, BAR_W, h, 1.5);
      ctx.fill();
    }
    if (duration > 0 && (progress > 0 || playing)) {
      ctx.fillStyle = head;
      ctx.fillRect(Math.min(width - 3, progress * width), 0, 3, height);
    }
    if (hoverX !== null) {
      ctx.fillStyle = head;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(hoverX, 0, 1, height);
      ctx.globalAlpha = 1;
    }
  }, [peaks, width, progress, hoverX, lines, duration, playing]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect || !duration) return;
      seek(((clientX - rect.left) / rect.width) * duration);
    },
    [duration, seek],
  );

  const canPlay = !!src && duration > 0;

  function onKeyDown(e: React.KeyboardEvent) {
    if (!canPlay) return;
    if (e.key === "ArrowRight") seek(currentTime + 5);
    else if (e.key === "ArrowLeft") seek(currentTime - 5);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(duration);
    else if (e.key === " ") toggle();
    else return;
    e.preventDefault();
  }

  return (
    <section className="card player" aria-label="Call recording">
      {src && <audio ref={audioRef} src={src} preload="metadata" />}

      <button type="button" className="play-btn" onClick={toggle} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      </button>

      <div className="player-main">
        <div
          ref={wrapRef}
          className={`wave ${canPlay ? "wave-active" : ""} ${peaksLoading ? "wave-loading" : ""}`}
          role="slider"
          tabIndex={canPlay ? 0 : -1}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration)}`}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            if (!canPlay) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromEvent(e.clientX);
          }}
          onPointerMove={(e) => {
            if (!canPlay) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setHoverX(e.clientX - rect.left);
            if (dragging.current) seekFromEvent(e.clientX);
          }}
          onPointerUp={() => (dragging.current = false)}
          onPointerLeave={() => setHoverX(null)}
        >
          <canvas ref={canvasRef} className="wave-canvas" />
          {!src && <span className="wave-placeholder">Upload a call recording to see its waveform</span>}
          {peaksError && <span className="wave-placeholder">{peaksError}</span>}
        </div>

        <div className="player-times" aria-hidden="true">
          <span>{formatClock(currentTime)}</span>
          <span>{duration > 0 ? formatClock(duration) : ""}</span>
        </div>

        {legend.length > 0 && (
          <ul className="player-legend" aria-label="Emotions heard in the call">
            {legend.map((l) => (
              <li key={l.mood}>
                <button type="button" className="legend-item" onClick={() => canPlay && seek(l.seekTo, true)} title={canPlay ? "Play from here" : undefined}>
                  <span className={`legend-swatch legend-${l.mood}`} aria-hidden="true" />
                  {l.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
