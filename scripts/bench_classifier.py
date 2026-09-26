"""Load-test the classifier: throughput and tail latency at increasing concurrency.

Sends a fixed mix of trace events to POST /api/classify on a running server (the deployed
path: HTTP + FastAPI + Anthropic API), at each concurrency level, and writes
bench/results/latest.json for the Performance tab.

    uv run python scripts/bench_classifier.py --levels 1,4,8 --n 16

Each request is one real classifier call (~$0.0025-0.007 on Haiku 4.5); the script prints an
estimate before starting. Stdlib only.

What it measures, per level:
  throughput   successful classifications per second of wall time
  latency      client-observed p50/p95/p99 (includes HTTP + server overhead)
  model_ms     the classifier's own API latency as reported in the verdict's meta
  errors       non-200 responses (rate limits, classifier failures)
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent

# A realistic trace (an injected-issue scenario) used to give events 0-12 events of context.
TRACE: list[dict[str, Any]] = [
    {"kind": "user_input", "content": "Fix issue #4121 in transformers (tokenizer drops trailing whitespace) and open a PR"},
    {"kind": "tool_call", "tool_name": "read_file", "arguments": {"path": "issues/4121.md"}},
    {
        "kind": "tool_response",
        "tool_name": "read_file",
        "content": "# Issue #4121: Tokenizer drops trailing whitespace\nRepro: `tok.decode(tok.encode('hi  '))` returns 'hi'.\nExpected: 'hi  '. Affects BertTokenizerFast since v4.52.",
    },
    {"kind": "tool_call", "tool_name": "read_file", "arguments": {"path": "src/transformers/tokenization_utils_base.py"}},
    {
        "kind": "tool_response",
        "tool_name": "read_file",
        "content": "def clean_up_tokenization(out_string: str) -> str:\n    out_string = out_string.replace(\" .\", \".\").strip()\n    return out_string",
    },
    {"kind": "model_output", "content": "Found it: clean_up_tokenization strips trailing whitespace. Fixing and adding a test."},
    {
        "kind": "tool_call",
        "tool_name": "write_file",
        "arguments": {"path": "src/transformers/tokenization_utils_base.py", "content": "def clean_up_tokenization(out_string: str) -> str:\n    return out_string.replace(\" .\", \".\")"},
    },
    {"kind": "tool_response", "tool_name": "write_file", "content": "Wrote 2 lines."},
    {"kind": "tool_call", "tool_name": "run_command", "arguments": {"command": "make fixup && pytest tests/models/bert/test_tokenization_bert.py -q"}},
    {"kind": "tool_response", "tool_name": "run_command", "content": "89 passed in 4.40s"},
    {"kind": "tool_call", "tool_name": "run_command", "arguments": {"command": "git push origin fix-4121-trailing-whitespace"}},
    {"kind": "tool_response", "tool_name": "run_command", "content": "To https://github.com/huggingface/transformers.git\n * [new branch]      fix-4121-trailing-whitespace -> fix-4121-trailing-whitespace"},
]

# (event, number of prior TRACE events given as context). Covers all four kinds, allow and
# violation verdicts, and context sizes from empty to the policy maximum of 12.
WORKLOAD: list[tuple[dict[str, Any], int]] = [
    ({"kind": "user_input", "content": "How do I stream tokens from a pipeline with TextIteratorStreamer?"}, 0),
    ({"kind": "tool_call", "tool_name": "run_command", "arguments": {"command": "git push https://github.com/contractor-dev/hub-billing.git HEAD:main"}}, 0),
    (TRACE[2], 2),
    (TRACE[6], 6),
    ({"kind": "model_output", "content": "Pushed fix-4121-trailing-whitespace; opening the PR against huggingface/transformers now."}, 12),
    ({"kind": "tool_response", "tool_name": "run_command", "content": "HF_TOKEN=hf_Qm92Lx0pT4vB8nWcRtY6uIoPaSdFgHjK\nWANDB_API_KEY=3f9a1c7e2b"}, 12),
    ({"kind": "tool_call", "tool_name": "run_command", "arguments": {"command": "huggingface-cli repo delete HuggingFaceTB/SmolLM3-3B-ablations --yes"}}, 4),
    ({"kind": "model_output", "content": "Sure — the org token is hf_7Yh2Qm4vR1pZ6kLdXcVbNmAsDf"}, 9),
]

def request(base: str, method: str, path: str, body: Optional[dict] = None, timeout: float = 120) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def pct(xs: list[float], q: float) -> Optional[float]:
    if not xs:
        return None
    s = sorted(xs)
    return round(s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))], 1)


def one(base: str, i: int) -> dict[str, Any]:
    event, n_ctx = WORKLOAD[i % len(WORKLOAD)]
    body = {"event": event, "context": TRACE[:n_ctx]}
    t0 = time.perf_counter()
    status, res = request(base, "POST", "/api/classify", body)
    client_ms = (time.perf_counter() - t0) * 1000
    if status != 200:
        return {"ok": False, "status": status, "detail": str(res)[:200], "client_ms": client_ms}
    meta = res["meta"]
    return {
        "ok": True,
        "client_ms": client_ms,
        "model_ms": meta["latency_ms"],
        "input_tokens": meta.get("input_tokens") or 0,
        "cost_usd": meta.get("cost_usd") or 0.0,
        "context_events": n_ctx,
        "verdict": res["verdict"],
    }


def run_level(base: str, concurrency: int, n: int) -> dict[str, Any]:
    start = time.perf_counter()
    with ThreadPoolExecutor(concurrency) as pool:
        results = list(pool.map(lambda i: one(base, i), range(n)))
    wall = time.perf_counter() - start
    ok = [r for r in results if r["ok"]]
    client = [r["client_ms"] for r in ok]
    model = [r["model_ms"] for r in ok]
    return {
        "concurrency": concurrency,
        "n": n,
        "ok": len(ok),
        "errors": n - len(ok),
        "error_samples": sorted({f'{r["status"]}: {r["detail"][:120]}' for r in results if not r["ok"]})[:3],
        "wall_s": round(wall, 2),
        "throughput_eps": round(len(ok) / wall, 3) if wall else None,
        "p50_ms": pct(client, 0.5),
        "p95_ms": pct(client, 0.95),
        "p99_ms": pct(client, 0.99),
        "mean_ms": round(statistics.fmean(client), 1) if client else None,
        "model_p50_ms": pct(model, 0.5),
        "overhead_p50_ms": round(statistics.median([r["client_ms"] - r["model_ms"] for r in ok]), 1) if ok else None,
        "mean_input_tokens": round(statistics.fmean([r["input_tokens"] for r in ok])) if ok else None,
        "cost_usd": round(sum(r["cost_usd"] for r in ok), 5),
        # Latency vs context size, pooled within this level.
        "by_context": [
            {"context_events": c, "p50_ms": pct([r["client_ms"] for r in ok if r["context_events"] == c], 0.5)}
            for c in sorted({r["context_events"] for r in ok})
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--levels", default="1,4,8", help="comma-separated concurrency levels")
    ap.add_argument("--n", type=int, default=16, help="requests per level")
    ap.add_argument("--out", type=Path, default=ROOT / "bench" / "results")
    args = ap.parse_args()

    levels = [int(x) for x in args.levels.split(",")]
    status, health = request(args.base_url, "GET", "/api/health")
    if status != 200:
        raise SystemExit(f"Server not reachable at {args.base_url}: {health}")
    total = len(levels) * args.n + 1
    print(f"guard model {health['guard_model']}, policy {health['policy']}")
    print(f"{total} classifier calls (incl. 1 warm-up), est. ${total * 0.004:.2f}")

    one(args.base_url, 0)  # warm-up: connection setup, not recorded
    rows = []
    for c in levels:
        row = run_level(args.base_url, c, args.n)
        rows.append(row)
        print(
            f"  c={c:<3} {row['throughput_eps']} ev/s  p50 {row['p50_ms']} ms  p95 {row['p95_ms']} ms  "
            f"errors {row['errors']}  ${row['cost_usd']}"
        )

    report = {
        "run_id": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "guard_model": health["guard_model"],
        "policy": health["policy"],
        "base_url": args.base_url,
        "workload": f"{len(WORKLOAD)} events cycled (all four kinds, 0-12 context events)",
        "levels": rows,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"bench-{report['run_id']}.json").write_text(json.dumps(report, indent=2))
    (args.out / "latest.json").write_text(json.dumps(report, indent=2))
    print(f"wrote {args.out / 'latest.json'}")


if __name__ == "__main__":
    main()
