#!/usr/bin/env python3
"""Pull public org metadata from the Hugging Face Hub.

Public repo/org metadata only. Member records are aggregated by default; use
--list-members to print public usernames (e.g. to map contributions to repos).
Do not use this to build profiles of individuals.

Usage:
    python scripts/org_public_stats.py huggingface
    python scripts/org_public_stats.py huggingface --list-members --json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

API = "https://huggingface.co/api"
REPO_TYPES = ("models", "datasets", "spaces")


def get(url: str, token: str | None = None):
    req = urllib.request.Request(url, headers={"User-Agent": "hf-org-public-stats"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch_repos(org: str, repo_type: str, token: str | None = None) -> list[dict]:
    """Paginate over an org's public repos of one type."""
    out, page, limit = [], 0, 1000
    while True:
        batch = get(f"{API}/{repo_type}?author={org}&limit={limit}&skip={page * limit}", token)
        out.extend(batch)
        if len(batch) < limit:
            return out
        page += 1


def collect(org: str, token: str | None = None) -> dict:
    overview = get(f"{API}/organizations/{org}/overview", token)
    members = get(f"{API}/organizations/{org}/members", token)
    repos = {t: fetch_repos(org, t, token) for t in REPO_TYPES}

    return {
        "org": org,
        "fullname": overview.get("fullname"),
        "verified": overview.get("isVerified"),
        "member_count": len(members),
        "members": sorted(m["user"] for m in members),  # public usernames
        "repos": {
            t: {
                "count": len(v),
                "total_downloads": sum(r.get("downloads", 0) or 0 for r in v),
                "total_likes": sum(r.get("likes", 0) or 0 for r in v),
                "top_by_likes": [
                    r["id"] for r in sorted(v, key=lambda r: r.get("likes", 0) or 0, reverse=True)[:10]
                ],
            }
            for t, v in repos.items()
        },
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("org", help="org name, e.g. huggingface")
    p.add_argument("--token", help="HF token (only needed for private/gated visibility)")
    p.add_argument("--list-members", action="store_true", help="print public member usernames")
    p.add_argument("--json", action="store_true", help="emit raw JSON")
    args = p.parse_args()

    data = collect(args.org, args.token)
    if not args.list_members:
        data.pop("members")

    if args.json:
        json.dump(data, sys.stdout, indent=2)
        print()
        return 0

    print(f"{data['fullname']} (@{data['org']}) verified={data['verified']}")
    print(f"members: {data['member_count']}")
    for t, s in data["repos"].items():
        print(f"{t:>9}: {s['count']:>5}  likes={s['total_likes']:<8} downloads={s['total_downloads']}")
        for rid in s["top_by_likes"][:5]:
            print(f"           - {rid}")
    if args.list_members:
        print("\nmembers: " + ", ".join(data["members"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
