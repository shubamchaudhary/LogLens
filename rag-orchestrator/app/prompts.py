"""Prompt text for both graphs. Kept in one place so the model contract is auditable."""

# ── Graph 1: correlate a cluster of findings into one incident ──────────────
CORRELATE_SYSTEM = (
    "You are a site-reliability incident analyst. You are given a cluster of "
    "log findings that overlap in time and category. Correlate them into a single "
    "coherent incident: what happened, in what order, and the most likely root "
    "cause. Ground every statement in the given finding titles/explanations — do "
    "not invent services, errors, or metrics.\n\n"
    "Respond with STRICT JSON only (no markdown fences):\n"
    '{"narrative": "2-5 sentence chronological account", '
    '"root_cause": "one-sentence most-likely root cause"}'
)


def correlate_user(findings: list[dict]) -> str:
    lines = ["FINDINGS IN THIS CLUSTER:"]
    for f in findings:
        lines.append(
            f"- [{f.get('severity')}/{f.get('category')}] {f.get('title')}: "
            f"{f.get('explanation')}"
        )
    return "\n".join(lines)


# ── Graph 1: ground-check judge ─────────────────────────────────────────────
GROUND_CHECK_SYSTEM = (
    "You are a strict grounding judge. Given the source findings and a proposed "
    "incident narrative + root cause, decide whether EVERY claim in the narrative "
    "is supported by the findings. If anything is invented or unsupported, it fails.\n\n"
    'Respond with STRICT JSON only: {"grounded": true|false, "reason": "short"}'
)


def ground_check_user(findings: list[dict], narrative: str, root_cause: str) -> str:
    src = "\n".join(
        f"- [{f.get('severity')}/{f.get('category')}] {f.get('title')}: {f.get('explanation')}"
        for f in findings
    )
    return (
        f"SOURCE FINDINGS:\n{src}\n\n"
        f"PROPOSED NARRATIVE:\n{narrative}\n\n"
        f"PROPOSED ROOT CAUSE:\n{root_cause}"
    )


# ── Graph 1: compose the final report ───────────────────────────────────────
REPORT_SYSTEM = (
    "You are writing the final log-analysis report for an on-call engineer. Use "
    "the correlated incidents and the top parser metrics. Be concrete and concise. "
    "Do not invent data beyond what is provided.\n\n"
    "Respond with STRICT JSON only (no fences):\n"
    '{"markdown": "# Report ... full markdown ...", '
    '"summary": "one-paragraph executive summary", '
    '"incident_count": <int>, "severity": "INFO|WARN|ERROR|CRITICAL"}'
)


def report_user(incidents: list[dict], metrics: list[dict]) -> str:
    inc_lines = ["INCIDENTS:"]
    if not incidents:
        inc_lines.append("  (none — no correlated incidents)")
    for i, inc in enumerate(incidents, 1):
        inc_lines.append(f"{i}. {inc.get('narrative')}  [root cause: {inc.get('root_cause')}]")
    met_lines = ["", "TOP METRICS:"]
    for m in metrics[:25]:
        extra = ""
        if m.get("max_p95") is not None:
            extra = f" p95={m.get('max_p95')}ms"
        met_lines.append(f"- {m.get('category')}.{m.get('metric')} total={m.get('total')}{extra}")
    return "\n".join(inc_lines + met_lines)


# ── Graph 2: grade retrieved chunks ─────────────────────────────────────────
GRADE_SYSTEM = (
    "You judge whether each retrieved log chunk is relevant to the question. "
    "Return only the ids of chunks that are actually relevant.\n\n"
    'Respond with STRICT JSON only: {"relevant_ids": ["<chunk_id>", ...]}'
)


def grade_user(question: str, docs: list[dict]) -> str:
    lines = [f"QUESTION: {question}", "", "CHUNKS:"]
    for d in docs:
        snippet = (d.get("content") or "")[:500]
        lines.append(f"[id={d.get('chunk_id')}] {snippet}")
    return "\n".join(lines)


# ── Graph 2: rewrite a weak question ────────────────────────────────────────
REWRITE_SYSTEM = (
    "The current question retrieved little relevant context from application logs. "
    "Rewrite it to be more specific to log terminology (status codes, exception "
    "class names, latency, pool/thread/GC terms) while preserving intent.\n\n"
    'Respond with STRICT JSON only: {"question": "rewritten question"}'
)


def rewrite_user(original: str, current: str) -> str:
    return f"ORIGINAL QUESTION: {original}\nCURRENT QUESTION: {current}"


# ── Graph 2: generate the grounded, cited answer ────────────────────────────
GENERATE_SYSTEM = (
    "Answer the question using ONLY the provided log chunks. Cite the specific "
    "chunk ids you used. If the chunks do not contain the answer, say so plainly. "
    "Never invent log lines.\n\n"
    "Respond with STRICT JSON only (no fences):\n"
    '{"answer": "grounded answer referencing the evidence", '
    '"citations": ["<chunk_id>", ...]}'
)


def generate_user(question: str, docs: list[dict]) -> str:
    lines = [f"QUESTION: {question}", "", "EVIDENCE CHUNKS:"]
    for d in docs:
        rng = f"lines {d.get('line_start')}-{d.get('line_end')}"
        snippet = (d.get("content") or "")[:800]
        lines.append(f"[id={d.get('chunk_id')} {rng}]\n{snippet}\n")
    return "\n".join(lines)
