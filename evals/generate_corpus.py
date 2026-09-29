#!/usr/bin/env python3
"""Deterministic generator for labelled Spring-style application logs.

Why synthetic: LogLens targets application logs (HTTP, SQL, pools, GC, auth),
and no public labelled dataset of that shape has incident timelines and
line-level ground truth. Loghub (BGL/Thunderbird/HDFS) is used separately for
the parts it can test. Everything here is seeded, so the same command always
produces byte-identical files.

Outputs (in --out-dir):
  <name>.log            the log archive
  <name>.labels.json    incidents (gold timeline + gold line numbers), the
                        per-line incident map, and generator parameters

Background noise matters: real services log benign ERROR/WARN lines all the
time. --noise controls that rate, because the anomaly gate's savings depend on
it (see evals/README.md).

Usage:
  python evals/generate_corpus.py --name eval_fixed --hours 6 --rate 2 --seed 7
  python evals/generate_corpus.py --name bench_1g --target-bytes 1000000000 --rate 200 --no-labels
"""
from __future__ import annotations

import argparse
import json
import os
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

SERVICES = ["api-gateway", "auth-service", "order-service", "payment-service",
            "inventory-service", "db-proxy", "notification-service", "search-service"]
ENDPOINTS = ["/api/orders", "/api/orders/{id}", "/api/payments", "/api/cart",
             "/api/search", "/api/users/me", "/api/inventory/{id}", "/api/checkout"]
TENANTS = ["acme", "globex", "initech", "umbrella", "hooli", "stark"]

NOISE = {"low": 0.0005, "medium": 0.003, "high": 0.01}


@dataclass
class Incident:
    kind: str
    start_s: int                 # offset from archive start, seconds
    duration_s: int
    description: str
    root_cause: str
    detectable: bool = True      # False = logged at INFO only (a "silent" incident)
    lines: list[int] = field(default_factory=list)          # gold line numbers
    timeline: list[dict] = field(default_factory=list)      # gold events


