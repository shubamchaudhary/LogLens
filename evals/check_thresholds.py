#!/usr/bin/env python3
"""Fail CI when an eval result drops below evals/thresholds.json."""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def get(d, dotted):
    for k in dotted.split("."):
        d = d[k]
    return d


def main() -> int:
    th = json.load(open(os.path.join(ROOT, "evals", "thresholds.json")))
    run = sys.argv[1] if len(sys.argv) > 1 else "anomaly_gating_robust"
    res = json.load(open(os.path.join(ROOT, "evals", "results", run, "results.json")))["results"]
    by_name = {r["dataset"]: r for r in res["synthetic"]}
    failures = []
    for dataset, checks in th["anomaly_gating"].items():
        for key, minimum in checks.items():
            value = get(by_name[dataset], key)
            ok = value >= minimum
            print(f"{'OK  ' if ok else 'FAIL'} {dataset} {key} = {value} (min {minimum})")
            if not ok:
                failures.append(key)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
