import { useState, type ReactNode } from "react";
import type { AnalyticsWindow, PerfReport, TurnTiming } from "../types";
import { bucketLabel, niceMax, topRounded, useWidth } from "./charts";

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;

const PAD = { top: 10, right: 44, bottom: 24, left: 44 };

function YAxis({ max, y, width, fmt }: { max: number; y: (v: number) => number; width: number; fmt: (v: number) => string }) {
  return (
    <>
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line className={t === 0 ? "axis" : "gridline"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="tick" x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
    </>
  );
}

function Tooltip({ left, top, width, children }: { left: number; top: number; width: number; children: ReactNode }) {
  return (
    <div className="tooltip" style={{ left: Math.max(0, Math.min(left, width - 170)), top }}>
      {children}
    </div>
  );
}

/** Classifier latency p50 and p95 per time bucket. Two series, one axis, crosshair tooltip. */
export function LatencyLineChart({ data, window }: { data: PerfReport["timeline"]; window: AnalyticsWindow }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.p95_ms ?? 0)));
  const x = (i: number) => PAD.left + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const series = [
    { key: "p50_ms" as const, label: "p50", cls: "s1" },
    { key: "p95_ms" as const, label: "p95", cls: "s2" },
  ];
  // Break the line where a bucket has no data rather than drawing through it.
  const path = (key: "p50_ms" | "p95_ms") =>
    data.reduce((d, pt, i) => {
      const v = pt[key];
      if (v == null) return d;
      const prev = i > 0 ? data[i - 1][key] : null;
      return d + `${prev == null ? "M" : "L"}${x(i)},${y(v)} `;
    }, "");
  const lastIdx = (key: "p50_ms" | "p95_ms") => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i][key] != null) return i;
    return -1;
  };
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 64)));

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <div className="legend">
          {series.map((s) => (
            <span key={s.key} className="legend-item">
              <span className={`swatch line ${s.cls}`} /> {s.label} latency
            </span>
          ))}
        </div>
      </div>
      <div className="chart-area" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label="Classifier latency p50 and p95 over time">
          <YAxis max={max} y={y} width={width} fmt={fmtMs} />
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={d.bucket} className="tick" x={x(i)} y={height - 6} textAnchor="middle">
                {bucketLabel(d.bucket, window)}
              </text>
            ) : null,
          )}
          {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />}
          {series.map((s) => {
            const li = lastIdx(s.key);
            return (
              <g key={s.key}>
                <path className={`line ${s.cls}`} d={path(s.key)} />
                {/* Isolated points (neighbours empty) would be invisible as a path. */}
                {data.map((d, i) =>
                  d[s.key] != null && data[i - 1]?.[s.key] == null && data[i + 1]?.[s.key] == null ? (
                    <circle key={i} className={`dot ${s.cls}`} cx={x(i)} cy={y(d[s.key]!)} r={3} />
                  ) : null,
                )}
                {li >= 0 && (
                  <text className="direct-label" x={x(li) + 6} y={y(data[li][s.key]!)} dy="0.32em">
                    {s.label}
                  </text>
                )}
                {hover !== null && data[hover][s.key] != null && (
                  <circle className={`marker ${s.cls}`} cx={x(hover)} cy={y(data[hover][s.key]!)} r={4.5} />
                )}
              </g>
            );
          })}
          {data.map((d, i) => (
            <rect
              key={d.bucket}
              className="hit"
              x={x(i) - plotW / Math.max(1, data.length) / 2}
              y={PAD.top}
              width={plotW / Math.max(1, data.length)}
              height={plotH}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <Tooltip left={x(hover) + 8} top={PAD.top} width={width}>
            <div className="tooltip-title">{bucketLabel(data[hover].bucket, window)}</div>
            {[...series].reverse().map((s) => (
              <div key={s.key} className="tooltip-row">
                <span className={`swatch line ${s.cls}`} /> {s.label}
                <span className="tooltip-value">{fmtMs(data[hover][s.key])}</span>
              </div>
            ))}
            <div className="tooltip-row">
              calls<span className="tooltip-value">{data[hover].n}</span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Single-series vertical bars (histogram, load-test levels). */
export function ColumnChart({
  bars,
  format,
  ariaLabel,
  height = 180,
}: {
  bars: { label: string; value: number; detail?: string }[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - 12);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const slot = bars.length ? plotW / bars.length : 0;
  const gap = Math.min(2, slot * 0.2); // 2px surface gap between adjacent bars
  const labelEvery = Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 56)));

  return (
    <div className="chart" ref={ref}>
      <div className="chart-area" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <YAxis max={max} y={y} width={width + PAD.right - 12} fmt={format} />
          {bars.map((b, i) => {
            const x = PAD.left + slot * i + gap / 2;
            const h = Math.max(b.value > 0 ? 1 : 0, y(0) - y(b.value));
            return (
              <g key={i}>
                {h > 0 && <path className={`bar s1 ${hover === i ? "hovered" : ""}`} d={topRounded(x, y(0) - h, slot - gap, h, 4)} />}
                {i % labelEvery === 0 && (
                  <text className="tick" x={x + (slot - gap) / 2} y={height - 6} textAnchor="middle">
                    {b.label}
                  </text>
                )}
                <rect className="hit" x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <Tooltip left={PAD.left + slot * hover + slot / 2 + 8} top={PAD.top} width={width}>
            <div className="tooltip-title">{bars[hover].label}</div>
            <div className="tooltip-row">
              {bars[hover].detail ?? "value"}
              <span className="tooltip-value">{format(bars[hover].value)}</span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Latency against input tokens: does a longer context make the classifier slower? */
export function ScatterChart({ points }: { points: PerfReport["scatter"] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom - 10;
  const maxY = niceMax(Math.max(0, ...points.map((p) => p.latency_ms)));
  const maxX = niceMax(Math.max(0, ...points.map((p) => p.input_tokens)));
  const x = (v: number) => PAD.left + (v / maxX) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / maxY) * plotH;

  const nearest = (mx: number, my: number) => {
    let best = -1;
    let bestD = 24 ** 2; // hit radius well beyond the 8px mark
    points.forEach((p, i) => {
      const d = (x(p.input_tokens) - mx) ** 2 + (y(p.latency_ms) - my) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best >= 0 ? best : null;
  };

  return (
    <div className="chart" ref={ref}>
      <div className="chart-area" onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Classifier latency against input tokens"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(nearest(e.clientX - r.left, e.clientY - r.top));
          }}
        >
          <YAxis max={maxY} y={y} width={width} fmt={fmtMs} />
          {[0, maxX / 2, maxX].map((t) => (
            <text key={t} className="tick" x={x(t)} y={PAD.top + plotH + 16} textAnchor="middle">
              {t >= 1000 ? `${(t / 1000).toFixed(1)}K` : t}
            </text>
          ))}
          <text className="tick" x={PAD.left + plotW / 2} y={height - 2} textAnchor="middle">
            input tokens (policy prompt + context + event)
          </text>
          {points.map((p, i) => (
            <circle key={i} className={`scatter-dot s1 ${hover === i ? "hovered" : ""}`} cx={x(p.input_tokens)} cy={y(p.latency_ms)} r={4} />
          ))}
        </svg>
        {hover !== null && (
          <Tooltip left={x(points[hover].input_tokens) + 10} top={y(points[hover].latency_ms) - 10} width={width}>
            <div className="tooltip-title mono">{points[hover].kind}</div>
            <div className="tooltip-row">
              latency<span className="tooltip-value">{fmtMs(points[hover].latency_ms)}</span>
            </div>
            <div className="tooltip-row">
              input tokens<span className="tooltip-value">{points[hover].input_tokens.toLocaleString()}</span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

const SEGMENTS = [
  { key: "agent_ms", label: "Agent model", cls: "s1" },
  { key: "guard_ms", label: "Guard (classifier)", cls: "s2" },
  { key: "tool_ms", label: "Tools", cls: "s3" },
] as const;

/** Where each recent turn's wall time went. Stacked horizontal bars, one row per turn. */
export function TurnBreakdown({ turns }: { turns: TurnTiming[] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...turns.map((t) => t.total_ms));

  return (
    <div className="chart">
      <div className="chart-head">
        <div className="legend">
          {SEGMENTS.map((s) => (
            <span key={s.key} className="legend-item">
              <span className={`swatch ${s.cls}`} /> {s.label}
            </span>
          ))}
        </div>
        <button className="link" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>started</th>
                <th>mode</th>
                <th>events</th>
                {SEGMENTS.map((s) => <th key={s.key}>{s.label}</th>)}
                <th>total</th>
                <th>guard share</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t, i) => (
                <tr key={i}>
                  <td className="nowrap">{new Date(t.started_at).toLocaleTimeString()}</td>
                  <td>{t.mode}</td>
                  <td>{t.n_events}</td>
                  {SEGMENTS.map((s) => <td key={s.key}>{fmtMs(t[s.key])}</td>)}
                  <td>{fmtMs(t.total_ms)}</td>
                  <td>{t.total_ms ? `${Math.round((t.guard_ms / t.total_ms) * 100)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="turn-bars" onMouseLeave={() => setHover(null)}>
          {turns.map((t, i) => (
            <div key={i} className={`turn-row ${hover === i ? "hovered" : ""}`} onMouseEnter={() => setHover(i)}>
              <span className="turn-label">
                {new Date(t.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                <span className="turn-mode">{t.mode}</span>
              </span>
              <span className="turn-track">
                {SEGMENTS.map((s) =>
                  t[s.key] > 0 ? (
                    <span
                      key={s.key}
                      className={`turn-seg ${s.cls}`}
                      style={{ width: `${(t[s.key] / max) * 100}%` }}
                    />
                  ) : null,
                )}
              </span>
              <span className="turn-total">{fmtMs(t.total_ms)}</span>
              {hover === i && (
                <div className="tooltip turn-tip">
                  <div className="tooltip-title">
                    {t.n_events} events · {t.classifier_calls} classifier calls{t.error ? " · error" : ""}
                  </div>
                  {SEGMENTS.map((s) => (
                    <div key={s.key} className="tooltip-row">
                      <span className={`swatch ${s.cls}`} /> {s.label}
                      <span className="tooltip-value">{fmtMs(t[s.key])}</span>
                    </div>
                  ))}
                  <div className="tooltip-row">
                    total<span className="tooltip-value">{fmtMs(t.total_ms)}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
