import type { TraceEvent } from "./types";

export function formatCost(usd?: number | null) {
  if (usd === undefined || usd === null) return "—";
  // Per-event costs are tiny; show per-1k events so the number is readable.
  return `$${(usd * 1000).toFixed(3)} / 1k events`;
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const humanize = (s: string) => s.replace(/_/g, " ");

/** Compact one-line rendering of a tool call: name(arg="…", …). */
export function callSignature(e: TraceEvent) {
  const args = Object.entries(e.arguments ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${e.tool_name ?? "tool"}(${args})`;
}

export function eventText(e: TraceEvent) {
  return e.kind === "tool_call" ? callSignature(e) : e.content ?? "";
}
