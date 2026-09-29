"""Shared helpers for the eval and bench scripts."""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_CP_FILE = os.path.join(ROOT, "loglens-backend", "build", "test-classpath.txt")


def git_sha() -> str:
    try:
        sha = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = subprocess.call(["git", "diff", "--quiet"], cwd=ROOT) != 0
        return sha + ("-dirty" if dirty else "")
    except Exception:
        return "unknown"


def java_cp() -> str:
    """Test runtime classpath written by `./gradlew :loglens-backend:printTestClasspath`."""
    if not os.path.exists(_CP_FILE):
        raise SystemExit("Run ./gradlew :loglens-backend:printTestClasspath first")
    return open(_CP_FILE).read().strip()


def write_report(out_dir: str, meta: dict, results: dict, markdown: str) -> None:
    """Every run writes machine-readable JSON plus a dated Markdown report."""
    os.makedirs(out_dir, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump({"meta": meta, "results": results}, f, indent=2, default=str)
    with open(os.path.join(out_dir, "REPORT.md"), "w") as f:
        f.write(markdown)
    with open(os.path.join(out_dir, f"history-{stamp}.json"), "w") as f:
        json.dump({"meta": meta, "results": results}, f, default=str)
    print(markdown)
