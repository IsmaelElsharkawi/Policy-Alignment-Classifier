import { Fragment, useState } from "react";
import { callSignature, formatCost, humanize } from "../format";
import { FAILURE_LABEL, POSITION, failureType, guardVerdict, type Mark, type Recording } from "../scenario";
import { VERDICTS, type RecordedEvent, type Verdict } from "../types";
import { ActionTag, VerdictBadge } from "./VerdictBadge";

const PREVIEW_LINES = 6;

/** What "blocked" means depends on where in the trace the event sits. */
const BLOCKED_NOTE: Record<string, string> = {
  user_input: "Turn stopped — the agent did not act on this message.",
  tool_call: "Not executed — the tool was never called.",
  tool_response: "Withheld — this result was not passed to the agent.",
  model_output: "Withheld — this reply never reached the user.",
};

/** While a scenario is being recorded: which events can be marked, and how to mark them. */
export interface Marking {
  recording: Recording;
  onMark: (eventId: string, mark: Mark | null) => void;
}

/** Claude Code–style transcript of an agent session, with the guardrail verdict on every step. */
export function Transcript({ events, marking }: { events: RecordedEvent[]; marking?: Marking }) {
  return (
    <div className="transcript">
      {events.map((e, i) => (
        <Fragment key={e.id}>
          {marking && i > 0 && i === marking.recording.fromIndex && (
            <div className="record-start">● recording starts here</div>
          )}
          <EventRow rec={e} marking={marking && i >= marking.recording.fromIndex ? marking : undefined} />
        </Fragment>
      ))}
    </div>
  );
}

function EventRow({ rec, marking }: { rec: RecordedEvent; marking?: Marking }) {
  const [open, setOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);
  const mark = marking?.recording.marks[rec.id];
  const { event, classification: c } = rec;
  // No classification and no error = not checked (guard off, or every rule switched off here).
  const verdict = c?.verdict ?? (rec.classifier_error ? "error" : "unchecked");
  const blocked = rec.action === "blocked";

  return (
    <div
      className={`step step-${event.kind} ${blocked ? "is-blocked" : ""} ${verdict !== "allow" ? "is-flagged" : ""} ${mark ? "is-marked" : ""}`}
    >
      <div className="step-line">
        <div className="step-body">
          <StepContent rec={rec} />
        </div>
        {marking && !markOpen && (
          <button
            className={`mark-btn ${mark ? "active" : ""}`}
            onClick={() => setMarkOpen(true)}
            title={mark ? "Edit this failure mark" : `Mark a guardrail failure on this ${POSITION[event.kind]}`}
          >
            ⚑ {mark ? "Edit mark" : "Mark failure"}
          </button>
        )}
        <button className="guard" onClick={() => setOpen(!open)} aria-expanded={open} title="Guardrail verdict">
          <VerdictBadge verdict={verdict} />
          {rec.action !== "passed" && <ActionTag action={rec.action} />}
        </button>
      </div>
      {blocked && <div className="blocked-note">{BLOCKED_NOTE[event.kind]}</div>}
      {mark && !markOpen && <MarkNote rec={rec} mark={mark} />}
      {marking && markOpen && (
        <MarkForm
          rec={rec}
          mark={mark}
          onSave={(m) => {
            marking.onMark(rec.id, m);
            setMarkOpen(false);
          }}
          onCancel={() => setMarkOpen(false)}
        />
      )}
      {open && (
        <div className="guard-detail">
          {c ? (
            <>
              <div className="guard-tags">
                <span className="kind-tag">{event.kind}</span>
                {c.category && <span className="cat">{humanize(c.category)}</span>}
                {c.rules.map((r) => (
                  <code key={r}>{r}</code>
                ))}
              </div>
              <p>{c.rationale}</p>
              {c.overridden && (
                <p className="override-note">
                  Classifier said <strong>{c.overridden.verdict}</strong> ({c.overridden.rules.join(", ")}); overridden
                  because {c.overridden.switched_off.join(", ")} {c.overridden.switched_off.length === 1 ? "is" : "are"} switched off
                  for {event.kind} in the Rules tab.
                </p>
              )}
              {c.evidence && <blockquote className="evidence">{c.evidence}</blockquote>}
              <div className="guard-meta">
                {c.meta.model} · {Math.round(c.meta.latency_ms)} ms · {c.meta.input_tokens ?? "—"} in /{" "}
                {c.meta.output_tokens ?? "—"} out · {formatCost(c.meta.cost_usd)}
              </div>
            </>
          ) : (
            <p className="field-error">{rec.classifier_error ?? "Classifier returned no result."}</p>
          )}
        </div>
      )}
    </div>
  );
}

