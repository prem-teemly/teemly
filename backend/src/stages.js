// The stages of an opportunity, in order, and how likely a deal at each stage is to close. One place
// for the whole backend: the opportunity panel, the weighted pipeline, department pages, the AI and
// validation all read these (migration 014).
//
//   Identified -> First contact -> In discussion -> Pitch / bid shared -> Negotiation -> Committed -> Won
//   Lost is a closed stage outside the flow.

export const STAGES = ["Identified", "First contact", "In discussion", "Pitch / bid shared", "Negotiation", "Committed", "Won", "Lost"];
/** Open stages, in order (the panel's columns are these plus Won). */
export const OPEN_STAGES = ["Identified", "First contact", "In discussion", "Pitch / bid shared", "Negotiation", "Committed"];
export const CLOSED_STAGES = ["Won", "Lost"];

/** Chance of closing at each stage: weighted pipeline = value × chance. */
export const STAGE_CHANCE = {
  Identified: 0.1,
  "First contact": 0.2,
  "In discussion": 0.3,
  "Pitch / bid shared": 0.5,
  Negotiation: 0.7,
  Committed: 0.9,
  Won: 1,
  Lost: 0,
};

/** Stages the AI may set from a conversation (Won and Lost are only ever set by the owner). */
export const AI_STAGES = OPEN_STAGES;

/** Old stage names (before migration 014) read as their new names. */
const RENAMED = { Proposal: "Pitch / bid shared" };
export const normalizeStage = (s) => RENAMED[s] ?? s;

/** Position in the flow (Lost counts as the start, so it never looks "further" than an open deal). */
export const stageIndex = (s) => (s === "Lost" ? -1 : STAGES.indexOf(normalizeStage(s)));
