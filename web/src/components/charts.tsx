import { useLayoutEffect, useRef, useState } from "react";
import { humanize } from "../format";
import type { Analytics, AnalyticsWindow, Verdict } from "../types";

// Verdicts use the reserved status colors (good / warning / critical), always
// paired with a label in the legend and tooltip. Stack order bottom → top.
const SERIES: { key: Verdict; label: string }[] = [
  { key: "allow", label: "Allow" },
  { key: "needs_review", label: "Needs review" },
  { key: "violation", label: "Violation" },
];

export function niceMax(n: number) {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => s * 4 >= n)!;
  return step * 4;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rect with only the top two corners rounded — the data end of a bar. */
export function topRounded(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function bucketLabel(iso: string, window: AnalyticsWindow) {
  const d = new Date(iso);
  return window === "24h"
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TimelineChart({ data, window }: { data: Analytics["timeline"]; window: AnalyticsWindow }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const height = 200;
  const pad = { top: 8, right: 8, bottom: 22, left: 32 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.allow + d.needs_review + d.violation)));
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const slot = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 64)));

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <div className="legend">
          {SERIES.map((s) => (
            <span key={s.key} className="legend-item">
              <span className={`swatch fill-${s.key}`} /> {s.label}
            </span>
          ))}
        </div>
        <button className="link" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {asTable ? (
        <table className="grid">
          <thead>
            <tr>
              <th>{window === "24h" ? "Hour" : "Day"}</th>
              {SERIES.map((s) => <th key={s.key}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.bucket}>
                <td>{bucketLabel(d.bucket, window)}</td>
                {SERIES.map((s) => <td key={s.key}>{d[s.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-area" onMouseLeave={() => setHover(null)}>
          <svg width={width} height={height} role="img" aria-label="Classified events over time by verdict">
            {ticks.map((t) => (
              <g key={t}>
                <line className={t === 0 ? "axis" : "gridline"} x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} />
                <text className="tick" x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = pad.left + slot * i + slot / 2;
              const x = cx - barW / 2;
              let acc = 0;
              const present = SERIES.filter((s) => d[s.key] > 0);
              return (
                <g key={d.bucket}>
                  {present.map((s, j) => {
                    const top = y(acc + d[s.key]);
                    const bottom = y(acc);
                    acc += d[s.key];
                    // 2px surface gap between stacked segments.
                    const h = Math.max(1, bottom - top - (j > 0 ? 2 : 0));
                    const isTop = j === present.length - 1;
                    return isTop ? (
                      <path key={s.key} className={`fill-${s.key}`} d={topRounded(x, top, barW, h, 4)} />
                    ) : (
                      <rect key={s.key} className={`fill-${s.key}`} x={x} y={top} width={barW} height={h} />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text className="tick" x={cx} y={height - 6} textAnchor="middle">
                      {bucketLabel(d.bucket, window)}
                    </text>
                  )}
                  {/* Hit target: the whole column, wider than the bar. */}
                  <rect
                    className={`hit ${hover === i ? "hovered" : ""}`}
                    x={pad.left + slot * i}
                    y={pad.top}
                    width={slot}
                    height={plotH}
                    onMouseEnter={() => setHover(i)}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div
              className="tooltip"
              style={{
                left: Math.min(pad.left + slot * hover + slot / 2, width - 150),
                top: pad.top,
              }}
            >
              <div className="tooltip-title">{bucketLabel(data[hover].bucket, window)}</div>
              {[...SERIES].reverse().map((s) => (
                <div key={s.key} className="tooltip-row">
                  <span className={`swatch fill-${s.key}`} /> {s.label}
                  <span className="tooltip-value">{data[hover][s.key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Single-series horizontal bars: magnitude per attack category, direct-labeled. */
export function CategoryBars({ data }: { data: Analytics["by_category"] }) {
  if (!data.length) return <p className="hint">No violations or review cases in this window.</p>;
  const max = Math.max(...data.map((d) => d.n));
  return (
    <div className="hbars" role="list">
      {data.map((d) => (
        <div key={d.category} className="hbar" role="listitem" title={`${humanize(d.category)}: ${d.n}`}>
          <span className="hbar-label">{humanize(d.category)}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(d.n / max) * 100}%` }} />
          </span>
          <span className="hbar-value">{d.n}</span>
        </div>
      ))}
    </div>
  );
}
