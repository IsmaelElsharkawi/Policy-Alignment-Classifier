"""Runtime settings, read from the environment (and .env if present)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _opt(name: str, default: Optional[str]) -> Optional[str]:
    value = os.environ.get(name, default)
    return value or None


@dataclass(frozen=True)
class Settings:
    # The agent being guarded (Opus 5) and the classifier guarding it (Haiku 4.5). The
    # classifier runs on every event on the request path, so it is the latency/cost lever.
    agent_model: str = os.environ.get("AGENT_MODEL", "claude-opus-5")
    guard_model: str = os.environ.get("GUARD_MODEL", "claude-haiku-4-5")
    # Only used if GUARD_MODEL supports effort (Haiku 4.5 does not). Agent effort is left
    # at the API default unless set.
    guard_effort: Optional[str] = _opt("GUARD_EFFORT", "low")
    agent_effort: Optional[str] = _opt("AGENT_EFFORT", None)
    # Server-side refusal fallbacks (Opus 5 / Fable 5.1). On a safety decline the request is
    # re-run on Anthropic's recommended fallback model; the served model is recorded.
    use_fallbacks: bool = os.environ.get("USE_FALLBACKS", "1") == "1"

    policy_id: str = os.environ.get("POLICY", "coding-agent")
    policies_dir: Path = Path(os.environ.get("POLICIES_DIR", ROOT / "policies"))
    data_dir: Path = Path(os.environ.get("DATA_DIR", ROOT / "data"))
    eval_results_dir: Path = Path(os.environ.get("EVAL_RESULTS_DIR", ROOT / "eval" / "results"))
    bench_results_dir: Path = Path(os.environ.get("BENCH_RESULTS_DIR", ROOT / "bench" / "results"))
    web_dist: Path = ROOT / "web" / "dist"

    max_agent_steps: int = int(os.environ.get("MAX_AGENT_STEPS", "10"))

    # The coding agent's tools run for real. AGENT_WORKSPACE pins every session to one existing
    # directory; otherwise each session gets data/workspaces/<id>/, cloned from AGENT_REPO if set.
    agent_workspace: Optional[str] = _opt("AGENT_WORKSPACE", None)
    agent_repo: Optional[str] = _opt("AGENT_REPO", None)
    command_timeout_s: float = float(os.environ.get("COMMAND_TIMEOUT", "120"))
    host: str = os.environ.get("HOST", "127.0.0.1")
    port: int = int(os.environ.get("PORT", "8000"))


settings = Settings()
