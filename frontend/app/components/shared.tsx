import { formatTime } from "../lib/api";

export type PanelState = "empty" | "loading" | "ready" | "failed";

const SPEAKER_COLORS = 6;

export function speakerIndex(speaker: string | null): number {
  if (!speaker) return 0;
  const label = speaker.match(/^(?:speaker|person)\s*(\d+)$/i);
  if (label) return ((parseInt(label[1], 10) - 1) % SPEAKER_COLORS) + 1;
  // Named senders (WhatsApp): a stable colour per name.
  let h = 0;
  for (const ch of speaker) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % SPEAKER_COLORS) + 1;
}

export function initials(name: string): string {
  const numbered = name.match(/^(?:speaker|person)\s*(\d+)$/i);
  if (numbered) return `P${numbered[1]}`;
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** Clickable timestamp chip that seeks the player. Renders nothing without a timestamp. */
export function TimeChip({ seconds, onSeek }: { seconds?: number | null; onSeek: (s: number) => void }) {
  if (seconds === null || seconds === undefined) return null;
  return (
    <button type="button" className="time-chip" onClick={() => onSeek(seconds)} aria-label={`Play from ${formatTime(seconds)}`}>
      {formatTime(seconds)}
    </button>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="empty-text">{children}</p>;
}
