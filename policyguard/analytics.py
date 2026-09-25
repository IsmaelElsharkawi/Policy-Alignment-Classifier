"""Aggregates recorded events for the Safety analytics tab."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from .schemas import EVENT_KINDS, VERDICTS, RecordedEvent
from .store import Store

Window = Literal["24h", "7d", "all"]


def _quantile(xs: list[float], q: float) -> int:
    s = sorted(xs)
    return round(s[min(len(s) - 1, int(q * len(s)))])


def compute(store: Store, window: Window) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    since: Optional[datetime] = {"24h": now - timedelta(hours=24), "7d": now - timedelta(days=7)}.get(window)
    # Unguarded runs (mode "off", e.g. synthetic data generation) were never classified.
    events = [e for e in store.events_since(since.isoformat() if since else None) if e.mode != "off"]
    classified = [e for e in events if e.classification]

    bucket = timedelta(hours=1) if window == "24h" else timedelta(days=1)
    first = since or (min((datetime.fromisoformat(e.ts) for e in events), default=now))
    if bucket == timedelta(hours=1):
        start = first.replace(minute=0, second=0, microsecond=0)
    else:
        start = first.replace(hour=0, minute=0, second=0, microsecond=0)
    timeline: list[dict[str, Any]] = []
    t = start
    while t <= now:
        timeline.append({"bucket": t.isoformat(), "allow": 0, "needs_review": 0, "violation": 0})
        t += bucket

    by_kind = {k: {v: 0 for v in VERDICTS} for k in EVENT_KINDS}
    categories: Counter[str] = Counter()
    rules: Counter[str] = Counter()
    for e in classified:
        c = e.classification
        assert c is not None
        i = int((datetime.fromisoformat(e.ts) - start) / bucket)
        if 0 <= i < len(timeline):
            timeline[i][c.verdict] += 1
        by_kind[e.event.kind][c.verdict] += 1
        if c.verdict != "allow":
            categories[c.category or "unclear"] += 1
            rules.update(c.rules)

    latencies = [e.classification.meta.latency_ms for e in classified if e.classification]
    costs = [e.classification.meta.cost_usd for e in classified if e.classification and e.classification.meta.cost_usd]
    incidents = sorted(
        (e for e in events if e.classifier_error or (e.classification and e.classification.verdict != "allow")),
        key=lambda e: e.ts,
        reverse=True,
    )[:50]

    return {
        "window": window,
        "totals": {
            "sessions": len({e.session_id for e in events}),
            "events": len(events),
            "violations": sum(1 for e in classified if e.classification.verdict == "violation"),  # type: ignore[union-attr]
            "needs_review": sum(1 for e in classified if e.classification.verdict == "needs_review"),  # type: ignore[union-attr]
            "blocked": sum(1 for e in events if e.action == "blocked"),
        },
        "timeline": timeline,
        "by_category": [{"category": k, "n": n} for k, n in categories.most_common()],
        "by_kind": by_kind,
        "by_rule": [{"rule": k, "n": n} for k, n in rules.most_common()],
        "latency": {"p50_ms": _quantile(latencies, 0.5), "p95_ms": _quantile(latencies, 0.95)} if latencies else None,
        "cost_usd_total": sum(costs) if costs else None,
        "incidents": [e.model_dump() for e in incidents],
    }
