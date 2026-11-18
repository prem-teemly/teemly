import { type Department, type Stage, call } from "./people";

/** One card on the opportunity panel (backend: GET /api/opportunity-board). */
export type BoardOpportunity = {
  id: string;
  title: string;
  stage: Stage;
  /** Chance of closing at this stage (0-1). */
  chance: number;
  department: Department | null;
  value_inr: number | null;
  next_step: string | null;
  due_date: string | null;
  overdue: boolean;
  origin: "ai" | "manual";
  person: {
    id: string;
    name: string;
    initials: string;
    category: string | null;
    role_title: string | null;
    organisation: string | null;
    city: string | null;
    score: number | null; // interest; null = not clear yet
    last_contact_at: string | null;
    last_contact_kind: "audio" | "whatsapp" | "added";
  };
  source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; at: string } | null;
  stage_since: string | null;
  /** The stage it was in before its latest move (e.g. Negotiation, when moved back to In discussion). */
  came_from?: { stage: Stage; at: string | null } | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
};

/** Something that has stalled: what was seen, and the move it suggests (the owner decides). */
export type Nudge = { opportunity_id: string; kind: "overdue" | "quiet" | "committed" | "stalled"; text: string; move_to: Stage | null };

export type Board = { stages: { stage: Stage; chance: number; open: boolean }[]; opportunities: BoardOpportunity[]; nudges: Nudge[] };

export const getBoard = () => call<Board>("/api/opportunity-board");

// ------------------------------------------------------------- one opportunity's page

export type InsightEvidence = { job_id: string; line_id: number; speaker: string | null; time_label: string | null; start: number | null; text: string; english: string | null };
/** The AI's view of a deal ("Will it work out?"), from the calls and chats with the person. */
export type Insight = {
  data: {
    factors: { label: string; level: "high" | "medium" | "low"; reason: string; evidence: InsightEvidence[] }[];
    would_change: string | null;
    suggested_chance_pct: number | null;
    details: { instrument: string | null; decision_by: string | null; expected: string | null };
  };
  based_on: string[];
  model: string | null;
  created_at: string | null;
  /** A newer call or chat with the person exists: refresh to read it. */
  stale: boolean;
};

export type OpportunityPage = {
  opportunity: {
    id: string;
    person_id: string;
    title: string;
    stage: Stage;
    department: Department | null;
    value_inr: number | null;
    chance_pct: number | null;
    chance: number;
    stage_chance: number;
    next_step: string | null;
    due_date: string | null;
    source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; duration_seconds: number | null; at: string } | null;
    origin: "ai" | "manual";
    evidence: { id: number; speaker: string | null; time_label: string | null; start: number | null; text: string; english: string | null }[];
    closed_at: string | null;
    created_at: string;
    updated_at: string;
  };
  person: {
    id: string;
    name: string;
    initials: string;
    category: string | null;
    role_title: string | null;
    organisation: string | null;
    city: string | null;
    score: number | null; // interest; null = not clear yet
    first_seen_at: string | null;
    last_contact_at: string | null;
    introduced_by: { id: string; name: string } | null;
  };
  department: { name: string; slug: string; color: string } | null;
  stages: { stage: Stage; chance: number }[];
  history: { from: Stage | null; to: Stage; by: "owner" | "ai"; source_job_id: string | null; at: string }[];
  conversations: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; duration_seconds: number | null; at: string; relation: "participant" | "mentioned"; context: string; quote: string | null }[];
  path: { id: string | null; name: string; initials: string; owner?: boolean }[];
  insight: Insight | null;
  can_analyse: boolean;
};

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const getOpportunityPage = (id: string) => call<OpportunityPage>(`/api/opportunities/${encodeURIComponent(id)}`);
export const refreshInsight = (id: string) => call<{ insight: Insight }>(`/api/opportunities/${encodeURIComponent(id)}/insight`, { method: "POST" }).then((r) => r.insight);
/** Accept a chance for this deal (0-100), or null to go back to the stage's chance. */
export const setChance = (id: string, pct: number | null) => call<{ opportunity: { chance: number; chance_pct: number | null } }>(`/api/opportunities/${encodeURIComponent(id)}`, post({ chance_pct: pct })).then((r) => r.opportunity);

/** Open (not Won or Lost) totals: count, value, and weighted value (value × chance). */
export function totals(opps: Pick<BoardOpportunity, "stage" | "value_inr" | "chance">[]) {
  const open = opps.filter((o) => o.stage !== "Won" && o.stage !== "Lost");
  return {
    count: open.length,
    value: open.reduce((s, o) => s + (o.value_inr ?? 0), 0),
    weighted: Math.round(open.reduce((s, o) => s + (o.value_inr ?? 0) * o.chance, 0)),
  };
}
