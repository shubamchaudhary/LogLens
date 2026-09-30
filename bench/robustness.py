#!/usr/bin/env python3
"""Robustness cases against the real backend (-Xmx256m): what happens, and does
the session end in a clear state (DONE / FAILED with a message) or hang?

Cases: malformed lines, one enormous line, non-UTF-8 bytes, NUL bytes, empty
file, gzip archive, a very busy minute (Postgres tsvector size limit), and a
poison Kafka message on log.ingest.parts.
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import random
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "evals"))
from chaos import App, kafka  # noqa: E402
from client import Client, db_counts, watch  # noqa: E402
from common import git_sha  # noqa: E402

DATA = os.path.join(HERE, ".work", "robust")


def make_inputs() -> dict[str, str]:
    os.makedirs(DATA, exist_ok=True)
    r = random.Random(5)
    base = [f"2026-07-15 09:{m:02d}:{s:02d} INFO [svc] - request ok latency={r.randint(5, 90)}ms"
            for m in range(10) for s in range(60)]
    files = {}

    def put(name, data: bytes):
        p = os.path.join(DATA, name)
        with open(p, "wb") as f:
            f.write(data)
        files[name] = p

    garbage = []
    for i, ln in enumerate(base):
        garbage.append(ln)
        if i % 7 == 0:
            garbage.append("".join(r.choice("{}[]<>|~^%$#@!;: abcxyz") for _ in range(r.randint(1, 300))))
    put("malformed_lines.log", ("\n".join(garbage) + "\n").encode())
    put("non_utf8.log", ("\n".join(base[:300]) + "\n").encode() + b"2026-07-15 09:05:00 ERROR caf\xe9 cr\xe8me \xff\xfe broken\n"
        + ("\n".join(base[300:]) + "\n").encode())
    put("nul_bytes.log", ("\n".join(base[:300]) + "\n").encode() + b"2026-07-15 09:05:00 ERROR binary \x00\x00 payload\n"
        + ("\n".join(base[300:]) + "\n").encode())
    put("empty.log", b"")
    put("archive.log.gz", gzip.compress(("\n".join(base) + "\n").encode()))
    # one enormous line (100 MB, no newline inside)
    p = os.path.join(DATA, "huge_single_line.log")
    if not os.path.exists(p):
        with open(p, "wb") as f:
            f.write(b"2026-07-15 09:00:00 INFO [svc] - ")
            chunk = ("x" * 1023 + " ").encode()
            for _ in range(100 * 1024):
                f.write(chunk)
            f.write(b"\n")
    files["huge_single_line.log"] = p
    # a very busy minute: 120k lines in 60 s, each with a unique trace id
    p = os.path.join(DATA, "busy_minute.log")
    if not os.path.exists(p):
        with open(p, "w") as f:
            for i in range(120_000):
                f.write(f"2026-07-15 09:00:{i * 60 // 120_000:02d} INFO [gw] traceId=TR{i:07d}{r.randint(0, 10**6)} "
                        f"span={r.getrandbits(48):012x} - GET /api/item/{i} status=200 latency={r.randint(5, 90)}ms\n")
    files["busy_minute.log"] = p
    return files


def app_errors(app: App, since: int) -> list[str]:
    out = []
    with open(app.log, errors="replace") as f:
        f.seek(since)
        for ln in f:
            if re.search(r"OutOfMemoryError|ERROR .*(Part|Splitting|failed)|Exception: ", ln):
                out.append(ln.strip()[:260])
    return out[:6]


def main():
    subprocess.run(["bash", "-c", "fuser -k 8080/tcp 8081/tcp 2>/dev/null"], check=False)
    time.sleep(2)
    from ingest_bench import clean_slate
    clean_slate()  # skip any backlog an interrupted run left in Kafka
    files = all_files = make_inputs()
    only = [x for x in os.environ.get("ROBUST_ONLY", "").split(",") if x]
    if only:  # rerun selected cases in a fresh JVM, merging into the existing results file
        files = {k: v for k, v in files.items() if k in only}
    App.EXTRA = ["--loglens.embedding.enabled=false"]
    results = []
    app = App("robustness", heap="256m", conc=3).start()
    c = Client()
    for name, path in files.items():
        if app.proc.poll() is not None:
            app = App("robustness", heap="256m", conc=3).start()
            c = Client()
        since = os.path.getsize(app.log)
        sid = c.create_session(name)
        t0 = time.time()
        try:
            c.upload(sid, path, name)
            tl = watch(sid, until=("ENRICHING", "CORRELATING", "DONE", "FAILED"), timeout_s=300)
        except Exception as e:  # noqa: BLE001
            tl = {"timeline_s": {}, "final": {"status": "CLIENT_ERROR", "error": str(e)[:200]}}
        alive = app.proc.poll() is None
        try:
            counts = db_counts(sid)
        except Exception:
            counts = None
        res = {"case": name, "bytes": os.path.getsize(path), "status": tl["final"]["status"],
               "error": tl["final"].get("error"), "seconds": round(time.time() - t0, 1), "jvm_alive": alive,
               "chunks": counts and counts["chunks"], "lines_stored": counts and counts["line_sum"],
               "app_errors": app_errors(app, since)}
        print(json.dumps(res), flush=True)
        results.append(res)
    out_path = os.environ.get("ROBUST_OUT", os.path.join(HERE, "results", "robustness.json"))
    if not only or "poison_message" in only:
        results.append(poison_case(app, all_files))
    app.stop()
    if only:
        for r in results:
            r["fresh_jvm"] = True
        old = json.load(open(out_path))["results"] if os.path.exists(out_path) else []
        results = [r for r in old if r["case"] not in only] + results
    out = {"date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "commit": git_sha(),
           "heap": "256m", "results": results}
    json.dump(out, open(out_path, "w"), indent=2)


def poison_case(app: App, files: dict[str, str]) -> dict:
    """Not JSON at all, straight onto the parts topic; then check a normal upload still works."""
    since = os.path.getsize(app.log)
    before = kafka("kafka-get-offsets.sh", "--bootstrap-server", "localhost:9092", "--topic", "log.ingest.dlq")
    subprocess.run(["docker", "exec", "-i", "ll-kafka", "/opt/kafka/bin/kafka-console-producer.sh",
                    "--bootstrap-server", "localhost:9092", "--topic", "log.ingest.parts"],
                   input="this is not json {{{\n", text=True, capture_output=True)
    time.sleep(15)
    after = kafka("kafka-get-offsets.sh", "--bootstrap-server", "localhost:9092", "--topic", "log.ingest.dlq")
    ok_after = Client()
    sid = ok_after.create_session("after-poison")
    ok_after.upload(sid, files["malformed_lines.log"], "after-poison.log")
    tl = watch(sid, until=("ENRICHING", "DONE", "FAILED"), timeout_s=120)
    res = {"case": "poison_message", "dlq_offsets_before": before.strip(), "dlq_offsets_after": after.strip(),
           "next_upload_status": tl["final"]["status"], "app_errors": app_errors(app, since)}
    print(json.dumps(res), flush=True)
    return res


if __name__ == "__main__":
    main()
