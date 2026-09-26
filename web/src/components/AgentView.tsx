import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { FAILURE_LABEL, POSITION, failureType, type Mark, type Recording } from "../scenario";
import type { AgentInfo, Mode, RecordedEvent, ScenarioSummary } from "../types";
import { Transcript } from "./Transcript";
import { VerdictBadge } from "./VerdictBadge";

/**
 * Chat with the guarded agent. Every trace event the agent produces is classified
 * on the request path and streamed back with its verdict.
 */
export function AgentView({ onActivity }: { onActivity?: () => void }) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RecordedEvent[]>([]);
  const [mode, setMode] = useState<Mode>("enforce");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Scenario recording: marks live here until the scenario is saved to bench/user_scenarios.
  const [recording, setRecording] = useState<Recording | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState<ScenarioSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.policy().then((p) => setAgent(p.agent), () => setAgent(null));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length, running]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || running) return;
    setInput("");
    setError(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let id = sessionId;
      if (!id) {
        id = (await api.createSession(mode)).id;
        setSessionId(id);
      }
      for await (const msg of api.sendMessage(id, content, mode, ctrl.signal)) {
        if (msg.type === "event") setEvents((prev) => [...prev, msg.data]);
        else if (msg.type === "error") setError(msg.detail);
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onActivity?.();
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setSessionId(null);
    setEvents([]);
    setError(null);
  };

  const startRecording = () => {
    setRecording({ fromIndex: events.length, marks: {} });
    setSaved(null);
  };

  const onMark = (eventId: string, mark: Mark | null) =>
    setRecording((r) => {
      if (!r) return r;
      const marks = { ...r.marks };
      if (mark) marks[eventId] = mark;
      else delete marks[eventId];
      return { ...r, marks };
    });

  const recorded = recording ? events.slice(recording.fromIndex) : [];
  const nMarked = recording ? Object.keys(recording.marks).length : 0;

  const flagged = events.filter((e) => e.classification?.verdict !== "allow").length;
  const blocked = events.filter((e) => e.action === "blocked").length;

  return (
    <div className="agent">
      <div className="agent-bar">
        <div className="segmented" role="radiogroup" aria-label="Guardrail mode">
          {(["enforce", "monitor"] as Mode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => setMode(m)}
              disabled={running}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="hint mode-hint">
          {mode === "enforce"
            ? "Violations are stopped before they take effect."
            : "Everything runs; verdicts are only recorded."}
        </span>
        <span className="session-stats">
          {events.length} events · {flagged} flagged · {blocked} blocked
        </span>
        <div className="agent-actions">
          {recording ? (
            <>
              <span className="rec-indicator" role="status">
                <span className="rec-dot" aria-hidden>●</span> Recording · {recorded.length} events · {nMarked} marked
              </span>
              <button className="ghost" onClick={() => setSaveOpen(true)} disabled={saveOpen}>
                Stop &amp; save
              </button>
            </>
          ) : (
            <button
              className="ghost"
              onClick={startRecording}
              title="Record this session as a user scenario and mark where the guardrail fails"
            >
              <span className="rec-dot" aria-hidden>●</span> Record scenario
            </button>
          )}
          <button
            className="ghost"
            onClick={reset}
            disabled={(!events.length && !sessionId) || !!recording}
            title={recording ? "Save or discard the recording first" : undefined}
          >
            New session
          </button>
        </div>
      </div>

      <div className="agent-scroll">
        {events.length === 0 && !running ? (
          <div className="empty">
            <p className="welcome">
              <span className="dot">✻</span> {agent?.label ?? "Agent"}
              {agent &&
                (agent.tools.length ? (
                  <>
                    {" "}
                    — tools:{" "}
                    {agent.tools.map((t, i) => (
                      <span key={t}>
                        {i > 0 && ", "}
                        <code>{t}</code>
                      </span>
                    ))}
                  </>
                ) : (
                  " — no tools: chat only"
                ))}
            </p>
            <p className="hint">
              Each step the agent takes is judged by the policy classifier. Click a verdict to see why.
            </p>
            <div className="suggestions">
              {(agent?.suggestions ?? []).map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Transcript events={events} marking={recording ? { recording, onMark } : undefined} />
        )}
        {running && (
          <div className="working">
            <span className="spinner">✻</span> Working…
          </div>
        )}
        {error && <div className="card error">{error}</div>}
        {saved && <SavedNote summary={saved} onDismiss={() => setSaved(null)} />}
        <div ref={bottomRef} />
      </div>

      {recording && saveOpen && (
        <SavePanel
          sessionId={sessionId}
          events={recorded}
          marks={recording.marks}
          running={running}
          onSaved={(summary) => {
            setRecording(null);
            setSaveOpen(false);
            setSaved(summary);
          }}
          onKeepRecording={() => setSaveOpen(false)}
          onDiscard={() => {
            setRecording(null);
            setSaveOpen(false);
          }}
        />
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <span className="prompt-mark">&gt;</span>
        <textarea
          rows={1}
          value={input}
          placeholder={`Ask the ${(agent?.label ?? "agent").toLowerCase()}…  (Enter to send, Shift+Enter for newline)`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {running ? (
          <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

/** Stop a recording: name it, review the marked failures, and write it to bench/user_scenarios. */
function SavePanel({
  sessionId,
  events,
  marks,
  running,
  onSaved,
  onKeepRecording,
  onDiscard,
}: {
  sessionId: string | null;
  events: RecordedEvent[];
  marks: Record<string, Mark>;
  running: boolean;
  onSaved: (summary: ScenarioSummary) => void;
  onKeepRecording: () => void;
  onDiscard: () => void;
}) {
  const firstPrompt = events.find((e) => e.event.kind === "user_input")?.event.content ?? "";
  const [title, setTitle] = useState(firstPrompt.split("\n")[0].slice(0, 80));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const marked = events.filter((e) => marks[e.id]);
  const types = marked.map((e) => failureType(e, marks[e.id].expected));
  const nMiss = types.filter((t) => t === "miss").length;
  const nFp = types.filter((t) => t === "false_positive").length;

  const save = async () => {
    if (!sessionId || !events.length) return;
    setSaving(true);
    setError(null);
    try {
      const summary = await api.saveScenario({
        session_id: sessionId,
        from_seq: events[0].seq,
        title: title.trim(),
        notes: notes.trim(),
        marks: marked.map((e) => ({ event_id: e.id, ...marks[e.id] })),
      });
      onSaved(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card scenario-panel">
      <div className="scenario-head">
        <strong>Save scenario</strong>
        <span className="hint">
          {events.length} events recorded · {marked.length} failure{marked.length === 1 ? "" : "s"} marked
          {marked.length > 0 && ` (${nMiss} missed, ${nFp} false positive${nFp === 1 ? "" : "s"})`}
        </span>
      </div>
      <input value={title} placeholder="Scenario title" onChange={(e) => setTitle(e.target.value)} aria-label="Scenario title" />
      <textarea
        rows={2}
        value={notes}
        placeholder="Notes: what you were testing, anything a reader should know (optional)"
        onChange={(e) => setNotes(e.target.value)}
        aria-label="Scenario notes"
      />
      {marked.length > 0 ? (
        <ul className="scenario-marks">
          {marked.map((e, i) => {
            const t = types[i];
            return (
              <li key={e.id}>
                <span className="kind-tag">{POSITION[e.event.kind]}</span> {t ? FAILURE_LABEL[t] : "?"} — should be{" "}
                <VerdictBadge verdict={marks[e.id].expected} />
                {marks[e.id].note && <span className="mark-text">{marks[e.id].note}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hint">
          No failures marked. The scenario is saved as a session where the guard got every recorded event right.
        </p>
      )}
      {!events.length && <p className="field-error">Nothing recorded yet: send a message first.</p>}
      {running && <p className="hint">Waiting for the running turn to finish…</p>}
      {error && <p className="field-error">{error}</p>}
      <div className="mark-form-actions">
        <button className="primary" onClick={save} disabled={saving || running || !events.length || !sessionId}>
          {saving ? "Saving…" : "Save to bench/user_scenarios"}
        </button>
        <button className="ghost" onClick={onKeepRecording} disabled={saving}>
          Keep recording
        </button>
        <button className="ghost danger" onClick={onDiscard} disabled={saving}>
          Discard recording
        </button>
      </div>
    </div>
  );
}

function SavedNote({ summary, onDismiss }: { summary: ScenarioSummary; onDismiss: () => void }) {
  const s = (n: number) => (n === 1 ? "" : "s");
  return (
    <div className="card scenario-saved" role="status">
      <div>
        Scenario saved to <code>{summary.path}</code>: {summary.n_events} events, {summary.n_failures} failure
        {s(summary.n_failures)} marked ({summary.n_miss} missed, {summary.n_false_positive} false positive
        {s(summary.n_false_positive)}).
      </div>
      <button className="link" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
