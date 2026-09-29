#!/usr/bin/env python3
"""Ingest throughput + constant-heap benchmark on the real backend.

For each archive: start a FRESH backend JVM with a fixed -Xmx, upload through
the public presign -> PUT -> confirm flow, and time the pipeline until the
session reaches ENRICHING (every part parsed and committed, finalizer done).
Heap is sampled every 250 ms with `jstat -gc` (used = S0U+S1U+EU+OU), RSS peak
from /proc/<pid>/status (VmHWM), GC pauses from the unified GC log.

Usage:
  python bench/ingest_bench.py --files bench/.work/data/bench_100m.log,... --heap 256m --conc 3
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "evals"))
from chaos import App  # noqa: E402
from client import Client, db_counts, watch  # noqa: E402
from common import git_sha  # noqa: E402


def java_pid(app: App) -> int:
    out = subprocess.run(["pgrep", "-g", str(app.proc.pid), "java"], capture_output=True, text=True).stdout.split()
    return int(out[0])


class HeapSampler(threading.Thread):
    def __init__(self, pid: int):
        super().__init__(daemon=True)
        self.pid, self.samples, self.stop_evt = pid, [], threading.Event()

    def run(self):
        while not self.stop_evt.is_set():
            try:
                out = subprocess.run(["jstat", "-gc", str(self.pid)], capture_output=True, text=True, timeout=5).stdout
                hdr, val = out.strip().splitlines()[-2:]
                d = dict(zip(hdr.split(), map(float, val.split())))
                used_kb = d["S0U"] + d["S1U"] + d["EU"] + d["OU"]
                rss = int(re.search(r"VmRSS:\s+(\d+)", open(f"/proc/{self.pid}/status").read()).group(1))
                self.samples.append((time.time(), used_kb / 1024, d["OU"] / 1024, rss / 1024))
            except Exception:
                pass
            time.sleep(0.25)


def gc_pauses(gc_log: str, since_s: float) -> dict:
    pauses = []
    rx = re.compile(r"\[(\d+\.\d+)s\].*Pause (\w+).*?(\d+)M->(\d+)M\((\d+)M\) (\d+\.\d+)ms")
    for line in open(gc_log, errors="replace"):
        m = rx.search(line)
        if m and float(m.group(1)) >= since_s:
            pauses.append((m.group(2), float(m.group(6)), int(m.group(3)), int(m.group(4))))
    if not pauses:
        return {"count": 0}
    ms = sorted(p[1] for p in pauses)
    return {"count": len(pauses), "total_ms": round(sum(ms), 1), "max_ms": round(ms[-1], 1),
            "p95_ms": round(ms[int(0.95 * len(ms)) - 1], 1),
            "full_gcs": sum(1 for p in pauses if p[0] == "Full"),
            "max_heap_after_gc_mb": max(p[3] for p in pauses)}


def run_one(path: str, heap: str, conc: int, extra: list[str]) -> dict:
    subprocess.run(["bash", "-c", "fuser -k 8080/tcp 2>/dev/null"], check=False)
    time.sleep(2)
    App.EXTRA = extra
    name = f"ingest-{os.path.basename(path)}-{heap}-c{conc}"
    app = App(name, heap=heap, conc=conc)
    gc_log = app.log[:-4] + ".gc.log"
    for f in (app.log, gc_log):
        if os.path.exists(f):
            os.remove(f)
    app.start()
    pid = java_pid(app)
    idle = HeapSampler(pid)
    idle.start()
    time.sleep(3)
    idle.stop_evt.set()
    idle_heap = max(s[1] for s in idle.samples) if idle.samples else None
    c = Client()
    sid = c.create_session(name)
    t_up = time.time()
    c.upload(sid, path)
    upload_s = time.time() - t_up
    boot = float(re.findall(r"\[(\d+\.\d+)s\]", open(gc_log).read())[-1]) if os.path.exists(gc_log) else 0
    sampler = HeapSampler(pid)
    sampler.start()
    t0 = time.time()
    tl = watch(sid, until=("ENRICHING", "DONE", "FAILED", "CORRELATING"), poll_s=0.25, timeout_s=7200)
    ingest_s = time.time() - t0
    sampler.stop_evt.set()
    counts = db_counts(sid)
    size = os.path.getsize(path)
    lines = counts["line_sum"]
    s = sampler.samples
    res = {
        "file": os.path.basename(path), "bytes": size, "lines_ingested": lines, "heap_xmx": heap,
        "part_concurrency": conc, "extra": extra,
        "upload_s": round(upload_s, 2), "ingest_s": round(ingest_s, 2),
        "mb_per_s": round(size / 1e6 / ingest_s, 2), "lines_per_s": int(lines / ingest_s),
        "timeline_s": tl["timeline_s"], "final_status": tl["final"]["status"], "error": tl["final"]["error"],
        "idle_heap_used_mb": round(idle_heap, 1) if idle_heap else None,
        "peak_heap_used_mb": round(max(x[1] for x in s), 1) if s else None,
        "peak_old_gen_mb": round(max(x[2] for x in s), 1) if s else None,
        "peak_rss_mb": round(max(x[3] for x in s), 1) if s else None,
        "vm_hwm_mb": int(re.search(r"VmHWM:\s+(\d+)", open(f"/proc/{pid}/status").read()).group(1)) // 1024,
        "gc": gc_pauses(gc_log, boot), "chunks": counts["chunks"],
        "heap_series": [(round(t - t0, 2), round(u, 1)) for t, u, _, _ in s][::4],
    }
    c.delete_session(sid)
    app.stop()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", required=True)
    ap.add_argument("--heap", default="256m")
    ap.add_argument("--conc", default="3")
    ap.add_argument("--extra", default="--loglens.embedding.enabled=false")
    ap.add_argument("--out", default=os.path.join(HERE, "results", "ingest.json"))
    args = ap.parse_args()
    runs = []
    if os.path.exists(args.out):
        runs = json.load(open(args.out)).get("runs", [])
    for f in args.files.split(","):
        for conc in [int(x) for x in args.conc.split(",")]:
            r = run_one(f, args.heap, conc, [x for x in args.extra.split(" ") if x])
            r["date"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            r["commit"] = git_sha()
            print(json.dumps({k: v for k, v in r.items() if k != "heap_series"}), flush=True)
            runs.append(r)
            json.dump({"runs": runs}, open(args.out, "w"), indent=1)


if __name__ == "__main__":
    main()
