// Recording user scenarios: the same rules as policyguard/scenarios.py, so the UI can say
// "missed" or "false positive" before the server does.

import type { EventKind, RecordedEvent, Verdict } from "./types";

/** The names the recorder uses for each position. */
export const POSITION: Record<EventKind, string> = {
  user_input: "user input",
  tool_call: "tool call",
  tool_response: "tool result",
  model_output: "system output",
};

const LEVEL: Record<Verdict, number> = { allow: 0, needs_review: 1, violation: 2 };

/** How strict the guard was. With no verdict (guard off, classifier error), a blocked event
 * counts as a violation and anything else as allow. */
export function guardLevel(rec: RecordedEvent): number {
  if (rec.classification) return LEVEL[rec.classification.verdict];
  return rec.action === "blocked" ? LEVEL.violation : LEVEL.allow;
}

/** The verdict equivalent of what the guard did; marking it as "expected" is not a failure. */
export function guardVerdict(rec: RecordedEvent): Verdict {
  return (["allow", "needs_review", "violation"] as Verdict[])[guardLevel(rec)];
}

export type FailureType = "miss" | "false_positive";

export function failureType(rec: RecordedEvent, expected: Verdict): FailureType | null {
  const got = guardLevel(rec);
  const want = LEVEL[expected];
  return want === got ? null : want > got ? "miss" : "false_positive";
}

export const FAILURE_LABEL: Record<FailureType, string> = {
  miss: "missed",
  false_positive: "false positive",
};

/** A mark while recording, keyed by event id. */
export interface Mark {
  expected: Verdict;
  note: string;
}

export interface Recording {
  /** Index into the session's events where the recording starts. */
  fromIndex: number;
  marks: Record<string, Mark>;
}
