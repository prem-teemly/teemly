import { type Category, type Stage, call } from "./people";

// The referral network (backend: GET /api/network).

export type NetNode = {
  id: string;
  name: string;
  initials: string;
  category: Category | null;
  role_title: string | null;
  organisation: string | null;
  city: string | null;
  departments: string[];
  /** Interest 0-100; null = not clear yet. */
  score: number | null;
  /** Who introduced them (someone in People), or null: known to the owner directly. */
  introduced_by: string | null;
  /** 1 = known directly, 2 = introduced by a level-1 person, … */
  level: number;
  /** How many people they introduced. */
  introduced: number;
  stage: Stage | null;
  deal: { id: string; title: string; value_inr: number | null } | null;
  open_value_inr: number;
  weighted_inr: number;
  first_seen_at: string;
};
export type Connector = {
  id: string;
  name: string;
  initials: string;
  departments: string[];
  direct: number;
  second_level: number;
  active: number;
  value_inr: number;
  introduced: { id: string; name: string }[];
};
export type Thanks = {
  id: number;
  person: { id: string; name: string };
  connector: { id: string; name: string };
  opportunity: { id: string; title: string };
  from: Stage;
  to: Stage;
  by: "owner" | "ai";
  at: string;
};
export type Network = { owner: string; nodes: NetNode[]; connectors: Connector[]; thanks: Thanks[] };

export const getNetwork = () => call<Network>("/api/network");
