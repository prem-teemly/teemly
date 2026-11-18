import type { PulseCategory, PulseData, PulseEvidence, PulseSignal } from "../lib/api";
import { Body, Card, type CardProps, ItemList } from "./AnalysisCards";
import { AlertIcon, ArrowRightCircleIcon, PulseIcon } from "./Icons";
import { PulsePeople, pulseByPerson } from "./PulsePeople";
import { TimeChip, initials, speakerIndex } from "./shared";

const CATEGORY: Record<PulseCategory, { label: string; tone: "pos" | "neg" | "warn" | "neutral" }> = {
  product_interest: { label: "Product interest detected", tone: "pos" },
  purchase_intent: { label: "Purchase intent", tone: "pos" },
  feature_preference: { label: "Feature preference", tone: "pos" },
  follow_up_interest: { label: "Follow-up interest", tone: "pos" },
  positive_feedback: { label: "Positive feedback", tone: "pos" },
  pain_point: { label: "Pain point", tone: "neg" },
  negative_feedback: { label: "Negative feedback", tone: "neg" },
  question_concern: { label: "Question or concern", tone: "warn" },
  competitor_mention: { label: "Competitor mentioned", tone: "warn" },
  commitment: { label: "Commitment / next step", tone: "neutral" },
};

const TONE_PILL = { pos: "outcome-positive", neg: "outcome-negative", warn: "outcome-unresolved", neutral: "outcome-neutral" };

const OVERALL: Record<PulseData["overall_interest"], { label: string; cls: string }> = {
  high: { label: "High interest", cls: "outcome-positive" },
  medium: { label: "Medium interest", cls: "outcome-unresolved" },
  low: { label: "Low interest", cls: "outcome-neutral" },
  none: { label: "No product interest", cls: "outcome-neutral" },
  not_enough_evidence: { label: "Not enough evidence", cls: "outcome-neutral" },
};

const TAMIL = /[஀-௿]/;


/** Highlight the verified quote inside the real transcript line, when it appears verbatim. */
function Highlighted({ text, quote }: { text: string; quote: string | null }) {
  const at = quote ? text.indexOf(quote) : -1;
  if (!quote || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="pulse-mark">{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

function EvidenceLine({ e, quote, onSeek }: { e: PulseEvidence; quote: string | null; onSeek: (s: number) => void }) {
  const tamil = TAMIL.test(e.original);
  return (
    <blockquote className="pulse-evidence">
      <div className="pulse-evidence-meta">
        <span>{e.speaker ?? "Unknown"}</span>
        {e.start !== null ? <TimeChip seconds={e.start} onSeek={onSeek} /> : <span>{e.time_label}</span>}
      </div>
      <p className={tamil ? "tamil" : undefined} lang={tamil ? "ta" : undefined}>
        <Highlighted text={e.original} quote={quote} />
      </p>
      {e.english && e.english.trim().toLowerCase() !== e.original.trim().toLowerCase() && (
        <p className="pulse-evidence-en" lang="en">
          {e.english}
        </p>
      )}
    </blockquote>
  );
}

function SignalCard({ s, onSeek }: { s: PulseSignal; onSeek: (s: number) => void }) {
  const cat = CATEGORY[s.category];
  return (
    <li className="pulse-signal">
      <div className="pulse-signal-head">
        <span className="pulse-signal-title">{cat.label}</span>
        <span className={`outcome-pill ${TONE_PILL[cat.tone]}`}>{s.level[0].toUpperCase() + s.level.slice(1)}</span>
        <span className={`pulse-basis pulse-basis-${s.basis}`}>{s.basis === "explicit" ? "Explicit" : "Inferred"}</span>
      </div>
      <div className="pulse-person">
        <span className={`t-avatar spk-${speakerIndex(s.person)}`} aria-hidden="true">
          {initials(s.person)}
        </span>
        <span className="pulse-person-name">{s.person}</span>
        <span className="pulse-subject">· {s.subject}</span>
      </div>
      <p className="pulse-context">{s.context}</p>
      {s.evidence.map((e) => (
        <EvidenceLine key={e.id} e={e} quote={s.quote} onSeek={onSeek} />
      ))}
    </li>
  );
}


export function PulseCard({ state, view, onSeek }: CardProps) {
  const pulse = view?.pulse ?? null;
  // Who spoke (in order), so people are listed in the order they appear.
  const speakers = view ? (view.talk.length ? view.talk.map((t) => t.name) : [...new Set(view.transcript.map((l) => l.speaker).filter((x): x is string => !!x))]) : [];
  const { signals, people } = pulse ? pulseByPerson(pulse, speakers) : { signals: [], people: [] };
  const unavailable = state === "ready" && view && !pulse;
  const overall = pulse ? OVERALL[pulse.overall_interest] : null;

  return (
    <Card title="Pulse" icon={<PulseIcon size={16} />} count={signals.length} className="pulse-card">
      {unavailable ? (
        <div className="notice-inline">
          <AlertIcon size={16} />
          <span>{view.pulseReason ?? "Pulse is not available for this conversation."}</span>
        </div>
      ) : (
        <Body
          state={state}
          hasData={!!pulse}
          emptyIdle="Interests, intent and engagement signals from the conversation will appear here, with evidence."
          emptyReady="Not enough evidence"
          lines={4}
        >
          {pulse && overall && (
            <>
              <div className="pulse-overview">
                <span className={`outcome-pill ${overall.cls}`}>{overall.label}</span>
                <p className="summary-text">{pulse.overview}</p>
              </div>

              <h3 className="sub-title">What each person is interested in</h3>
              <PulsePeople people={people} />


              <h3 className="sub-title">Signals</h3>
              {signals.length ? (
                <ul className="pulse-signals">
                  {signals.map((s, i) => (
                    <SignalCard key={i} s={s} onSeek={onSeek} />
                  ))}
                </ul>
              ) : (
                <p className="empty-text">Not enough evidence</p>
              )}

              {pulse.recommended_actions.length > 0 && (
                <>
                  <h3 className="sub-title">Recommended follow-ups</h3>
                  <ItemList
                    items={pulse.recommended_actions.map((a) => ({
                      text: a.action,
                      meta: a.reason,
                      timestamp: a.evidence.find((e) => e.start !== null)?.start ?? null,
                    }))}
                    icon={<ArrowRightCircleIcon size={15} />}
                    onSeek={onSeek}
                  />
                </>
              )}
            </>
          )}
        </Body>
      )}
    </Card>
  );
}
