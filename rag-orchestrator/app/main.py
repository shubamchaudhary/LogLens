"""FastAPI entrypoint for the RAG orchestrator (LangGraph sidecar).

Endpoints:
  GET  /health              — liveness + whether a Gemini key is configured
  POST /analyze/{sid}       — kick Graph 1 in the background, return 202
  POST /drilldown           — run Graph 2 synchronously, return the cited answer
"""
from __future__ import annotations

import logging
import uuid

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import config, db, graph_analyze, graph_drilldown, llm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("orchestrator")

app = FastAPI(title="ChunkAI RAG Orchestrator", version="1.0.0")


class DrilldownRequest(BaseModel):
    session_id: str
    question: str = Field(min_length=1)


class DrilldownResponse(BaseModel):
    answer: str
    citations: list[str]


def _valid_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="invalid session_id (must be a UUID)")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "gemini_key_configured": config.has_api_key()}


@app.post("/analyze/{session_id}", status_code=202)
def analyze(session_id: str, background: BackgroundTasks) -> dict:
    sid = _valid_uuid(session_id)
    if not db.session_exists(sid):
        raise HTTPException(status_code=404, detail="session not found")
    log.info("[%s] /analyze accepted, dispatching Graph 1", sid)
    background.add_task(graph_analyze.run_analysis, sid)
    return {"status": "accepted", "session_id": sid}


@app.post("/drilldown", response_model=DrilldownResponse)
async def drilldown(req: DrilldownRequest) -> DrilldownResponse:
    sid = _valid_uuid(req.session_id)
    if not db.session_exists(sid):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        result = await run_in_threadpool(graph_drilldown.run_drilldown, sid, req.question)
    except llm.ProviderRateLimited as exc:
        # Every key in the pool is rate-limited (typically a daily quota cap).
        # Surface a distinct 429 so the client can tell "rate-limited, try later"
        # apart from a genuine orchestrator outage.
        log.warning("[%s] drilldown rate-limited: %s", sid, exc)
        raise HTTPException(status_code=429, detail="AI provider rate-limited; try again later")
    return DrilldownResponse(**result)
