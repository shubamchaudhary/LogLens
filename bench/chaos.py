#!/usr/bin/env python3
"""Black-box fault injection for the "exactly-once effects" claim.

Runs the REAL backend jar against the local stack and injects failures at the
worst moment for at-least-once delivery:

  crash_after_commit  kill -9 the JVM the instant a part (or enrich item) logs
                      that its DB transaction committed, i.e. after the write
                      and before the Kafka offset commit. Restart, repeat N times.
  rebalance           start a second instance mid-ingest (partitions move), then
                      kill the first one.
  replay              after completion, rewind the consumer group to offset 0
                      and let every message be delivered again.

After each scenario the session's rows are compared with a clean baseline run
of the same file: chunk count, sum of chunk line spans, duplicate line_start
values, log_metrics row count and summed counts, findings and occurrence sums,
and the enrichment completion counter.

Usage: python bench/chaos.py --file <log> [--scenarios crash_after_commit,replay,...]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

import psycopg
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "evals"))
from client import DB, Client, db_counts, watch  # noqa: E402
from common import git_sha  # noqa: E402

WORK = os.path.join(HERE, ".work")
# after the DB write, before the offset commit: old code logs "-> N finding(s) upserted"
# after its upserts; new code logs "ENRICH_WINDOW work <id> committed" after its transaction
ENRICH_COMMITTED = r"ENRICH_WINDOW work [0-9a-f-]+ (committed|\u2192 \d+ finding\(s\) upserted)"
KAFKA = ["docker", "exec", "ll-kafka", "/opt/kafka/bin/"]


class App:
    """One backend JVM; optionally kill -9 it when a log line matches."""

    EXTRA: list[str] = []

    def __init__(self, name: str, port: int = 8080, heap: str = "512m", conc: int = 3):
        self.name, self.port, self.heap, self.conc = name, port, heap, conc
        self.log = os.path.join(WORK, f"chaos-{name}.log")
        self.proc = None
        self.kill_pattern = None
        self.kills = 0
        self.max_kills = 0

    def start(self):
        env = dict(os.environ, PORT=str(self.port))
        self.proc = subprocess.Popen([os.path.join(HERE, "run_app.sh"), self.heap, str(self.conc), self.log] + App.EXTRA,
                                     cwd=ROOT, env=env, start_new_session=True)
        for _ in range(120):
            try:
                if requests.get(f"http://localhost:{self.port}/api/v1/health", timeout=1).ok:
                    return self
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError("app did not start")

    def kill9(self):
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.kill9()

    def arm(self, pattern: str) -> threading.Event:
        """Tail the log; SIGKILL the JVM on the first new line matching pattern."""
        fired = threading.Event()
        rx = re.compile(pattern)
        start = os.path.getsize(self.log) if os.path.exists(self.log) else 0

        def follow():
            with open(self.log, errors="replace") as f:
                f.seek(start)
                while self.proc.poll() is None:
                    line = f.readline()
                    if not line:
                        time.sleep(0.002)
                        continue
                    if rx.search(line):
                        self.kill9()
                        fired.set()
                        return
        threading.Thread(target=follow, daemon=True).start()
        return fired


def kafka(*args) -> str:
    return subprocess.run(KAFKA[:-1] + [KAFKA[-1] + args[0]] + list(args[1:]),
                          capture_output=True, text=True).stdout


def duplicates(session_id: str) -> int:
    t = "log_chunks_s_" + session_id.replace("-", "_")
    with psycopg.connect(DB) as c:
        return c.execute(f"SELECT count(*) FROM (SELECT line_start FROM {t} GROUP BY 1 HAVING count(*) > 1) d"
                         ).fetchone()[0]


def snapshot(session_id: str) -> dict:
    s = db_counts(session_id)
    s["duplicate_line_starts"] = duplicates(session_id)
    with psycopg.connect(DB) as c:
        tot, enr, st = c.execute("SELECT total_windows, enriched_windows, analysis_status FROM sessions WHERE id=%s",
                                 (session_id,)).fetchone()
    s.update(total_windows=tot, enriched_windows=enr, status=st)
    return s


def count_log(app: App, pattern: str) -> int:
    rx = re.compile(pattern)
    with open(app.log, errors="replace") as f:
        return sum(1 for ln in f if rx.search(ln))


def run_scenario(name: str, file: str, kills: int) -> dict:
    client = None
    app = App(name).start()
    client = Client()
    sid = client.create_session(f"chaos-{name}")
    events = []
    if name in ("baseline", "replay_ingest", "replay_enrich"):
        client.upload(sid, file)
        watch(sid, timeout_s=3600)
    elif name == "crash_after_part_commit":
        fired = app.arm(r"Part [0-9a-f-]+:\d+ done")
        client.upload(sid, file)
        for i in range(kills):
            fired.wait(600)
            events.append(f"kill -9 #{i + 1} right after a part committed")
            app.start()
            if i + 1 < kills:
                fired = app.arm(r"Part [0-9a-f-]+:\d+ done")
        watch(sid, timeout_s=3600)
    elif name == "crash_after_enrich_commit":
        fired = app.arm(r"ENRICH_WINDOW work [0-9a-f-]+ -> |ENRICH_WINDOW work [0-9a-f-]+ →")
        client.upload(sid, file)
        for i in range(kills):
            if not fired.wait(900):
                break
            events.append(f"kill -9 #{i + 1} right after an ENRICH_WINDOW upsert")
            app.start()
            if i + 1 < kills:
                fired = app.arm(r"ENRICH_WINDOW work [0-9a-f-]+ →")
        watch(sid, timeout_s=3600)
    elif name == "rebalance":
        # two instances share the consumer groups; kill one while it owns parts
        second = App("rebalance-2", port=8081).start()
        time.sleep(15)  # let the group settle with 2 members
        events.append("two instances in the consumer groups before upload")
        fired = app.arm(r"Part [0-9a-f-]+:\d+ done")
        client.upload(sid, file)
        fired.wait(600)
        events.append("instance 1 kill -9 right after one of its parts committed; group rebalanced to instance 2")
        watch(sid, timeout_s=3600)
        app = second
    snap = snapshot(sid)
    extra = {}
    if name in ("replay_ingest", "replay_enrich"):
        group, topic = ("ingest-part-workers", "log.ingest.parts") if name == "replay_ingest" \
            else ("llm-workers", "llm.enrich.requests")
        before = snap
        app.stop()
        # a group can only be rewound once it has no live members (session timeout ~45 s)
        for _ in range(120):
            desc = kafka("kafka-consumer-groups.sh", "--bootstrap-server", "localhost:9092", "--describe",
                         "--group", group, "--members")
            if "has no active members" in desc or not any(l.strip() and "CONSUMER-ID" not in l
                                                           for l in desc.splitlines()[1:]):
                break
            time.sleep(2)
        out = kafka("kafka-consumer-groups.sh", "--bootstrap-server", "localhost:9092", "--group", group,
                    "--topic", topic, "--reset-offsets", "--to-earliest", "--execute")
        extra["reset_output"] = out.strip().splitlines()[-3:]
        events.append(f"rewound {group} on {topic} to earliest")
        extra["reset_output_lines"] = len(out.splitlines())
        app = App(name + "-replay").start()
        time.sleep(40)
        snap = snapshot(sid)
        extra["before_replay"] = before
        extra["skip_logs"] = count_log(app, r"already (processed|committed).*skipping")
    extra["redelivery_skip_logs"] = count_log(app, r"already (processed|committed).*skipp")
    extra["jar"] = os.environ.get("JAR", "current build")
    app.stop()
    return {"scenario": name, "session": sid, "events": events, "result": snap, **extra}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--kills", type=int, default=3)
    ap.add_argument("--part-bytes", type=int, default=262144, help="small parts => many parts to crash between")
    ap.add_argument("--scenarios", default="baseline,crash_after_part_commit,rebalance,replay_ingest,"
                                           "crash_after_enrich_commit,replay_enrich")
    args = ap.parse_args()
    subprocess.run(["bash", "-c", "fuser -k 8080/tcp 8081/tcp 2>/dev/null"], check=False)
    App.EXTRA = [f"--loglens.ingest.part-target-bytes={args.part_bytes}"]
    out = {"date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "commit": git_sha(),
           "file": os.path.basename(args.file), "bytes": os.path.getsize(args.file),
           "part_target_bytes": args.part_bytes, "runs": []}
    for sc in args.scenarios.split(","):
        print("==", sc, flush=True)
        r = run_scenario(sc, args.file, args.kills)
        print(json.dumps(r, indent=1), flush=True)
        out["runs"].append(r)
    path = os.environ.get("CHAOS_OUT", os.path.join(ROOT, "bench", "results", "chaos.json"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):  # keep earlier scenarios, replace re-run ones
        old = json.load(open(path))
        rerun = {r["scenario"] for r in out["runs"]}
        out["runs"] = [r for r in old.get("runs", []) if r["scenario"] not in rerun] + out["runs"]
    json.dump(out, open(path, "w"), indent=2)


if __name__ == "__main__":
    main()
