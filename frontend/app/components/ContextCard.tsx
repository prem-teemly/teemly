import { formatTime } from "../lib/api";
import { Body, Card, type CardProps } from "./AnalysisCards";
import { AlertIcon, ListIcon } from "./Icons";
import { TimeChip } from "./shared";

/**
 * The main context of the call: what it is about, what the people discussed (points, interests,
 * decisions, commitments, next steps), and each part of the conversation with the time it happened.
 * The PDF report shows the same saved context.
 */
export function ContextCard({ state, view, onSeek }: CardProps) {
  if (view?.source === "whatsapp") return null;
  const ctx = view?.context ?? null;
  const pending = state === "ready" && view && !ctx && !view.contextReason;

  return (
    <Card title="Main context" icon={<ListIcon size={16} />} count={ctx?.sections.length} className="context-card">
      <Body
        state={pending ? "loading" : state}
        hasData={!!ctx || !!view?.contextReason}
        emptyIdle="What the people discussed, and when, will appear here."
        emptyReady="No context is available for this recording."
        lines={4}
      >
        {ctx ? (
          <>
            {ctx.main_topic && <p className="summary-text context-topic">{ctx.main_topic}</p>}
            {ctx.overview && <p className="context-overview">{ctx.overview}</p>}

            {ctx.sections.length > 0 && (
              <>
                <h3 className="sub-title">
                  What was discussed, and when{view && view.duration > 0 ? ` · ${formatTime(view.duration)} call` : ""}
                </h3>
                <ol className="context-timeline">
                  {ctx.sections.map((s, i) => (
                    <li key={i} className="context-section">
                      <div className="context-section-head">
                        <TimeChip seconds={s.start} onSeek={onSeek} />
                        <span className="context-range">
                          {s.time_label} · {formatTime(s.end - s.start)} long
                        </span>
                      </div>
                      <p className="context-title">{s.title}</p>
                      <p className="context-summary">{s.summary}</p>
                      {s.speakers.length > 0 && <p className="context-who">{s.speakers.join(" · ")}</p>}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        ) : (
          <div className="notice-inline">
            <AlertIcon size={16} />
            <span>{view?.contextReason ?? "The context is not available for this recording."}</span>
          </div>
        )}
      </Body>
    </Card>
  );
}
