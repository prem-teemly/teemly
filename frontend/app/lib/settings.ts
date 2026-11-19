import { call } from "./people";

/** How this room is set up (read-only; the values are changed in backend/.env). */
export type RoomSettings = {
  storage: { provider: "local" | "oci"; region: string | null };
  /** 0 = recordings are kept until deleted. */
  retention_hours: number;
  ai: { provider: string; transcribe_model: string; text_model: string; location: string };
  database: { connected: boolean; migrations: number | null };
  /** signup: who can create an account (open = anyone, restricted = SIGNUP_ALLOWED, closed = nobody new). */
  login: { enabled: boolean; method?: "email"; code_delivery: "console" | "email"; session_days: number; signup?: "open" | "restricted" | "closed" };
  upload: { audio_formats: string[]; max_audio_mb: number };
};

export const getSettings = () => call<RoomSettings>("/api/settings");

/** "Until you delete them", "48 hours", "30 days", "12 months". */
export function retentionLabel(hours: number): string {
  if (!hours) return "Until you delete them";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  if (days % 30 === 0 && days >= 60) return `${days / 30} months`;
  return `${days} days`;
}
