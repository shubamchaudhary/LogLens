#!/usr/bin/env python3
"""Build the golden Q&A set over the fixed eval archive (eval_mediumnoise).

Every answerable question's gold answer and gold supporting line numbers are
COMPUTED from the archive and its incident labels (no LLM involved), so they
can be re-derived and checked. ~20% of questions are unanswerable from the
logs, to measure abstention.

Each item:
  id, type (count|first|last|time_range|root_cause|entity|comparison|why|unanswerable),
  question, gold_answer, gold_lines [line numbers], check {kind, value},
  verified_by ["generator"] (the owner adds "owner" after reviewing)

Usage: python evals/build_golden_qa.py  -> evals/datasets/golden_qa.json
"""
from __future__ import annotations

import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ARCHIVE = os.path.join(HERE, "datasets", "synthetic", "eval_mediumnoise.log")
LABELS = os.path.join(HERE, "datasets", "synthetic", "eval_mediumnoise.labels.json")
OUT = os.path.join(HERE, "datasets", "golden_qa.json")


def main() -> None:
    lines = open(ARCHIVE, encoding="utf-8").read().split("\n")[:-1]
    meta = json.load(open(LABELS))
    inc = {i["kind"]: i for i in meta["incidents"]}
    L = lambda n: lines[n - 1]  # noqa: E731
    ts = lambda n: L(n)[11:19]  # noqa: E731  HH:MM:SS
    hhmm = lambda n: L(n)[11:16]  # noqa: E731

    def grep(rx, within=None):
        r = re.compile(rx)
        rng = within if within is not None else range(1, len(lines) + 1)
        return [n for n in rng if r.search(L(n))]

    items = []

    def add(qtype, q, answer, gold, check):
        items.append({"id": f"q{len(items) + 1:03d}", "type": qtype, "question": q, "gold_answer": answer,
                      "gold_lines": sorted(set(gold)), "check": check, "verified_by": ["generator"]})

    # ── db pool exhaustion: root-cause chain ─────────────────────────────────
    d = inc["db_pool_exhaustion"]["lines"]
    pool = [n for n in d if "Connection is not available" in L(n)]
    e503 = [n for n in d if "status=503" in L(n)]
    add("why", f"Why did POST /api/checkout return 503 errors around {hhmm(e503[0])}?",
        "The database connection pool (HikariPool-1, max 10) was exhausted; queries timed out after 30000ms "
        "(SQLTimeoutException) and the gateway returned 503 for checkout.", pool[:3] + e503[:3],
        {"kind": "contains_all", "value": ["pool", "503"]})
    add("first", "When did the database connection pool first report that no connection was available?",
        f"{ts(pool[0])} (HikariPool-1 - Connection is not available, request timed out after 30000ms)", [pool[0]],
        {"kind": "time", "value": ts(pool[0])})
    add("count", "How many requests to POST /api/checkout returned status=503?", str(len(grep(r"status=503"))),
        grep(r"status=503"), {"kind": "exact_number", "value": len(grep(r"status=503"))})
    add("root_cause", "What was the maximum number of threads waiting for a DB connection during the pool incident?",
        str(max(int(re.search(r"waiting=(\d+)", L(n)).group(1)) for n in pool)),
        [max(pool, key=lambda n: int(re.search(r"waiting=(\d+)", L(n)).group(1)))],
        {"kind": "exact_number", "value": max(int(re.search(r"waiting=(\d+)", L(n)).group(1)) for n in pool)})

    # ── payment latency: time range, no errors ───────────────────────────────
    p = inc["payment_latency"]["lines"]
    add("time_range", "Between what times was the payment API latency elevated to multiple seconds?",
        f"From about {ts(p[0])} to {ts(p[-1])}.", [p[0], p[-1]], {"kind": "time_range", "value": [ts(p[0]), ts(p[-1])]})
    worst = max(p, key=lambda n: int(re.search(r"latency=(\d+)ms", L(n)).group(1)))
    add("entity", "What was the highest latency recorded for POST /api/payments?",
        re.search(r"latency=(\d+)ms", L(worst)).group(1) + "ms", [worst],
        {"kind": "exact_number", "value": int(re.search(r"latency=(\d+)ms", L(worst)).group(1))})
    add("why", f"Were there errors from the payment API while it was slow around {hhmm(p[0])}?",
        "No. The payment calls returned status=200; the problem was latency only (seconds per call).", p[:3],
        {"kind": "contains_any", "value": ["no error", "status=200", "200"]})

    # ── OOM crash chain ──────────────────────────────────────────────────────
    o = inc["oom_crash"]["lines"]
    oom = [n for n in o if "OutOfMemoryError" in L(n)]
    gc = [n for n in o if "Full GC" in L(n)]
    started = [n for n in o if "Started SearchApplication" in L(n)]
    add("first", "When did the search service first throw OutOfMemoryError?", ts(oom[0]), [oom[0]],
        {"kind": "time", "value": ts(oom[0])})
    add("count", "How many OutOfMemoryError lines were logged?", str(len(grep(r"OutOfMemoryError"))),
        grep(r"OutOfMemoryError"), {"kind": "exact_number", "value": len(grep(r"OutOfMemoryError"))})
    add("root_cause", "Why did the search service restart?",
        "Full GC pauses grew and heap usage stayed high (94%), then java.lang.OutOfMemoryError: Java heap space "
        "in IndexCache.load; the service restarted (Started SearchApplication).", gc[:2] + oom[:1] + started[:1],
        {"kind": "contains_all", "value": ["OutOfMemoryError"]})
    add("entity", "Which class and method appear at the top of the OutOfMemoryError stack trace in application code?",
        "com.shop.search.IndexCache.load (IndexCache.java:88)", [oom[0] + 2],
        {"kind": "contains_any", "value": ["IndexCache.load", "IndexCache"]})

    # ── silent auth incident (INFO only) ─────────────────────────────────────
    a = inc["auth_silent"]["lines"]
    add("why", "Were there repeated failed login attempts for the admin user? When?",
        f"Yes, POST /api/login returned 401 (invalid_credentials, user=admin) repeatedly from {ts(a[0])} to {ts(a[-1])}.",
        a[:3], {"kind": "contains_any", "value": ["401", "invalid_credentials", "admin"]})
    add("count", "How many failed admin login attempts (status=401) were logged?", str(len(grep(r"api/login status=401"))),
        grep(r"api/login status=401"), {"kind": "exact_number", "value": len(grep(r"api/login status=401"))})

    # ── deadlock ─────────────────────────────────────────────────────────────
    dl = grep(r"Deadlock detected")
    add("count", "How many deadlocks were detected while updating inventory stock?", str(len(dl)), dl,
        {"kind": "exact_number", "value": len(dl)})
    add("why", "What happened to transactions when the inventory deadlocks occurred?",
        "They were rolled back (Deadlock detected while updating stock; transaction rolled back).", dl[:3],
        {"kind": "contains_any", "value": ["rolled back", "rollback"]})
    add("first", "When was the first deadlock detected?", ts(dl[0]), [dl[0]], {"kind": "time", "value": ts(dl[0])})

    # ── bad deploy ───────────────────────────────────────────────────────────
    b = inc["bad_deploy"]["lines"]
    dep = [n for n in b if "Deploying new version" in L(n)]
    rdy = [n for n in b if "Readiness probe failed" in L(n)]
    rb = [n for n in b if "Rolling back" in L(n)]
    add("entity", "Which release of the order service failed its readiness checks, and which release was it rolled back to?",
        "Release 4.2.0 failed readiness (component=kafkaProducer); it was rolled back to 4.1.3.", dep[:1] + rdy[:1] + rb[:1],
        {"kind": "contains_all", "value": ["4.2.0", "4.1.3"]})
    add("root_cause", "Which component was DOWN when the order service readiness probe failed?", "kafkaProducer",
        rdy[:3], {"kind": "contains_any", "value": ["kafkaProducer", "Kafka producer"]})
    add("count", "How many times did the order service readiness probe fail?", str(len(grep(r"Readiness probe failed"))),
        grep(r"Readiness probe failed"), {"kind": "exact_number", "value": len(grep(r"Readiness probe failed"))})
    add("time_range", "When did the failed deployment start and when was the rollback?",
        f"Deploy started {ts(dep[0])}; rollback at {ts(rb[0])}.", [dep[0], rb[0]],
        {"kind": "time_range", "value": [ts(dep[0]), ts(rb[0])]})

    # ── thread pool ──────────────────────────────────────────────────────────
    tp = grep(r"RejectedExecutionException")
    add("entity", "What was the queue capacity of the notification executor when tasks were rejected?", "500", tp[:2],
        {"kind": "exact_number", "value": 500})
    add("count", "How many notification tasks were rejected?", str(len(tp)), tp, {"kind": "exact_number", "value": len(tp)})

    # ── slow SQL ─────────────────────────────────────────────────────────────
    s = inc["slow_sql"]["lines"]
    slowest = max(s, key=lambda n: int(re.search(r"duration=(\d+)ms", L(n)).group(1)))
    add("entity", "What was the slowest SQL query duration in the logs?",
        re.search(r"duration=(\d+)ms", L(slowest)).group(1) + "ms", [slowest],
        {"kind": "exact_number", "value": int(re.search(r"duration=(\d+)ms", L(slowest)).group(1))})
    add("time_range", "When were SQL queries taking several seconds?", f"From about {ts(s[0])} to {ts(s[-1])}.",
        [s[0], s[-1]], {"kind": "time_range", "value": [ts(s[0]), ts(s[-1])]})
    add("why", f"Did the slow SQL queries around {hhmm(s[0])} fail?",
        "No. They completed (SQL executed) but took seconds and returned many rows; there were no SQL errors.", s[:3],
        {"kind": "contains_any", "value": ["no", "did not fail", "completed"]})

    # ── kafka lag ────────────────────────────────────────────────────────────
    k = grep(r"Consumer lag high")
    add("entity", "Which Kafka topic had high consumer lag?", "orders", k[:3], {"kind": "contains_any", "value": ["orders"]})
    maxlag = max(k, key=lambda n: int(re.search(r"lag=(\d+)", L(n)).group(1)))
    add("entity", "What was the highest consumer lag reported?", re.search(r"lag=(\d+)", L(maxlag)).group(1), [maxlag],
        {"kind": "exact_number", "value": int(re.search(r"lag=(\d+)", L(maxlag)).group(1))})

    # ── disk full ────────────────────────────────────────────────────────────
    df = grep(r"No space left on device")
    add("last", "When did the DB proxy last fail to write a WAL segment?", ts(df[-1]), [df[-1]],
        {"kind": "time", "value": ts(df[-1])})
    add("why", "Why did WAL writes fail?", "The volume ran out of space: No space left on device.", df[:3],
        {"kind": "contains_any", "value": ["No space left", "disk full", "out of space"]})

    # ── upstream 429 ─────────────────────────────────────────────────────────
    rl = grep(r"throttled request status=429")
    add("entity", "Which upstream provider throttled payment requests?", "stripe", rl[:3],
        {"kind": "contains_any", "value": ["stripe"]})
    add("count", "How many payment requests were throttled with status=429?", str(len(rl)), rl,
        {"kind": "exact_number", "value": len(rl)})

    # ── cert expiry ──────────────────────────────────────────────────────────
    ce = grep(r"SSLHandshakeException")
    add("entity", "Which partner host had an expired TLS certificate?", "partner-api.example.com", ce[:3],
        {"kind": "contains_any", "value": ["partner-api.example.com"]})
    add("first", "When did the first SSLHandshakeException occur?", ts(ce[0]), [ce[0]],
        {"kind": "time", "value": ts(ce[0])})

    # ── comparisons across incidents ─────────────────────────────────────────
    add("comparison", "Which happened first: the inventory deadlocks or the disk-full WAL errors?",
        "The inventory deadlocks happened first.", [dl[0], df[0]], {"kind": "contains_any", "value": ["deadlock"]})
    add("comparison", "Which happened later: the OutOfMemoryError in search or the failed release 4.2.0 deploy?",
        "The failed release 4.2.0 deploy happened later.", [oom[0], dep[0]],
        {"kind": "contains_any", "value": ["4.2.0", "deploy"]})
    e_db = len(grep(r"ERROR \[db-proxy\]"))
    e_gw = len(grep(r"ERROR \[api-gateway\]"))
    more = "db-proxy" if e_db > e_gw else "api-gateway"
    add("comparison", "Did db-proxy or api-gateway log more ERROR lines overall?",
        f"{more} ({max(e_db, e_gw)} vs {min(e_db, e_gw)})", grep(rf"ERROR \[{more}\]")[:5],
        {"kind": "contains_any", "value": [more]})
    add("count", "How many benign 'Failed to send email' errors did the notification service log?",
        str(len(grep(r"Failed to send email"))), grep(r"Failed to send email"),
        {"kind": "exact_number", "value": len(grep(r"Failed to send email"))})
    add("why", "Were the email send failures an incident?",
        "No. They are background noise: SMTP 421 'try again later' with automatic retry, spread across the whole day.",
        grep(r"Failed to send email")[:3], {"kind": "contains_any", "value": ["retry", "not an incident", "background", "noise"]})
    add("entity", "What status code did the gateway log for client-aborted search requests?", "499",
        grep(r"status=499")[:3], {"kind": "exact_number", "value": 499})
    add("first", "When did the order service finish starting up at the beginning of the logs?", ts(4), [4],
        {"kind": "time", "value": ts(4)})
    add("entity", "How long did the order service take to start?", "9.8 seconds", [4],
        {"kind": "contains_any", "value": ["9.8"]})

    # ── what-happened-around questions (one per incident) ────────────────────
    for kind in ["db_pool_exhaustion", "oom_crash", "bad_deploy", "thread_pool", "disk_full", "cert_expiry",
                 "kafka_lag", "rate_limited_upstream", "deadlock", "payment_latency"]:
        lines_k = inc[kind]["lines"]
        add("why", f"What went wrong around {hhmm(lines_k[len(lines_k) // 3])}?", inc[kind]["root_cause"],
            lines_k[len(lines_k) // 3: len(lines_k) // 3 + 3], {"kind": "llm_judge", "value": inc[kind]["root_cause"]})

    # ── unanswerable (~20%) ──────────────────────────────────────────────────
    for q in ["What was the CPU temperature of pod-3 during the OOM incident?",
              "Did the Redis cluster fail over during the database incident?",
              "Which Kubernetes node was evicted during the bad deploy?",
              "What was the p99 latency of the GraphQL endpoint?",
              "List the credit card numbers used in failed payments.",
              "What was the root cause of the outage on 2026-07-20?",
              "How many emails bounced from gmail.com addresses?",
              "Which engineer approved release 4.2.0?",
              "What was the S3 bucket size at the end of the day?",
              "Which feature flag was toggled before the checkout errors?",
              "What was the Postgres replication lag during the disk-full event?",
              "How much did the payment incident cost in lost revenue?",
              "What did the load balancer health dashboard show at noon?",
              "Which customer tenant filed a support ticket about slow search?"]:
        add("unanswerable", q, "ABSTAIN: the logs do not contain this information.", [],
            {"kind": "abstain", "value": True})

    digest = hashlib.sha256(open(ARCHIVE, "rb").read()).hexdigest()
    doc = {"archive": "evals/datasets/synthetic/eval_mediumnoise.log (python evals/generate_corpus.py --name "
                      "eval_mediumnoise --hours 6 --rate 2 --seed 7 --noise medium)",
           "archive_sha256": digest, "count": len(items),
           "unanswerable_share": round(sum(1 for i in items if i["type"] == "unanswerable") / len(items), 3),
           "items": items}
    json.dump(doc, open(OUT, "w"), indent=1)
    print(f"{len(items)} questions, unanswerable share {doc['unanswerable_share']}, archive sha256 {digest[:12]}")


if __name__ == "__main__":
    main()
