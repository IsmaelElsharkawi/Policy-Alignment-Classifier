"""Latency, cost and throughput analytics for the Performance tab.

Two sources:
- recorded traffic: every classified event (classifier latency, tokens, cost) and every turn
  (wall-clock split into agent / guard / tool time);
- load tests: scripts/bench_classifier.py, which measures throughput and tail latency under
  controlled concurrency (bench/results/latest.json).
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional, Sequence

from .schemas import HOOK_FOR_KIND, RecordedEvent
from .store import Store

Window = Literal["24h", "7d", "all"]

MAX_SCATTER = 600
RECENT_TURNS = 25


def pct(xs: Sequence[float], q: float) -> Optional[float]:
    """Nearest-rank percentile; None for an empty sample."""
    if not xs:
        return None
    s = sorted(xs)
    return round(s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))], 1)


def _summary(lat: list[float], tokens: list[int], costs: list[float]) -> dict[str, Any]:
    return {
        "n": len(lat),
        "p50_ms": pct(lat, 0.5),
        "p95_ms": pct(lat, 0.95),
        "p99_ms": pct(lat, 0.99),
        "mean_ms": round(statistics.fmean(lat), 1) if lat else None,
        "mean_input_tokens": round(statistics.fmean(tokens)) if tokens else None,
        "cost_per_event_usd": statistics.fmean(costs) if costs else None,
    }


def _histogram(lat: list[float], bins: int = 24) -> list[dict[str, float]]:
    if not lat:
        return []
    top = pct(lat, 0.99) or max(lat)
    raw = max(top / bins, 1.0)
    mag = 10 ** math.floor(math.log10(raw))
    width = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)  # nice bin width
    counts: dict[int, int] = defaultdict(int)
    for x in lat:
        counts[min(int(x // width), bins)] += 1  # last bin collects the tail beyond p99
    return [
        {"start_ms": i * width, "end_ms": (i + 1) * width, "n": counts.get(i, 0), "overflow": i == bins}
        for i in range(0, max(counts) + 1)
    ]


def _buckets(window: Window, first: datetime, now: datetime) -> tuple[datetime, timedelta, int]:
    step = timedelta(hours=1) if window == "24h" else timedelta(days=1)
    start = first.replace(minute=0, second=0, microsecond=0)
    if step == timedelta(days=1):
        start = start.replace(hour=0)
    n = int((now - start) / step) + 1
    return start, step, n


def compute(store: Store, window: Window) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    since: Optional[datetime] = {"24h": now - timedelta(hours=24), "7d": now - timedelta(days=7)}.get(window)
    since_iso = since.isoformat() if since else None

    events: list[RecordedEvent] = [e for e in store.events_since(since_iso) if e.mode != "off"]
    classified = [e for e in events if e.classification]
    errors = [e for e in events if e.classifier_error]

    lat = [e.classification.meta.latency_ms for e in classified]  # type: ignore[union-attr]
    tok = [e.classification.meta.input_tokens or 0 for e in classified]  # type: ignore[union-attr]
    cost = [e.classification.meta.cost_usd for e in classified if e.classification.meta.cost_usd]  # type: ignore[union-attr]

    # --- per hook point and per model
    def group(key) -> list[dict[str, Any]]:
        groups: dict[str, list[RecordedEvent]] = defaultdict(list)
        for e in classified:
            groups[key(e)].append(e)
        out = []
        for k, es in groups.items():
            m = [e.classification.meta for e in es]  # type: ignore[union-attr]
            out.append(
                {"key": k, **_summary([x.latency_ms for x in m], [x.input_tokens or 0 for x in m], [x.cost_usd for x in m if x.cost_usd])}
            )
        return sorted(out, key=lambda r: -r["n"])

    by_kind = group(lambda e: e.event.kind)
    for row in by_kind:
        row["hook"] = HOOK_FOR_KIND[row["key"]].value
    by_model = group(lambda e: e.classification.meta.model)  # type: ignore[union-attr]

    # --- over time: latency percentiles and throughput per bucket
    first = since or min((datetime.fromisoformat(e.ts) for e in classified), default=now)
    start, step, n_buckets = _buckets(window, first, now)
    per_bucket: list[list[float]] = [[] for _ in range(n_buckets)]
    per_minute: dict[str, int] = defaultdict(int)
    for e in classified:
        t = datetime.fromisoformat(e.ts)
        i = int((t - start) / step)
        if 0 <= i < n_buckets:
            per_bucket[i].append(e.classification.meta.latency_ms)  # type: ignore[union-attr]
        per_minute[t.strftime("%Y-%m-%dT%H:%M")] += 1
    timeline = [
        {"bucket": (start + i * step).isoformat(), "n": len(b), "p50_ms": pct(b, 0.5), "p95_ms": pct(b, 0.95)}
        for i, b in enumerate(per_bucket)
    ]

    # --- turns: where the wall-clock time goes
    turns = store.turns_since(since_iso)  # all modes; "recent" shows unguarded turns for comparison
    guarded = [t for t in turns if t["mode"] != "off"]
    totals = [t["usage"]["total_ms"] for t in guarded if t["usage"].get("total_ms")]
    shares = [
        t["usage"]["guard_ms"] / t["usage"]["total_ms"]
        for t in guarded
        if t["usage"].get("total_ms") and t["usage"].get("agent_calls")  # exclude turns stopped at input
    ]
    recent = [
        {
            "session_id": t["session_id"],
            "started_at": t["started_at"],
            "mode": t["mode"],
            "n_events": t["n_events"],
            "error": t["error"],
            "agent_ms": round(t["usage"].get("agent_ms", 0.0), 1),
            "guard_ms": round(t["usage"].get("guard_ms", 0.0), 1),
            "tool_ms": round(t["usage"].get("tool_ms", 0.0), 1),
            "total_ms": round(t["usage"].get("total_ms", 0.0), 1),
            "classifier_calls": t["usage"].get("classifier_calls", 0),
        }
        for t in turns[-RECENT_TURNS:]
    ][::-1]

    scatter = [
        {"input_tokens": e.classification.meta.input_tokens or 0, "latency_ms": e.classification.meta.latency_ms, "kind": e.event.kind}  # type: ignore[union-attr]
        for e in classified[-MAX_SCATTER:]
    ]

    busy_minutes = list(per_minute.values())
    return {
        "window": window,
        "classifier": {
            **_summary(lat, tok, cost),
            "errors": len(errors),
            "error_rate": len(errors) / len(events) if events else 0.0,
            "mean_output_tokens": round(statistics.fmean([e.classification.meta.output_tokens or 0 for e in classified])) if classified else None,  # type: ignore[union-attr]
        },
        "turns": {
            "n": len(guarded),
            "p50_total_ms": pct(totals, 0.5),
            "p95_total_ms": pct(totals, 0.95),
            "median_guard_share": round(statistics.median(shares), 3) if shares else None,
            "mean_classifier_calls": round(statistics.fmean([t["usage"].get("classifier_calls", 0) for t in guarded]), 1) if guarded else None,
            "recent": recent,
        },
        "throughput": {
            # Observed traffic, not capacity: see the load test for capacity.
            "peak_events_per_min": max(busy_minutes) if busy_minutes else 0,
            "mean_events_per_active_min": round(statistics.fmean(busy_minutes), 1) if busy_minutes else 0,
        },
        "timeline": timeline,
        "histogram": _histogram(lat),
        "scatter": scatter,
        "by_kind": by_kind,
        "by_model": by_model,
    }
