"use client";

import { useEffect, useState } from "react";

const PEAK_COUNT = 1200;

type Decoded = { file: File; peaks: number[] | null; error: string | null };

/** Decodes the selected file in the browser and returns normalised peak amplitudes (0-1). */
export function useWaveformPeaks(file: File | null) {
  const [decoded, setDecoded] = useState<Decoded | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    (async () => {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      try {
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        if (cancelled) return;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
        const block = Math.max(1, Math.floor(buffer.length / PEAK_COUNT));
        // Stride keeps long files fast; the max of a sampled window looks identical.
        const step = Math.max(1, Math.floor(block / 400));
        const peaks = new Array<number>(Math.min(PEAK_COUNT, buffer.length)).fill(0);
        for (let p = 0; p < peaks.length; p++) {
          let max = 0;
          const end = Math.min(buffer.length, (p + 1) * block);
          for (let i = p * block; i < end; i += step) {
            for (const ch of channels) {
              const v = Math.abs(ch[i]);
              if (v > max) max = v;
            }
          }
          peaks[p] = max;
        }
        const top = Math.max(...peaks, 1e-6);
        setDecoded({ file, peaks: peaks.map((v) => v / top), error: null });
      } catch {
        if (!cancelled) {
          setDecoded({ file, peaks: null, error: "This browser could not decode the audio for the waveform." });
        }
      } finally {
        ctx.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  // Results for a previous file are ignored, so no reset is needed when the file changes.
  const current = file && decoded?.file === file ? decoded : null;
  return {
    peaks: current?.peaks ?? null,
    error: current?.error ?? null,
    loading: !!file && !current,
  };
}
