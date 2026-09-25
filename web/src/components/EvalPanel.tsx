import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { formatCost, pct } from "../format";
import { VERDICTS, type EvalReport } from "../types";
import { VerdictBadge } from "./VerdictBadge";

/** Shows the most recent offline eval run produced by the harness. */
export function EvalPanel({ active }: { active: boolean }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "wrong">("wrong");

  useEffect(() => {
    if (!active) return;
    api.latestEval().then(
      (r) => {
        setReport(r);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [active]);

  const cases = useMemo(
    () => (report ? report.cases.filter((c) => filter === "all" || !c.correct) : []),
    [report, filter],
  );

  if (error) return <div className="panel"><div className="card error">{error}</div></div>;
  if (!report) return <div className="panel"><p className="hint">Loading eval report…</p></div>;

  const { metrics } = report;
  const predCols: string[] = [...VERDICTS,...(Object.values(report.confusion).some((r) => r.error) ? ["error"] : [])];

  return (
    <div className="panel">
      <p className="hint">
        Run <code>{report.run_id}</code> · {report.model} · policy {report.policy_version} ·{" "}
        {new Date(report.created_at).toLocaleString()} · n = {report.n}
      </p>

      <div className="stats">
        <Stat label="Accuracy" value={pct(metrics.accuracy)} />
        <Stat label="Violation recall" value={pct(metrics.violation_recall)} />
        <Stat label="Violation precision" value={pct(metrics.violation_precision)} />
        <Stat label="Sent to review" value={pct(metrics.needs_review_rate)} />
        {report.latency && <Stat label="Latency p50 / p95" value={`${report.latency.p50_ms} / ${report.latency.p95_ms} ms`} />}
        {report.cost_per_event_usd !== undefined && <Stat label="Cost" value={formatCost(report.cost_per_event_usd)} />}
      </div>

      <div className="two-col">
        <div>
          <h3>Confusion (rows = gold, cols = predicted)</h3>
          <table className="grid">
            <thead>
              <tr>
                <th />
                {predCols.map((v) => <th key={v}>{v}</th>)}
              </tr>
            </thead>
            <tbody>
              {VERDICTS.map((gold) => (
                <tr key={gold}>
                  <th>{gold}</th>
                  {predCols.map((pred) => {
                    const n = report.confusion[gold]?.[pred] ?? 0;
                    return (
                      <td key={pred} className={gold === pred ? "diag" : n ? "off" : ""}>
                        {n}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>By event kind</h3>
          <table className="grid">
            <thead>
              <tr><th>kind</th><th>n</th><th>accuracy</th></tr>
            </thead>
            <tbody>
              {Object.entries(report.by_kind).map(([kind, s]) => (
                <tr key={kind}>
                  <th>{kind}</th>
                  <td>{s.n}</td>
                  <td>{pct(s.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row">
        <h3 className="grow">Cases</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | "wrong")}>
          <option value="wrong">Disagreements only</option>
          <option value="all">All cases</option>
        </select>
      </div>
      <table className="grid cases">
        <thead>
          <tr><th>id</th><th>kind</th><th>gold</th><th>pred</th><th>rationale / label note</th></tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id} className={c.correct ? "" : "wrong"}>
              <td className="mono">{c.id}</td>
              <td>{c.kind}</td>
              <td><VerdictBadge verdict={c.gold} /></td>
              <td><VerdictBadge verdict={c.pred} /></td>
              <td>
                {c.rationale}
                {c.label_note && <div className="hint">Label: {c.label_note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