class Gen:
    def __init__(self, seed: int, start: datetime, rate: float, noise: float):
        self.r = random.Random(seed)
        self.start = start
        self.rate = rate
        self.noise = noise
        self.line_no = 0
        self.trace = 100000

    def ts(self, sec: float) -> str:
        t = self.start + timedelta(seconds=sec)
        return t.strftime("%Y-%m-%d %H:%M:%S.") + f"{t.microsecond // 1000:03d}"

    def ctx(self, svc: str) -> str:
        self.trace += 1
        return (f"[{svc}] tenant={self.r.choice(TENANTS)} traceId=TR{self.trace} "
                f"host=pod-{self.r.randint(0, 5)}")

    # ── normal traffic ──────────────────────────────────────────────────────
    def normal(self, sec: float) -> list[str]:
        r = self.r
        svc = r.choice(SERVICES)
        roll = r.random()
        ep = r.choice(ENDPOINTS).replace("{id}", str(r.randint(1000, 99999)))
        method = r.choice(["GET", "GET", "GET", "POST", "PUT"])
        if roll < 0.40:
            lat = max(3, int(r.lognormvariate(3.3, 0.5)))
            msg = f"INFO {self.ctx('api-gateway')} - {method} {ep} status=200 latency={lat}ms"
        elif roll < 0.60:
            d = max(1, int(r.lognormvariate(2.3, 0.6)))
            msg = f"INFO {self.ctx('db-proxy')} - SQL executed query=SELECT duration={d}ms rows={r.randint(0, 50)}"
        elif roll < 0.70:
            msg = f"INFO {self.ctx(svc)} - Cache {'hit' if r.random() < 0.8 else 'miss'} key=cart:{r.randint(1, 9999)}"
        elif roll < 0.76:
            msg = f"INFO {self.ctx('payment-service')} - Payment authorized amount={r.randint(5, 900)}.00 currency=USD"
        elif roll < 0.80:
            msg = f"INFO {self.ctx('order-service')} - Order created orderId=O{r.randint(10000, 99999)}"
        elif roll < 0.83:
            p = max(2, int(r.lognormvariate(2.5, 0.4)))
            msg = f"INFO {self.ctx(svc)} - GC pause (G1 Evacuation Pause) {p}ms"
        elif roll < 0.86:
            msg = f"DEBUG {self.ctx(svc)} - Scheduler tick jobs=0"
        elif roll < 0.89:
            msg = f"INFO {self.ctx('auth-service')} - JWT validated user=u{r.randint(1, 5000)}"
        elif roll < 0.92:
            msg = f"INFO {self.ctx('inventory-service')} - Inventory reserved sku=SKU{r.randint(100, 999)} qty={r.randint(1, 4)}"
        elif roll < 0.95:
            msg = f"INFO {self.ctx('search-service')} - Search completed q=shoes hits={r.randint(0, 300)} took={r.randint(5, 60)}ms"
        elif roll < 0.983:  # WARN share below = 1.7%, matching the owner's 10k-line sample
            msg = f"INFO {self.ctx('notification-service')} - Email queued template=order_confirmation"
        else:
            msg = f"WARN {self.ctx(svc)} - Slow downstream call took {r.randint(300, 700)}ms endpoint={ep}"
        return [f"{self.ts(sec)} {msg}"]

    def benign_error(self, sec: float) -> list[str]:
        """Background ERROR noise every real service has; not an incident."""
        r = self.r
        choice = r.random()
        if choice < 0.4:
            return [f"{self.ts(sec)} ERROR {self.ctx('notification-service')} - Failed to send email to "
                    f"user u{r.randint(1, 5000)}: SMTP 421 try again later (will retry)"]
        if choice < 0.7:
            return [f"{self.ts(sec)} ERROR {self.ctx('api-gateway')} - Client aborted request "
                    f"GET /api/search status=499 latency={r.randint(10, 90)}ms"]
        return [f"{self.ts(sec)} WARN {self.ctx('order-service')} - Validation failed for cart "
                f"C{r.randint(1, 999)}: quantity must be positive"]

    # ── incident emitters: return lines for one tick inside the incident ────
    def incident_lines(self, inc: Incident, sec: float, phase: float) -> list[str]:
        r = self.r
        k = inc.kind
        if k == "db_pool_exhaustion":
            if phase < 0.25:
                return [f"{self.ts(sec)} WARN {self.ctx('db-proxy')} - HikariPool-1 - Connection is not available, "
                        f"request timed out after 30000ms (total=10, active=10, idle=0, waiting={r.randint(20, 90)})"]
            if phase < 0.75:
                return [f"{self.ts(sec)} ERROR {self.ctx('order-service')} - Query timeout: SQLTimeoutException "
                        f"statement cancelled after 30000ms",
                        f"{self.ts(sec)} ERROR {self.ctx('api-gateway')} - POST /api/checkout status=503 latency=30012ms "
                        f"downstream=order-service"]
            return [f"{self.ts(sec)} INFO {self.ctx('db-proxy')} - HikariPool-1 - pool recovered active=4 idle=6"]
        if k == "payment_latency":
            lat = r.randint(2500, 6000)
            return [f"{self.ts(sec)} INFO {self.ctx('api-gateway')} - POST /api/payments status=200 latency={lat}ms"]
        if k == "oom_crash":
            if phase < 0.6:
                p = int(200 + 3000 * phase)
                return [f"{self.ts(sec)} WARN {self.ctx('search-service')} - GC pause (G1 Full GC) {p}ms heap usage high 94%"]
            if phase < 0.7:
                return [f"{self.ts(sec)} ERROR {self.ctx('search-service')} - java.lang.OutOfMemoryError: Java heap space",
                        "\tat java.util.Arrays.copyOf(Arrays.java:3512)",
                        "\tat com.shop.search.IndexCache.load(IndexCache.java:88)",
                        "\tat com.shop.search.SearchService.warm(SearchService.java:41)"]
            return [f"{self.ts(sec)} INFO {self.ctx('search-service')} - Started SearchApplication in {r.randint(8, 20)}.{r.randint(1, 9)} seconds"]
        if k == "auth_silent":
            return [f"{self.ts(sec)} INFO {self.ctx('auth-service')} - POST /api/login status=401 latency={r.randint(20, 60)}ms "
                    f"reason=invalid_credentials user=admin"]
        if k == "deadlock":
            return [f"{self.ts(sec)} ERROR {self.ctx('inventory-service')} - Deadlock detected while updating stock "
                    f"sku=SKU{r.randint(100, 999)}; transaction rolled back"]
        if k == "bad_deploy":
            if phase < 0.15:
                return [f"{self.ts(sec)} INFO {self.ctx('order-service')} - Deploying new version release 4.2.0"]
            if phase < 0.8:
                return [f"{self.ts(sec)} ERROR {self.ctx('order-service')} - Readiness probe failed: status=DOWN "
                        f"component=kafkaProducer"]
            return [f"{self.ts(sec)} INFO {self.ctx('order-service')} - Rolling back to release 4.1.3"]
        if k == "thread_pool":
            return [f"{self.ts(sec)} ERROR {self.ctx('notification-service')} - Task rejected: "
                    f"java.util.concurrent.RejectedExecutionException: queue is full (capacity=500)"]
        if k == "slow_sql":
            d = r.randint(2500, 9000)
            return [f"{self.ts(sec)} INFO {self.ctx('db-proxy')} - SQL executed query=SELECT duration={d}ms rows={r.randint(1000, 90000)}"]
        if k == "kafka_lag":
            return [f"{self.ts(sec)} WARN {self.ctx('order-service')} - Consumer lag high topic=orders partition={r.randint(0, 5)} "
                    f"lag={r.randint(5000, 90000)}"]
        if k == "disk_full":
            return [f"{self.ts(sec)} ERROR {self.ctx('db-proxy')} - Failed to write WAL segment: No space left on device"]
        if k == "rate_limited_upstream":
            return [f"{self.ts(sec)} WARN {self.ctx('payment-service')} - Upstream provider throttled request status=429 "
                    f"retry_after=2s provider=stripe"]
        if k == "cert_expiry":
            return [f"{self.ts(sec)} ERROR {self.ctx('api-gateway')} - SSLHandshakeException: PKIX path validation failed: "
                    f"certificate expired for host partner-api.example.com"]
        raise ValueError(k)


