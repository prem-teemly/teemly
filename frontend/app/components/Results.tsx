import type { AnalysisResult, Segment } from "../lib/api";
import { formatTime } from "../lib/api";

const SPEAKER_COLORS = 8;

function speakerClass(speaker: string | null): string {
  if (!speaker) return "spk spk-none";
  const n = parseInt(speaker.replace(/\D/g, ""), 10) || 1;
  return `spk spk-${((n - 1) % SPEAKER_COLORS) + 1}`;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

function Unavailable({ title, reason }: { title: string; reason: string | null }) {
  return (
    <div className="notice notice-warn" role="status">
      <strong>{title}</strong>
      <span>{reason ?? "No reason was given."}</span>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="bullets">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

function Value({ v }: { v: string | null }) {
  return v ? <>{v}</> : <span className="na">Not stated</span>;
}

function SegmentList({ segments, lang }: { segments: Segment[]; lang: "ta" | "en" }) {
  if (!segments.length) return <Empty>No speech was transcribed.</Empty>;
  return (
    <ol className="segments">
      {segments.map((s, i) => (
        <li key={i} className="segment">
          <div className="segment-meta">
            <span className="time">
              {formatTime(s.start)}–{formatTime(s.end)}
            </span>
            <span className={speakerClass(s.speaker)}>{s.speaker ?? "Unknown"}</span>
            {s.warning && (
              <span className="seg-warning" title={s.warning}>
                ⚠ Unclear
              </span>
            )}
          </div>
          <p lang={lang} className={lang === "ta" ? "tamil" : undefined}>
            {s.text || <span className="na">(no text)</span>}
          </p>
          {s.warning && <p className="seg-warning-text">{s.warning}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function Results({ result }: { result: AnalysisResult }) {
  const a = result.analysis.data;
  const coveredPct = result.audio_duration_seconds
    ? Math.min(100, Math.round((result.coverage.last_segment_end_seconds / result.audio_duration_seconds) * 100))
    : 0;

  return (
    <div className="results">
      <div className="facts">
        <div>
          <span className="fact-label">Audio length</span>
          <span className="fact-value">{formatTime(result.audio_duration_seconds)}</span>
        </div>
        <div>
          <span className="fact-label">Transcribed up to</span>
          <span className="fact-value">
            {formatTime(result.coverage.last_segment_end_seconds)} ({coveredPct}%)
          </span>
        </div>
        <div>
          <span className="fact-label">People</span>
          <span className="fact-value">{result.speakers.available ? result.speakers.count : "Unavailable"}</span>
        </div>
        <div>
          <span className="fact-label">Engines</span>
          <span className="fact-value small">
            {result.transcription_model}
            {result.analysis.available ? ` · ${result.analysis.model}` : ""}
          </span>
        </div>
      </div>

      {/* Meeting analysis */}
      {!result.analysis.available || !a ? (
        <Section title="Meeting analysis">
          <Unavailable title="Meeting analysis unavailable." reason={result.analysis.reason} />
        </Section>
      ) : (
        <>
          {a.transcript_quality_note && (
            <div className="notice notice-info" role="note">
              <strong>Transcript quality:</strong>
              <span>{a.transcript_quality_note}</span>
            </div>
          )}
          <Section title="Meeting summary">
            <p className="summary">{a.summary}</p>
            <dl className="kv">
              <dt>Purpose</dt>
              <dd>
                <Value v={a.purpose} />
              </dd>
            </dl>
          </Section>

          <Section title="Discussion topics" count={a.topics.length}>
            <BulletList items={a.topics} empty="No distinct topics identified." />
          </Section>

          <Section title="Important points" count={a.important_points.length}>
            <BulletList items={a.important_points} empty="No important points identified." />
          </Section>

          {a.key_context.length > 0 && (
            <Section title="Key context" count={a.key_context.length}>
              <BulletList items={a.key_context} empty="" />
            </Section>
          )}

          <Section title="Decisions" count={a.decisions.length}>
            {a.decisions.length ? (
              <ul className="cards">
                {a.decisions.map((d, i) => (
                  <li key={i} className="card">
                    <p className="card-title">{d.decision}</p>
                    <p className="card-meta">
                      Made by: <Value v={d.made_by} />
                    </p>
                    <p className="evidence">“{d.evidence}”</p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No decisions were found in this meeting.</Empty>
            )}
          </Section>

          <Section title="Action items" count={a.action_items.length}>
            {a.action_items.length ? (
              <div className="table-wrap">
                <table className="actions">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Responsible</th>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.action_items.map((t, i) => (
                      <tr key={i}>
                        <td data-label="Task">
                          <span className="task">{t.task}</span>
                          <span className="evidence">“{t.evidence}”</span>
                          {t.uncertain && <span className="uncertain">Uncertain: {t.uncertain}</span>}
                        </td>
                        <td data-label="Responsible">
                          <Value v={t.responsible_person} />
                        </td>
                        <td data-label="Date">
                          <Value v={t.date} />
                        </td>
                        <td data-label="Time">
                          <Value v={t.time} />
                        </td>
                        <td data-label="Deadline">
                          <Value v={t.deadline} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No action items were found in this meeting.</Empty>
            )}
          </Section>
        </>
      )}

      {/* Transcripts */}
      <Section title="Transcript by person" count={result.tamil_segments.length}>
        {!result.speakers.available && (
          <Unavailable title="Identifying who spoke is unavailable." reason={result.speakers.reason} />
        )}
        <SegmentList segments={result.tamil_segments} lang="ta" />
      </Section>

      <Section title="Tamil transcript">
        {result.tamil_transcript ? (
          <p lang="ta" className="tamil transcript">
            {result.tamil_transcript}
          </p>
        ) : (
          <Empty>No Tamil speech was transcribed.</Empty>
        )}
      </Section>

      <Section title="English translation">
        {result.english_translation ? (
          <>
            <p className="transcript">{result.english_translation}</p>
            <details className="details">
              <summary>English translation with timestamps ({result.english_segments.length} segments)</summary>
              <SegmentList segments={result.english_segments} lang="en" />
            </details>
          </>
        ) : (
          <Empty>No English translation was produced.</Empty>
        )}
      </Section>

      <p className="footnote">
        {result.coverage.note} Processing time:{" "}
        {Object.entries(result.timings_seconds)
          .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}s`)
          .join(" · ")}
        .
      </p>
    </div>
  );
}
