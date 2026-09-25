"""Hooks, modelled on Claude Code's: callables registered on a HookEvent that the agent loop
runs before an event takes effect. A hook can pass, flag or block the event.

The policy guard is one hook (PolicyGuardHook). Others can be registered alongside it (audit
logging, rate limits, deterministic checks); the most severe action wins.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Protocol, Sequence

from .classifier import Classifier, ClassifierError
from .policy import Policy
from .rule_scope import RuleScope
from .schemas import Action, ClassifyResult, ContextEvent, HookEvent, Mode, TraceEvent

log = logging.getLogger(__name__)

_SEVERITY: dict[Action, int] = {"passed": 0, "flagged": 1, "blocked": 2}


@dataclass
class HookInput:
    hook_event: HookEvent
    event: TraceEvent
    context: Sequence[ContextEvent]
    session_id: str
    mode: Mode


@dataclass
class HookResult:
    action: Action
    classification: Optional[ClassifyResult] = None
    error: Optional[str] = None


class Hook(Protocol):
    name: str

    async def __call__(self, inp: HookInput) -> Optional[HookResult]:
        """Return None to abstain."""
        ...


@dataclass
class HookRegistry:
    hooks: dict[HookEvent, list[Hook]] = field(default_factory=dict)

    def register(self, hook: Hook, events: Sequence[HookEvent] = tuple(HookEvent)) -> None:
        for ev in events:
            self.hooks.setdefault(ev, []).append(hook)

    async def run(self, inp: HookInput) -> HookResult:
        combined = HookResult(action="passed")
        for hook in self.hooks.get(inp.hook_event, []):
            result = await hook(inp)
            if result is None:
                continue
            if _SEVERITY[result.action] > _SEVERITY[combined.action]:
                combined.action = result.action
            # The first hook that produced a verdict is the one recorded on the event.
            combined.classification = combined.classification or result.classification
            combined.error = combined.error or result.error
        return combined


class PolicyGuardHook:
    """Classifies the event against the policy and maps the verdict to an action using the
    policy's enforcement config (policies/<id>/policy.yaml)."""

    name = "policy-guard"

    def __init__(self, policy: Policy, classifier: Classifier, scope: Optional[RuleScope] = None):
        self.policy = policy
        self.classifier = classifier
        self.scope = scope

    async def __call__(self, inp: HookInput) -> Optional[HookResult]:
        if not self.policy.hook_enabled(inp.hook_event):
            return None
        if self.scope is not None and not self.scope.any_enforced(inp.event.kind):
            return None  # every rule switched off at this position: no classifier call at all
        try:
            result = await self.classifier.classify(inp.event, inp.context)
        except ClassifierError as e:
            log.warning("classifier failed on %s: %s", inp.hook_event.value, e)
            return HookResult(action=self.policy.on_classifier_error[inp.mode], error=str(e))
        except Exception as e:  # never let a guard bug take the agent down silently
            log.exception("classifier crashed")
            return HookResult(action=self.policy.on_classifier_error[inp.mode], error=f"Classifier crashed: {e}")
        return HookResult(action=self.policy.action_for(inp.mode, result.verdict), classification=result)