INCIDENT_CATALOG = [
    ("db_pool_exhaustion", 480, "DB connection pool exhausted, checkout returned 503",
     "Connection pool (HikariPool-1, max 10) saturated; queries timed out and the gateway returned 503", True),
    ("payment_latency", 420, "Payment API latency spiked to seconds with no errors",
     "Slow payment provider; only visible as latency, never as ERROR lines", True),
    ("oom_crash", 360, "Search service ran out of heap and restarted",
     "Growing GC pauses then OutOfMemoryError in IndexCache.load; service restarted", True),
    ("auth_silent", 300, "Burst of failed admin logins (401) logged at INFO",
     "Credential-stuffing attempt against user=admin; logged only as INFO status=401", False),
    ("deadlock", 180, "Inventory stock updates deadlocked",
     "Concurrent stock updates took row locks in opposite order; transactions rolled back", True),
    ("bad_deploy", 420, "Order service release 4.2.0 failed readiness and was rolled back",
     "Release 4.2.0 could not start its Kafka producer; readiness DOWN until rollback to 4.1.3", True),
    ("thread_pool", 240, "Notification executor rejected tasks",
     "Notification executor queue (capacity 500) full; RejectedExecutionException", True),
    ("slow_sql", 360, "Reporting queries took seconds without failing",
     "Unindexed reporting query scanned large tables; visible only as SQL latency", True),
    ("kafka_lag", 300, "Order consumer lag grew into tens of thousands",
     "Order consumer fell behind; lag warnings on topic orders", True),
    ("disk_full", 180, "DB proxy could not write WAL: disk full",
     "Volume ran out of space; WAL writes failed", True),
    ("rate_limited_upstream", 240, "Payment provider throttled requests with 429",
     "Upstream (stripe) rate limit hit; WARN lines with status=429", True),
    ("cert_expiry", 240, "Partner API calls failed on an expired TLS certificate",
     "Partner certificate expired; SSLHandshakeException on every call", True),
]