function MarkNote({ rec, mark }: { rec: RecordedEvent; mark: Mark }) {
  const type = failureType(rec, mark.expected);
  return (
    <div className="mark-note">
      <span className="mark-flag">⚑</span> Guard failed on this {POSITION[rec.event.kind]}
      {type && <> — {FAILURE_LABEL[type]}</>}: should be <VerdictBadge verdict={mark.expected} />
      {mark.note && <span className="mark-text">{mark.note}</span>}
    </div>
  );
}

/** Pick the verdict the event should have had; the guard's own verdict isn't a failure. */
function MarkForm({
  rec,
  mark,
  onSave,
  onCancel,
}: {
  rec: RecordedEvent;
  mark?: Mark;
  onSave: (mark: Mark | null) => void;
  onCancel: () => void;
}) {
  const got = guardVerdict(rec);
  const [expected, setExpected] = useState<Verdict>(mark?.expected ?? (got === "allow" ? "violation" : "allow"));
  const [note, setNote] = useState(mark?.note ?? "");
  const type = failureType(rec, expected);
  const c = rec.classification;

  return (
    <form
      className="mark-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (type) onSave({ expected, note: note.trim() });
      }}
    >
      <div className="mark-form-head">
        <strong>Guardrail failure on this {POSITION[rec.event.kind]}</strong>
        <span className="hint">
          The guard said{" "}
          {c ? <VerdictBadge verdict={c.verdict} /> : <VerdictBadge verdict={rec.classifier_error ? "error" : "unchecked"} />}{" "}
          and the event was {rec.action}.
        </span>
      </div>
      <div className="mark-form-row">
        <span>It should have been</span>
        <div className="segmented" role="radiogroup" aria-label="Expected verdict">
          {VERDICTS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={expected === v}
              className={expected === v ? "active" : ""}
              disabled={v === got}
              title={v === got ? "That is what the guard did" : undefined}
              onClick={() => setExpected(v)}
            >
              {v.replace("_", " ")}
            </button>
          ))}
        </div>
        {type && <span className={`failure-type failure-${type}`}>{FAILURE_LABEL[type]}</span>}
      </div>
      <textarea
        rows={2}
        value={note}
        placeholder="What went wrong? (optional, saved with the scenario)"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mark-form-actions">
        <button type="submit" className="primary" disabled={!type}>
          {mark ? "Update mark" : "Mark failure"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {mark && (
          <button type="button" className="ghost danger" onClick={() => onSave(null)}>
            Remove mark
          </button>
        )}
      </div>
    </form>
  );
}

function StepContent({ rec }: { rec: RecordedEvent }) {
  const { event } = rec;
  switch (event.kind) {
    case "user_input":
      return (
        <div className="user-msg">
          <span className="prompt-mark">&gt;</span>
          <span className="pre">{event.content}</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="tool-call">
          <span className="dot">●</span>
          <span className="pre">{callSignature(event)}</span>
        </div>
      );
    case "tool_response":
      return (
        <div className="tool-result">
          <span className="elbow">⎿</span>
          <Collapsible text={event.content ?? ""} />
        </div>
      );
    case "model_output":
      return (
        <div className="assistant-msg">
          <span className="dot">●</span>
          <span className="pre">{event.content}</span>
        </div>
      );
  }
}

function Collapsible({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > PREVIEW_LINES;
  return (
    <span className="pre">
      {expanded || !long ? text : lines.slice(0, PREVIEW_LINES).join("\n")}
      {long && (
        <button className="link expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? "show less" : `… +${lines.length - PREVIEW_LINES} lines`}
        </button>
      )}
    </span>
  );
}
