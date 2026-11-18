"use client";

import { formatClock } from "../lib/api";
import type { CallView, Item } from "../lib/callView";
import { CommitmentsCard, SummaryCard } from "./AnalysisCards";
import { ContextCard } from "./ContextCard";
import EmotionBanner from "./EmotionBanner";
import { CheckIcon, SparkleIcon, UserPlusIcon } from "./Icons";
import { PulseCard } from "./PulseCard";
import { type PanelState, Skeleton } from "./shared";

type Props = { state: PanelState; view: CallView | null; onSeek: (s: number) => void };

/** Clickable time of the moment something was said (plays the recording from there). */
function Chip({ seconds, onSeek }: { seconds?: number | null; onSeek: (s: number) => void }) {
  if (seconds === null || seconds === undefined) return null;
  return (
    <button type="button" className="rr-chip" onClick={() => onSeek(seconds)} aria-label={`Play from ${formatClock(seconds)}`}>
      {formatClock(seconds)}
    </button>
  );
}

/** Loading / empty / unavailable states shared by the cards. */
function Pending({ state, empty, ready }: { state: PanelState; empty: string; ready: string }) {
  if (state === "loading") return <Skeleton lines={2} />;
  return <p className="rr-empty">{state === "ready" ? ready : state === "failed" ? "Not available for this recording." : empty}</p>;
}

function Summary({ state, view }: Props) {
  const text = view?.finalSummary ?? view?.summary ?? null;
  return (
    <section className="rr-card rr-summary" aria-label="Summary">
      <p className="rr-summary-label">
        <SparkleIcon size={13} /> Summary
      </p>
      {state === "ready" && view && !view.analysisAvailable ? (
        <p className="rr-empty">{view.analysisReason ?? "The summary is not available for this call."}</p>
      ) : state === "ready" && text ? (
        <p className="rr-summary-text">{text}</p>
      ) : (
        <Pending state={state} empty="A short summary of the conversation will appear here." ready="No summary was produced." />
      )}
    </section>
  );
}

function Commitments({ state, view, onSeek }: Props) {
  const items: Item[] = view?.commitments ?? [];
  return (
    <section className="rr-card" aria-label="Commitments and follow-ups">
      <h2 className="rr-title">Commitments → follow-ups</h2>
      {state === "ready" && items.length ? (
        <ul className="rr-commitments">
          {items.map((c, i) => (
            <li key={i}>
              <CheckIcon size={16} className="rr-check" />
              <span className="rr-commit-text">
                {c.text}
                {c.meta ? ` · ${c.meta}` : ""}
              </span>
              <Chip seconds={c.timestamp} onSeek={onSeek} />
            </li>
          ))}
        </ul>
      ) : (
        <Pending state={state} empty="Promises and agreed next steps will appear here." ready="No commitments or follow-ups were found." />
      )}
    </section>
  );
}

function Signals({ state, view, onSeek }: Props) {
  const pos = view?.positiveSignals ?? [];
  const neg = view?.negativeSignals ?? [];
  return (
    <section className="rr-card" aria-label="Signals">
      <h2 className="rr-title">Signals</h2>
      {state === "ready" && pos.length + neg.length ? (
        <ul className="rr-signals">
          {[...pos.map((s) => ["+", s] as const), ...neg.map((s) => ["−", s] as const)].map(([sign, s], i) => (
            <li key={i}>
              <span className={`rr-sign ${sign === "+" ? "rr-sign-pos" : "rr-sign-neg"}`} aria-label={sign === "+" ? "Positive" : "Negative"}>
                {sign}
              </span>
              <span className="rr-signal-text">{s.text}</span>
              <Chip seconds={s.timestamp} onSeek={onSeek} />
            </li>
          ))}
        </ul>
      ) : (
        <Pending state={state} empty="Interest and concern signals will appear here." ready="No signals were detected." />
      )}
    </section>
  );
}

function NewPeople({ state, view, onSeek }: Props) {
  if (state !== "ready" || !view?.people.length) return null;
  return (
    <>
      {view.people.map((p, i) => (
        <section key={i} className="rr-card rr-person" aria-label="New person mentioned">
          <span className="rr-person-avatar" aria-hidden="true">
            <UserPlusIcon size={15} />
          </span>
          <div className="rr-person-main">
            <p className="rr-person-name" title={p.name}>
              {p.name}
            </p>
            <p className="rr-person-sub">
              {p.timestamp != null && (
                <button type="button" className="rr-link" onClick={() => onSeek(p.timestamp!)}>
                  Mentioned at {formatClock(p.timestamp)}
                </button>
              )}
              {p.context ? ` · ${p.context}` : ""}
            </p>
          </div>
          <button type="button" className="rr-add" aria-disabled="true" title="Saving contacts is not available yet">
            <UserPlusIcon size={15} /> Add
          </button>
        </section>
      ))}
    </>
  );
}

function Outcome({ state, view }: Props) {
  const interest = view?.interest ?? [];
  return (
    <section className="rr-card rr-outcome" aria-label="Outcome">
      {state === "ready" && interest.length ? (
        <p className="rr-outcome-row">
          <span className="rr-outcome-label">Outcome</span>
          {interest.map((p) => (
            <span key={p.person} className={`rr-outcome-item ${p.level >= 3 ? "rr-high" : "rr-mid"}`}>
              {p.person}: {p.label.replace(/ interest$/, "")}
            </span>
          ))}
        </p>
      ) : (
        <>
          <span className="rr-outcome-label">Outcome</span>
          <Pending state={state} empty="Each person's interest will appear here." ready={view?.pulseReason ?? "No clear interest was found."} />
        </>
      )}
    </section>
  );
}

/** The analysis beside the transcript: the short cards first, then the full analysis (always shown). */
export default function RightRail(props: Props) {
  return (
    <div className="side-column">
      <Summary {...props} />
      <Commitments {...props} />
      <Signals {...props} />
      <NewPeople {...props} />
      <Outcome {...props} />
      {props.state === "ready" && props.view && (
        <>
          <ContextCard {...props} />
          {props.view.source === "audio" && <EmotionBanner phase="completed" view={props.view} onSeek={props.onSeek} />}
          <PulseCard {...props} />
          <SummaryCard {...props} />
          <CommitmentsCard {...props} />
        </>
      )}
    </div>
  );
}
