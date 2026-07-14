"""Graph 2 — interactive drill-down Q&A over one session's chunks.

retrieve -> grade -> (weak? rewrite -> retrieve)* -> generate -> {answer, citations}

Hybrid retrieval (pgvector kNN + full-text) is grounded strictly in the
session's own log chunks; the answer cites the chunk ids it used.
"""
from __future__ import annotations

import logging
from typing import Any, Optional, TypedDict

from langgraph.graph import StateGraph, END

from . import config, db, llm, prompts

log = logging.getLogger("orchestrator.drilldown")


class DrilldownState(TypedDict, total=False):
    session_id: str
    original_question: str
    question: str
    docs: list[dict[str, Any]]
    best_docs: list[dict[str, Any]]
    graded: list[dict[str, Any]]
    rewrites: int
    answer: str
    citations: list[str]


def retrieve_node(state: DrilldownState) -> DrilldownState:
    q = state["question"]
    embedding: Optional[list[float]] = None
    if config.has_api_key():
        try:
            embedding = llm.embed_query(q)
        except Exception:
            log.exception("embedding failed, falling back to full-text only")
    docs = db.retrieve_chunks(state["session_id"], embedding, q, config.RETRIEVE_LIMIT)
    log.info("[%s] retrieved %d chunk(s)", state["session_id"], len(docs))
    out: DrilldownState = {"docs": docs}
    # Preserve the first useful retrieval so a degrading rewrite (or an
    # over-strict grader) can never leave us answering from nothing.
    if docs and not state.get("best_docs"):
        out["best_docs"] = docs
    return out


def grade_node(state: DrilldownState) -> DrilldownState:
    docs = state.get("docs", [])
    if not docs:
        return {"graded": []}
    verdict = llm.chat_json(prompts.GRADE_SYSTEM, prompts.grade_user(state["question"], docs))
    keep = {str(x) for x in verdict.get("relevant_ids", [])}
    graded = [d for d in docs if str(d["chunk_id"]) in keep]
    log.info("[%s] graded %d/%d chunk(s) relevant", state["session_id"], len(graded), len(docs))
    return {"graded": graded}


def rewrite_node(state: DrilldownState) -> DrilldownState:
    data = llm.chat_json(
        prompts.REWRITE_SYSTEM,
        prompts.rewrite_user(state["original_question"], state["question"]),
    )
    new_q = str(data.get("question") or state["question"]).strip()
    log.info("[%s] rewrote question (attempt %d): %s",
             state["session_id"], state.get("rewrites", 0) + 1, new_q)
    return {"question": new_q, "rewrites": state.get("rewrites", 0) + 1}


def generate_node(state: DrilldownState) -> DrilldownState:
    # Prefer graded-relevant docs; fall back to the current retrieval, then to the
    # first useful retrieval we ever saw (best_docs) so an over-strict grader or a
    # degrading rewrite can never force an empty-evidence answer.
    docs = state.get("graded") or state.get("docs") or state.get("best_docs", [])
    if not docs:
        return {"answer": "No relevant log evidence was found for this question.",
                "citations": []}
    data = llm.chat_json(prompts.GENERATE_SYSTEM, prompts.generate_user(state["question"], docs))
    valid_ids = {str(d["chunk_id"]) for d in docs}
    citations = [str(c) for c in data.get("citations", []) if str(c) in valid_ids]
    return {"answer": str(data.get("answer", "")).strip(), "citations": citations}


def _after_grade(state: DrilldownState) -> str:
    if state.get("graded"):
        return "generate"
    if state.get("rewrites", 0) < config.MAX_REWRITES:
        return "rewrite"
    return "generate"  # give up rewriting; answer from whatever we have


def _build():
    b = StateGraph(DrilldownState)
    b.add_node("retrieve", retrieve_node)
    b.add_node("grade", grade_node)
    b.add_node("rewrite", rewrite_node)
    b.add_node("generate", generate_node)

    b.set_entry_point("retrieve")
    b.add_edge("retrieve", "grade")
    b.add_conditional_edges("grade", _after_grade,
                            {"generate": "generate", "rewrite": "rewrite"})
    b.add_edge("rewrite", "retrieve")
    b.add_edge("generate", END)
    return b.compile()


GRAPH = _build()


def run_drilldown(session_id: str, question: str) -> dict[str, Any]:
    final = GRAPH.invoke({
        "session_id": session_id,
        "original_question": question,
        "question": question,
        "rewrites": 0,
    })
    return {"answer": final.get("answer", ""), "citations": final.get("citations", [])}
