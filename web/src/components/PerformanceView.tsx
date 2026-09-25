import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatCost, pct } from "../format";
import type { AnalyticsWindow, BenchReport, LatencySummary, PerfReport } from "../types";
import { ColumnChart, fmtMs, LatencyLineChart, ScatterChart, TurnBreakdown } from "./perfCharts";

const WINDOWS: { id: AnalyticsWindow; label: string }[] = [
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
];

/**
 * Latency, cost and throughput. The classifier sits on the request path of every event,
 * so what it costs per event, and how much of a turn is spent waiting on it, is the
 * production constraint this page is about.
 */
export function PerformanceView({ active, refreshKey }: { active: boolean; refreshKey: number }) {
  const [window, setWindow] = useState<AnalyticsWindow>("7d");
  const [data, setData] = useState<PerfReport | null>(null);
  const [bench, setBench] = useState<BenchReport | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.perf(window));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      setBench(await api.bench());
      setBenchError(null);
    } catch (e) {
      setBench(null);
      setBenchError(e instanceof Error ? e.message : String(e));
    }
  }, [window]);

  useEffect(() => {
    if (active) load();
  }, [active, load, refreshKey]);

  if (error && !data) return <div className="card error">{error}</div>;
  if (!data) return <p className="hint">Loading performance data…</p>;

  const c = data.classifier;
  const t = data.turns;

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

      <h2 className="section-title">Recorded traffic</h2>
      <div className="stats">
        <Stat label="Classifier p50" value={fmtMs(c.p50_ms)} sub={`p95 ${fmtMs(c.p95_ms)} · p99 ${fmtMs(c.p99_ms)}`} />
        <Stat label="Classifier calls" value={c.n.toLocaleString()} sub={`${c.errors} errors (${pct(c.error_rate)})`} />
        <Stat label="Cost per event" value={formatCost(c.cost_per_event_usd)} sub={`~${c.mean_input_tokens ?? "—"} tokens in / ${c.mean_output_tokens ?? "—"} out`} />
        <Stat label="Turn latency p50" value={fmtMs(t.p50_total_ms)} sub={`p95 ${fmtMs(t.p95_total_ms)} · ${t.n} guarded turns`} />
        <Stat
          label="Time waiting on guard"
          value={t.median_guard_share == null ? "—" : pct(t.median_guard_share)}
          sub={`median share of a turn · ${t.mean_classifier_calls ?? "—"} calls/turn`}
        />
        <Stat
          label="Observed throughput"
          value={`${data.throughput.peak_events_per_min}/min`}
          sub={`peak · ${data.throughput.mean_events_per_active_min}/min mean when active`}
        />
      </div>

      <section className="card">
        <h3>Where a turn's time goes</h3>
        <p className="hint">
          Recent turns, newest first. Events are classified sequentially on the request path, so guard time adds
          directly to what the user waits.
        </p>
        {t.recent.length ? <TurnBreakdown turns={t.recent} /> : <p className="hint">No turns recorded yet.</p>}
      </section>

      <section className="card">
        <h3>Classifier latency over time</h3>
        {c.n ? <LatencyLineChart data={data.timeline} window={window} /> : <p className="hint">No classifier calls in this window.</p>}
      </section>

      <div className="two-col">
        <section className="card">
          <h3>Latency distribution</h3>
          {data.histogram.length ? (
            <ColumnChart
              ariaLabel="Histogram of classifier latency"
              bars={data.histogram.map((b) => ({
                label: b.overflow ? `>${fmtMs(b.start_ms)}` : fmtMs(b.start_ms),
                value: b.n,
                detail: b.overflow ? `calls slower than ${fmtMs(b.start_ms)}` : `calls ${fmtMs(b.start_ms)}–${fmtMs(b.end_ms)}`,
              }))}
              format={(v) => String(Math.round(v))}
            />
          ) : (
            <p className="hint">No data.</p>
          )}
        </section>
        <section className="card">
          <h3>Latency vs input size</h3>
          {data.scatter.length ? <ScatterChart points={data.scatter} /> : <p className="hint">No data.</p>}
        </section>
      </div>

      <div className="two-col">
        <section className="card">
          <h3>By hook point</h3>
          <SummaryTable rows={data.by_kind.map((r) => ({ ...r, name: r.key, sub: r.hook }))} />
        </section>
        <section className="card">
          <h3>By classifier model</h3>
          <SummaryTable rows={data.by_model.map((r) => ({ ...r, name: r.key }))} />
        </section>
      </div>

      <h2 className="section-title">Load test</h2>
      {bench ? (
        <BenchSection bench={bench} />
      ) : (
        <div className="card">
          <p className="hint">
            {benchError ?? "No load test yet."} Recorded traffic shows what happened, not capacity. Measure capacity with{" "}
            <code>uv run python scripts/bench_classifier.py --levels 1,4,8 --n 16</code>.
          </p>
        </div>
      )}
    </div>
  );
}

