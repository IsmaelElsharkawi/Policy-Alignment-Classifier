// Wire types shared with the backend. See docs/api.md for the contract.

export type EventKind = "user_input" | "model_output" | "tool_call" | "tool_response";

export const EVENT_KINDS: EventKind[] = ["user_input", "model_output", "tool_call", "tool_response"];

export interface TraceEvent {
  kind: EventKind;
  /** Free text for user_input / model_output / tool_response. */
  content?: string;
  /** Tool invoked (tool_call) or tool that produced the result (tool_response). */
  tool_name?: string;
  /** Arguments of a tool_call. */
  arguments?: Record<string, unknown>;
}

/**
 * "needs_review" is deliberate: when the policy does not decide an event, the
 * classifier should say so rather than guess allow/violation.
 */
export type Verdict = "allow" | "violation" | "needs_review";

export const VERDICTS: Verdict[] = ["allow", "needs_review", "violation"];

export interface ClassifyResult {
  verdict: Verdict;
  /** Policy rule ids the verdict relies on, e.g. ["R3"]. */
  rules: string[];
  /** Attack / risk category for non-allow verdicts, e.g. "prompt_injection". */
  category?: string | null;
  rationale: string;
  /** Span of the event that triggered the verdict, if any. */
  evidence?: string | null;
  /** Set when the operator's rule scope changed the classifier's answer. */
  overridden?: { verdict: Verdict; rules: string[]; switched_off: string[] } | null;
  meta: {
    model: string;
    latency_ms: number;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
}

/**
 * enforce: violations are stopped (tool not executed, output withheld).
 * monitor: everything runs, verdicts are only recorded.
 * off: no classifier; the raw agent trace is recorded (API / synthetic data runs).
 */
export type Mode = "enforce" | "monitor" | "off";

/** What the guardrail did with the event. */
export type Action = "passed" | "flagged" | "blocked";

/** One trace event as it happened in an agent session, with its classification. */
export interface RecordedEvent {
  id: string;
  session_id: string;
  seq: number;
  ts: string;
  event: TraceEvent;
  /** null when the classifier itself failed; see classifier_error. */
  classification: ClassifyResult | null;
  classifier_error?: string | null;
  action: Action;
  /** Mode the event ran under; "off" events were never classified. */
  mode?: Mode | null;
}

/** Lines of the NDJSON stream returned by POST /sessions/{id}/messages. */
export type StreamMessage =
  | { type: "event"; data: RecordedEvent }
  | { type: "done" }
  | { type: "error"; detail: string };

export interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  mode: Mode;
  n_events: number;
  n_violations: number;
  n_review: number;
}

export interface SessionDetail extends SessionSummary {
  events: RecordedEvent[];
}

export type AnalyticsWindow = "24h" | "7d" | "all";

export interface Analytics {
  window: AnalyticsWindow;
  totals: {
    sessions: number;
    events: number;
    violations: number;
    needs_review: number;
    blocked: number;
  };
  /** Verdict counts per time bucket, oldest first. */
  timeline: { bucket: string; allow: number; needs_review: number; violation: number }[];
  /** Non-allow events by category, descending. */
  by_category: { category: string; n: number }[];
  by_kind: Record<EventKind, Record<Verdict, number>>;
  by_rule: { rule: string; n: number }[];
  latency?: { p50_ms: number; p95_ms: number } | null;
  cost_usd_total?: number | null;
  /** Most recent violation / needs_review events, newest first. */
  incidents: RecordedEvent[];
}

export interface Policy {
  id: string;
  version: string;
  /** Markdown source of the policy the classifier is prompted with. */
  text: string;
}

export interface EvalCase {
  id: string;
  kind: EventKind;
  gold: Verdict;
  pred: Verdict | "error";
  correct: boolean;
  rules: string[];
  rationale: string;
  /** Why the gold label was chosen, especially for contested cases. */
  label_note?: string;
  tags?: string[];
}

export interface EvalReport {
  run_id: string;
  model: string;
  policy_version: string;
  created_at: string;
  n: number;
  metrics: {
    accuracy: number;
    violation_precision: number;
    violation_recall: number;
    needs_review_rate: number;
  };
  /** confusion[gold][pred] = count */
  confusion: Record<string, Record<string, number>>;
  by_kind: Record<string, { n: number; accuracy: number }>;
  latency?: { p50_ms: number; p95_ms: number };
  cost_per_event_usd?: number;
  cases: EvalCase[];
}

// --- performance -------------------------------------------------------------

export interface LatencySummary {
  n: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  mean_ms: number | null;
  mean_input_tokens: number | null;
  cost_per_event_usd: number | null;
}

export interface TurnTiming {
  session_id: string;
  started_at: string;
  mode: Mode;
  n_events: number;
  error: string | null;
  agent_ms: number;
  guard_ms: number;
  tool_ms: number;
  total_ms: number;
  classifier_calls: number;
}

export interface PerfReport {
  window: AnalyticsWindow;
  classifier: LatencySummary & { errors: number; error_rate: number; mean_output_tokens: number | null };
  turns: {
    n: number;
    p50_total_ms: number | null;
    p95_total_ms: number | null;
    /** Median fraction of a turn's wall time spent waiting on the guard. */
    median_guard_share: number | null;
    mean_classifier_calls: number | null;
    recent: TurnTiming[];
  };
  throughput: { peak_events_per_min: number; mean_events_per_active_min: number };
  timeline: { bucket: string; n: number; p50_ms: number | null; p95_ms: number | null }[];
  histogram: { start_ms: number; end_ms: number; n: number; overflow: boolean }[];
  scatter: { input_tokens: number; latency_ms: number; kind: EventKind }[];
  by_kind: (LatencySummary & { key: EventKind; hook: string })[];
  by_model: (LatencySummary & { key: string })[];
}

export interface BenchLevel {
  concurrency: number;
  n: number;
  ok: number;
  errors: number;
  error_samples: string[];
  wall_s: number;
  throughput_eps: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  mean_ms: number | null;
  model_p50_ms: number | null;
  overhead_p50_ms: number | null;
  mean_input_tokens: number | null;
  cost_usd: number;
  by_context: { context_events: number; p50_ms: number | null }[];
}

export interface BenchReport {
  run_id: string;
  created_at: string;
  guard_model: string;
  policy: string;
  workload: string;
  levels: BenchLevel[];
}

// --- rules matrix ---------------------------------------------------------------

export interface RulePosition {
  kind: EventKind;
  label: string;
  hook: string;
  description: string;
}

/** rule id -> event kind -> enforced (true) or switched off (false). */
export type RuleScopeMatrix = Record<string, Record<EventKind, boolean>>;

/** One row of policies/<id>/rules.json. `prompt` is what the classifier reads for the rule. */
export interface RuleEntry {
  /** R5 (a top-level rule or definition) or R5.1 (a sub-rule). */
  number: string;
  /** e.g. PERSONAL DATA_person; the part before the first "_" titles the rule group. */
  name: string;
  prompt: string;
}

export interface RulesConfig {
  policy_id: string;
  policy_version: string;
  positions: RulePosition[];
  /** Rule groups (R1..Rn), derived from `entries`; these are the rows of the scope matrix. */
  rules: { id: string; title: string; subrules: string[] }[];
  entries: RuleEntry[];
  scope: RuleScopeMatrix;
}
