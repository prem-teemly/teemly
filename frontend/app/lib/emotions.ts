/** Display helpers for the per-line emotions detected from tone of voice and words. */

export type EmotionTone = "pos" | "warn" | "neg" | "neutral";

const TONE: Record<string, EmotionTone> = {
  friendly: "pos",
  happy: "pos",
  excited: "pos",
  interested: "pos",
  calm: "pos",
  hesitant: "warn",
  concerned: "warn",
  confused: "warn",
  frustrated: "neg",
  angry: "neg",
  sad: "neg",
  neutral: "neutral",
};

export const emotionTone = (emotion: string): EmotionTone => TONE[emotion] ?? "neutral";

export const emotionLabel = (emotion: string): string => (emotion ? emotion[0].toUpperCase() + emotion.slice(1) : "");

/** Emotions worth showing on a line (neutral lines get no tag). */
export const isNotable = (emotion: string | null | undefined): emotion is string => !!emotion && emotion !== "neutral";
