// Emotion overview built from the per-segment emotions the transcriber reports.
//
// Each transcript segment carries the emotion audible in its tone of voice and words ("neutral" when
// nothing is clearly audible). This module only aggregates those labels — it never invents emotions:
// shares are measured in speaking time, and the timeline merges consecutive segments of the same
// speaker and emotion.

const NEUTRAL = "neutral";
const MERGE_GAP_SECONDS = 6;

const share = (seconds, total) => (total > 0 ? Math.round((seconds / total) * 1000) / 1000 : 0);
const spoken = (s) => Math.max(0.5, (s.end ?? 0) - (s.start ?? 0)); // every line counts a little

function ranked(totals, total) {
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([emotion, seconds]) => ({ emotion, seconds: Math.round(seconds * 10) / 10, share: share(seconds, total) }));
}

/** Overview of emotions in a transcript (segments with start, end, speaker, emotion). */
export function summarize(segments) {
  const labelled = segments.filter((s) => s.emotion);
  if (!labelled.length) {
    return { available: false, reason: "No emotion labels were produced for this recording.", overall: [], by_speaker: {}, timeline: [] };
  }
  const totals = {};
  const bySpeaker = {};
  let total = 0;
  for (const s of labelled) {
    const d = spoken(s);
    total += d;
    totals[s.emotion] = (totals[s.emotion] ?? 0) + d;
    const who = s.speaker ?? "Unknown";
    bySpeaker[who] ??= { total: 0, totals: {} };
    bySpeaker[who].total += d;
    bySpeaker[who].totals[s.emotion] = (bySpeaker[who].totals[s.emotion] ?? 0) + d;
  }

  // Non-neutral moments, merged when the same speaker keeps the same emotion.
  const timeline = [];
  for (const s of labelled) {
    if (s.emotion === NEUTRAL) continue;
    const last = timeline[timeline.length - 1];
    if (last && last.emotion === s.emotion && last.speaker === s.speaker && s.start - last.end <= MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, s.end);
      last.lines += 1;
    } else {
      timeline.push({ emotion: s.emotion, speaker: s.speaker ?? null, start: s.start, end: s.end, lines: 1 });
    }
  }

  return {
    available: true,
    reason: null,
    overall: ranked(totals, total),
    by_speaker: Object.fromEntries(Object.entries(bySpeaker).map(([who, v]) => [who, ranked(v.totals, v.total)])),
    timeline,
  };
}
