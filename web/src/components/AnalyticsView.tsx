import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { eventText, formatCost, humanize, pct, time } from "../format";
import {
  EVENT_KINDS,
  VERDICTS,
  type Analytics,
  type AnalyticsWindow,
  type SessionDetail,
  type SessionSummary,
} from "../types";
import { CategoryBars, TimelineChart } from "./charts";
import { Transcript } from "./Transcript";
import { ActionTag, VerdictBadge } from "./VerdictBadge";

const WINDOWS: { id: AnalyticsWindow; label: string }[] = [
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
];

/**
 * Safety analytics over every classified event: volume and verdicts over time,
 * attacks by category, where in the trace they occur, the incident log, and
 * session history.
 */
export function AnalyticsView({ active, refreshKey }: { active: boolean; refreshKey: number }) {
  const [window, setWindow] = useState<AnalyticsWindow>("7d");
  const [data, setData] = useState<Analytics | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<SessionDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([api.analytics(window), api.listSessions()]);
      setData(a);
      setSessions(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [window]);

  // Refetch when the tab becomes visible or the agent produced new events.
  useEffect(() => {
    if (active) load();
  }, [active, load, refreshKey]);

  const showSession = async (id: string) => {
    try {
      setOpenSession(await api.getSession(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error && !data) return <div className="card error">{error}</div>;
  if (!data) return <p className="hint">Loading analytics…</p>;

  const { totals } = data;
  const flaggedRate = totals.events ? (totals.violations + totals.needs_review) / totals.events : 0;

  return (
    <div className="panel">
      <div className="filters">
        <select value={window} onChange={(e) => setWindow(e.target.value as AnalyticsWindow)}>
          {WINDOWS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={load}>
          Refresh
        </button>
        {error && <span className="field-error">{error}</span>}
      </div>

      <div className="stats">
        <Stat label="Events classified" value={totals.events.toLocaleString()} sub={`${totals.sessions} sessions`} />
        <Stat label="Violations" value={totals.violations.toLocaleString()} sub={`${totals.blocked} blocked`} tone="violation" />
        <Stat label="Needs review" value={totals.needs_review.toLocaleString()} sub="policy silent / unsure" tone="needs_review" />
        <Stat label="Flag rate" value={pct(flaggedRate)} sub="violation + review" />
        {data.latency && (
          <Stat label="Classifier latency" value={`${data.latency.p50_ms} ms`} sub={`p95 ${data.latency.p95_ms} ms`} />
        )}
        {data.cost_usd_total != null && (
          <Stat
            label="Classifier cost"
            value={`$${data.cost_usd_total.toFixed(4)}`}
            sub={totals.events ? formatCost(data.cost_usd_total / totals.events) : undefined}
          />
        )}
      </div>

      <section className="card">
        <h3>Verdicts over time</h3>
        <TimelineChart data={data.timeline} window={window} />
      </section>

      <div className="two-col">
        <section className="card">
          <h3>Attacks by category</h3>
          <CategoryBars data={data.by_category} />
          {data.by_rule.length > 0 && (
            <p className="hint rules-line">
              Rules cited:{" "}
              {data.by_rule.map((r) => (
                <span key={r.rule} className="rule-count">
                  <code>{r.rule}</code> ×{r.n}
                </span>
              ))}
            </p>
          )}
        </section>
        <section className="card">
          <h3>Where in the trace</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>event kind</th>
                {VERDICTS.map((v) => (
                  <th key={v}>{humanize(v)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENT_KINDS.map((k) => (
                <tr key={k}>
                  <th className="mono">{k}</th>
                  {VERDICTS.map((v) => {
                    const n = data.by_kind[k]?.[v] ?? 0;
                    return (
                      <td key={v} className={v !== "allow" && n ? `hot-${v}` : ""}>
                        {n}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h3>Incident log</h3>
        {data.incidents.length === 0 ? (
          <p className="hint">No incidents in this window.</p>
        ) : (
          <div className="table-scroll">
            <table className="grid incidents">
              <thead>
                <tr>
                  <th>time</th>
                  <th>verdict</th>
                  <th>category</th>
                  <th>kind</th>
                  <th>event</th>
                  <th>action</th>
                </tr>
              </thead>
              <tbody>
                {data.incidents.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => showSession(e.session_id)}>
                    <td className="nowrap">{time(e.ts)}</td>
                    <td>
                      <VerdictBadge verdict={e.classification?.verdict ?? "error"} />
                    </td>
                    <td>
                      {humanize(e.classification?.category ?? "—")}
                      <div className="hint">{e.classification?.rules.join(", ")}</div>
                    </td>
                    <td className="mono">{e.event.kind}</td>
                    <td className="mono truncate" title={eventText(e.event)}>
                      {eventText(e.event)}
                    </td>
                    <td>
                      <ActionTag action={e.action} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Session history</h3>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>started</th>
                <th>first message</th>
                <th>mode</th>
                <th>events</th>
                <th>violations</th>
                <th>review</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => showSession(s.id)}>
                  <td className="nowrap">{time(s.created_at)}</td>
                  <td className="truncate" title={s.title}>
                    {s.title}
                  </td>
                  <td>{s.mode}</td>
                  <td>{s.n_events}</td>
                  <td className={s.n_violations ? "hot-violation" : ""}>{s.n_violations}</td>
                  <td className={s.n_review ? "hot-needs_review" : ""}>{s.n_review}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {openSession && <SessionDrawer session={openSession} onClose={() => setOpenSession(null)} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SessionDrawer({ session, onClose }: { session: SessionDetail; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Session transcript">
        <header className="drawer-head">
          <div>
            <h3>{session.title}</h3>
            <p className="hint">
              {time(session.created_at)} · {session.mode} · {session.n_events} events · {session.n_violations} violations
            </p>
          </div>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <Transcript events={session.events} />
      </aside>
    </div>
  );
}
