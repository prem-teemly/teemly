import type { CallView, Item } from "../lib/callView";
import {
  ActivityIcon,
  AlertIcon,
  ArrowRightCircleIcon,
  BuildingIcon,
  CheckCircleIcon,
  FlagIcon,
  SparkleIcon,
  TrendDownIcon,
  TrendUpIcon,
  UserPlusIcon,
} from "./Icons";
import { EmptyText, type PanelState, Skeleton, TimeChip, initials } from "./shared";

export type CardProps = { state: PanelState; view: CallView | null; onSeek: (s: number) => void };

export function Card({
  title,
  icon,
  count,
  className = "",
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card side-card ${className}`} aria-label={title}>
      <header className="card-head">
        <span className="card-icon">{icon}</span>
        <h2 className="card-title">{title}</h2>
        {count !== undefined && count > 0 && <span className="count-badge">{count}</span>}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Shared empty / loading / failed handling; renders `children` only when data is ready. */
export function Body({
  state,
  hasData,
  emptyReady,
  emptyIdle,
  lines = 3,
  children,
}: {
  state: PanelState;
  hasData: boolean;
  emptyReady: string;
  emptyIdle: string;
  lines?: number;
  children: React.ReactNode;
}) {
  if (state === "loading") return <Skeleton lines={lines} />;
  if (state === "empty") return <EmptyText>{emptyIdle}</EmptyText>;
  if (state === "failed") return <EmptyText>Not available for this recording.</EmptyText>;
  if (!hasData) return <EmptyText>{emptyReady}</EmptyText>;
  return <>{children}</>;
}

function BulletList({ title, items, onSeek }: { title: string; items: Item[]; onSeek: (s: number) => void }) {
  if (!items.length) return null;
  return (
    <>
      <h3 className="sub-title">{title}</h3>
      <ul className="bullet-list">
        {items.map((p, i) => (
          <li key={i}>
            <span>{p.text}</span>
            <TimeChip seconds={p.timestamp} onSeek={onSeek} />
          </li>
        ))}
      </ul>
    </>
  );
}

export function ItemList({ items, icon, onSeek, tone }: { items: Item[]; icon: React.ReactNode; onSeek: (s: number) => void; tone?: string }) {
  return (
    <ul className="item-list">
      {items.map((it, i) => (
        <li key={i} className={`item ${tone ? `item-${tone}` : ""}`}>
          <span className="item-icon">{icon}</span>
          <div className="item-content">
            <p className="item-text">{it.text}</p>
            {it.meta && <p className="item-meta">{it.meta}</p>}
          </div>
          <TimeChip seconds={it.timestamp} onSeek={onSeek} />
        </li>
      ))}
    </ul>
  );
}

export function SummaryCard({ state, view, onSeek }: CardProps) {
  const unavailable = state === "ready" && view && !view.analysisAvailable;
  return (
    <Card title="Summary" icon={<SparkleIcon size={16} />} className="summary-card">
      {unavailable ? (
        <div className="notice-inline">
          <AlertIcon size={16} />
          <span>{view.analysisReason ?? "Conversation analysis is not available for this call."}</span>
        </div>
      ) : (
        <Body
          state={state}
          hasData={!!view?.summary || !!view?.keyPoints.length}
          emptyIdle="A short summary of the conversation will appear here."
          emptyReady="No summary was produced."
          lines={4}
        >
          {view?.purpose && (
            <p className="summary-text">
              <strong>Purpose: </strong>
              {view.purpose}
            </p>
          )}
          {view?.summary && <p className="summary-text">{view.summary}</p>}
          {view && (
            <>
              <BulletList title="Key discussion points" items={view.keyPoints} onSeek={onSeek} />
              <BulletList title="Problems discussed" items={view.problems} onSeek={onSeek} />
              {view.finalSummary && (
                <>
                  <h3 className="sub-title">Final summary</h3>
                  <p className="summary-text">{view.finalSummary}</p>
                </>
              )}
              <BulletList title="Key takeaways" items={view.takeaways} onSeek={onSeek} />
              {view.qualityNote && (
                <div className="notice-inline">
                  <AlertIcon size={16} />
                  <span>{view.qualityNote}</span>
                </div>
              )}
            </>
          )}
        </Body>
      )}
    </Card>
  );
}

export function CommitmentsCard({ state, view, onSeek }: CardProps) {
  const decisions = view?.decisions ?? [];
  const actions = view?.actionItems ?? [];
  const followUps = view?.followUps ?? [];
  const total = decisions.length + actions.length + followUps.length;
  return (
    <Card title="Decisions, actions and follow-ups" icon={<CheckCircleIcon size={16} />} count={total}>
      <Body
        state={state}
        hasData={total > 0}
        emptyIdle="Decisions, action items and next steps from the conversation will appear here."
        emptyReady="No decisions, action items or follow-ups were found."
      >
        {decisions.length > 0 && (
          <>
            <h3 className="sub-title">Decisions</h3>
            <ItemList items={decisions} icon={<CheckCircleIcon size={15} />} onSeek={onSeek} />
          </>
        )}
        {actions.length > 0 && (
          <>
            <h3 className="sub-title">Action items</h3>
            <ItemList items={actions} icon={<ArrowRightCircleIcon size={15} />} onSeek={onSeek} />
          </>
        )}
        {followUps.length > 0 && (
          <>
            <h3 className="sub-title">Follow-ups</h3>
            <ItemList items={followUps} icon={<FlagIcon size={15} />} onSeek={onSeek} />
          </>
        )}
      </Body>
    </Card>
  );
}

export function SignalsCard({ state, view, onSeek }: CardProps) {
  const pos = view?.positiveSignals ?? [];
  const neg = view?.negativeSignals ?? [];
  return (
    <Card title="Signals" icon={<ActivityIcon size={16} />} count={pos.length + neg.length}>
      <Body
        state={state}
        hasData={pos.length + neg.length > 0}
        emptyIdle="Positive and negative signals will appear here."
        emptyReady="No signals were detected."
      >
        {pos.length > 0 && <ItemList items={pos} icon={<TrendUpIcon size={15} />} onSeek={onSeek} tone="pos" />}
        {neg.length > 0 && <ItemList items={neg} icon={<TrendDownIcon size={15} />} onSeek={onSeek} tone="neg" />}
      </Body>
    </Card>
  );
}

export function PeopleCard({ state, view, onSeek }: CardProps) {
  const people = view?.people ?? [];
  const companies = view?.companies ?? [];
  return (
    <Card title="New Person" icon={<UserPlusIcon size={16} />} count={people.length}>
      <Body
        state={state}
        hasData={people.length + companies.length > 0}
        emptyIdle="People and companies mentioned in the call will appear here."
        emptyReady="No new people were mentioned."
        lines={2}
      >
        {people.length > 0 && (
          <ul className="people-list">
            {people.map((p, i) => (
              <li key={i} className="person">
                <span className="person-avatar">{initials(p.name)}</span>
                <div className="item-content">
                  <p className="person-name">{p.name}</p>
                  {(p.role || p.company) && (
                    <p className="item-meta">{[p.role, p.company].filter(Boolean).join(" · ")}</p>
                  )}
                  {p.context && <p className="person-context">{p.context}</p>}
                </div>
                <TimeChip seconds={p.timestamp} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        )}
        {companies.length > 0 && (
          <div className="chips">
            {companies.map((c) => (
              <span key={c} className="chip">
                <BuildingIcon size={13} />
                {c}
              </span>
            ))}
          </div>
        )}
      </Body>
    </Card>
  );
}

const OUTCOME_LABEL = { positive: "Positive", neutral: "Neutral", negative: "Negative", unresolved: "Unresolved" };

export function OutcomeCard({ state, view, onSeek }: CardProps) {
  const o = view?.outcome ?? null;
  return (
    <Card title="Outcome" icon={<FlagIcon size={16} />}>
      <Body
        state={state}
        hasData={!!o}
        emptyIdle="The call outcome will appear here."
        emptyReady="No clear outcome was identified."
        lines={2}
      >
        {o && (
          <div className="outcome">
            <div className="outcome-head">
              <span className={`outcome-pill outcome-${o.status}`}>{OUTCOME_LABEL[o.status]}</span>
              <span className="outcome-label">{o.label}</span>
              <TimeChip seconds={o.timestamp} onSeek={onSeek} />
            </div>
            {o.description && <p className="outcome-desc">{o.description}</p>}
          </div>
        )}
      </Body>
    </Card>
  );
}
