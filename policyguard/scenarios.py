"""User scenarios: a stretch of a chat session recorded from the UI, with the events where a
person saw the guardrail fail.

Each scenario is saved as bench/user_scenarios/<id>/:

    scenario.json  the recorded events, the guard's decisions, and every marked failure
    cases.jsonl    one labelable case per recorded event (the export.to_cases shape), with
                   `label` set to a verdict, so `scripts/redteam.py replay` can score the
                   current guard on it

A marked event is labeled with the verdict the person said it should have had. An unmarked
event is labeled with the guard's own verdict (`label_source: "unmarked"`): the person watched
it and did not call it a failure. Events the guard never judged (guard off, or a classifier
error) stay unlabeled unless marked.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import export
from .config import ROOT
from .schemas import RecordedEvent, ScenarioIn, ScenarioSummary

# Strictness order, to tell a miss (should have been stricter) from a false positive.
LEVEL = {"allow": 0, "needs_review": 1, "violation": 2}

# The names the recorder uses for each position.
POSITION = {
    "user_input": "user input",
    "tool_call": "tool call",
    "tool_response": "tool result",
    "model_output": "system output",
}


class ScenarioError(ValueError):
    pass


def guard_level(rec: RecordedEvent) -> int:
    """How strict the guard was with this event. With no verdict (guard off, classifier error),
    what happened decides: a blocked event was treated as a violation, anything else as allow."""
    if rec.classification is not None:
        return LEVEL[rec.classification.verdict]
    return LEVEL["violation"] if rec.action == "blocked" else LEVEL["allow"]


def failure_type(rec: RecordedEvent, expected: str) -> str:
    got, want = guard_level(rec), LEVEL[expected]
    if want == got:
        verdict = rec.classification.verdict if rec.classification else f"{rec.action} (no verdict)"
        raise ScenarioError(f"event {rec.seq} ({rec.event.kind}): the guard already treated it as {verdict}")
    return "miss" if want > got else "false_positive"


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40].strip("-") or "scenario"


def _display_path(folder: Path) -> str:
    try:
        return folder.resolve().relative_to(ROOT).as_posix()
    except ValueError:  # USER_SCENARIOS_DIR points outside the repo
        return str(folder)


def save(
    body: ScenarioIn,
    records: list[RecordedEvent],
    out_dir: Path,
    *,
    context_max: int,
    meta: dict[str, Any],
    now: Optional[datetime] = None,
) -> ScenarioSummary:
    """Validate the marks against the session's events and write the scenario folder.

    `records` is the whole session, so cases keep context from before the recording started."""
    recorded = [r for r in records if r.seq >= body.from_seq]
    if not recorded:
        raise ScenarioError("nothing was recorded: the session has no events from that point")
    by_id = {r.id: r for r in recorded}

    failures = []
    for mark in body.marks:
        rec = by_id.get(mark.event_id)
        if rec is None:
            raise ScenarioError(f"event {mark.event_id} is not part of the recording")
        c = rec.classification
        failures.append(
            {
                "event_id": rec.id,
                "seq": rec.seq,
                "kind": rec.event.kind,
                "position": POSITION[rec.event.kind],
                "failure": failure_type(rec, mark.expected),
                "expected": mark.expected,
                "note": mark.note.strip(),
                "guard": {
                    "verdict": c.verdict if c else None,
                    "action": rec.action,
                    "rules": c.rules if c else [],
                    "rationale": c.rationale if c else None,
                    "classifier_error": rec.classifier_error,
                },
                "event": rec.event.model_dump(exclude_none=True),
            }
        )
    if len({f["event_id"] for f in failures}) != len(failures):
        raise ScenarioError("an event is marked more than once")
    failures.sort(key=lambda f: f["seq"])

    now = now or datetime.now(timezone.utc)
    title = body.title.strip() or "Untitled scenario"
    base = f"{now.strftime('%Y%m%dT%H%M%SZ')}-{_slug(title)}"
    out_dir.mkdir(parents=True, exist_ok=True)
    for n in range(1, 100):  # two saves with the same title in the same second
        sid = base if n == 1 else f"{base}-{n}"
        folder = out_dir / sid
        try:
            folder.mkdir()
            break
        except FileExistsError:
            continue
    else:
        raise ScenarioError(f"could not find a free folder name for {base}")

    marked = {f["event_id"]: f for f in failures}
    cases = []
    for case in export.to_cases(records, context_max, blind=False):
        if case["seq"] < body.from_seq:
            continue
        f = marked.get(case["id"])
        if f is not None:
            case.update(label=f["expected"], label_source="user", failure=f["failure"], note=f["note"])
        else:
            case.update(label=case["guard"]["verdict"], label_source="unmarked" if case["guard"]["verdict"] else None)
        # Fields scripts/redteam.py expects of a case.
        case.update(technique=f"user scenario: {title}", results={})
        cases.append(case)

    counts = Counter(f["failure"] for f in failures)
    by_position = Counter(f["position"] for f in failures)
    summary = ScenarioSummary(
        id=sid,
        title=title,
        recorded_at=now.isoformat(),
        path=_display_path(folder),
        n_events=len(recorded),
        n_failures=len(failures),
        n_miss=counts["miss"],
        n_false_positive=counts["false_positive"],
        failures_by_position=dict(by_position),
    )
    scenario = {
        **summary.model_dump(),
        "notes": body.notes.strip(),
        **meta,
        "session_id": recorded[0].session_id,
        "from_seq": body.from_seq,
        "failures": failures,
        "events": [r.model_dump() for r in recorded],
    }
    (folder / "scenario.json").write_text(json.dumps(scenario, indent=2, ensure_ascii=False), encoding="utf-8")
    (folder / "cases.jsonl").write_text(
        "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cases), encoding="utf-8"
    )
    return summary
