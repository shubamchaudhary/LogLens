#!/usr/bin/env python3
"""Answer-quality evals for Graph 2 (corrective RAG) — needs a chat model.

For every golden question it runs the REAL LangGraph drill-down graph
(rag-orchestrator/app/graph_drilldown.py) and scores the final state:

  correctness      exact numbers / times / entities checked by code (no judge)
  abstention       unanswerable -> must decline; answerable -> must not
  citations        validity (cited ids were retrieved), precision (cited chunk
                   contains a gold line), recall (>= 1 cited chunk with a gold line)
  faithfulness     LLM judge: share of answer claims supported by the cited text
                   (judge should be a DIFFERENT model family from the generator)
  corrective loop  how often grade->rewrite fired, rewrites used, extra calls

Cost guard: every chat call goes through a disk cache keyed by
sha256(model + params + system + user), so re-runs are free; before a run the
script estimates tokens and cost and refuses above --max-usd unless --yes.

Providers: the generator is whatever the orchestrator is configured for
(LLM_PROVIDER / GROQ_* / GEMINI_*). The judge: --judge anthropic (ANTHROPIC_API_KEY,
recommended: different family) | gemini | none. `--dry-run` uses bench/llm_stub.py
to prove the wiring only; its scores are NOT quality numbers.

Judge agreement: `--export-judge-sample 40` writes items for the owner to label
(evals/datasets/judge_labels.todo.json); once labelled (judge_labels.json),
`--kappa` reports Cohen's kappa between the judge and the owner.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import statistics
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "rag-orchestrator"))
os.environ.setdefault("DATABASE_URL", "postgresql://loglens:loglens123@localhost:5434/loglens_db")
from common import git_sha, write_report  # noqa: E402

CACHE_DIR = os.path.join(ROOT, "evals", ".cache", "llm")
QA = os.path.join(ROOT, "evals", "datasets", "golden_qa.json")
ABSTAIN = re.compile(r"(do(es)? not contain|no (relevant )?(log )?evidence|not (found|present|available|mentioned)|"
                     r"cannot (be )?(determined|answer)|no information|not in the (logs|provided))", re.I)
PRICE_PER_MTOK = {"llama-3.3-70b-versatile": (0.59, 0.79), "llama-3.1-8b-instant": (0.05, 0.08),
                  "gemini-2.5-flash": (0.30, 2.50), "claude-haiku-4-5-20251001": (1.0, 5.0)}  # USD in/out, verify before use

STATS = {"calls": 0, "cache_hits": 0, "prompt_chars": 0, "completion_chars": 0}


def install_cache():
    """Wrap the orchestrator's llm.chat with a disk cache (prompt + model + params)."""
    from app import config, llm
    os.makedirs(CACHE_DIR, exist_ok=True)
    real = llm.chat
    model = config.GROQ_GEN_MODEL if config.is_groq() else config.GEN_MODEL

    def cached(system: str, user: str) -> str:
        # endpoint is part of the key so stub (dry-run) answers can never be served to a real run
        endpoint = config.GROQ_BASE_URL if config.is_groq() else config.GEMINI_BASE_URL
        key = hashlib.sha256(json.dumps([endpoint, model, 0.3, system, user]).encode()).hexdigest()
        path = os.path.join(CACHE_DIR, key + ".json")
        STATS["prompt_chars"] += len(system) + len(user)
        if os.path.exists(path):
            STATS["cache_hits"] += 1
            return json.load(open(path))["out"]
        out = real(system, user)
        STATS["calls"] += 1
        STATS["completion_chars"] += len(out)
        json.dump({"model": model, "out": out}, open(path, "w"))
        return out
    llm.chat = cached
    return model