function BenchSection({ bench }: { bench: BenchReport }) {
  const levels = bench.levels;
  return (
    <>
      <p className="hint">
        Run <code>{bench.run_id}</code> · {bench.guard_model} · {bench.workload} ·{" "}
        {new Date(bench.created_at).toLocaleString()}
      </p>
      <div className="two-col">
        <section className="card">
          <h3>Throughput by concurrency</h3>
          <ColumnChart
            ariaLabel="Classifier throughput at each concurrency level"
            bars={levels.map((l) => ({ label: `c=${l.concurrency}`, value: l.throughput_eps ?? 0, detail: "events / second" }))}
            format={(v) => v.toFixed(v < 10 ? 1 : 0)}
          />
        </section>
        <section className="card">
          <h3>p95 latency by concurrency</h3>
          <ColumnChart
            ariaLabel="Classifier p95 latency at each concurrency level"
            bars={levels.map((l) => ({ label: `c=${l.concurrency}`, value: l.p95_ms ?? 0, detail: "p95 latency" }))}
            format={fmtMs}
          />
        </section>
      </div>
      <section className="card">
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>concurrency</th>
                <th>ok / n</th>
                <th>throughput</th>
                <th>p50</th>
                <th>p95</th>
                <th>p99</th>
                <th>model p50</th>
                <th>overhead p50</th>
                <th>tokens in</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.concurrency}>
                  <td>{l.concurrency}</td>
                  <td className={l.errors ? "hot-violation" : ""}>
                    {l.ok} / {l.n}
                  </td>
                  <td>{l.throughput_eps ?? "—"} ev/s</td>
                  <td>{fmtMs(l.p50_ms)}</td>
                  <td>{fmtMs(l.p95_ms)}</td>
                  <td>{fmtMs(l.p99_ms)}</td>
                  <td>{fmtMs(l.model_p50_ms)}</td>
                  <td>{fmtMs(l.overhead_p50_ms)}</td>
                  <td>{l.mean_input_tokens ?? "—"}</td>
                  <td>${l.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {levels.some((l) => l.error_samples.length) && (
          <p className="hint">Errors: {levels.flatMap((l) => l.error_samples).join(" · ")}</p>
        )}
        <p className="hint">
          Latency by context size (c=1):{" "}
          {levels[0]?.by_context.map((b) => `${b.context_events} prior events → ${fmtMs(b.p50_ms)}`).join(" · ")}
        </p>
      </section>
    </>
  );
}

function SummaryTable({ rows }: { rows: (LatencySummary & { name: string; sub?: string })[] }) {
  if (!rows.length) return <p className="hint">No data.</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th />
          <th>n</th>
          <th>p50</th>
          <th>p95</th>
          <th>tokens in</th>
          <th>cost / 1k</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <th>
              <span className="mono">{r.name}</span>
              {r.sub && <div className="hint">{r.sub}</div>}
            </th>
            <td>{r.n}</td>
            <td>{fmtMs(r.p50_ms)}</td>
            <td>{fmtMs(r.p95_ms)}</td>
            <td>{r.mean_input_tokens ?? "—"}</td>
            <td>{r.cost_per_event_usd == null ? "—" : `$${(r.cost_per_event_usd * 1000).toFixed(2)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
