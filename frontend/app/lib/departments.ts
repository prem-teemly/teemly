"use client";

import { useEffect, useState } from "react";
import { call } from "./people";

/** A department: the eight built-in ones plus the ones the owner adds in Settings. */
export type Dept = {
  id: string;
  slug: string;
  name: string;
  color: string;
  description: string | null;
  built_in: boolean;
  /** Optional goal set on the department's page, e.g. "Seed round" and 2 crore. */
  goal_label?: string | null;
  target_inr?: number | null;
  /** The dashboard the owner chose in Settings (null = from the name), and the one used. */
  view_type?: DeptView | null;
  view?: DeptView;
};
export type DeptWithCount = Dept & { people: number };

/** Department dashboards (Settings → Departments → Dashboard). */
export type DeptView = "investors" | "sales" | "partners" | "suppliers" | "tenders" | "standard";
export const DEPT_VIEWS: { value: DeptView; label: string; hint: string }[] = [
  { value: "investors", label: "Investors", hint: "Pipeline, weighted, committed, every investor's ticket" },
  { value: "sales", label: "Sales pipeline", hint: "Win rate, average deal, closing soon, stalled, customers" },
  { value: "partners", label: "Partners", hint: "Territories, onboarding, what each partner brings" },
  { value: "suppliers", label: "Suppliers", hint: "Quotes vs committed, deliveries and promises" },
  { value: "tenders", label: "Tenders & deadlines", hint: "Deadline countdown, tender value, officials" },
  { value: "standard", label: "Standard", hint: "People, opportunities and the funnel" },
];
/** The same guess the backend makes from a department's name (for a department not chosen yet). */
export function guessView(name: string): DeptView {
  const n = name.toLowerCase();
  if (/invest|investor|fund|capital|angel/.test(n)) return "investors";
  if (/tender|govt|government|public sector|bid/.test(n)) return "tenders";
  if (/vendor|supplier|procure|purchase|sourcing/.test(n)) return "suppliers";
  if (/partner|channel|distribut|dealer|reseller|franchise/.test(n)) return "partners";
  if (/sale|customer|client|business development|\bbd\b/.test(n)) return "sales";
  return "standard";
}

type DealRef = { id: string; title: string; person: { id: string; name: string; initials: string }; stage: string; value_inr: number | null; next_step: string | null; due_date: string | null };
/** What a department's dashboard needs beyond the totals (all counted from calls and deals). */
export type DeptExtras = {
  view: DeptView;
  win_rate: number | null;
  won_count: number;
  lost_count: number;
  avg_deal_inr: number | null;
  /** How many deals got at least as far as each stage. */
  reached: { stage: string; count: number }[];
  closing_soon: (DealRef & { days_left: number })[];
  deadlines: (DealRef & { days_left: number })[];
  stalled: (DealRef & { days_in_stage: number })[];
  quiet: { id: string; name: string; days: number; open_value_inr: number }[];
  cities: { city: string; known: boolean; people: number; open_value_inr: number }[];
  /** Person id -> who they introduced (anywhere in the room) and the open value that brought. */
  introduced: Record<string, { count: number; open_value_inr: number; names: string[] }>;
  commitments: { id: number; text: string; who: "you" | "them"; by: string | null; person: { id: string; name: string }; due_text: string | null; job_id: string; at: string | null }[];
  stage_since: Record<string, string | null>;
};

