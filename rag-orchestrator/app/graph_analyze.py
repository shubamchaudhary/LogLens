"""Graph 1 — ingest-time correlation & report generation.

load -> cluster -> (correlate -> ground_check)* -> write_incidents
     -> compose_report[REPORTING] -> save_report[DONE]

Entry status is CORRELATING (the Java lane flips it there before calling us).
A session with no findings short-circuits to a trivial report with no LLM call.
Any unhandled failure marks the session FAILED with an error_message.
"""
from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any, Optional, TypedDict

from langgraph.graph import StateGraph, END

from . import config, db, llm, prompts

log = logging.getLogger("orchestrator.analyze")

# Findings in the same category whose time ranges overlap (or sit within this
# gap) are treated as one incident.
CLUSTER_GAP_SECONDS = 300


class AnalyzeState(TypedDict, total=False):
    session_id: str
    findings: list[dict[str, Any]]
    metrics: list[dict[str, Any]]
    clusters: list[list[dict[str, Any]]]
    cluster_idx: int
    attempt: int
    pending_narrative: str
    pending_root_cause: str
    incidents: list[dict[str, Any]]
    report_md: str
    report_json: str


# ── clustering (pure python, no LLM) ────────────────────────────────────────

def _overlaps(a: dict, b_start, b_end, tol: timedelta) -> bool:
    a_start, a_end = a.get("time_range_start"), a.get("time_range_end")
    if a_start is None or a_end is None or b_start is None or b_end is None:
        return False
    return (a_start - tol) <= b_end and b_start <= (a_end + tol)


def _cluster_findings(findings: list[dict]) -> list[list[dict]]:
    tol = timedelta(seconds=CLUSTER_GAP_SECONDS)
    by_cat: dict[str, list[dict]] = {}
    for f in findings:
        by_cat.setdefault(f.get("category", "?"), []).append(f)

    clusters: list[list[dict]] = []
    for _cat, group in by_cat.items():
        timed = [f for f in group if f.get("time_range_start") is not None]
        untimed = [f for f in group if f.get("time_range_start") is None]
        timed.sort(key=lambda f: f["time_range_start"])

        current: list[dict] = []
        cur_start = cur_end = None
        for f in timed:
            if current and _overlaps(f, cur_start, cur_end, tol):
                current.append(f)
                cur_start = min(cur_start, f["time_range_start"])
                cur_end = max(cur_end, f["time_range_end"])
            else:
                if current:
                    clusters.append(current)
                current = [f]
                cur_start, cur_end = f["time_range_start"], f["time_range_end"]
        if current:
            clusters.append(current)
        if untimed:
            clusters.append(untimed)  # all same-category untimed findings -> one incident
    return clusters


def _time_bounds(cluster: list[dict]):
    starts = [f["time_range_start"] for f in cluster if f.get("time_range_start")]
    ends = [f["time_range_end"] for f in cluster if f.get("time_range_end")]
    return (min(starts) if starts else None, max(ends) if ends else None)


# ── nodes ───────────────────────────────────────────────────────────────────

def load_node(state: AnalyzeState) -> AnalyzeState:
    sid = state["session_id"]
    findings = db.load_findings(sid)
    metrics = db.load_top_metrics(sid, config.TOP_METRICS_LIMIT)
    log.info("[%s] loaded %d findings, %d metric groups", sid, len(findings), len(metrics))
    return {"findings": findings, "metrics": metrics}


def cluster_node(state: AnalyzeState) -> AnalyzeState:
    clusters = _cluster_findings(state.get("findings", []))
    log.info("[%s] clustered into %d incident group(s)", state["session_id"], len(clusters))
    # Fresh run: remove any incidents left by a previous attempt.
    db.clear_incidents(state["session_id"])
    return {"clusters": clusters, "cluster_idx": 0, "attempt": 0, "incidents": []}


def correlate_node(state: AnalyzeState) -> AnalyzeState:
    cluster = state["clusters"][state["cluster_idx"]]
    data = llm.chat_json(prompts.CORRELATE_SYSTEM, prompts.correlate_user(cluster))
    return {
        "pending_narrative": str(data.get("narrative", "")).strip(),
        "pending_root_cause": str(data.get("root_cause", "")).strip() or None,
    }


