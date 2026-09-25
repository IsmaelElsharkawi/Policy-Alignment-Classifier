"""Loads a policy from policies/<id>/ (policy.md + rules.json + policy.yaml). See policies/README.md."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import yaml

from .schemas import VERDICTS, Action, HookEvent

_GUARD_ACTIONS = {"pass": "passed", "flag": "flagged", "block": "blocked"}
_RULE_NUMBER = re.compile(r"^R(\d+)(?:\.(\d+))?$")


class PolicyError(ValueError):
    pass


@dataclass(frozen=True)
class RuleInfo:
    """A top-level rule (R3, titled Secrets) and the ids of its sub-rules (R3.1, R3.2, ...)."""

    id: str
    title: str
    subrules: tuple[str, ...]


@dataclass(frozen=True)
class RuleEntry:
    """One row of rules.json. `prompt` is the text the classifier reads for this rule."""

    number: str  # R5 (a top-level rule or definition) or R5.1 (a sub-rule)
    name: str  # e.g. PERSONAL DATA_person; the part before the first "_" titles the group
    prompt: str

    @property
    def group(self) -> str:
        return self.number.split(".")[0]


def _sort_key(number: str) -> tuple[int, int]:
    m = _RULE_NUMBER.match(number)
    assert m
    return int(m.group(1)), int(m.group(2) or -1)  # the group-level entry sorts first


def write_json_atomic(path: Path, body) -> None:
    # Atomic write so a crash mid-save never leaves a half-written file.
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(body, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


class RuleBook:
    """The rule table in policies/<id>/rules.json, editable at runtime from the Rules tab.

    Entries are grouped by top-level number (R5, R5.1, R5.2 -> group R5). Groups are what the
    rule scope switches on and off per position; entries are what verdicts cite. `revision`
    changes on every edit so the classifier knows to rebuild its system prompt.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise PolicyError(f"{path}: expected a JSON list of {{number, name, prompt}}")
        entries: list[RuleEntry] = []
        for i, item in enumerate(raw):
            try:
                entries.append(self._validate(item, [e.number for e in entries]))
            except ValueError as e:
                raise PolicyError(f"{path}[{i}]: {e}") from e
        if not entries:
            raise PolicyError(f"{path} has no rules")
        self._entries = tuple(sorted(entries, key=lambda e: _sort_key(e.number)))
        self.revision = 0

    @staticmethod
    def _validate(item, taken: list[str]) -> RuleEntry:
        if not isinstance(item, dict):
            raise ValueError("each rule must be an object with number, name and prompt")
        number = str(item.get("number", "")).strip()
        name = str(item.get("name", "")).strip()
        prompt = " ".join(str(item.get("prompt", "")).split())
        if not _RULE_NUMBER.match(number):
            raise ValueError(f"number {number!r} must look like R5 or R5.1")
        if number in taken:
            raise ValueError(f"rule {number} already exists")
        if not name:
            raise ValueError(f"{number}: name is required")
        if not prompt:
            raise ValueError(f"{number}: prompt is required")
        return RuleEntry(number=number, name=name, prompt=prompt)

    # --- queries ------------------------------------------------------------

    @property
    def entries(self) -> tuple[RuleEntry, ...]:
        return self._entries

    @property
    def groups(self) -> tuple[RuleInfo, ...]:
        members: dict[str, list[RuleEntry]] = {}
        for e in self._entries:
            members.setdefault(e.group, []).append(e)
        infos = []
        for gid, group in members.items():
            head = next((e for e in group if e.number == gid), group[0])
            infos.append(
                RuleInfo(
                    id=gid,
                    title=head.name.split("_")[0].strip(),
                    subrules=tuple(e.number for e in group if e.number != gid),
                )
            )
        return tuple(infos)

    @property
    def rule_ids(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(i for g in self.groups for i in (g.id, *g.subrules)))

    def render(self) -> str:
        """The "## Rules" section of the classifier prompt."""
        lines = ["## Rules"]
        for g in self.groups:
            lines += ["", f"### {g.id} — {g.title}"]
            lines += [f"- **{e.number}** {e.prompt}" for e in self._entries if e.group == g.id]
        return "\n".join(lines)

    # --- updates ------------------------------------------------------------

    def add(self, item: dict) -> RuleEntry:
        with self._lock:
            entry = self._validate(item, [e.number for e in self._entries])
            self._commit(tuple(sorted((*self._entries, entry), key=lambda e: _sort_key(e.number))))
        return entry

    def remove(self, number: str) -> None:
        with self._lock:
            kept = tuple(e for e in self._entries if e.number != number)
            if len(kept) == len(self._entries):
                raise KeyError(number)
            if not kept:
                raise ValueError("The policy needs at least one rule")
            self._commit(kept)

    def _commit(self, entries: tuple[RuleEntry, ...]) -> None:
        write_json_atomic(self.path, [{"number": e.number, "name": e.name, "prompt": e.prompt} for e in entries])
        self._entries = entries
        self.revision += 1


