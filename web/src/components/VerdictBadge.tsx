import type { Action, Verdict } from "../types";

// Icon + label so a verdict never relies on color alone.
const VERDICT: Record<string, { label: string; icon: string }> = {
  allow: { label: "Allow", icon: "✓" },
  needs_review: { label: "Needs review", icon: "?" },
  violation: { label: "Violation", icon: "✕" },
  error: { label: "Classifier error", icon: "!" },
  unchecked: { label: "Not checked", icon: "–" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict | "error" | "unchecked" }) {
  const v = VERDICT[verdict] ?? { label: verdict, icon: "" };
  return (
    <span className={`badge badge-${verdict}`}>
      <span aria-hidden>{v.icon}</span> {v.label}
    </span>
  );
}

const ACTION_LABEL: Record<Action, string> = { passed: "passed", flagged: "flagged", blocked: "blocked" };

export function ActionTag({ action }: { action: Action }) {
  return <span className={`action action-${action}`}>{ACTION_LABEL[action]}</span>;
}
