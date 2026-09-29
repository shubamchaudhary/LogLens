"""Prompt text for both graphs. Kept in one place so the model contract is auditable."""
import re

PROMPT_VERSION = "2026-09-29.2"  # bump on any prompt change; eval reports record it

_STOP = frozenset("a an the and or of to in on at by for from with as is are was were be been do does did what "
                  "which who when where why how many much any there it its this that around about during first "
                  "last time happen happened went wrong".split())


def focus_snippet(content: str, question: str, max_chars: int) -> str:
    """The lines of a chunk most relevant to the question, in log order, within max_chars.

    A chunk is a whole 60 s window (often 10-20 KB). Showing the model only its
    first max_chars hid the evidence: the retrieval eval found ~11% of gold lines
    visible that way. Lines are scored by how many question terms they contain;
    WARN/ERROR/exception lines get a small boost; the top lines are then emitted
    in their original order, so the budget is spent on evidence, not on the
    window's first few INFO lines.
    """
    if len(content) <= max_chars:
        return content
    terms = {t for t in re.findall(r"[a-z0-9_.]+", question.lower()) if len(t) > 1 and t not in _STOP}
    lines = content.split("\n")
    scored = []
    for i, ln in enumerate(lines):
        low = ln.lower()
        score = sum(1 for t in terms if t in low)
        if re.search(r"\b(ERROR|FATAL|WARN|WARNING)\b|Exception|Error:", ln):
            score += 0.5
        scored.append((score, i))
    picked, used = [], 0
    for score, i in sorted(scored, key=lambda x: (-x[0], x[1])):
        cost = len(lines[i]) + 1
        if used + cost > max_chars:
            continue
        picked.append(i)
        used += cost
    return "\n".join(lines[i] for i in sorted(picked))

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
    "You are writing the final log-analysis report for an on-call engineer, using "
    "the correlated incidents and the top parser metrics provided.\n\n"
    "FORMAT — GitHub-flavoured MARKDOWN with this structure:\n"
    "- '# Log Analysis Report' title.\n"
    "- '## Summary' — 2-4 sentences: what happened and how bad.\n"
    "- '## Key Metrics' — a MARKDOWN TABLE of the most important parser metrics "
    "(columns: Category | Metric | Total | p95 (ms)). Use '—' where a value is "
    "absent. These numbers come from deterministic parsers — reproduce them "
    "exactly, never round or invent.\n"
    "- '## Incidents' — for each incident a '### <short title>' followed by a "
    "chronological narrative and a **Root cause:** line.\n"
    "- '## Recommendations' — a short bullet list of concrete, evidence-based "
    "actions.\n\n"
    "RULES: Be concrete and concise. Do NOT invent incidents, services, or "
    "metrics beyond what is provided. Every number must trace to the given "
    "metrics.\n\n"
    "Respond with STRICT JSON only (no fences), where \"markdown\" is the full "
    "report as a markdown string:\n"
    '{"markdown": "# Log Analysis Report ...", '
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
        snippet = focus_snippet(d.get("content") or "", question, 500)
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
    "You are a precise site-reliability analyst answering a question about "
    "application logs, using ONLY the provided log chunks as evidence.\n\n"
    "STYLE:\n"
    "- Write a clear, well-structured answer in GitHub-flavoured MARKDOWN.\n"
    "- Lead with a one- or two-sentence direct answer, then supporting detail.\n"
    "- When the evidence contains multiple items, counts, timestamps, error "
    "types, endpoints, or latencies, present them as a MARKDOWN TABLE "
    "(e.g. columns like Time | Component | Error | Count). Use bullet lists for "
    "non-tabular detail. Use short section headers only if the answer is long.\n"
    "- Be specific: quote exact error strings, status codes, and line references "
    "that appear in the evidence.\n\n"
    "GROUNDING (critical — do not violate):\n"
    "- Use ONLY facts present in the chunks. Never invent log lines, numbers, "
    "services, or timestamps.\n"
    "- Do NOT compute totals the evidence doesn't state; if you count occurrences, "
    "count only what is visibly present in the shown chunks and say so.\n"
    "- If the chunks do not contain the answer, say that plainly instead of "
    "guessing.\n"
    "- Cite the chunk ids you actually used.\n\n"
    "Respond with STRICT JSON only (no fences), where \"answer\" is a markdown "
    "string:\n"
    '{"answer": "<markdown answer>", "citations": ["<chunk_id>", ...]}'
)


def generate_user(question: str, docs: list[dict]) -> str:
    lines = [f"QUESTION: {question}", "", "EVIDENCE CHUNKS:"]
    for d in docs:
        rng = f"lines {d.get('line_start')}-{d.get('line_end')}"
        snippet = focus_snippet(d.get("content") or "", question, 800)
        lines.append(f"[id={d.get('chunk_id')} {rng}]\n{snippet}\n")
    return "\n".join(lines)
