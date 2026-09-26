import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentInfo, Mode, RecordedEvent } from "../types";
import { Transcript } from "./Transcript";

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
        <button className="ghost" onClick={reset} disabled={!events.length && !sessionId}>
          New session
        </button>
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
          <Transcript events={events} />
        )}
        {running && (
          <div className="working">
            <span className="spinner">✻</span> Working…
          </div>
        )}
        {error && <div className="card error">{error}</div>}
        <div ref={bottomRef} />
      </div>

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
