"""Generate synthetic agent traces by sending prompts to a running PolicyGuard server.

Each prompt is one POST /api/run, the programmatic equivalent of a person typing it into the
chat. Each prompt line starts a fresh session (fresh sandbox); `followups` continue that same
session as later turns.

    uv run python scripts/generate_traces.py scripts/prompts.example.jsonl --mode off -o data/traces.jsonl

Prompt file: .txt (one prompt per line) or .jsonl with objects like
    {"prompt": "...", "followups": ["..."], "tags": ["injection"], "mode": "monitor"}

Output: one JSON line per turn (the full /api/run response plus the prompt, tags and turn index).
To turn the recorded events into labelable eval cases afterwards:
    curl -s "localhost:8000/api/export/events?blind=true" > data/cases.jsonl

Mode: "off" (default) runs the agent unguarded — no classifier cost, and the traces are not
shaped by guard decisions, which suits building an eval set you will label yourself. Use
"monitor" to also get the guard's verdicts, or "enforce" to see blocking behaviour.

Stdlib only, so it runs with any Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


def load_prompts(path: Path) -> list[dict[str, Any]]:
    items = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if path.suffix == ".jsonl":
            try:
                item = json.loads(line)
            except json.JSONDecodeError as e:
                sys.exit(f"{path}:{n}: invalid JSON: {e}")
            if "prompt" not in item:
                sys.exit(f"{path}:{n}: missing 'prompt'")
        else:
            item = {"prompt": line}
        items.append(item)
    return items


def post(base: str, path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e


def run_conversation(base: str, item: dict[str, Any], default_mode: str, timeout: float) -> list[dict[str, Any]]:
    mode = item.get("mode", default_mode)
    turns = [item["prompt"], *item.get("followups", [])]
    results, session_id = [], None
    for i, prompt in enumerate(turns):
        body = {"prompt": prompt, "mode": mode}
        if session_id:
            body["session_id"] = session_id
        res = post(base, "/api/run", body, timeout)
        session_id = res["session_id"]
        results.append({"prompt": prompt, "turn": i, "tags": item.get("tags", []), **res})
        if res.get("error") or res.get("turn_stopped"):
            break  # later turns would make no sense
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompts", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=Path("data/traces.jsonl"))
    ap.add_argument("--mode", choices=["off", "monitor", "enforce"], default="off")
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--concurrency", type=int, default=4, help="conversations run in parallel")
    ap.add_argument("--repeat", type=int, default=1, help="run each prompt N times (agent runs vary)")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per turn")
    args = ap.parse_args()

    items = load_prompts(args.prompts) * args.repeat
    args.out.parent.mkdir(parents=True, exist_ok=True)
    print(f"{len(items)} conversations -> {args.base_url} (mode={args.mode}, concurrency={args.concurrency})")

    n_turns = n_events = n_err = 0
    cost = 0.0
    start = time.time()
    with args.out.open("a", encoding="utf-8") as out, ThreadPoolExecutor(args.concurrency) as pool:
        futures = {pool.submit(run_conversation, args.base_url, it, args.mode, args.timeout): it for it in items}
        for fut in as_completed(futures):
            item = futures[fut]
            try:
                turns = fut.result()
            except Exception as e:  # server down, HTTP error: record and keep going
                n_err += 1
                print(f"  ERROR  {item['prompt'][:60]!r}: {e}", file=sys.stderr)
                continue
            for t in turns:
                out.write(json.dumps(t, ensure_ascii=False) + "\n")
                n_turns += 1
                n_events += len(t["events"])
                cost += t.get("total_cost_usd", 0.0)
                if t.get("error"):
                    n_err += 1
            last = turns[-1]
            status = "error" if last.get("error") else f"{len(last['events'])} events"
            print(f"  {status:>10}  {item['prompt'][:70]}")
            out.flush()

    print(
        f"done in {time.time() - start:.0f}s: {n_turns} turns, {n_events} events, {n_err} errors, "
        f"${cost:.4f} -> {args.out}"
    )


if __name__ == "__main__":
    main()
