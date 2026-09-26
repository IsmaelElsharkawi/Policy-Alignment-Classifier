import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { humanize, pct } from "../format";
import { VERDICTS, type EvalGroup, type EvalReport } from "../types";
import { VerdictBadge } from "./VerdictBadge";

const MAX_ROWS = 300;
const SOURCE_LABEL: Record<string, string> = { hand: "hand", redteam: "red team", wildjailbreak: "WildJailbreak" };
const rate = (x: number | null) => (x === null ? "—" : pct(x));

/** Shows the latest run of the evaluation benchmark (scripts/eval_benchmark.py). */
export function EvalPanel({ active }: { active: boolean }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<EvalGroup["id"]>("policy");
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

  const group = report?.groups.find((g) => g.id === groupId) ?? report?.groups[0];
  const cases = useMemo(() => {
    if (!report || !group) return [];
    return report.cases.filter(
      (c) =>
        (group.id === "policy" ? c.source !== "wildjailbreak" : c.source === group.id) &&
        (filter === "all" || c.outcome !== "correct"),
    );
  }, [report, group, filter]);

  if (error) return <div className="panel"><div className="card error">{error}</div></div>;
  if (!report || !group) return <div className="panel"><p className="hint">Loading eval report…</p></div>;

  const m = group.metrics;
  const predCols: string[] = [...VERDICTS, ...(Object.values(group.confusion).some((r) => r.error) ? ["error"] : [])];
  const goldRows = VERDICTS.filter((v) => group.confusion[v]);
  const { params } = report;

  return (
    <div className="panel">
      <p className="hint">
        Run <code>{report.run_id}</code> · guard {report.guard_model} · policy {report.policy.id} v{report.policy.version} ·{" "}
        {new Date(report.created_at).toLocaleString()} · {report.cases.length} of {report.benchmark.n} benchmark cases
        {params.wjb_sample ? ` (WildJailbreak sampled to ${params.wjb_sample})` : ""} · {params.repeats}{" "}
        {params.repeats === 1 ? "vote" : "votes"} per case · {report.calls} calls · ${report.cost_usd.toFixed(2)}
      </p>

      <div className="card">
        <h3>Results by source</h3>
        <p className="hint">
          Pick a row to see its confusion matrix and cases. WildJailbreak labels mean harmful in general, not against
          this policy, so it is never pooled into the policy-labeled row.
        </p>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>source</th><th>n</th><th>accuracy</th><th>attacks through</th><th>false blocks</th>
                <th>precision</th><th>recall</th><th>F1</th>
              </tr>
            </thead>
            <tbody>
              {report.groups.map((g) => (
                <tr
                  key={g.id}
                  className={`clickable${g.id === group.id ? " selected" : ""}`}
                  onClick={() => setGroupId(g.id)}
                  aria-selected={g.id === group.id}
                >
                  <th>{g.label}</th>
                  <td>{g.metrics.n}</td>
                  <td>{rate(g.metrics.accuracy)}</td>
                  <td>{rate(g.metrics.attack_success_rate)}</td>
                  <td>{rate(g.metrics.false_block_rate)}</td>
                  <td>{rate(g.metrics.precision)}</td>
                  <td>{rate(g.metrics.recall)}</td>
                  <td>{rate(g.metrics.f1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3>{group.label}</h3>
      <p className="hint">{group.note}</p>
      <div className="stats">
        <Stat label="Accuracy" value={rate(m.accuracy)} sub={`${m.n} cases${m.errors ? `, ${m.errors} errors` : ""}`} />
        <Stat
          label="Attacks through"
          value={rate(m.attack_success_rate)}
          sub={`violations allowed or only sent to review, of ${m.violations}`}
          tone="violation"
        />
        <Stat label="False blocks" value={rate(m.false_block_rate)} sub={`allowed cases blocked, of ${m.allowed}`} tone="needs_review" />
        <Stat label="F1 (violation)" value={rate(m.f1)} sub={`precision ${rate(m.precision)} · recall ${rate(m.recall)}`} />
      </div>

      <div className="two-col">
        <div>
          <h3>Confusion (rows = label, cols = guard)</h3>
          <table className="grid">
            <thead>
              <tr>
                <th />
                {predCols.map((v) => <th key={v}>{humanize(v)}</th>)}
              </tr>
            </thead>
            <tbody>
              {goldRows.map((gold) => (
                <tr key={gold}>
                  <th>{humanize(gold)}</th>
                  {predCols.map((pred) => {
                    const n = group.confusion[gold]?.[pred] ?? 0;
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
          <h3>Policy-labeled cases by event kind</h3>
          <table className="grid">
            <thead>
              <tr><th>kind</th><th>n</th><th>accuracy</th><th>attacks through</th><th>false blocks</th></tr>
            </thead>
            <tbody>
              {Object.entries(report.by_kind).map(([kind, s]) => (
                <tr key={kind}>
                  <th>{humanize(kind)}</th>
                  <td>{s.n}</td>
                  <td>{rate(s.accuracy)}</td>
                  <td>{rate(s.attack_success_rate)}</td>
                  <td>{rate(s.false_block_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row">
        <h3 className="grow">Cases · {group.label}</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | "wrong")}>
          <option value="wrong">Guard got wrong</option>
          <option value="all">All cases</option>
        </select>
      </div>
      {cases.length > MAX_ROWS && <p className="hint">Showing the first {MAX_ROWS} of {cases.length}.</p>}
      <div className="table-scroll">
        <table className="grid cases">
          <thead>
            <tr><th>case</th><th>label</th><th>guard</th><th>event</th><th>guard's rationale / label note</th></tr>
          </thead>
          <tbody>
            {cases.slice(0, MAX_ROWS).map((c) => (
              <tr key={c.id} className={c.outcome === "correct" ? "" : "wrong"}>
                <td>
                  <div className="mono">{c.id}</div>
                  <div className="hint">
                    {SOURCE_LABEL[c.source]} · {humanize(c.kind)} · {c.split}
                    {c.n_context ? ` · ${c.n_context} prior events` : ""}
                  </div>
                  {c.outcome !== "correct" && <div className="hint">{humanize(c.outcome)}</div>}
                </td>
                <td>
                  <VerdictBadge verdict={c.label} />
                  {c.label_source && <div className="hint">{c.label_source}</div>}
                </td>
                <td>
                  <VerdictBadge verdict={c.verdict ?? "error"} />
                  {c.rules.length > 0 && <div className="hint">{c.rules.join(", ")}</div>}
                  {c.votes.length > 1 && <div className="hint">votes {c.votes.join(" / ")}</div>}
                </td>
                <td className="case-text">
                  {c.technique && c.source !== "wildjailbreak" && <div className="hint">{c.technique}</div>}
                  <div className="mono">{c.text}</div>
                </td>
                <td>
                  {c.error ? <span className="hint">{c.error}</span> : c.rationale ?? <span className="hint">not recorded in this run</span>}
                  {c.label_note && <div className="hint">Label: {c.label_note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "violation" | "needs_review" }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
