"""
ChunkAI RAG orchestrator — the Python LangGraph sidecar (Layer 3).

Two graphs run here, both reading and writing Postgres directly (the Java side
owns nothing in this layer):
  * Graph 1 (analyze)   — correlate Layer-2 findings into incidents + a report.
  * Graph 2 (drilldown) — grounded, cited Q&A over a session's log chunks.
"""
