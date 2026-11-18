// Pulse by person: what each person is interested in, from Pulse's evidence-backed signals.
//
// Signals are ordered by the time of their first evidence line; interest-raising signals count up,
// pain points and objections count down (`amp`), sized by the signal level.

const LEVEL = { high: 1, medium: 0.66, low: 0.36 };
const DIRECTION = {
  purchase_intent: 1, product_interest: 0.9, follow_up_interest: 0.8, feature_preference: 0.75,
  positive_feedback: 0.7, commitment: 0.8, competitor_mention: -0.3, question_concern: -0.45,
  pain_point: -0.6, negative_feedback: -0.75,
};
const OVERALL_LABEL = { 3: "High interest", 2: "Medium interest", 1: "Low interest", 0: "No clear interest" };
// Only these show buying interest; a commitment (e.g. the seller promising a demo) is a beat, not interest.
const INTEREST = new Set(["purchase_intent", "product_interest", "follow_up_interest", "feature_preference", "positive_feedback"]);

/**
 * Each person's interest level, what they are interested in, and their statements and concerns. `speakers` = everyone who spoke, in order; `duration` (audio) or
 * `lineCount` (chat) sets the time axis.
 */
export function pulseByPerson(pulseData, { speakers = [], duration = 0, lineCount = 0 } = {}) {
  const signals = pulseData?.signals ?? [];
  const order = [...speakers];
  for (const s of signals) if (!order.includes(s.person)) order.push(s.person);
  const span = duration > 0 ? duration : Math.max(1, lineCount - 1);
  const beats = signals
    .map((s) => {
      const ev = s.evidence?.[0];
      const t = duration > 0 ? ev?.start ?? 0 : ev?.id ?? 0;
      const dir = DIRECTION[s.category] ?? 0.5;
      return { signal: s, person: s.person, t, x: Math.min(1, Math.max(0, t / span)), amp: dir * (LEVEL[s.level] ?? 0.5) };
    })
    .sort((a, b) => a.t - b.t)
    .map((b, i) => ({ ...b, n: i + 1 }));
  const people = order.slice(0, 6).map((person) => {
    const mine = beats.filter((b) => b.person === person);
    const positive = mine.filter((b) => b.amp > 0);
    const top = Math.max(0, ...positive.filter((b) => INTEREST.has(b.signal.category)).map((b) => ({ high: 3, medium: 2, low: 1 })[b.signal.level] ?? 0));
    const committed = mine.some((b) => b.signal.category === "commitment");
    return {
      person,
      interest: top || !committed ? OVERALL_LABEL[top] : "Committed to a next step",
      level: top,
      beats: mine,
      interests: [...new Set(positive.filter((b) => INTEREST.has(b.signal.category)).map((b) => b.signal.subject))].slice(0, 5),
      statements: [...new Set(positive.map((b) => b.signal.context))].slice(0, 3),
      concerns: [...new Set(mine.filter((b) => b.amp < 0).map((b) => b.signal.context))].slice(0, 2),
    };
  });
  return { people, beats, span, timeAxis: duration > 0 };
}


