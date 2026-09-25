"""The policy alignment classifier: one prompted LLM call per trace event."""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Optional, Protocol, Sequence

import anthropic

from .pricing import cost_usd
from .policy import Policy
from .prompts import build_system_prompt, output_schema, render_user_message
from .schemas import ClassifyMeta, ClassifyResult, TraceEvent

if TYPE_CHECKING:
    from .rule_scope import RuleScope

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClassifierError(RuntimeError):
    pass


class Classifier(Protocol):
    async def classify(self, event: TraceEvent, context: Sequence[TraceEvent]) -> ClassifyResult: ...


def supports_effort(model: str) -> bool:
    # Haiku 4.5 rejects output_config.effort.
    return not model.startswith("claude-haiku")


def supports_fallbacks(model: str) -> bool:
    return model.startswith(("claude-opus-5", "claude-fable-5-1"))


class LLMClassifier:
    def __init__(
        self,
        client: anthropic.AsyncAnthropic,
        policy: Policy,
        model: str,
        effort: Optional[str] = "low",
        use_fallbacks: bool = True,
        scope: Optional[RuleScope] = None,
    ):
        self.client = client
        self.policy = policy
        self.model = model
        self.effort = effort if supports_effort(model) else None
        self.use_fallbacks = use_fallbacks and supports_fallbacks(model)
        self._system: list[dict] = []
        self._system_revision: Optional[int] = None
        self._schema = output_schema(policy)
        self.scope = scope

    def _system_blocks(self) -> list[dict]:
        # Stable until the rule table is edited, so the prefix can be cached.
        if self._system_revision != self.policy.rulebook.revision:
            self._system = [
                {"type": "text", "text": build_system_prompt(self.policy), "cache_control": {"type": "ephemeral"}}
            ]
            self._system_revision = self.policy.rulebook.revision
        return self._system

    async def classify(self, event: TraceEvent, context: Sequence[TraceEvent] = ()) -> ClassifyResult:
        disabled = self.scope.disabled(event.kind) if self.scope else []
        output_config: dict = {"format": {"type": "json_schema", "schema": self._schema}}
        if self.effort:
            output_config["effort"] = self.effort
        request = dict(
            model=self.model,
            # Room for adaptive thinking plus a short JSON verdict.
            max_tokens=4096,
            system=self._system_blocks(),
            messages=[{"role": "user", "content": render_user_message(self.policy, event, context, disabled)}],
            output_config=output_config,
        )

        start = time.perf_counter()
        try:
            if self.use_fallbacks:
                resp = await self.client.beta.messages.create(
                    **request, betas=[FALLBACK_BETA], fallbacks="default"
                )
            else:
                resp = await self.client.messages.create(**request)
        except TypeError as e:  # the SDK raises TypeError when no credentials resolve
            raise ClassifierError(f"No Anthropic credentials configured (set ANTHROPIC_API_KEY): {e}") from e
        except anthropic.APIConnectionError as e:
            raise ClassifierError(f"Classifier API unreachable: {e}") from e
        except anthropic.RateLimitError as e:
            raise ClassifierError("Classifier rate limited") from e
        except anthropic.APIStatusError as e:
            raise ClassifierError(f"Classifier API error {e.status_code}: {e.message}") from e
        latency_ms = (time.perf_counter() - start) * 1000

        if resp.stop_reason == "refusal":
            raise ClassifierError("Classifier model declined to classify this event")
        if resp.stop_reason == "max_tokens":
            raise ClassifierError("Classifier ran out of tokens before producing a verdict")

        text = next((b.text for b in resp.content if b.type == "text"), None)
        if text is None:
            raise ClassifierError("Classifier returned no verdict")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise ClassifierError(f"Classifier returned invalid JSON: {text[:200]}") from e

        usage = resp.usage
        result = ClassifyResult(
            verdict=data["verdict"],
            rules=[r for r in data.get("rules", []) if r],
            category=None if data["verdict"] == "allow" or data.get("category") == "none" else data.get("category"),
            rationale=data.get("rationale", ""),
            evidence=data.get("evidence") or None,
            meta=ClassifyMeta(
                model=resp.model,
                latency_ms=round(latency_ms, 1),
                input_tokens=(usage.input_tokens or 0)
                + (usage.cache_read_input_tokens or 0)
                + (usage.cache_creation_input_tokens or 0),
                output_tokens=usage.output_tokens,
                cache_read_tokens=usage.cache_read_input_tokens,
                cost_usd=cost_usd(resp.model, usage),
            ),
        )
        return apply_scope(result, event.kind, self.scope) if self.scope else result


def apply_scope(result: ClassifyResult, kind: str, scope: "RuleScope") -> ClassifyResult:
    """Deterministic backstop for the operator's rule scope: drop switched-off rules from the
    citation, and if a non-allow verdict rested only on switched-off rules, make it allow.
    A needs_review that cites no rule is left alone (nothing to attribute it to)."""
    off = [r for r in result.rules if not scope.is_enforced(r, kind)]
    if not off:
        return result
    kept = [r for r in result.rules if scope.is_enforced(r, kind)]
    overridden = {"verdict": result.verdict, "rules": result.rules, "switched_off": off}
    if result.verdict != "allow" and not kept:
        return result.model_copy(
            update={
                "verdict": "allow",
                "rules": [],
                "category": None,
                "evidence": None,
                "rationale": f"[Allowed: {', '.join(off)} switched off for {kind}] {result.rationale}",
                "overridden": overridden,
            }
        )
    return result.model_copy(update={"rules": kept, "overridden": overridden})
