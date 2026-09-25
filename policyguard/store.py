"""SQLite persistence for sessions, agent message history, and recorded events."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .schemas import Mode, RecordedEvent, SessionDetail, SessionSummary, TurnUsage

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',     -- agent conversation (Anthropic message params)
    guard_notes TEXT NOT NULL DEFAULT '[]'   -- notices for the agent's next user turn
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    verdict TEXT,            -- NULL when the classifier failed
    action TEXT NOT NULL,
    record TEXT NOT NULL     -- full RecordedEvent JSON
);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    started_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    n_events INTEGER NOT NULL,
    error TEXT,
    usage TEXT NOT NULL      -- TurnUsage JSON: tokens, cost, agent/guard/tool/total ms
);
CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    # --- sessions -----------------------------------------------------------

    def create_session(self, mode: Mode) -> SessionSummary:
        sid = f"sess_{uuid.uuid4().hex[:12]}"
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO sessions (id, title, created_at, mode) VALUES (?, ?, ?, ?)",
                (sid, "New session", now_iso(), mode),
            )
        return self.session_summary(sid)  # type: ignore[return-value]

    _SUMMARY_SQL = """
        SELECT s.id, s.title, s.created_at, s.mode,
               COUNT(e.id) AS n_events,
               COALESCE(SUM(e.verdict = 'violation'), 0) AS n_violations,
               COALESCE(SUM(e.verdict = 'needs_review'), 0) AS n_review
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
    """

    def session_summary(self, sid: str) -> Optional[SessionSummary]:
        with self._lock:
            row = self._db.execute(self._SUMMARY_SQL + " WHERE s.id = ? GROUP BY s.id", (sid,)).fetchone()
        return SessionSummary(**dict(row)) if row else None

    def list_sessions(self, limit: int = 200) -> list[SessionSummary]:
        with self._lock:
            rows = self._db.execute(
                self._SUMMARY_SQL + " GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [SessionSummary(**dict(r)) for r in rows]

    def get_session(self, sid: str) -> Optional[SessionDetail]:
        summary = self.session_summary(sid)
        if summary is None:
            return None
        return SessionDetail(**summary.model_dump(), events=self.session_events(sid))

    def update_session(self, sid: str, *, title: Optional[str] = None, mode: Optional[Mode] = None) -> None:
        with self._lock, self._db:
            if title is not None:
                self._db.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, sid))
            if mode is not None:
                self._db.execute("UPDATE sessions SET mode = ? WHERE id = ?", (mode, sid))

    def load_agent_state(self, sid: str) -> tuple[list[dict[str, Any]], list[str]]:
        with self._lock:
            row = self._db.execute("SELECT messages, guard_notes FROM sessions WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise KeyError(sid)
        return json.loads(row["messages"]), json.loads(row["guard_notes"])

    def save_agent_state(self, sid: str, messages: list[dict[str, Any]], notes: list[str]) -> None:
        with self._lock, self._db:
            self._db.execute(
                "UPDATE sessions SET messages = ?, guard_notes = ? WHERE id = ?",
                (json.dumps(messages), json.dumps(notes), sid),
            )

    # --- events -------------------------------------------------------------

    def next_seq(self, sid: str) -> int:
        with self._lock:
            row = self._db.execute("SELECT COALESCE(MAX(seq) + 1, 0) FROM events WHERE session_id = ?", (sid,)).fetchone()
        return int(row[0])

    def add_event(self, rec: RecordedEvent) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO events (id, session_id, seq, ts, kind, verdict, action, record) VALUES (?,?,?,?,?,?,?,?)",
                (
                    rec.id,
                    rec.session_id,
                    rec.seq,
                    rec.ts,
                    rec.event.kind,
                    rec.classification.verdict if rec.classification else None,
                    rec.action,
                    rec.model_dump_json(),
                ),
            )

    def session_events(self, sid: str) -> list[RecordedEvent]:
        with self._lock:
            rows = self._db.execute("SELECT record FROM events WHERE session_id = ? ORDER BY seq", (sid,)).fetchall()
        return [RecordedEvent.model_validate_json(r["record"]) for r in rows]

    def events_since(self, since_iso: Optional[str]) -> list[RecordedEvent]:
        with self._lock:
            if since_iso:
                rows = self._db.execute("SELECT record FROM events WHERE ts >= ? ORDER BY ts", (since_iso,)).fetchall()
            else:
                rows = self._db.execute("SELECT record FROM events ORDER BY ts").fetchall()
        return [RecordedEvent.model_validate_json(r["record"]) for r in rows]

    # --- turns --------------------------------------------------------------

    def add_turn(
        self, session_id: str, started_at: str, mode: Mode, n_events: int, usage: TurnUsage, error: Optional[str]
    ) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO turns (session_id, started_at, mode, n_events, error, usage) VALUES (?,?,?,?,?,?)",
                (session_id, started_at, mode, n_events, error, usage.model_dump_json()),
            )

    def turns_since(self, since_iso: Optional[str]) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT session_id, started_at, mode, n_events, error, usage FROM turns"
                + (" WHERE started_at >= ?" if since_iso else "")
                + " ORDER BY started_at",
                (since_iso,) if since_iso else (),
            ).fetchall()
        return [{**dict(r), "usage": json.loads(r["usage"])} for r in rows]
