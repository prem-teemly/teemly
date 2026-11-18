import { formatTime } from "../lib/api";
import type { CallView } from "../lib/callView";
import { emotionLabel, emotionTone, isNotable } from "../lib/emotions";

type Props = {
  phase: "uploading" | "processing" | "completed";
  view: CallView | null;
  onSeek: (seconds: number) => void;
};

const BADGE_CLASS = { pos: "friendly", warn: "caution", neg: "negative", neutral: "neutral" } as const;

/**
 * Emotions detected in the recording (tone of voice and words, per transcript line). Replaces the
 * former fixed "Warm / Cautious / Friendly planning" placeholder with real, evidence-based data.
 */
export default function EmotionBanner({ phase, view, onSeek }: Props) {
  const emotions = view?.emotions ?? null;

  if (!emotions) {
    const lines = view?.transcript.filter((l) => isNotable(l.emotion)) ?? [];
    return (
      <div className="planning-banner" aria-live="polite">
        <div className="planning-title-row">
          <span className="planning-badge neutral">Emotions</span>
          {lines.slice(-3).map((l, i) => (
            <span key={i} className={`planning-badge ${BADGE_CLASS[emotionTone(l.emotion!)]}`}>
              {emotionLabel(l.emotion!)}
            </span>
          ))}
        </div>
        <p className="planning-copy">
          {phase === "completed"
            ? "No emotion information is available for this conversation."
            : "Listening for emotions in tone of voice and words…"}
        </p>
      </div>
    );
  }

  const notable = emotions.overall.filter((o) => isNotable(o.emotion)).slice(0, 4);
  const speakers = Object.entries(emotions.by_speaker)
    .map(([who, xs]) => {
      const top = xs.filter((x) => isNotable(x.emotion)).slice(0, 2).map((x) => emotionLabel(x.emotion).toLowerCase());
      return `${who}: ${top.length ? top.join(", ") : "neutral"}`;
    })
    .join(" · ");

  return (
    <div className="planning-banner" aria-live="polite">
      <div className="planning-title-row">
        {notable.length ? (
          notable.map((o) => (
            <span key={o.emotion} className={`planning-badge ${BADGE_CLASS[emotionTone(o.emotion)]}`} title={`${Math.round(o.share * 100)}% of speaking time`}>
              {emotionLabel(o.emotion)} · {Math.round(o.share * 100)}%
            </span>
          ))
        ) : (
          <span className="planning-badge neutral">Neutral tone</span>
        )}
      </div>
      <p className="planning-copy">{speakers}</p>
      {emotions.timeline.length > 0 && (
        <div className="emotion-moments">
          {emotions.timeline.slice(0, 8).map((m, i) => (
            <button
              key={i}
              type="button"
              className={`emotion-moment emotion-${emotionTone(m.emotion)}`}
              onClick={() => onSeek(m.start)}
              title="Play this moment"
            >
              {emotionLabel(m.emotion)}
              {m.speaker ? ` · ${m.speaker}` : ""} · {formatTime(m.start)}–{formatTime(m.end)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
