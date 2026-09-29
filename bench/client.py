#!/usr/bin/env python3
"""Minimal LogLens API client used by benchmarks and evals.

Drives the real public flow: register/login -> create session -> presign ->
PUT bytes straight to blob storage -> confirm -> watch status until DONE/FAILED,
recording when each status was first seen (the end-to-end timeline).
"""
from __future__ import annotations

import json
import time
import uuid

import psycopg
import requests

API = "http://localhost:8080/api/v1"
DB = "postgresql://loglens:loglens123@localhost:5434/loglens_db"


class Client:
    def __init__(self, api: str = API):
        self.api = api
        email = f"bench-{uuid.uuid4().hex[:10]}@example.com"
        pw = "Bench-Passw0rd!"
        r = requests.post(f"{api}/auth/register", json={"email": email, "password": pw, "fullName": "Bench"})
        r.raise_for_status()
        self.token = r.json()["token"]
        self.h = {"Authorization": f"Bearer {self.token}"}

    def create_session(self, title: str) -> str:
        r = requests.post(f"{self.api}/sessions", json={"title": title}, headers=self.h)
        r.raise_for_status()
        return r.json()["id"]

    def upload(self, session_id: str, path: str, name: str | None = None) -> str:
        import os
        name = name or os.path.basename(path)
        size = os.path.getsize(path)
        r = requests.post(f"{self.api}/sessions/{session_id}/documents/presign",
                          json={"fileName": name, "fileSizeBytes": size}, headers=self.h)
        r.raise_for_status()
        pre = r.json()
        with open(path, "rb") as f:
            # requests streams a 0-byte file with chunked encoding, which S3/MinIO reject (411);
            # a browser sends Content-Length: 0, so do the same.
            requests.put(pre["uploadUrl"], data=f if size else b"").raise_for_status()
        r = requests.post(f"{self.api}/sessions/{session_id}/documents/{pre['documentId']}/confirm",
                          json={"fileName": name}, headers=self.h)
        r.raise_for_status()
        return pre["documentId"]

    def delete_session(self, session_id: str) -> None:
        requests.delete(f"{self.api}/sessions/{session_id}", headers=self.h)


def status(session_id: str) -> tuple[str, int, int, str | None]:
    with psycopg.connect(DB) as c:
        row = c.execute("SELECT analysis_status, total_windows, enriched_windows, error_message "
                        "FROM sessions WHERE id=%s", (session_id,)).fetchone()
    return row


def watch(session_id: str, until=("DONE", "FAILED"), poll_s: float = 0.5, timeout_s: float = 7200,
          stop_at: str | None = None) -> dict:
    """Poll the session row; return {status: first_seen_seconds} plus the final row."""
    t0 = time.time()
    seen: dict[str, float] = {}
    last = None
    while time.time() - t0 < timeout_s:
        st = status(session_id)
        if st[0] not in seen:
            seen[st[0]] = round(time.time() - t0, 3)
        last = st
        if st[0] in until or (stop_at and st[0] == stop_at):
            break
        time.sleep(poll_s)
    return {"timeline_s": seen, "final": {"status": last[0], "total_windows": last[1],
                                           "enriched_windows": last[2], "error": last[3]}}


def db_counts(session_id: str) -> dict:
    t = "log_chunks_s_" + session_id.replace("-", "_")
    with psycopg.connect(DB) as c:
        return {
            "chunks": c.execute(f"SELECT count(*) FROM {t}").fetchone()[0],
            "embedded": c.execute(f"SELECT count(*) FROM {t} WHERE embedding IS NOT NULL").fetchone()[0],
            "anomalous": c.execute(f"SELECT count(*) FROM {t} WHERE is_anomalous").fetchone()[0],
            "metric_rows": c.execute("SELECT count(*) FROM log_metrics WHERE session_id=%s", (session_id,)).fetchone()[0],
            "metric_count_sum": int(c.execute("SELECT coalesce(sum(count),0) FROM log_metrics WHERE session_id=%s",
                                              (session_id,)).fetchone()[0]),
            "findings": c.execute("SELECT count(*) FROM log_findings WHERE session_id=%s", (session_id,)).fetchone()[0],
            "finding_occurrences": int(c.execute("SELECT coalesce(sum(occurrence_count),0) FROM log_findings "
                                                 "WHERE session_id=%s", (session_id,)).fetchone()[0]),
            "line_sum": int(c.execute(f"SELECT coalesce(sum(line_end-line_start+1),0) FROM {t}").fetchone()[0]),
        }


if __name__ == "__main__":
    import sys
    c = Client()
    sid = c.create_session("smoke")
    c.upload(sid, sys.argv[1])
    print(json.dumps(watch(sid), indent=2))
    print(db_counts(sid))
