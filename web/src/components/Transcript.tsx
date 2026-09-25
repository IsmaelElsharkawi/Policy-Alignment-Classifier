import { useState } from "react";
import { callSignature, formatCost, humanize } from "../format";
import type { RecordedEvent } from "../types";
import { ActionTag, VerdictBadge } from "./VerdictBadge";

const PREVIEW_LINES = 6;

/** What "blocked" means depends on where in the trace the event sits. */
const BLOCKED_NOTE: Record<string, string> = {
  user_input: "Turn stopped — the agent did not act on this message.",
  tool_call: "Not executed — the tool was never called.",
  tool_response: "Withheld — this result was not passed to the agent.",
  model_output: "Withheld — this reply never reached the user.",
};

/** Claude Code–style transcript of an agent session, with the guardrail verdict on every step. */
export function Transcript({ events }: { events: RecordedEvent[] }) {
  return (
    <div className="transcript">
      {events.map((e) => (
        <EventRow key={e.id} rec={e} />
      ))}
    </div>
  );
}

function EventRow({ rec }: { rec: RecordedEvent }) {
  const [open, setOpen] = useState(false);
  const { event, classification: c } = rec;
  // No classification and no error = not checked (guard off, or every rule switched off here).
  const verdict = c?.verdict ?? (rec.classifier_error ? "error" : "unchecked");
  const blocked = rec.action === "blocked";

  return (
    <div className={`step step-${event.kind} ${blocked ? "is-blocked" : ""} ${verdict !== "allow" ? "is-flagged" : ""}`}>
      <div className="step-line">
        <div className="step-body">
          <StepContent rec={rec} />
        </div>
        <button className="guard" onClick={() => setOpen(!open)} aria-expanded={open} title="Guardrail verdict">
          <VerdictBadge verdict={verdict} />
          {rec.action !== "passed" && <ActionTag action={rec.action} />}
        </button>
      </div>
      {blocked && <div className="blocked-note">{BLOCKED_NOTE[event.kind]}</div>}
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
