"""Download the TraceSafe-Bench dataset (CyCraftAI/TraceSafe on the Hugging Face Hub).

1,170 multi-step tool-calling trajectories: 90 benign baselines plus 90 per risk category
(prompt injection in/out, user-info / API-key / data leak, and hallucination and interface
failures), from "TraceSafe: A Systematic Assessment of LLM Guardrails on Multi-Step Tool-Calling
Trajectories" (COLM 2026). Apache-2.0. About 59 MB.

The dataset is gated: accept its terms once at https://huggingface.co/datasets/CyCraftAI/TraceSafe
while logged in, then put a read token in .env as HF_TOKEN=hf_... (or export it).

    uv run python scripts/fetch_tracesafe.py            # -> data/tracesafe/
    uv run python scripts/fetch_tracesafe.py --out some/dir --force

Files already present with the right size are skipped. data/ is gitignored.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
REPO = "CyCraftAI/TraceSafe"
API = f"https://huggingface.co/api/datasets/{REPO}?blobs=true"
FILE_URL = f"https://huggingface.co/datasets/{REPO}/resolve/main/{{}}"


def get(url: str, token: str | None):
    headers = {"User-Agent": "policyguard-fetch/0.1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)


def main() -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "tracesafe")
    ap.add_argument("--force", action="store_true", help="re-download files already present")
    args = ap.parse_args()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

    with get(API, token) as r:
        siblings = json.load(r)["siblings"]
    files = [(s["rfilename"], s.get("size")) for s in siblings if s["rfilename"].endswith((".jsonl", ".md"))]
    args.out.mkdir(parents=True, exist_ok=True)

    for name, size in files:
        dest = args.out / name
        if dest.exists() and not args.force and (size is None or dest.stat().st_size == size):
            print(f"  skip  {name}")
            continue
        try:
            with get(FILE_URL.format(name), token) as r, open(dest.with_suffix(".part"), "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
        except urllib.error.HTTPError as e:
            dest.with_suffix(".part").unlink(missing_ok=True)
            if e.code in (401, 403):
                why = "no HF_TOKEN set" if not token else "token rejected, or the dataset's terms not accepted yet"
                print(f"error: {name}: HTTP {e.code} ({why}). See the docstring for access steps.", file=sys.stderr)
                return 1
            raise
        dest.with_suffix(".part").replace(dest)
        print(f"  got   {name} ({dest.stat().st_size:,} bytes)")

    records = sum(1 for p in args.out.glob("*.jsonl") for line in p.open(encoding="utf-8") if line.strip())
    print(f"{records:,} records in {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
