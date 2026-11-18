import type { PulseData, PulseSignal } from "../lib/api";
import { speakerIndex } from "./shared";

/*
 * Pulse by person: what each person is interested in, in plain words, from Pulse's evidence-backed
 * signals. Same rules as the PDF report (backend/src/services/pulseWave.js).
 */

const DIRECTION: Record<PulseSignal["category"], number> = {
  purchase_intent: 1, product_interest: 0.9, follow_up_interest: 0.8, feature_preference: 0.75,
  positive_feedback: 0.7, commitment: 0.8, competitor_mention: -0.3, question_concern: -0.45,
  pain_point: -0.6, negative_feedback: -0.75,
};
const OVERALL = ["No clear interest", "Low interest", "Medium interest", "High interest"];
const RANK = { high: 3, medium: 2, low: 1 } as const;
// Only these show buying interest; a commitment (e.g. the seller promising a demo) is not interest.
const INTEREST = new Set<PulseSignal["category"]>(["purchase_intent", "product_interest", "follow_up_interest", "feature_preference", "positive_feedback"]);

export type PersonPulse = { person: string; level: number; label: string; interests: string[]; statements: string[]; concerns: string[] };

/** Signals in time order (first evidence line), and each person's interest. */
export function pulseByPerson(pulse: PulseData, speakers: string[]) {
  const signals = [...pulse.signals].sort((a, b) => (a.evidence[0]?.start ?? a.evidence[0]?.id ?? 0) - (b.evidence[0]?.start ?? b.evidence[0]?.id ?? 0));
  const order = [...speakers];
  for (const s of signals) if (!order.includes(s.person)) order.push(s.person);
  const people: PersonPulse[] = order
    .map((person) => {
      const mine = signals.filter((s) => s.person === person);
      const up = mine.filter((s) => DIRECTION[s.category] > 0);
      const interest = up.filter((s) => INTEREST.has(s.category));
      const level = Math.max(0, ...interest.map((s) => RANK[s.level]));
      const committed = mine.some((s) => s.category === "commitment");
      return {
        person,
        level,
        label: level || !committed ? OVERALL[level] : "Committed to a next step",
        interests: [...new Set(interest.map((s) => s.subject))].slice(0, 5),
        statements: [...new Set(up.map((s) => s.context))].slice(0, 3),
        concerns: [...new Set(mine.filter((s) => DIRECTION[s.category] < 0).map((s) => s.context))].slice(0, 2),
      };
    })
    .filter((p) => p.statements.length || p.concerns.length);
  return { signals, people };
}

export function PulsePeople({ people }: { people: PersonPulse[] }) {
  if (!people.length) return null;
  return (
    <ul className="pulse-people">
      {people.map((p) => (
        <li key={p.person} className="pulse-people-row">
          <div className="pulse-people-head">
            <span className="pulse-dot" style={{ background: `var(--spk-${speakerIndex(p.person)})` }} aria-hidden="true" />
            <span className="pulse-person-name">{p.person}</span>
            <span className={`outcome-pill ${p.level >= 3 ? "outcome-positive" : p.level === 2 ? "outcome-unresolved" : "outcome-neutral"}`}>
              {p.label}
            </span>
          </div>
          {p.interests.length > 0 && (
            <p className="pulse-statement">
              <strong>Interested in:</strong> {p.interests.join(", ")}
            </p>
          )}
          {p.statements.map((t) => (
            <p key={t} className="pulse-statement">
              {t}
            </p>
          ))}
          {p.concerns.map((t) => (
            <p key={t} className="pulse-statement pulse-concern">
              {t}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}
