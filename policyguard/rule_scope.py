"""Operator switchboard: which policy rules are enforced at which trace position.

A matrix of top-level rule (R1..R7) x event kind -> enforced (True) or switched off (False).
Switching off a rule switches off its sub-rules too (R3 off => R3.1..R3.4 off). Stored in
policies/<id>/rule_scope.json next to the policy, edited from the Rules tab, and applied
immediately. A missing file means every rule is enforced everywhere, which is exactly the
policy as written. Rules added to the rule table later start enforced everywhere; removing a
rule group drops its row.

Effect of a switched-off cell (see classifier.py and hooks.py):
  - the classifier is told which rules are off for that event kind;
  - if a non-allow verdict still cites only switched-off rules, it is overridden to allow
    (the original verdict is kept on the record);
  - if every rule is off for an event kind, the classifier is not called at that hook.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .policy import Policy, write_json_atomic
from .schemas import EVENT_KINDS

POSITIONS = EVENT_KINDS  # user_input, model_output, tool_call, tool_response


def top_level(rule_id: str) -> str:
    return rule_id.split(".")[0]


class RuleScope:
    def __init__(self, policy: Policy, path: Path):
        self.policy = policy
        self.path = path
        self._lock = threading.Lock()
        self._matrix = self._defaults()
        if path.exists():
            self._matrix.update(self._validate(json.loads(path.read_text(encoding="utf-8")).get("scope", {}), partial=True))

    def _defaults(self) -> dict[str, dict[str, bool]]:
        return {r.id: {k: True for k in POSITIONS} for r in self.policy.rules}

    def _validate(self, scope: dict, partial: bool = False) -> dict[str, dict[str, bool]]:
        known = {r.id for r in self.policy.rules}
        out: dict[str, dict[str, bool]] = {}
        for rid, cells in scope.items():
            if rid not in known:
                if partial:  # stale file: a rule was renamed or removed from rules.json
                    continue
                raise ValueError(f"Unknown rule {rid!r}; policy has {sorted(known)}")
            if not isinstance(cells, dict) or set(cells) - set(POSITIONS):
                raise ValueError(f"{rid}: cells must be a subset of {list(POSITIONS)}")
            out[rid] = {k: bool(cells.get(k, True)) for k in POSITIONS}
        return out

    # --- queries ------------------------------------------------------------

    def is_enforced(self, rule_id: str, kind: str) -> bool:
        return self._matrix.get(top_level(rule_id), {}).get(kind, True)

    def disabled(self, kind: str) -> list[str]:
        return [r.id for r in self.policy.rules if not self.is_enforced(r.id, kind)]

    def any_enforced(self, kind: str) -> bool:
        return any(self.is_enforced(r.id, kind) for r in self.policy.rules)

    def as_dict(self) -> dict[str, dict[str, bool]]:
        """The matrix for the policy's current rule groups (new groups default to enforced)."""
        return {r.id: dict(self._matrix.get(r.id, {k: True for k in POSITIONS})) for r in self.policy.rules}

    # --- updates ------------------------------------------------------------

    def replace(self, scope: dict) -> None:
        """Replace the whole matrix (rules missing from `scope` revert to enforced)."""
        matrix = self._defaults()
        matrix.update(self._validate(scope))
        with self._lock:
            self._matrix = matrix
            self._write()

    def prune(self) -> None:
        """Drop rows for rule groups no longer in the rule table, so a removed-then-re-added
        group starts enforced instead of inheriting old switches."""
        with self._lock:
            known = {r.id for r in self.policy.rules}
            if set(self._matrix) - known:
                self._matrix = {rid: cells for rid, cells in self._matrix.items() if rid in known}
                if self.path.exists():
                    self._write()

    def _write(self) -> None:
        body = {
            "policy": self.policy.id,
            "policy_version": self.policy.version,
            "note": "Edited from the Rules tab. true = rule enforced at that position; false = switched off.",
            "scope": self.as_dict(),
        }
        write_json_atomic(self.path, body)
