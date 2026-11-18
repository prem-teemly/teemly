"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Playback state for one <audio> element; currentTime updates every frame while playing. */
export function useAudioPlayer(src: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // A new source starts loading: reset playback state.
    const onLoadStart = () => {
      setCurrentTime(0);
      setDuration(0);
      setPlaying(false);
    };
    el.addEventListener("loadstart", onLoadStart);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(el.currentTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    return () => {
      el.removeEventListener("loadstart", onLoadStart);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
    };
  }, [src]);

  // Smooth progress while playing (timeupdate only fires ~4x per second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [src]);

  const seek = useCallback((seconds: number, play = false) => {
    const el = audioRef.current;
    if (!el) return;
    const max = Number.isFinite(el.duration) ? el.duration : seconds;
    el.currentTime = Math.max(0, Math.min(max, seconds));
    setCurrentTime(el.currentTime);
    if (play && el.paused) el.play().catch(() => setPlaying(false));
  }, []);

  // With no source the <audio> element is unmounted; never expose stale values.
  return src
    ? { audioRef, currentTime, duration, playing, toggle, seek }
    : { audioRef, currentTime: 0, duration: 0, playing: false, toggle, seek };
}

export type AudioPlayer = ReturnType<typeof useAudioPlayer>;