def plan_incidents(r: random.Random, total_s: int, n: int) -> list[Incident]:
    """Place n incidents at non-overlapping, well-separated offsets."""
    catalog = INCIDENT_CATALOG[:n]
    slot = total_s // (n + 1)
    out = []
    for i, (kind, dur, desc, cause, detectable) in enumerate(catalog):
        jitter = r.randint(-slot // 6, slot // 6)
        start = max(60, slot * (i + 1) + jitter)
        out.append(Incident(kind, start, dur, desc, cause, detectable))
    return out


def generate(args) -> dict:
    start = datetime(2026, 7, 15, 9, 0, 0, tzinfo=timezone.utc)
    g = Gen(args.seed, start, args.rate, NOISE.get(args.noise, args.noise) if isinstance(args.noise, str) else args.noise)
    total_s = int(args.hours * 3600) if args.hours else 10 ** 9
    incidents = [] if args.no_incidents else plan_incidents(g.r, int(args.hours * 3600) if args.hours else 6 * 3600,
                                                            args.incidents)
    os.makedirs(args.out_dir, exist_ok=True)
    log_path = os.path.join(args.out_dir, f"{args.name}.log")
    line_incident: dict[int, str] = {}
    written = 0
    sec = 0.0
    step = 1.0 / args.rate
    with open(log_path, "w", encoding="utf-8", newline="\n", buffering=1 << 20) as f:
        # startup banner, like a real service
        for s in ("Starting OrderApplication using Java 17", "HikariPool-1 - Starting...",
                  "HikariPool-1 - Start completed.", "Started OrderApplication in 9.8 seconds"):
            g.line_no += 1
            line = f"{g.ts(0)} INFO [order-service] tenant=system traceId=TR0 host=pod-0 - {s}\n"
            f.write(line)
            written += len(line)
        while sec < total_s and (not args.target_bytes or written < args.target_bytes):
            active = None
            for inc in incidents:
                if inc.start_s <= sec < inc.start_s + inc.duration_s:
                    active = inc
                    break
            if active is not None and g.r.random() < 0.5:
                phase = (sec - active.start_s) / active.duration_s
                lines = g.incident_lines(active, sec, phase)
                tag = active.kind
            elif g.r.random() < g.noise:
                lines, tag = g.benign_error(sec), None
            else:
                lines, tag = g.normal(sec), None
            for ln in lines:
                g.line_no += 1
                if tag is not None and not args.no_labels:
                    line_incident[g.line_no] = tag
                    active.lines.append(g.line_no)
                    if len(active.timeline) < 400:
                        active.timeline.append({"line": g.line_no, "ts": ln[:23]})
                ln = ln + "\n"
                f.write(ln)
                written += len(ln)
            sec += step * g.r.uniform(0.5, 1.5)
    meta = {
        "name": args.name, "seed": args.seed, "rate_lines_per_s": args.rate, "noise": args.noise,
        "start": start.isoformat(), "lines": g.line_no, "bytes": written, "seconds": sec,
        "incidents": [inc.__dict__ for inc in incidents],
    }
    if not args.no_labels:
        meta["line_incident"] = line_incident
        with open(os.path.join(args.out_dir, f"{args.name}.labels.json"), "w") as f:
            json.dump(meta, f)
    return meta


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--name", required=True)
    p.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "datasets", "synthetic"))
    p.add_argument("--hours", type=float, default=6.0)
    p.add_argument("--rate", type=float, default=2.0, help="average lines per second")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--noise", default="medium", help="low|medium|high or a float per-line probability")
    p.add_argument("--incidents", type=int, default=12)
    p.add_argument("--no-incidents", action="store_true")
    p.add_argument("--no-labels", action="store_true")
    p.add_argument("--target-bytes", type=int, default=0, help="stop once this many bytes are written")
    args = p.parse_args()
    if args.noise not in NOISE:
        args.noise = float(args.noise)
    if args.target_bytes:
        args.hours = args.hours if args.hours else 0
    meta = generate(args)
    print(json.dumps({k: v for k, v in meta.items() if k not in ("incidents", "line_incident")}))


if __name__ == "__main__":
    main()
