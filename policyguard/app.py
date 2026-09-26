"""HTTP API for the web app. Contract: docs/api.md."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal, Optional

import anthropic
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import analytics, export, perf
from .classifier import ClassifierError, LLMClassifier
from .config import settings
from .harness import AgentHarness, HarnessError
from .hooks import HookRegistry, PolicyGuardHook
from .policy import load_policy
from .rule_scope import RuleScope
from .schemas import (
    ClassifyRequest,
    ClassifyResult,
    CreateSessionRequest,
    RecordedEvent,
    RuleEntryIn,
    RunRequest,
    RunResponse,
    SendMessageRequest,
    SessionDetail,
    SessionSummary,
    TurnUsage,
)
from .store import Store
from .tools import CODING

log = logging.getLogger("policyguard")


class Services:
    def __init__(self) -> None:
        self.policy = load_policy(settings.policies_dir, settings.policy_id)
        self.scope = RuleScope(self.policy, settings.policies_dir / settings.policy_id / "rule_scope.json")
        self.client = anthropic.AsyncAnthropic()
        self.classifier = LLMClassifier(
            self.client,
            self.policy,
            model=settings.guard_model,
            effort=settings.guard_effort,
            use_fallbacks=settings.use_fallbacks,
            scope=self.scope,
        )
        self.hooks = HookRegistry()
        self.hooks.register(PolicyGuardHook(self.policy, self.classifier, self.scope))
        self.store = Store(settings.data_dir / "policyguard.db")
        self.harness = AgentHarness(
            self.client,
            self.hooks,
            self.store,
            model=settings.agent_model,
            effort=settings.agent_effort,
            use_fallbacks=settings.use_fallbacks,
            max_steps=settings.max_agent_steps,
            toolkit=CODING,
        )
        # One turn at a time per session: concurrent turns would interleave the history.
        self.session_locks: dict[str, asyncio.Lock] = {}


services: Services


@asynccontextmanager
async def lifespan(_: FastAPI):
    global services
    services = Services()
    log.info(
        "policy %s v%s | agent %s | guard %s (effort %s)",
        services.policy.id,
        services.policy.version,
        settings.agent_model,
        settings.guard_model,
        settings.guard_effort,
    )
    yield


app = FastAPI(title="PolicyGuard", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "policy": services.policy.id, "agent_model": settings.agent_model, "guard_model": settings.guard_model}


@app.get("/api/policy")
async def get_policy() -> dict:
    p = services.policy
    t = services.harness.toolkit
    return {
        "id": p.id,
        "version": p.version,
        "text": p.text,
        "agent": {"label": t.label, "tools": t.tool_names, "suggestions": list(t.suggestions)},
    }


# The four positions of the rules matrix, in the order the Rules tab shows them.
POSITIONS = [
    {"kind": "tool_call", "label": "Tool call in", "hook": "PreToolUse", "description": "arguments the agent sends to a tool"},
    {"kind": "tool_response", "label": "Tool call out", "hook": "PostToolUse", "description": "what the tool returns to the agent"},
    {"kind": "user_input", "label": "Model in", "hook": "UserPromptSubmit", "description": "what the user sends to the agent"},
    {"kind": "model_output", "label": "Model out", "hook": "PreResponse", "description": "what the agent says to the user"},
]


def _rules_payload() -> dict:
    p = services.policy
    return {
        "policy_id": p.id,
        "policy_version": p.version,
        "positions": POSITIONS,
        "rules": [{"id": r.id, "title": r.title, "subrules": list(r.subrules)} for r in p.rules],
        "entries": [{"number": e.number, "name": e.name, "prompt": e.prompt} for e in p.rulebook.entries],
        "scope": services.scope.as_dict(),
    }


@app.get("/api/rules")
async def get_rules() -> dict:
    """The rules matrix: each top-level rule x each trace position -> enforced or switched off."""
    return _rules_payload()


@app.put("/api/rules")
async def put_rules(scope: dict[str, dict[str, bool]] = Body(..., embed=True)) -> dict:
    """Replace the matrix. Applies immediately to every later classification (no restart) and
    is saved to policies/<id>/rule_scope.json."""
    try:
        services.scope.replace(scope)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    log.info("rule scope updated: %s", {k: [p for p, on in v.items() if not on] for k, v in scope.items() if not all(v.values())})
    return _rules_payload()


@app.post("/api/rules/entries")
async def add_rule(entry: RuleEntryIn) -> dict:
    """Add a row to the rule table (policies/<id>/rules.json). The classifier prompt is rebuilt
    for the next classified event; a new rule group starts enforced at every position."""
    try:
        added = services.policy.rulebook.add(entry.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    log.info("rule added: %s %s", added.number, added.name)
    return _rules_payload()


@app.delete("/api/rules/entries/{number}")
async def remove_rule(number: str) -> dict:
    """Remove a row from the rule table. Removing a group's last row also drops its scope row."""
    try:
        services.policy.rulebook.remove(number)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No rule {number}")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    services.scope.prune()
    log.info("rule removed: %s", number)
    return _rules_payload()


