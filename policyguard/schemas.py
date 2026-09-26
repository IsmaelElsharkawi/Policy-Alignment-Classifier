"""Wire types. Mirrors web/src/types.ts; see docs/api.md."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

EventKind = Literal["user_input", "model_output", "tool_call", "tool_response"]
Verdict = Literal["allow", "violation", "needs_review"]
Action = Literal["passed", "flagged", "blocked"]
# enforce: violations are stopped. monitor: everything runs, verdicts recorded.
# off: no classifier at all; the raw agent trace is recorded (synthetic data generation).
Mode = Literal["enforce", "monitor", "off"]

EVENT_KINDS: tuple[EventKind, ...] = ("user_input", "model_output", "tool_call", "tool_response")
VERDICTS: tuple[Verdict, ...] = ("allow", "needs_review", "violation")


class HookEvent(str, Enum):
    """Points in the agent loop where hooks run. Named after Claude Code's hook events;
    each corresponds to exactly one trace event kind."""

    USER_PROMPT_SUBMIT = "UserPromptSubmit"  # user_input, before the agent sees it
    PRE_TOOL_USE = "PreToolUse"  # tool_call, before the tool executes
    POST_TOOL_USE = "PostToolUse"  # tool_response, before the result reaches the agent
    PRE_RESPONSE = "PreResponse"  # model_output, before the user sees it


HOOK_FOR_KIND: dict[str, HookEvent] = {
    "user_input": HookEvent.USER_PROMPT_SUBMIT,
    "tool_call": HookEvent.PRE_TOOL_USE,
    "tool_response": HookEvent.POST_TOOL_USE,
    "model_output": HookEvent.PRE_RESPONSE,
}


class TraceEvent(BaseModel):
    kind: EventKind
    content: Optional[str] = None
    tool_name: Optional[str] = None
    arguments: Optional[dict[str, Any]] = None


class ContextEvent(TraceEvent):
    """A prior event as the classifier sees it, including what the guard did with it."""

    guard_action: Optional[Action] = None


class ClassifyMeta(BaseModel):
    model: str
    latency_ms: float
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    cost_usd: Optional[float] = None


class ClassifyResult(BaseModel):
    verdict: Verdict
    rules: list[str] = Field(default_factory=list)
    category: Optional[str] = None
    rationale: str
    evidence: Optional[str] = None
    meta: ClassifyMeta
    # Set when the operator's rule scope changed the classifier's answer: the original
    # verdict and rules, and which cited rules were switched off at this position.
    overridden: Optional[dict[str, Any]] = None


class RecordedEvent(BaseModel):
    id: str
    session_id: str
    seq: int
    ts: str
    event: TraceEvent
    classification: Optional[ClassifyResult] = None
    classifier_error: Optional[str] = None
    action: Action
    # Mode the event ran under; "off" events were never classified.
    mode: Optional[Mode] = None


class SessionSummary(BaseModel):
    id: str
    title: str
    created_at: str
    mode: Mode
    n_events: int = 0
    n_violations: int = 0
    n_review: int = 0


class SessionDetail(SessionSummary):
    events: list[RecordedEvent]


# --- request bodies ---------------------------------------------------------


class ClassifyRequest(BaseModel):
    event: TraceEvent
    context: list[TraceEvent] = Field(default_factory=list)


class CreateSessionRequest(BaseModel):
    mode: Mode = "enforce"


class SendMessageRequest(BaseModel):
    content: str = Field(min_length=1)
    mode: Mode = "enforce"


class RuleEntryIn(BaseModel):
    """A new row for the rule table. Validated further by RuleBook (number format, uniqueness)."""

    number: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=1, max_length=80)
    prompt: str = Field(min_length=1, max_length=4000)


class RunRequest(BaseModel):
    """One human prompt. Omit session_id to start a fresh session (fresh sandbox)."""

    prompt: str = Field(min_length=1)
    session_id: Optional[str] = None
    mode: Mode = "enforce"


class TurnUsage(BaseModel):
    agent_calls: int = 0
    agent_input_tokens: int = 0
    agent_output_tokens: int = 0
    agent_cost_usd: float = 0.0
    classifier_calls: int = 0
    classifier_cost_usd: float = 0.0
    # Wall-clock breakdown of the turn (ms). total_ms also includes storage and the time the
    # caller spends consuming each yielded event (e.g. writing it to the HTTP stream).
    agent_ms: float = 0.0
    guard_ms: float = 0.0
    tool_ms: float = 0.0
    total_ms: float = 0.0

    @property
    def total_cost_usd(self) -> float:
        return self.agent_cost_usd + self.classifier_cost_usd


class RunResponse(BaseModel):
    session_id: str
    # Every trace event of this turn, in order, with the guard's verdict and action.
    events: list[RecordedEvent]
    # What the user would see: model_output texts that were not blocked.
    reply: str
    turn_stopped: bool  # the prompt itself was blocked at UserPromptSubmit
    n_blocked: int
    n_flagged: int
    error: Optional[str] = None
    latency_ms: float
    usage: TurnUsage
    total_cost_usd: float


# --- user scenarios ---------------------------------------------------------


class ScenarioMark(BaseModel):
    """One event where the person recording saw the guardrail fail: the verdict it should
    have had. Whether that makes it a miss or a false positive follows from the guard's own."""

    event_id: str
    expected: Verdict
    note: str = Field(default="", max_length=4000)


class ScenarioIn(BaseModel):
    """A recorded stretch of a chat session: every event from `from_seq` on, plus the marks."""

    session_id: str
    from_seq: int = Field(default=0, ge=0)
    title: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=8000)
    marks: list[ScenarioMark] = Field(default_factory=list)


class ScenarioSummary(BaseModel):
    id: str
    title: str
    recorded_at: str
    # Folder the scenario was written to (relative to the repo when it is inside it).
    path: str
    n_events: int
    n_failures: int
    n_miss: int  # the guard should have been stricter
    n_false_positive: int  # the guard should have been more lenient
    # "user input" / "tool call" / "tool result" / "system output" -> marked failures
    failures_by_position: dict[str, int] = Field(default_factory=dict)