def ground_check_node(state: AnalyzeState) -> AnalyzeState:
    idx = state["cluster_idx"]
    cluster = state["clusters"][idx]
    narrative = state.get("pending_narrative", "")
    root_cause = state.get("pending_root_cause") or ""
    attempt = state.get("attempt", 0)

    verdict = llm.chat_json(
        prompts.GROUND_CHECK_SYSTEM,
        prompts.ground_check_user(cluster, narrative, root_cause),
    )
    grounded = bool(verdict.get("grounded"))
    last_attempt = attempt + 1 >= config.MAX_CORRELATE_ATTEMPTS

    if grounded or last_attempt:
        start, end = _time_bounds(cluster)
        incident = {
            "time_range_start": start,
            "time_range_end": end,
            "finding_ids": [f["id"] for f in cluster],
            "narrative": narrative or "(no narrative generated)",
            "root_cause": state.get("pending_root_cause"),
        }
        incidents = list(state.get("incidents", [])) + [incident]
        if not grounded:
            log.warning("[%s] cluster %d accepted ungrounded after %d attempts",
                        state["session_id"], idx, attempt + 1)
        return {"incidents": incidents, "cluster_idx": idx + 1, "attempt": 0}

    log.info("[%s] cluster %d not grounded, regenerating (attempt %d)",
             state["session_id"], idx, attempt + 1)
    return {"attempt": attempt + 1}


def write_incidents_node(state: AnalyzeState) -> AnalyzeState:
    sid = state["session_id"]
    for inc in state.get("incidents", []):
        db.insert_incident(
            sid,
            inc["time_range_start"],
            inc["time_range_end"],
            inc["finding_ids"],
            inc["narrative"],
            inc["root_cause"],
        )
    log.info("[%s] wrote %d incident(s)", sid, len(state.get("incidents", [])))
    return {}


def compose_report_node(state: AnalyzeState) -> AnalyzeState:
    sid = state["session_id"]
    db.set_status(sid, "REPORTING")
    findings = state.get("findings", [])
    incidents = state.get("incidents", [])
    metrics = state.get("metrics", [])

    if not findings:
        # No anomalies were found — emit a clean bill of health without an LLM call.
        md = ("# Log Analysis Report\n\n"
              "No anomalies were detected in this session. All parsed metrics were "
              "within normal ranges.\n")
        payload = {"summary": "No anomalies detected.", "incident_count": 0,
                   "severity": "INFO", "metrics_reviewed": len(metrics)}
        return {"report_md": md, "report_json": json.dumps(payload)}

    data = llm.chat_json(prompts.REPORT_SYSTEM, prompts.report_user(incidents, metrics))
    md = str(data.get("markdown") or "# Log Analysis Report\n\n(report body missing)")
    payload = {
        "summary": data.get("summary", ""),
        "incident_count": data.get("incident_count", len(incidents)),
        "severity": data.get("severity", "WARN"),
        "metrics_reviewed": len(metrics),
    }
    return {"report_md": md, "report_json": json.dumps(payload)}


def save_report_node(state: AnalyzeState) -> AnalyzeState:
    sid = state["session_id"]
    db.upsert_report(sid, state["report_md"], state["report_json"])
    db.set_status(sid, "DONE")
    log.info("[%s] report saved, session DONE", sid)
    return {}


# ── routing ──────────────────────────────────────────────────────────────────

def _after_cluster(state: AnalyzeState) -> str:
    return "correlate" if state.get("clusters") else "compose_report"


def _after_ground_check(state: AnalyzeState) -> str:
    # attempt reset to 0 signals "accepted"; non-zero means "retry same cluster".
    if state.get("attempt", 0) != 0:
        return "correlate"
    if state.get("cluster_idx", 0) < len(state.get("clusters", [])):
        return "correlate"
    return "write_incidents"


def _build():
    b = StateGraph(AnalyzeState)
    b.add_node("load", load_node)
    b.add_node("cluster", cluster_node)
    b.add_node("correlate", correlate_node)
    b.add_node("ground_check", ground_check_node)
    b.add_node("write_incidents", write_incidents_node)
    b.add_node("compose_report", compose_report_node)
    b.add_node("save_report", save_report_node)

    b.set_entry_point("load")
    b.add_edge("load", "cluster")
    b.add_conditional_edges("cluster", _after_cluster,
                            {"correlate": "correlate", "compose_report": "compose_report"})
    b.add_edge("correlate", "ground_check")
    b.add_conditional_edges("ground_check", _after_ground_check,
                            {"correlate": "correlate", "write_incidents": "write_incidents"})
    b.add_edge("write_incidents", "compose_report")
    b.add_edge("compose_report", "save_report")
    b.add_edge("save_report", END)
    return b.compile()


GRAPH = _build()


def run_analysis(session_id: str) -> None:
    """Invoke Graph 1 for a session; mark FAILED on any unhandled error."""
    try:
        GRAPH.invoke({"session_id": session_id})
    except Exception as exc:  # noqa: BLE001 — top-level guard, must catch all
        log.exception("[%s] analysis failed", session_id)
        try:
            db.set_status(session_id, "FAILED", f"orchestrator analysis error: {exc}")
        except Exception:
            log.exception("[%s] could not record FAILED status", session_id)
