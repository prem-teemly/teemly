import { type Department, type Stage, call } from "./people";

/** The Today page (backend: GET /api/today). */
export type TodayData = {
  owner: string | null;
  since: string;
  analysed: { calls: number; chats: number };
  numbers: {
    open_opportunities: number;
    hot: number;
    new_opportunities: number;
    investor_pipeline_inr: number;
    investor_weighted_inr: number;
    investors: number;
    follow_ups: number;
    overdue: number;
    referrals: number;
    referrals_top_via: { name: string; count: number } | null;
  };
  top: {
    id: string;
    title: string;
    stage: Stage;
    department: Department | null;
    value_inr: number | null;
    chance: number;
    rank: number;
    urgency: string | null;
    overdue: boolean;
    due_date: string | null;
    next_step: string | null;
    reason: { speaker: string | null; time_label: string | null; text: string } | null;
    person: { id: string; name: string; initials: string; score: number | null };
  }[];
  /** progress: 0 … 1. */
  live: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; status: "queued" | "processing" | "completed" | "failed"; stage_label: string; progress: number; error: string | null; person_id: string | null; finished_seconds_ago: number | null }[];
  investor_heat: { id: string; name: string; initials: string; score: number | null; change: number; open_value_inr: number }[];
  follow_ups: {
    kind: "deal" | "commitment";
    id: string | number;
    text: string;
    who: "you" | "them";
    by?: string | null;
    /** Who they are (role, company, city), to know who to contact. */
    person: { id: string; name: string; role_title?: string | null; organisation?: string | null; city?: string | null; category?: string | null } | null;
    due_date: string | null;
    due_text: string | null;
    overdue: boolean;
    deal?: string;
    /** Why (a deal's next step): the deal it moves on. */
    deal_info?: { title: string; value_inr: number | null; stage: Stage; department: Department | null };
    job_id?: string;
    /** Why (a promise from a call): the call it was said in. */
    source?: { file_name: string | null; at: string | null };
  }[];
  /** All open deals (top shows the first page; ask getTopOpportunities(offset) for more). */
  top_total?: number;
  top_has_more?: boolean;
  /** More follow-ups than the first page: ask getFollowUps(offset). */
  follow_ups_has_more?: boolean;
  referrals: { id: string; name: string; via: { id: string; name: string } }[];
  pipeline: { name: string; slug: string; color: string; open_value_inr: number; open: number }[];
  /** The opportunity panel's nudges (facts from the data, most important first). */
  attention: { opportunity_id: string; kind: "overdue" | "quiet" | "committed" | "stalled"; text: string; move_to: Stage | null; title: string | null; person: { id: string; name: string } | null }[];
  /** AI views already made on opportunity pages (never made by this page). */
  insights: {
    items: {
      id: string;
      title: string;
      stage: Stage;
      value_inr: number | null;
      person: { id: string; name: string };
      chance: number;
      suggested_chance_pct: number | null;
      /** (AI chance − current chance) × value, in rupees: negative = at risk; null without a number. */
      impact_inr?: number | null;
      would_change: string | null;
      factor: { label: string; level: string; reason: string } | null;
      at: string | null;
      stale: boolean;
    }[];
    total: number;
    /** More than the first page: ask getInsights(offset). */
    has_more?: boolean;
    not_read: number;
    not_read_top: { id: string; title: string; person: { id: string; name: string }; value_inr: number | null }[];
  };
  /** Departments with a target (set in Settings). */
  goals: { name: string; slug: string; color: string; goal_label: string | null; target_inr: number; open_value_inr: number; weighted_inr: number; won_value_inr: number; open: number }[];
  department_facts: { department: string | null; text: string }[];
  /** Net stage change per deal in the period. */
  moves: {
    items: { id: string; title: string; value_inr: number | null; person: { id: string; name: string }; from: Stage; to: Stage; by: "owner" | "ai"; steps: number; direction: "forward" | "back" | "lost"; at: string }[];
    total: number;
    forward: number;
    back: number;
    unchanged: number;
  };
  inbox: { people: number; people_names: string[]; departments: number; department_names: string[] };
};

export const getToday = (since: string) => call<TodayData>(`/api/today?since=${encodeURIComponent(since)}`);

/** A page of follow-ups (paged on the server, like notifications). */
export type FollowUpPage = { items: TodayData["follow_ups"]; total: number; overdue: number; has_more: boolean; offset: number };
export const getFollowUps = (offset: number, limit = 5) => call<FollowUpPage>(`/api/follow-ups?offset=${offset}&limit=${limit}`);

/** A page of top opportunities (ranked and paged on the server). */
export type TopPage = { items: TodayData["top"]; total: number; has_more: boolean; offset: number };
export const getTopOpportunities = (offset: number, limit = 5) => call<TopPage>(`/api/top-opportunities?offset=${offset}&limit=${limit}`);

/** A page of AI insights (at-risk deals first, then the biggest rupee change; ordered on the server). */
export type InsightPage = { items: TodayData["insights"]["items"]; total: number; has_more: boolean; offset: number };
export const getInsights = (offset: number, limit = 4) => call<InsightPage>(`/api/insights?offset=${offset}&limit=${limit}`);

/** Start of today, or of the last 7 days, in the browser's time zone (as ISO). */
export function startOf(range: "today" | "week"): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "week") d.setDate(d.getDate() - 6);
  return d.toISOString();
}