def judge_call(provider: str, prompt: str) -> str:
    key = hashlib.sha256(json.dumps(["judge", provider, prompt]).encode()).hexdigest()
    path = os.path.join(CACHE_DIR, "judge_" + key + ".json")
    if os.path.exists(path):
        return json.load(open(path))["out"]
    if provider == "anthropic":
        body = {"model": os.environ.get("JUDGE_MODEL", "claude-haiku-4-5-20251001"), "max_tokens": 400,
                "temperature": 0, "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                     headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                                              "anthropic-version": "2023-06-01", "content-type": "application/json"})
        out = json.loads(urllib.request.urlopen(req, timeout=60).read())["content"][0]["text"]
    elif provider == "gemini":
        from app import llm
        out = llm.chat("You are a strict evaluator.", prompt)
    else:
        return '{"supported": null}'
    json.dump({"out": out}, open(path, "w"))
    return out


JUDGE_PROMPT = """You grade whether an answer about application logs is supported by evidence.
EVIDENCE (the log chunks the answer cited):
{evidence}

ANSWER:
{answer}

Split the answer into atomic factual claims. For each, decide if the EVIDENCE supports it.
Reply with JSON only: {{"claims": <int>, "supported": <int>, "unsupported_examples": ["..."]}}"""


def check_correct(item: dict, answer: str) -> bool | None:
    c = item["check"]
    a = answer.lower()
    if c["kind"] == "exact_number":
        nums = {int(n) for n in re.findall(r"\b\d+\b", answer.replace(",", ""))}
        return c["value"] in nums
    if c["kind"] == "time":
        return c["value"] in answer or c["value"][:5] in answer
    if c["kind"] == "time_range":
        return all(v[:5] in answer for v in c["value"])
    if c["kind"] == "contains_all":
        return all(v.lower() in a for v in c["value"])
    if c["kind"] == "contains_any":
        return any(v.lower() in a for v in c["value"])
    if c["kind"] == "abstain":
        return bool(ABSTAIN.search(answer))
    return None  # llm_judge items are scored by faithfulness only


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True, help="session holding the fixed eval archive")
    ap.add_argument("--judge", choices=["anthropic", "gemini", "none"], default="none")
    ap.add_argument("--limit", type=int, default=0, help="first N questions (0 = all)")
    ap.add_argument("--max-usd", type=float, default=5.0)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="wiring check against bench/llm_stub.py")
    ap.add_argument("--export-judge-sample", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "evals", "results", "llm"))
    args = ap.parse_args()
    if args.dry_run:
        os.environ.update(GROQ_API_KEYS="stub", GROQ_BASE_URL="http://127.0.0.1:8089/openai/v1",
                          GEMINI_API_KEYS="stub", GEMINI_BASE_URL="http://127.0.0.1:8089/v1beta")
    from app import db, graph_drilldown, prompts
    model = install_cache()
    qa = json.load(open(QA))["items"]
    items = qa[: args.limit] if args.limit else qa
    table = db.chunk_table(args.session)
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT chunk_id::text AS id, line_start, line_end, content FROM {table}")
        chunks = {r["id"]: r for r in cur.fetchall()}

    # cost estimate: ~4 calls/question (grade, maybe rewrite+grade, generate) x ~12k chars
    est_tokens = len(items) * 4 * 12000 / 4
    pin, pout = PRICE_PER_MTOK.get(model, (1.0, 3.0))
    est_usd = est_tokens / 1e6 * pin + len(items) * 4 * 300 / 1e6 * pout
    print(f"[cost guard] model={model} questions={len(items)} est_tokens~{int(est_tokens)} est_usd~{est_usd:.2f} "
          f"(cache makes re-runs free)")
    if est_usd > args.max_usd and not args.yes and not args.dry_run:
        raise SystemExit(f"estimated ${est_usd:.2f} > --max-usd {args.max_usd}; re-run with --yes to proceed")

    rows = []
    for it in items:
        t0 = time.time()
        calls0 = STATS["calls"] + STATS["cache_hits"]
        final = graph_drilldown.GRAPH.invoke({"session_id": args.session, "original_question": it["question"],
                                              "question": it["question"], "rewrites": 0})
        answer, cites = final.get("answer", ""), final.get("citations", [])
        retrieved = {str(d["chunk_id"]) for d in (final.get("docs") or []) + (final.get("best_docs") or [])}
        gold = set(it["gold_lines"])
        hit = [c for c in cites if c in chunks and any(chunks[c]["line_start"] <= g <= chunks[c]["line_end"] for g in gold)]
        row = {"id": it["id"], "type": it["type"], "answer": answer[:600], "citations": cites,
               "correct": check_correct(it, answer),
               "abstained": bool(ABSTAIN.search(answer)),
               "citation_valid_share": (sum(1 for c in cites if c in retrieved) / len(cites)) if cites else None,
               "citation_precision": (len(hit) / len(cites)) if cites and gold else None,
               "citation_recall": (1.0 if hit else 0.0) if gold else None,
               "rewrites": final.get("rewrites", 0), "graded_relevant": len(final.get("graded") or []),
               "llm_calls": STATS["calls"] + STATS["cache_hits"] - calls0, "latency_s": round(time.time() - t0, 2)}
        if args.judge != "none" and cites and not args.dry_run:
            ev = "\n---\n".join(prompts.focus_snippet(chunks[c]["content"], it["question"], 2000) for c in cites if c in chunks)
            try:
                j = json.loads(re.search(r"\{.*\}", judge_call(args.judge, JUDGE_PROMPT.format(evidence=ev, answer=answer)),
                                         re.S).group(0))
                row["faithfulness"] = j["supported"] / j["claims"] if j.get("claims") else None
            except Exception as e:  # noqa: BLE001
                row["judge_error"] = str(e)[:200]
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("id", "type", "correct", "abstained", "citation_precision", "rewrites")}))

    ans = [r for r in rows if r["type"] != "unanswerable"]
    una = [r for r in rows if r["type"] == "unanswerable"]
    mean = lambda xs: round(statistics.mean(xs), 3) if xs else None  # noqa: E731
    summary = {
        "correctness_checked": mean([1.0 if r["correct"] else 0.0 for r in ans if r["correct"] is not None]),
        "numeric_exact_match": mean([1.0 if r["correct"] else 0.0 for r in ans if r["type"] == "count"]),
        "abstention_correct_refusal": mean([1.0 if r["abstained"] else 0.0 for r in una]),
        "abstention_false_refusal": mean([1.0 if r["abstained"] else 0.0 for r in ans]),
        "citation_validity": mean([r["citation_valid_share"] for r in rows if r["citation_valid_share"] is not None]),
        "citation_precision": mean([r["citation_precision"] for r in ans if r["citation_precision"] is not None]),
        "citation_recall": mean([r["citation_recall"] for r in ans if r["citation_recall"] is not None]),
        "faithfulness": mean([r["faithfulness"] for r in rows if r.get("faithfulness") is not None]),
        "corrective_loop_trigger_rate": mean([1.0 if r["rewrites"] else 0.0 for r in rows]),
        "avg_llm_calls_per_question": mean([r["llm_calls"] for r in rows]),
        "p50_latency_s": statistics.median([r["latency_s"] for r in rows]) if rows else None,
    }
    meta = {"eval": "llm_answer_quality", "date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "commit": git_sha(), "generator_model": model, "judge": args.judge, "dry_run": args.dry_run,
            "prompt_version": getattr(prompts, "PROMPT_VERSION", "unversioned"), "questions": len(rows),
            "llm_calls_made": STATS["calls"], "cache_hits": STATS["cache_hits"],
            "est_cost_usd": round(STATS["prompt_chars"] / 4 / 1e6 * pin + STATS["completion_chars"] / 4 / 1e6 * pout, 4)}
    if args.export_judge_sample:
        sample = [r for r in rows if r.get("citations")][: args.export_judge_sample]
        json.dump([{"id": r["id"], "answer": r["answer"], "citations": r["citations"], "owner_supported": None}
                   for r in sample], open(os.path.join(ROOT, "evals", "datasets", "judge_labels.todo.json"), "w"), indent=1)
    label = "dry_run" if args.dry_run else model
    md = [f"# LLM answer-quality eval ({label})", "",
          "**DRY RUN against the local stub: wiring check only, NOT quality numbers.**" if args.dry_run else "",
          f"- {meta['date']} | commit `{meta['commit']}` | generator `{model}` | judge `{args.judge}` | "
          f"prompt {meta['prompt_version']} | calls {meta['llm_calls_made']} (+{meta['cache_hits']} cached) | "
          f"est ${meta['est_cost_usd']}", "", "| Metric | Value |", "|---|---|"]
    md += [f"| {k} | {v} |" for k, v in summary.items()]
    write_report(os.path.join(args.out, label), meta, {"summary": summary, "rows": rows}, "\n".join(md) + "\n")


if __name__ == "__main__":
    main()
