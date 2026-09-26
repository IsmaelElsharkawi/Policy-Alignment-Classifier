"""The agent harness: a Claude Code-style agentic loop with hooks at every point where the
agent's trace changes the world or the agent's context.

    user message ──UserPromptSubmit──► model ──► text ──PreResponse──► user
                                         │
                                         └─► tool_use ──PreToolUse──► tool ──PostToolUse──► model

Every trace event passes through the hook registry *before* it takes effect, is recorded with
the guard's verdict, and is yielded to the caller (the API streams it to the UI).

What "blocked" does, by position:
  user_input     the turn stops; the message never enters the agent's history
  tool_call      the tool is not executed; the agent gets an error tool_result saying why
  tool_response  the result is replaced with a withheld notice before the agent sees it
  model_output   the text is not shown to the user; the agent is told on its next turn

History is append-only: the agent's own assistant messages are stored exactly as returned
(thinking blocks included) and never edited; guard notices are appended as new content.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, AsyncIterator, Optional, Protocol

import anthropic

from .classifier import FALLBACK_BETA, supports_effort, supports_fallbacks
from .hooks import HookInput, HookRegistry, HookResult
from .pricing import cost_usd
from .schemas import HOOK_FOR_KIND, ContextEvent, Mode, RecordedEvent, TraceEvent, TurnUsage
from .store import Store, now_iso
from .tools import CODING, Sandbox, Toolkit

log = logging.getLogger(__name__)

REFUSAL_TEXT = "I can't help with that request."


class HarnessError(RuntimeError):
    pass


class MessagesClient(Protocol):
    """The slice of AsyncAnthropic the harness needs (lets tests substitute a fake)."""

    messages: Any
    beta: Any


class AgentHarness:
    def __init__(
        self,
        client: MessagesClient,
        hooks: HookRegistry,
        store: Store,
        *,
        model: str,
        effort: Optional[str] = None,
        use_fallbacks: bool = True,
        max_steps: int = 10,
        context_events: int = 40,
        toolkit: Toolkit = CODING,
    ):
        self.client = client
        self.hooks = hooks
        self.store = store
        self.model = model
        self.effort = effort if effort and supports_effort(model) else None
        self.use_fallbacks = use_fallbacks and supports_fallbacks(model)
        self.max_steps = max_steps
        self.context_events = context_events
        self.toolkit = toolkit
        self._sandboxes: dict[str, Sandbox] = {}

    def sandbox(self, session_id: str) -> Sandbox:
        if session_id not in self._sandboxes:
            self._sandboxes[session_id] = self.toolkit.new_sandbox()
        return self._sandboxes[session_id]

    # --- guard --------------------------------------------------------------

    async def _guard(
        self, session_id: str, event: TraceEvent, mode: Mode, usage: Optional[TurnUsage] = None
    ) -> RecordedEvent:
        """Run hooks on an event, persist the outcome, and return it."""
        if mode == "off":
            result = HookResult(action="passed")
        else:
            prior = self.store.session_events(session_id)[-self.context_events :]
            context = [ContextEvent(**p.event.model_dump(), guard_action=p.action) for p in prior]
            t0 = time.perf_counter()
            result = await self.hooks.run(
                HookInput(
                    hook_event=HOOK_FOR_KIND[event.kind],
                    event=event,
                    context=context,
                    session_id=session_id,
                    mode=mode,
                )
            )
            if usage is not None:
                usage.guard_ms += (time.perf_counter() - t0) * 1000
            if usage is not None and (result.classification or result.error):
                usage.classifier_calls += 1
                if result.classification and result.classification.meta.cost_usd:
                    usage.classifier_cost_usd += result.classification.meta.cost_usd
        rec = RecordedEvent(
            id=f"ev_{uuid.uuid4().hex[:12]}",
            session_id=session_id,
            seq=self.store.next_seq(session_id),
            ts=now_iso(),
            event=event,
            classification=result.classification,
            classifier_error=result.error,
            action=result.action,
            mode=mode,
        )
        self.store.add_event(rec)
        return rec

    @staticmethod
    def _reason(rec: RecordedEvent) -> str:
        c = rec.classification
        if c is None:
            return f"the policy guard could not classify it ({rec.classifier_error})"
        rules = f" ({', '.join(c.rules)})" if c.rules else ""
        return f"policy{rules}: {c.rationale}"

    # --- model --------------------------------------------------------------

    async def _call_model(self, messages: list[dict[str, Any]]):
        request: dict[str, Any] = dict(
            model=self.model,
            max_tokens=16000,
            system=self.toolkit.system_prompt,
            messages=messages,
            cache_control={"type": "ephemeral"},
        )
        if self.toolkit.definitions:
            request["tools"] = self.toolkit.definitions
        if self.effort:
            request["output_config"] = {"effort": self.effort}
        try:
            if self.use_fallbacks:
                return await self.client.beta.messages.create(**request, betas=[FALLBACK_BETA], fallbacks="default")
            return await self.client.messages.create(**request)
        except TypeError as e:  # the SDK raises TypeError when no credentials resolve
            raise HarnessError("No Anthropic credentials configured: set ANTHROPIC_API_KEY in .env") from e
        except anthropic.APIConnectionError as e:
            raise HarnessError(f"Agent model unreachable: {e}") from e
        except anthropic.AuthenticationError as e:
            raise HarnessError("Agent model authentication failed: set ANTHROPIC_API_KEY") from e
        except anthropic.RateLimitError as e:
            raise HarnessError("Agent model rate limited; try again shortly") from e
        except anthropic.APIStatusError as e:
            raise HarnessError(f"Agent model error {e.status_code}: {e.message}") from e

    # --- loop ---------------------------------------------------------------

    async def run_turn(
        self, session_id: str, user_text: str, mode: Mode, usage: Optional[TurnUsage] = None
    ) -> AsyncIterator[RecordedEvent]:
        """Run one user turn, yielding each trace event as it is guarded. Token, cost and
        timing totals are accumulated into `usage` (if given) and the turn is recorded for
        performance analytics."""
        usage = usage if usage is not None else TurnUsage()
        started_at, start = now_iso(), time.perf_counter()
        n_events, error = 0, None
        try:
            async for rec in self._turn(session_id, user_text, mode, usage):
                n_events += 1
                yield rec
        except Exception as e:
            error = str(e)
            raise
        finally:
            usage.total_ms = (time.perf_counter() - start) * 1000
            self.store.add_turn(session_id, started_at, mode, n_events, usage, error)

    async def _turn(
        self, session_id: str, user_text: str, mode: Mode, usage: TurnUsage
    ) -> AsyncIterator[RecordedEvent]:
        messages, notes = self.store.load_agent_state(session_id)
        if not messages:
            self.store.update_session(session_id, title=user_text.strip()[:80])
        self.store.update_session(session_id, mode=mode)

        # UserPromptSubmit
        rec = await self._guard(session_id, TraceEvent(kind="user_input", content=user_text), mode, usage)
        yield rec
        if rec.action == "blocked":
            return

        user_content: list[dict[str, Any]] = [{"type": "text", "text": n} for n in notes]
        user_content.append({"type": "text", "text": user_text})
        messages.append({"role": "user", "content": user_content})
        notes = []

        try:
            for _ in range(self.max_steps):
                t0 = time.perf_counter()
                resp = await self._call_model(messages)
                if usage is not None:
                    usage.agent_ms += (time.perf_counter() - t0) * 1000
                    _add_agent_usage(usage, resp)
                # Stored exactly as returned (thinking and fallback blocks included).
                if resp.content:
                    messages.append({"role": "assistant", "content": [b.to_dict() for b in resp.content]})

                if resp.stop_reason == "refusal":
                    rec = await self._guard(session_id, TraceEvent(kind="model_output", content=REFUSAL_TEXT), mode, usage)
                    yield rec
                    return

                tool_results: list[dict[str, Any]] = []
                for block in resp.content:
                    if block.type == "text" and block.text.strip():
                        # PreResponse
                        rec = await self._guard(session_id, TraceEvent(kind="model_output", content=block.text), mode, usage)
                        yield rec
                        if rec.action == "blocked":
                            notes.append(
                                f"[Policy guard] Your message beginning {block.text[:60]!r} was withheld "
                                f"from the user: {self._reason(rec)}"
                            )

                    elif block.type == "tool_use":
                        args = dict(block.input) if isinstance(block.input, dict) else {}
                        # PreToolUse
                        rec = await self._guard(
                            session_id, TraceEvent(kind="tool_call", tool_name=block.name, arguments=args), mode, usage
                        )
                        yield rec
                        if rec.action == "blocked":
                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": block.id,
                                    "content": f"Blocked by the policy guard, not executed. Reason: {self._reason(rec)}",
                                    "is_error": True,
                                }
                            )
                            continue

                        t0 = time.perf_counter()
                        content, is_error = await self.sandbox(session_id).execute(block.name, args)
                        if usage is not None:
                            usage.tool_ms += (time.perf_counter() - t0) * 1000
                        # PostToolUse
                        rec = await self._guard(
                            session_id, TraceEvent(kind="tool_response", tool_name=block.name, content=content), mode, usage
                        )
                        yield rec
                        if rec.action == "blocked":
                            content = f"[Result withheld by the policy guard. Reason: {self._reason(rec)}]"
                        tool_results.append(
                            {"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error}
                        )

                if resp.stop_reason == "tool_use":
                    # All results in one user message; guard notices ride along after them.
                    messages.append(
                        {"role": "user", "content": tool_results + [{"type": "text", "text": n} for n in notes]}
                    )
                    notes = []
                    continue
                if resp.stop_reason == "max_tokens":
                    raise HarnessError("Agent response hit max_tokens")
                return  # end_turn
            raise HarnessError(f"Agent did not finish within {self.max_steps} steps")
        finally:
            _close_dangling_tool_uses(messages)
            self.store.save_agent_state(session_id, messages, notes)


def _close_dangling_tool_uses(messages: list[dict[str, Any]]) -> None:
    """If a turn was interrupted after the model asked for tools but before their results were
    appended, add error results so the history stays valid for the next request."""
    if not messages or messages[-1]["role"] != "assistant":
        return
    pending = [b["id"] for b in messages[-1]["content"] if isinstance(b, dict) and b.get("type") == "tool_use"]
    if pending:
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": tid, "content": "Interrupted before completion.", "is_error": True}
                    for tid in pending
                ],
            }
        )


def _add_agent_usage(usage: TurnUsage, resp: Any) -> None:
    u = getattr(resp, "usage", None)
    usage.agent_calls += 1
    if u is None:
        return
    usage.agent_input_tokens += (
        (u.input_tokens or 0) + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0)
    )
    usage.agent_output_tokens += u.output_tokens or 0
    usage.agent_cost_usd += cost_usd(resp.model, u) or 0.0
