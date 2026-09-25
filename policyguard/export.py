"""Turns recorded agent traces into labelable cases: one per event, carrying the prior events
of its session as context. This is the input shape of the eval harness.

`blind=True` strips the guard's opinion so a human labeler isn't anchored by it. A prior
event's guard_action is kept only when it is "blocked": that is a fact about what happened
(the agent never saw that result, or the tool never ran), not an opinion.
"""

from __future__ import annotations

from itertools import groupby
from typing import Any, Iterable, Iterator

from .schemas import RecordedEvent


def _event(rec: RecordedEvent) -> dict[str, Any]:
    return rec.event.model_dump(exclude_none=True)


def to_cases(records: Iterable[RecordedEvent], context_max: int, blind: bool) -> Iterator[dict[str, Any]]:
    ordered = sorted(records, key=lambda r: (r.session_id, r.seq))
    for session_id, group in groupby(ordered, key=lambda r: r.session_id):
        history: list[RecordedEvent] = []
        for rec in group:
            context = []
            for prior in history[-context_max:]:
                item = _event(prior)
                if not blind or prior.action == "blocked":
                    item["guard_action"] = prior.action
                context.append(item)

            case: dict[str, Any] = {
                "id": rec.id,
                "session_id": session_id,
                "seq": rec.seq,
                "ts": rec.ts,
                "mode": rec.mode,
                "event": _event(rec),
                "context": context,
                "label": None,  # to be filled in: {"gold": verdict, "rules": [...], "note": "..."}
            }
            if not blind:
                c = rec.classification
                case["guard"] = {
                    "action": rec.action,
                    "verdict": c.verdict if c else None,
                    "rules": c.rules if c else [],
                    "category": c.category if c else None,
                    "rationale": c.rationale if c else None,
                    "classifier_error": rec.classifier_error,
                }
            yield case
            history.append(rec)