export type PersonCard = { id: string; name: string; initials: string; category: string | null; role_title: string | null; score: number | null };
export type DeptCard = Dept & {
  people: number;
  hot: number;
  warm: number;
  open_opportunities: number;
  open_value_inr: number;
  won_value_inr: number;
  new_this_week: number;
  key_people: PersonCard[];
  last_contact_at: string | null;
};
export type Overview = {
  total_people: number;
  departments: DeptCard[];
  sits_where: (PersonCard & { departments: string[] })[];
  facts: { department: string | null; text: string; value_inr: number | null }[];
};
export type DeptPerson = {
  id: string;
  name: string;
  initials: string;
  category: string | null;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  /** Interest 0-100; null = not clear yet. */
  score: number | null;
  consent: "Yes" | "No" | "Ask";
  introduced_by: { id: string; name: string } | null;
  last_contact_at: string | null;
  last_contact_kind: "audio" | "whatsapp" | "added";
  opportunities: number;
  open_value_inr: number;
  won_value_inr: number;
  stage: string | null;
  next_step: string | null;
  overdue?: boolean;
  due_date?: string | null;
  /** Interest in each conversation, oldest first (80 high, 60 some, 35 low). */
  interest_trend?: number[];
  interest_change?: number;
  conversations?: number;
  /** The latest conversation only talked about them: who was talking. */
  last_contact_via?: string | null;
};
export type DeptOpportunity = {
  id: string;
  person: { id: string; name: string; initials: string };
  title: string;
  stage: string;
  value_inr: number | null;
  next_step: string | null;
  due_date: string | null;
  origin: "ai" | "manual";
  source: { job_id: string; kind: "audio" | "whatsapp"; file_name: string; at: string } | null;
  chance?: number;
  created_at?: string | null;
  updated_at: string | null;
};
export type DeptDetail = {
  department: Dept;
  /** Older backends do not send it (the standard page is used). */
  extras?: DeptExtras;
  totals: {
    people: number;
    hot: number;
    open_opportunities: number;
    open_value_inr: number;
    won_value_inr: number;
    people_with_value: number;
    weighted_inr?: number;
    weighted_added_this_week_inr?: number;
    won_people?: number;
    closest?: { person: { id: string; name: string; initials: string }; stage: string; value_inr: number | null } | null;
  };
  stage_chance?: Record<string, number>;
  funnel: { stage: string; count: number; value_inr: number }[];
  people: DeptPerson[];
  opportunities: DeptOpportunity[];
  /** Counted facts (never guessed): who brings them in, the largest ticket, who is quiet. */
  insights?: string[];
};

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getDepartmentOverview = () => call<Overview>("/api/department-overview");
export const getDepartmentDetail = (slug: string) => call<DeptDetail>(`/api/department-pages/${encodeURIComponent(slug)}`);

// --------------------------------------------------------------- shared department list

/** Fallback while loading (and for an older backend): the eight built-in departments. */
export const BUILT_IN: Dept[] = [
  ["investment", "Investment", "#6c63f6"],
  ["sales", "Sales", "#2fae6a"],
  ["channel-partners", "Channel partners", "#18a7b5"],
  ["accounts", "Accounts", "#64748b"],
  ["marketing", "Marketing", "#e2507a"],
  ["tech-ai", "Tech & AI", "#3b82f6"],
  ["govt-tenders", "Govt tenders", "#d4891b"],
  ["vendors", "Vendors", "#9a6b4b"],
].map(([slug, name, color]) => ({ id: slug, slug, name, color, description: null, built_in: true }));

let cached: DeptWithCount[] | null = null;
let palette: string[] = [];
let inflight: Promise<DeptWithCount[]> | null = null;
const listeners = new Set<(d: DeptWithCount[]) => void>();

async function fetchDepartments(): Promise<DeptWithCount[]> {
  const r = await call<{ departments: DeptWithCount[]; palette: string[] }>("/api/departments");
  cached = r.departments;
  palette = r.palette ?? [];
  for (const l of listeners) l(cached);
  return cached;
}

/** Reload the list everywhere (after adding, changing or deleting a department, or new people). */
export function refreshDepartments(): Promise<DeptWithCount[]> {
  inflight = fetchDepartments().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** The current departments (with member counts), shared by every component; loads once. */
export function useDepartments(): { departments: DeptWithCount[]; loaded: boolean; palette: string[] } {
  const [list, setList] = useState<DeptWithCount[] | null>(cached);
  useEffect(() => {
    listeners.add(setList);
    if (!cached && !inflight) void refreshDepartments().catch(() => {});
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return { departments: list ?? BUILT_IN.map((d) => ({ ...d, people: 0 })), loaded: !!list, palette };
}

export const createDepartment = async (d: { name: string; color?: string; description?: string | null; view_type?: DeptView | null }) => {
  const r = await call<{ department: Dept }>("/api/departments", post(d));
  void refreshDepartments().catch(() => {});
  return r.department;
};
export const updateDepartment = async (id: string, d: { color?: string; description?: string | null; goal_label?: string | null; target_inr?: number | null; view_type?: DeptView | null }) => {
  const r = await call<{ department: Dept }>(`/api/departments/${id}`, post(d));
  void refreshDepartments().catch(() => {});
  return r.department;
};
export const deleteDepartment = async (id: string) => {
  await call<{ status: string }>(`/api/departments/${id}`, { method: "DELETE" });
  void refreshDepartments().catch(() => {});
};

/** Tag colours from a department's colour: tinted background, the colour as text. */
export function deptStyle(color: string | undefined): React.CSSProperties {
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#64748b";
  return { background: `${c}1f`, color: c };
}