@dataclass(frozen=True)
class Policy:
    id: str
    version: str
    title: str
    preamble: str  # policy.md: deployment, trust model, anything that isn't a rule
    rulebook: RuleBook
    hooks: dict[HookEvent, bool]
    actions: dict[str, dict[str, Action]]  # mode -> verdict -> action
    on_classifier_error: dict[str, Action]  # mode -> action
    context_max_events: int
    context_max_chars: int
    categories: dict[str, str]  # name -> description shown to the classifier

    @property
    def text(self) -> str:
        """The exact policy text the classifier is prompted with."""
        return f"{self.preamble}\n\n{self.rulebook.render()}"

    @property
    def rules(self) -> tuple[RuleInfo, ...]:
        return self.rulebook.groups

    @property
    def rule_ids(self) -> tuple[str, ...]:
        return self.rulebook.rule_ids

    def action_for(self, mode: str, verdict: str) -> Action:
        return self.actions[mode][verdict]

    def hook_enabled(self, hook: HookEvent) -> bool:
        return self.hooks.get(hook, False)


def _action(value: str, where: str) -> Action:
    if value not in _GUARD_ACTIONS:
        raise PolicyError(f"{where}: expected one of {sorted(_GUARD_ACTIONS)}, got {value!r}")
    return _GUARD_ACTIONS[value]  # type: ignore[return-value]


def _categories(raw) -> dict[str, str]:
    if not raw:
        return {"unclear": "no better fit"}
    if isinstance(raw, list):  # plain list of names is still accepted
        return {str(name): "" for name in raw}
    return {str(k): str(v or "") for k, v in raw.items()}


def load_policy(policies_dir: Path, policy_id: str) -> Policy:
    root = policies_dir / policy_id
    md_path, yaml_path, rules_path = root / "policy.md", root / "policy.yaml", root / "rules.json"
    if not all(p.exists() for p in (md_path, yaml_path, rules_path)):
        raise PolicyError(f"Policy {policy_id!r} needs {md_path}, {rules_path} and {yaml_path}")

    text = md_path.read_text(encoding="utf-8").strip()
    cfg = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}

    hooks = {}
    for name, enabled in (cfg.get("hooks") or {}).items():
        try:
            hooks[HookEvent(name)] = bool(enabled)
        except ValueError:
            raise PolicyError(f"Unknown hook {name!r}; expected one of {[h.value for h in HookEvent]}")

    actions: dict[str, dict[str, Action]] = {}
    for mode in ("enforce", "monitor"):
        per_mode = (cfg.get("actions") or {}).get(mode) or {}
        missing = [v for v in VERDICTS if v not in per_mode]
        if missing:
            raise PolicyError(f"actions.{mode} is missing verdicts {missing}")
        actions[mode] = {v: _action(per_mode[v], f"actions.{mode}.{v}") for v in VERDICTS}

    on_error_cfg = cfg.get("on_classifier_error") or {"enforce": "block", "monitor": "flag"}
    on_error = {m: _action(on_error_cfg[m], f"on_classifier_error.{m}") for m in ("enforce", "monitor")}

    ctx = cfg.get("context") or {}
    return Policy(
        id=str(cfg.get("id", policy_id)),
        version=str(cfg.get("version", "0")),
        title=str(cfg.get("title", policy_id)),
        preamble=text,
        rulebook=RuleBook(rules_path),
        hooks=hooks,
        actions=actions,
        on_classifier_error=on_error,
        context_max_events=int(ctx.get("max_events", 12)),
        context_max_chars=int(ctx.get("max_chars_per_event", 1500)),
        categories=_categories(cfg.get("categories")),
    )
