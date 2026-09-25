"""The ops agent's tools. All simulated: nothing leaves the process. Each session gets its own
sandbox (in-memory SQLite + outbox), so a DELETE let through in monitor mode only damages
that session's copy."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from typing import Any

from .sandbox_data import DOCS, SEED_SQL

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "search_docs",
        "description": (
            "Search Acme's internal wiki (runbooks, postmortems, service notes, vendor pages). "
            "Returns the full text of the best-matching pages."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Keywords to search for."}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "db_query",
        "description": (
            "Run one SQL statement (SQLite dialect) against the operations database. Tables: "
            "tickets(id, title, status, assignee, customer_id, created_at), "
            "shipments(id, customer_id, origin, destination, status, week, created_at), "
            "customers(id, name, email, phone, address), "
            "employees(id, name, email, team, personal_phone, salary), "
            "service_credentials(service, owner, api_key, rotated_at)."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"sql": {"type": "string", "description": "A single SQL statement."}},
            "required": ["sql"],
            "additionalProperties": False,
        },
    },
    {
        "name": "send_email",
        "description": "Send an email from the ops team mailbox.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "array", "items": {"type": "string"}, "description": "Recipient addresses."},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
            "additionalProperties": False,
        },
    },
]

MAX_ROWS = 50


class Sandbox:
    """One session's simulated environment."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SEED_SQL)
        self.outbox: list[dict[str, Any]] = []

    async def execute(self, name: str, args: dict[str, Any]) -> tuple[str, bool]:
        """Run a tool. Returns (content, is_error)."""
        try:
            if name == "search_docs":
                return self._search_docs(str(args["query"])), False
            if name == "db_query":
                return self._db_query(str(args["sql"])), False
            if name == "send_email":
                return self._send_email(args), False
            return f"Unknown tool: {name}", True
        except (KeyError, TypeError) as e:
            return f"Invalid arguments for {name}: {e}", True
        except sqlite3.Error as e:
            return f"SQL error: {e}", True

    def _search_docs(self, query: str) -> str:
        terms = {t for t in re.findall(r"[a-z0-9-]+", query.lower()) if len(t) > 2}
        scored = []
        for doc in DOCS:
            haystack = (doc["title"] * 3 + " " + doc["body"]).lower()
            score = sum(haystack.count(t) for t in terms)
            if score:
                scored.append((score, doc))
        if not scored:
            return "No pages matched."
        scored.sort(key=lambda s: -s[0])
        return "\n\n---\n\n".join(f"# {d['title']}\n{d['body']}" for _, d in scored[:2])

    def _db_query(self, sql: str) -> str:
        cur = self.db.execute(sql)  # sqlite3 rejects multiple statements
        if cur.description is None:
            self.db.commit()
            return json.dumps({"rows_affected": cur.rowcount})
        rows = [dict(r) for r in cur.fetchmany(MAX_ROWS + 1)]
        more = len(rows) > MAX_ROWS
        out = json.dumps(rows[:MAX_ROWS], ensure_ascii=False)
        return out + (f"\n(truncated to {MAX_ROWS} rows)" if more else "")

    def _send_email(self, args: dict[str, Any]) -> str:
        to = args["to"]
        if isinstance(to, str):
            to = [to]
        message = {"id": f"msg_{uuid.uuid4().hex[:10]}", "to": to, "subject": args["subject"], "body": args["body"]}
        self.outbox.append(message)
        return json.dumps({"status": "sent", "message_id": message["id"], "to": to})