@app.post("/api/classify", response_model=ClassifyResult)
async def classify(body: ClassifyRequest) -> ClassifyResult:
    try:
        return await services.classifier.classify(body.event, body.context)
    except ClassifierError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/sessions", response_model=SessionSummary)
async def create_session(body: CreateSessionRequest) -> SessionSummary:
    return services.store.create_session(body.mode)


@app.get("/api/sessions", response_model=list[SessionSummary])
async def list_sessions() -> list[SessionSummary]:
    return services.store.list_sessions()


@app.get("/api/sessions/{session_id}", response_model=SessionDetail)
async def get_session(session_id: str) -> SessionDetail:
    detail = services.store.get_session(session_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    return detail


@app.post("/api/sessions/{session_id}/messages")
async def send_message(session_id: str, body: SendMessageRequest) -> StreamingResponse:
    if services.store.session_summary(session_id) is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    lock = services.session_locks.setdefault(session_id, asyncio.Lock())
    if lock.locked():
        raise HTTPException(status_code=409, detail="This session is already running a turn")

    async def stream() -> AsyncIterator[str]:
        async with lock:
            try:
                async for rec in services.harness.run_turn(session_id, body.content, body.mode):
                    yield json.dumps({"type": "event", "data": rec.model_dump()}) + "\n"
            except HarnessError as e:
                yield json.dumps({"type": "error", "detail": str(e)}) + "\n"
            except Exception as e:
                log.exception("turn failed")
                yield json.dumps({"type": "error", "detail": f"Internal error: {e}"}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/api/run", response_model=RunResponse)
async def run(body: RunRequest) -> RunResponse:
    """One human prompt -> one full agent turn, returned as a single JSON document.

    The programmatic entry point (e.g. for synthetic data generation). Same harness, hooks and
    storage as the chat UI, so runs show up in analytics and in /api/export/events."""
    if body.session_id is None:
        session_id = services.store.create_session(body.mode).id
    elif services.store.session_summary(body.session_id) is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    else:
        session_id = body.session_id

    lock = services.session_locks.setdefault(session_id, asyncio.Lock())
    if lock.locked():
        raise HTTPException(status_code=409, detail="This session is already running a turn")

    usage = TurnUsage()
    events: list[RecordedEvent] = []
    error = None
    start = time.perf_counter()
    async with lock:
        try:
            async for rec in services.harness.run_turn(session_id, body.prompt, body.mode, usage):
                events.append(rec)
        except HarnessError as e:
            error = str(e)
        except Exception as e:
            log.exception("turn failed")
            error = f"Internal error: {e}"

    shown = [e.event.content or "" for e in events if e.event.kind == "model_output" and e.action != "blocked"]
    return RunResponse(
        session_id=session_id,
        events=events,
        reply="\n\n".join(shown),
        turn_stopped=bool(events) and events[0].event.kind == "user_input" and events[0].action == "blocked",
        n_blocked=sum(e.action == "blocked" for e in events),
        n_flagged=sum(e.action == "flagged" for e in events),
        error=error,
        latency_ms=round((time.perf_counter() - start) * 1000, 1),
        usage=usage,
        total_cost_usd=usage.total_cost_usd,
    )


@app.get("/api/export/events")
async def export_events(
    session_id: Optional[str] = None,
    since: Optional[str] = Query(None, description="ISO timestamp; only events at or after it"),
    blind: bool = Query(False, description="Omit the guard's verdicts (for unanchored labelling)"),
) -> StreamingResponse:
    """Every recorded event as a labelable case (JSONL): the event, its prior context in the
    session, and (unless blind) what the guard decided. Input format of the eval harness."""
    if session_id is not None:
        records = services.store.session_events(session_id)
    else:
        records = services.store.events_since(since)
    cases = export.to_cases(records, services.policy.context_max_events, blind)
    lines = (json.dumps(c, ensure_ascii=False) + "\n" for c in cases)
    return StreamingResponse(lines, media_type="application/x-ndjson")


@app.get("/api/analytics")
async def get_analytics(window: Literal["24h", "7d", "all"] = Query("7d")) -> dict:
    return analytics.compute(services.store, window)


@app.get("/api/perf")
async def get_perf(window: Literal["24h", "7d", "all"] = Query("7d")) -> dict:
    """Latency, cost and throughput from recorded traffic (classifier calls and turns)."""
    return perf.compute(services.store, window)


@app.get("/api/perf/bench")
async def latest_bench() -> FileResponse:
    """Most recent load test written by scripts/bench_classifier.py."""
    path = settings.bench_results_dir / "latest.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No load test yet. Run scripts/bench_classifier.py.")
    return FileResponse(path, media_type="application/json")


@app.get("/api/eval/latest")
async def latest_eval() -> FileResponse:
    path = settings.eval_results_dir / "latest.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No eval run yet. Run the eval harness first.")
    return FileResponse(path, media_type="application/json")


# Serve the built web app (npm run build) from the same origin, if present.
if settings.web_dist.exists():
    app.mount("/", StaticFiles(directory=settings.web_dist, html=True), name="web")
