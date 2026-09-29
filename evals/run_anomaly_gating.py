#!/usr/bin/env python3
"""Anomaly-detection + LLM-gating eval (deterministic, no LLM calls, $0).

For every dataset it runs the production Layer-1 path (WindowEvalCli: chunker,
parsers, AnomalyDetector, finalizer latency rule) and scores the flagged
windows against labels:

  * window precision / recall / F1   (a window is positive if any line in it
                                      belongs to a labelled incident/alert)
  * incident recall + detection delay (synthetic incidents only)
  * false alarms per hour of log time
  * gating: LLM calls and estimated tokens WITH the gate (anomalous windows
    only, as EnrichProducer does) vs WITHOUT it (every window), using the same
    record-aware splitter + token estimate as EnrichConsumer

Usage:
  python evals/run_anomaly_gating.py            # full suite
  python evals/run_anomaly_gating.py --fast     # CI subset
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from common import git_sha, java_cp, write_report  # noqa: E402

SYN = os.path.join(ROOT, "evals", "datasets", "synthetic")
LH = os.path.join(ROOT, "evals", "datasets", "loghub", "prepared")


MODE = "robust"


def run_windows(log_path: str, out_json: str, window_s: int = 60) -> dict:
    subprocess.run(["java", "-Xmx1g", "-cp", java_cp(), "com.loglens.ingest.WindowEvalCli",
                    log_path, out_json, str(window_s), "5000", MODE],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return json.load(open(out_json))


def positive_windows(windows, positive_lines: set[int]) -> list[bool]:
    sorted_lines = sorted(positive_lines)
    import bisect
    out = []
    for w in windows:
        i = bisect.bisect_left(sorted_lines, w["lineStart"])
        out.append(i < len(sorted_lines) and sorted_lines[i] <= w["lineEnd"])
    return out


def score(windows, truth: list[bool]) -> dict:
    tp = sum(1 for w, t in zip(windows, truth) if w["anomalous"] and t)
    fp = sum(1 for w, t in zip(windows, truth) if w["anomalous"] and not t)
    fn = sum(1 for w, t in zip(windows, truth) if not w["anomalous"] and t)
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3)}


def log_hours(windows, window_s=60) -> float:
    b = [dt.datetime.fromisoformat(w["bucket"].replace("Z", "+00:00")) for w in windows]
    return ((max(b) - min(b)).total_seconds() + window_s) / 3600 if b else 0.0


def gating(windows) -> dict:
    flagged = [w for w in windows if w["anomalous"]]
    calls_g = sum(w["llmCalls"] for w in flagged)
    calls_all = sum(w["llmCalls"] for w in windows)
    tok_g = sum(w["estTokens"] for w in flagged)
    tok_all = sum(w["estTokens"] for w in windows)
    return {
        "windows": len(windows), "flagged_windows": len(flagged),
        "flagged_share": round(len(flagged) / len(windows), 3) if windows else 0,
        "llm_calls_gated": calls_g, "llm_calls_ungated": calls_all,
        "call_reduction": round(1 - calls_g / calls_all, 3) if calls_all else 0,
        "est_tokens_gated": tok_g, "est_tokens_ungated": tok_all,
        "token_reduction": round(1 - tok_g / tok_all, 3) if tok_all else 0,
        "reasons": _reason_counts(flagged),
    }


def _reason_counts(flagged):
    c: dict[str, int] = {}
    for w in flagged:
        for r in w["reasons"]:
            c[r] = c.get(r, 0) + 1
    return dict(sorted(c.items(), key=lambda kv: -kv[1]))


def incident_detection(windows, labels) -> list[dict]:
    out = []
    for inc in labels["incidents"]:
        mask = positive_windows(windows, set(inc["lines"]))
        hit = [w for w, m in zip(windows, mask) if m]
        flagged = [w for w in hit if w["anomalous"]]
        start = dt.datetime.fromisoformat(labels["start"]) + dt.timedelta(seconds=inc["start_s"])
        delay = None
        if flagged:
            first = min(dt.datetime.fromisoformat(w["bucket"].replace("Z", "+00:00")) for w in flagged)
            delay = max(0, int((first - start).total_seconds()))
        out.append({"kind": inc["kind"], "detectable_by_design": inc["detectable"], "windows": len(hit),
                    "flagged_windows": len(flagged), "detected": bool(flagged), "delay_s": delay,
                    "reasons": _reason_counts(flagged)})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--mode", choices=["legacy", "robust"], default="robust",
                    help="loglens.anomaly.mode to evaluate (feature flag)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    global MODE
    MODE = args.mode
    args.out = args.out or os.path.join(ROOT, "evals", "results",
                                        f"anomaly_gating_{args.mode}" + ("_fast" if args.fast else ""))
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.out, "windows")
    os.makedirs(work, exist_ok=True)

    results = {"synthetic": [], "heldout": [], "loghub": [], "owner_sample": None, "volume_sensitivity": []}
    noises = ["medium"] if args.fast else ["low", "medium", "high"]
    for n in noises:
        name = f"eval_{n}noise"
        labels = json.load(open(os.path.join(SYN, f"{name}.labels.json")))
        w = run_windows(os.path.join(SYN, f"{name}.log"), os.path.join(work, f"{name}.json"))["windows"]
        truth = positive_windows(w, {int(k) for k in labels["line_incident"]})
        inc = incident_detection(w, labels)
        results["synthetic"].append({
            "dataset": name, "noise": n, "lines": labels["lines"], "log_hours": round(log_hours(w), 2),
            "window": score(w, truth),
            "false_alarms_per_hour": round(sum(1 for x, t in zip(w, truth) if x["anomalous"] and not t) / log_hours(w), 2),
            "incident_recall": round(sum(i["detected"] for i in inc) / len(inc), 3),
            "incidents": inc, "gating": gating(w)})

    if not args.fast:
        # held-out seeds: same generator, different random streams (rules were not tuned on these)
        for seed in [101, 202, 303]:
            name = f"heldout_seed{seed}"
            path = os.path.join(SYN, f"{name}.log")
            if not os.path.exists(path):
                subprocess.run([sys.executable, os.path.join(ROOT, "evals", "generate_corpus.py"), "--name", name,
                                "--hours", "6", "--rate", "2", "--seed", str(seed), "--noise", "medium"],
                               check=True, stdout=subprocess.DEVNULL)
            labels = json.load(open(os.path.join(SYN, f"{name}.labels.json")))
            w = run_windows(path, os.path.join(work, f"{name}.json"))["windows"]
            truth = positive_windows(w, {int(k) for k in labels["line_incident"]})
            inc = incident_detection(w, labels)
            results["heldout"].append({"dataset": name, "window": score(w, truth),
                                       "incident_recall": round(sum(i["detected"] for i in inc) / len(inc), 3),
                                       "missed": [i["kind"] for i in inc if not i["detected"]],
                                       "gating": {k: v for k, v in gating(w).items() if k != "reasons"}})
        for name in ["BGL", "Thunderbird", "HDFS", "Spark", "Apache"]:
            doc = run_windows(os.path.join(LH, f"{name}_2k.iso.log"), os.path.join(work, f"{name}.json"))
            raw = run_windows(os.path.join(ROOT, "evals", "datasets", "loghub", f"{name}_2k.log"),
                              os.path.join(work, f"{name}.raw.json"))
            w = doc["windows"]
            entry = {"dataset": f"Loghub {name}_2k", "lines": doc["lines"],
                     "native_timestamp_recognition": round(raw["timestampRecognizedLines"] / raw["lines"], 3),
                     "log_hours": round(log_hours(w), 2), "gating": gating(w)}
            lab = os.path.join(LH, f"{name}_2k.labels.json")
            if os.path.exists(lab):
                L = json.load(open(lab))
                truth = positive_windows(w, set(L["alert_lines"]))
                entry["window"] = score(w, truth)
                entry["false_alarms_per_hour"] = round(entry["window"]["fp"] / entry["log_hours"], 2)
                entry["alert_lines"] = len(L["alert_lines"])
            results["loghub"].append(entry)

        own = run_windows(os.path.join(ROOT, "evals", "datasets", "owner_sample_10k.log"),
                          os.path.join(work, "owner_sample_10k.json"))
        results["owner_sample"] = {"dataset": "owner_sample_10k (docs/10klogs.txt from repo history)",
                                   "lines": own["lines"], "gating": gating(own["windows"])}

        # Same generator, same seed, only the line rate changes: does the gate scale with traffic?
        for rate in [1, 2, 5, 20, 50]:
            name = f"volume_rate{rate}"
            path = os.path.join(SYN, f"{name}.log")
            if not os.path.exists(path):
                subprocess.run([sys.executable, os.path.join(ROOT, "evals", "generate_corpus.py"), "--name", name,
                                "--hours", "2", "--rate", str(rate), "--seed", "11", "--noise", "medium",
                                "--incidents", "4"], check=True, stdout=subprocess.DEVNULL)
            labels = json.load(open(os.path.join(SYN, f"{name}.labels.json")))
            w = run_windows(path, os.path.join(work, f"{name}.json"))["windows"]
            truth = positive_windows(w, {int(k) for k in labels["line_incident"]})
            results["volume_sensitivity"].append({"lines_per_s": rate, "window": score(w, truth),
                                                  "gating": {k: v for k, v in gating(w).items() if k != "reasons"}})

    meta = {"eval": "anomaly_gating", "mode": MODE, "date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "commit": git_sha(), "fast": args.fast, "llm_calls_made": 0, "cost_usd": 0.0,
            "config": {"window_seconds": 60, "max_content_chars": 5000, "warn_threshold": 5,
                       "latency_multiplier": 3.0}}
    write_report(args.out, meta, results, render_md(meta, results))


def render_md(meta, res) -> str:
    L = [f"# Anomaly detection and LLM gating eval (loglens.anomaly.mode={meta['mode']})",
         "",
         f"- Date: {meta['date']}  |  Commit: `{meta['commit']}`  |  LLM calls made: 0  |  Cost: $0",
         f"- Config: window {meta['config']['window_seconds']}s, max {meta['config']['max_content_chars']} chars/LLM call, "
         f"WARN burst >= {meta['config']['warn_threshold']}, latency > {meta['config']['latency_multiplier']}x corpus p95",
         "- How: production chunker + parsers + AnomalyDetector run by `WindowEvalCli`; scored by this script.",
         "", "## Synthetic app logs (labelled incidents)", "",
         "| Dataset | Windows | Flagged | Precision | Recall | F1 | False alarms/h | Incident recall | LLM calls gated / ungated | Call reduction |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for s in res["synthetic"]:
        g, w = s["gating"], s["window"]
        L.append(f"| {s['dataset']} | {g['windows']} | {g['flagged_windows']} | {w['precision']} | {w['recall']} | {w['f1']} | "
                 f"{s['false_alarms_per_hour']} | {s['incident_recall']} | {g['llm_calls_gated']} / {g['llm_calls_ungated']} | "
                 f"{g['call_reduction']:.1%} |")
    if res["synthetic"]:
        L += ["", "### Per-incident detection (" + res["synthetic"][0]["dataset"] + ")", "",
              "| Incident | Detectable by design | Windows | Flagged | Detected | Delay (s) | Rules that fired |", "|---|---|---|---|---|---|---|"]
        for i in res["synthetic"][min(1, len(res['synthetic']) - 1)]["incidents"]:
            L.append(f"| {i['kind']} | {i['detectable_by_design']} | {i['windows']} | {i['flagged_windows']} | {i['detected']} | "
                     f"{i['delay_s']} | {', '.join(f'{k}:{v}' for k, v in i['reasons'].items())} |")
    if res["heldout"]:
        L += ["", "## Held-out generator seeds (rules not tuned on these)", "",
              "| Dataset | Precision | Recall | F1 | Incident recall | Missed | Call reduction |", "|---|---|---|---|---|---|---|"]
        for h in res["heldout"]:
            L.append(f"| {h['dataset']} | {h['window']['precision']} | {h['window']['recall']} | {h['window']['f1']} | "
                     f"{h['incident_recall']} | {', '.join(h['missed']) or '-'} | {h['gating']['call_reduction']:.1%} |")
    if res["loghub"]:
        L += ["", "## Loghub 2k samples", "",
              "| Dataset | Native timestamp recognition | Windows | Flagged share | Precision | Recall | F1 | Call reduction |",
              "|---|---|---|---|---|---|---|---|"]
        for e in res["loghub"]:
            w = e.get("window", {})
            L.append(f"| {e['dataset']} | {e['native_timestamp_recognition']:.1%} | {e['gating']['windows']} | "
                     f"{e['gating']['flagged_share']:.1%} | {w.get('precision', 'n/a')} | {w.get('recall', 'n/a')} | "
                     f"{w.get('f1', 'n/a')} | {e['gating']['call_reduction']:.1%} |")
    if res["owner_sample"]:
        g = res["owner_sample"]["gating"]
        L += ["", "## Owner's 10k-line sample (the demo corpus)", "",
              f"{g['flagged_windows']} of {g['windows']} windows flagged; LLM calls {g['llm_calls_gated']} gated vs "
              f"{g['llm_calls_ungated']} ungated ({g['call_reduction']:.1%} fewer). Rules: {g['reasons']}"]
    if res["volume_sensitivity"]:
        L += ["", "## Does the gate scale with traffic? (same generator, only lines/s changes)", "",
              "| Lines/s | Windows | Flagged share | Call reduction | Precision | Recall |", "|---|---|---|---|---|---|"]
        for v in res["volume_sensitivity"]:
            L.append(f"| {v['lines_per_s']} | {v['gating']['windows']} | {v['gating']['flagged_share']:.1%} | "
                     f"{v['gating']['call_reduction']:.1%} | {v['window']['precision']} | {v['window']['recall']} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
