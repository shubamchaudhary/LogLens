#!/usr/bin/env python3
"""Generates the 1 GB showcase log: one day of a 9-service e-commerce platform.

Seeded and deterministic: the same command always writes a byte-identical file
(the sha256 is printed and stored in meta.json), so the file can be rebuilt
anywhere instead of being copied around.

Six incidents are modelled on failure modes that take real production systems
down, with the messages and stack traces those systems actually print:

  1. TLS certificate of a payment partner expires  (javax.net.ssl / PKIX)
  2. Release adds an unindexed query, DB pool runs dry  (HikariCP, Postgres slow log)
  3. Redis primary fails over, clients stall, cache goes cold  (Sentinel, Lettuce)
  4. Kafka consumer exceeds max.poll.interval.ms, rebalance loop  (kafka-clients)
  5. Unbounded in-memory cache, OutOfMemoryError, OOMKilled  (G1, kubelet)
  6. Flash sale, multi-row updates in inconsistent order, deadlocks  (PostgreSQL)

Around them runs normal traffic plus the background ERROR/WARN noise every real
system has (client aborts, SMTP retries, bot traffic, validation errors), so the
anomaly gate has something to ignore.

Outputs in --out-dir:
  deeploglens-1gb.log   the log
  meta.json             sha256, line/byte counts, line->byte index, incident ground truth

Usage: python3 generate_log.py [--out-dir DIR] [--target-bytes N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from datetime import datetime, timedelta, timezone

START = datetime(2026, 7, 15, 8, 0, 0, tzinfo=timezone.utc)
RATE = 148  # average lines per second of normal traffic (1 GiB ≈ 08:00 → 18:00)
INDEX_EVERY = 1000  # line -> byte offset index granularity (for ranged previews)

TENANTS = ["acme", "globex", "initech", "umbrella", "hooli", "stark", "wayne", "tyrell"]
PODS = {
    "api-gateway": ["api-gateway-5b8d7c-2xq9m", "api-gateway-5b8d7c-7hv4k", "api-gateway-5b8d7c-p3n8r"],
    "auth-service": ["auth-service-6c4f9b-k8w2d", "auth-service-6c4f9b-t5m7q"],
    "order-service": ["order-service-7f9c6d-4kz2p", "order-service-7f9c6d-9wq5j", "order-service-7f9c6d-b2m8x",
                      "order-service-7f9c6d-r6t3n"],
    "payment-service": ["payment-service-58d6f4-h2v9c", "payment-service-58d6f4-x7p4l"],
    "inventory-service": ["inventory-service-6d7b8f-c4j9w", "inventory-service-6d7b8f-m8r2s"],
    "search-service": ["search-service-6f7d9c-q8n2m", "search-service-6f7d9c-z5k7h"],
    "notification-service": ["notification-service-74c9d8-f3x6b", "notification-service-74c9d8-w9n2t"],
    "cart-service": ["cart-service-59f8c7-d5h8k", "cart-service-59f8c7-s2q6v"],
    "postgres": ["orders-db-0"],
}
INFRA = {"postgres", "kubelet", "redis-sentinel"}  # no customer tenant on infrastructure lines
ENDPOINTS = [("GET", "/api/products/{id}", 0.22), ("GET", "/api/search", 0.16), ("POST", "/api/cart/items", 0.12),
             ("GET", "/api/cart", 0.12), ("POST", "/api/checkout", 0.06), ("GET", "/api/orders", 0.08),
             ("GET", "/api/orders/{id}", 0.06), ("POST", "/api/payments", 0.05), ("GET", "/api/users/me", 0.08),
             ("POST", "/api/auth/token", 0.05)]
QUERIES = ["running shoes", "wireless earbuds", "rain jacket", "coffee grinder", "yoga mat", "usb-c hub",
           "desk lamp", "trail backpack", "air fryer", "phone case", "office chair", "water bottle"]


def t(sec: float) -> str:
    d = START + timedelta(seconds=sec)
    return d.strftime("%Y-%m-%d %H:%M:%S.") + f"{d.microsecond // 1000:03d}"


def at(hh: int, mm: int, ss: int = 0) -> int:
    """Seconds since START for a wall-clock time on the same day."""
    return (hh - START.hour) * 3600 + (mm - START.minute) * 60 + ss


# Incident schedule (seconds since START). Ground truth only: nothing downstream
# reads these to build the UI; it is used to check the pipeline found them.
INCIDENTS = [
    {"key": "cert-expiry", "start": at(9, 14), "end": at(9, 27, 10),
     "truth": "TLS certificate of api.partner-bank.example expired at 09:14:00; every payment authorization "
              "failed the handshake until the truststore was reloaded at 09:27:10. Expiry warnings were logged "
              "from 08:05."},
    {"key": "pool-exhaustion", "start": at(10, 39), "end": at(11, 3),
     "truth": "order-service 5.4.0 (rolled out 10:38) queries orders by lower(customer_email), which cannot use "
              "the customer_email index; 4 s sequential scans hold connections, the 20-connection Hikari pool "
              "runs dry and checkout returns 503 until the 11:01 rollback to 5.3.2."},
    {"key": "redis-failover", "start": at(12, 22), "end": at(12, 29, 30),
     "truth": "Redis primary 10.0.4.21 went down; Sentinel promoted 10.0.4.22 after ~35 s but Lettuce clients "
              "kept reconnecting to the old address, so reads timed out and the cold cache pushed load onto "
              "Postgres until clients reconnected."},
    {"key": "kafka-rebalance", "start": at(14, 5), "end": at(14, 22),
     "truth": "SMTP sends slowed to ~1.8 s; with max.poll.records=500 one batch exceeds max.poll.interval.ms "
              "(300 s), so notification consumers are kicked from the group, commits fail, partitions are "
              "revoked and reprocessed (duplicate emails suppressed) until max.poll.records was cut to 50."},
    {"key": "search-oom", "start": at(15, 31), "end": at(15, 53),
     "truth": "search-service QueryResultCache has no size bound; old-gen fills, G1 full GCs take seconds, then "
              "OutOfMemoryError and kubelet OOMKills (exit 137) in a crash loop until a cache cap was deployed."},
    {"key": "inventory-deadlock", "start": at(17, 8), "end": at(17, 19),
     "truth": "Flash sale: multi-SKU reservations update inventory rows in cart order, so two carts with the "
              "same SKUs in opposite order deadlock; Postgres aborts one transaction until the 2.7.4 hotfix sorts "
              "SKUs before updating."},
]


# Share of request slots an incident takes over (tuned so error rates stay in the
# single digits to tens per second, like a real outage at ~150 lines/s).
INTENSITY = {"cert-expiry": 0.06, "pool-exhaustion": 0.10, "redis-failover": 0.10, "kafka-rebalance": 0.15,
             "search-oom": 0.12, "inventory-deadlock": 0.10}


class Writer:
    def __init__(self, path: str, target: int):
        self.f = open(path, "wb", buffering=1 << 22)
        self.sha = hashlib.sha256()
        self.bytes = 0
        self.lines = 0
        self.target = target
        self.index = [0]  # byte offset of line 1, 1+INDEX_EVERY, ...
        self.marks: dict[str, list[int]] = {}

    def write(self, text: str, mark: str | None = None):
        for line in text.split("\n"):
            b = (line + "\n").encode()
            self.lines += 1
            if self.lines % INDEX_EVERY == 1 and self.lines > 1:
                self.index.append(self.bytes)
            self.f.write(b)
            self.sha.update(b)
            self.bytes += len(b)
            if mark:
                self.marks.setdefault(mark, []).append(self.lines)

    def close(self):
        self.f.close()


class Gen:
    def __init__(self, seed: int, w: Writer):
        self.r = random.Random(seed)
        self.w = w

    def pod(self, svc: str) -> str:
        return self.r.choice(PODS[svc])

    def trace(self) -> str:
        return f"{self.r.getrandbits(64):016x}"

    def line(self, sec: float, level: str, svc: str, logger: str, msg: str, pod: str | None = None,
             tenant: str | None = None) -> str:
        if tenant is None:
            tenant = "-" if svc in INFRA else self.r.choice(TENANTS)
        return (f"{t(sec)} {level:<5} [{svc}] pod={pod or self.pod(svc)} trace={self.trace()} "
                f"tenant={tenant} - {logger} : {msg}")

    def access(self, sec, method, path, status, latency, upstream=None, level=None):
        lvl = level or ("ERROR" if status >= 500 else "WARN" if status in (429, 409) else "INFO")
        up = f" upstream={upstream}" if upstream else ""
        return self.line(sec, lvl, "api-gateway", "o.s.c.g.f.AccessLogFilter",
                         f"{method} {path} status={status} latency={latency}ms bytes={self.r.randint(180, 9000)}{up}")

    # ── normal traffic ───────────────────────────────────────────────────────
    def normal(self, sec: float, state: dict) -> str:
        r = self.r
        roll = r.random()
        if roll < 0.34:
            method, path, _ = r.choices(ENDPOINTS, weights=[e[2] for e in ENDPOINTS])[0]
            path = path.replace("{id}", str(r.randint(10000, 99999)))
            if path == "/api/search":
                path += "?q=" + r.choice(QUERIES).replace(" ", "+")
            lat = max(2, int(r.lognormvariate(3.4, 0.55) * state.get("latency_x", 1)))
            return self.access(sec, method, path, 200 if method == "GET" else r.choice((200, 201)), lat)
        if roll < 0.46:
            svc = r.choice(("order-service", "inventory-service", "cart-service"))
            d = max(1, int(r.lognormvariate(1.3, 0.6) * state.get("sql_x", 1)))
            q = r.choice(("SELECT o.* FROM orders o WHERE o.id = $1", "SELECT * FROM cart_items WHERE cart_id = $1",
                          "UPDATE inventory SET reserved = reserved + $1 WHERE sku = $2",
                          "SELECT * FROM products WHERE id = $1", "INSERT INTO order_lines VALUES ($1, $2, $3)"))
            return self.line(sec, "DEBUG", svc, "o.h.e.j.s.SqlStatementLogger",
                             f"SQL executed in {d}ms rows={r.randint(0, 40)}: {q}")
        if roll < 0.55:
            svc = r.choice(("cart-service", "inventory-service", "search-service"))
            hit = r.random() < state.get("hit_rate", 0.93)
            return self.line(sec, "DEBUG", svc, "c.s.c.RedisCacheClient",
                             f"Cache {'HIT' if hit else 'MISS'} key=product:{r.randint(10000, 99999)}")
        if roll < 0.62:
            return self.line(sec, "INFO", "search-service", "c.s.search.SearchController",
                             f"Search q=\"{r.choice(QUERIES)}\" hits={r.randint(0, 400)} took={r.randint(4, 70)}ms")
        if roll < 0.68:
            return self.line(sec, "INFO", "auth-service", "c.s.auth.JwtValidator",
                             f"JWT validated sub=u-{r.randint(10000, 99999)} scope=shop:read exp=900s")
        if roll < 0.73:
            return self.line(sec, "INFO", "cart-service", "c.s.cart.CartService",
                             f"Item added cart=C-{r.randint(100000, 999999)} sku=SKU-{r.randint(10000, 99999)} qty={r.randint(1, 3)}")
        if roll < 0.77:
            return self.line(sec, "INFO", "order-service", "c.s.order.CheckoutService",
                             f"Order O-{r.randint(1000000, 9999999)} created items={r.randint(1, 6)} total={r.randint(9, 800)}.{r.randint(0, 99):02d} USD")
        if roll < 0.81:
            return self.line(sec, "INFO", "payment-service", "c.s.payment.PartnerBankClient",
                             f"Payment authorized provider=partner-bank amount={r.randint(9, 800)}.00 USD latency={r.randint(90, 380)}ms")
        if roll < 0.85:
            return self.line(sec, "INFO", "inventory-service", "c.s.inventory.ReservationService",
                             f"Reserved sku=SKU-{r.randint(10000, 99999)} qty={r.randint(1, 3)} warehouse={r.choice(('blr-1', 'fra-2', 'iad-1'))}")
        if roll < 0.89:
            return self.line(sec, "INFO", "notification-service", "c.s.notify.EmailSender",
                             f"Email sent template=order_confirmation messageId=<{self.trace()}@mail.shop.io> took={r.randint(80, 260)}ms")
        if roll < 0.92:
            svc = r.choice(list(PODS)[:-1])
            young = r.randint(600, 1400)
            return self.line(sec, "INFO", svc, "gc",
                             f"GC({r.randint(1000, 99999)}) Pause Young (Normal) (G1 Evacuation Pause) "
                             f"{young}M->{r.randint(180, 420)}M(4096M) {r.uniform(3, 18):.3f}ms")
        if roll < 0.96:
            svc = r.choice(list(PODS)[:-1])
            return self.line(sec, "DEBUG", svc, "o.s.b.a.health.HealthEndpoint", "GET /actuator/health status=UP took=2ms")
        return self.line(sec, "INFO", "notification-service", "c.s.notify.OrderEventsListener",
                         f"Processed {r.randint(20, 120)} records from order-events-{r.randint(0, 5)} in {r.randint(90, 600)}ms")

    def noise(self, sec: float) -> str:
        """Benign ERROR/WARN lines a healthy system logs anyway."""
        r = self.r
        roll = r.random()
        if roll < 0.30:
            return self.access(sec, "GET", f"/api/search?q={r.choice(QUERIES).replace(' ', '+')}", 499,
                               r.randint(30, 400), level="WARN")
        if roll < 0.48:
            return self.line(sec, "ERROR", "notification-service", "c.s.notify.EmailSender",
                             f"SMTP 421 4.7.0 Try again later for u-{r.randint(10000, 99999)}@mail.example; scheduled retry in 60s")
        if roll < 0.64:
            return self.line(sec, "WARN", "auth-service", "c.s.auth.JwtValidator",
                             f"Rejected token: JWT signature does not match locally computed signature (ip=185.{r.randint(1, 254)}.{r.randint(1, 254)}.{r.randint(1, 254)})")
        if roll < 0.78:
            return self.line(sec, "WARN", "cart-service", "c.s.cart.CartController",
                             f"Validation failed for cart C-{r.randint(100000, 999999)}: quantity must be between 1 and 10")
        if roll < 0.90:
            return self.line(sec, "WARN", "inventory-service", "c.s.inventory.ReservationService",
                             f"Stock low sku=SKU-{r.randint(10000, 99999)} available={r.randint(0, 4)}")
        if roll < 0.97:
            return self.access(sec, "POST", "/api/auth/token", 429, r.randint(2, 9), level="WARN")
        return self.line(sec, "WARN", "order-service", "com.zaxxer.hikari.pool.HikariPool",
                         "HikariPool-1 - Thread starvation or clock leap detected (housekeeper delta=1m3s).")

    # ── incidents ────────────────────────────────────────────────────────────
    def cert_expiry(self, sec, p, st):
        r = self.r
        out = []
        if r.random() < 0.55:
            order = f"O-{r.randint(1000000, 9999999)}"
            msg = ("Payment authorization failed provider=partner-bank order=" + order +
                   " error=javax.net.ssl.SSLHandshakeException: PKIX path validation failed: "
                   "java.security.cert.CertPathValidatorException: validity check failed")
            if r.random() < 0.25:
                msg += ("\njavax.net.ssl.SSLHandshakeException: PKIX path validation failed: "
                        "java.security.cert.CertPathValidatorException: validity check failed"
                        "\n\tat java.base/sun.security.ssl.Alert.createSSLException(Alert.java:131)"
                        "\n\tat java.base/sun.security.ssl.TransportContext.fatal(TransportContext.java:378)"
                        "\n\tat java.base/sun.security.ssl.CertificateMessage$T13CertificateConsumer.checkServerCerts(CertificateMessage.java:1335)"
                        "\n\tat com.shop.payment.client.PartnerBankClient.authorize(PartnerBankClient.java:88)"
                        "\n\tat com.shop.payment.PaymentService.charge(PaymentService.java:54)"
                        "\nCaused by: java.security.cert.CertificateExpiredException: NotAfter: Wed Jul 15 09:14:00 UTC 2026"
                        "\n\tat java.base/sun.security.x509.CertificateValidity.valid(CertificateValidity.java:277)"
                        "\n\tat java.base/sun.security.x509.X509CertImpl.checkValidity(X509CertImpl.java:619)")
            out.append(self.line(sec, "ERROR", "payment-service", "c.s.payment.PaymentService", msg))
            out.append(self.access(sec, "POST", "/api/payments", 502, r.randint(40, 120), upstream="payment-service"))
            if r.random() < 0.5:
                out.append(self.line(sec, "WARN", "order-service", "c.s.order.CheckoutService",
                                     f"Checkout failed order={order} reason=PAYMENT_UNAVAILABLE"))
        if r.random() < 0.2:
            out.append(self.line(sec, "WARN", "payment-service", "c.s.payment.client.RetryingClient",
                                 f"Retrying partner-bank call attempt={r.randint(2, 3)}/3 backoff=200ms"))
        return out

    def pool_exhaustion(self, sec, p, st):
        r = self.r
        out = []
        if r.random() < 0.18:
            dur = r.uniform(3100, 5200) * (0.6 if p < 0.08 else 1)
            out.append(self.line(sec, "WARN", "postgres", "postgres",
                                 f"LOG:  duration: {dur:.3f} ms  execute <unnamed>: SELECT o.* FROM orders o WHERE "
                                 f"lower(o.customer_email) = $1 ORDER BY o.created_at DESC LIMIT 50", pod="orders-db-0"))
        if p > 0.09 and r.random() < 0.5:
            waiting = r.randint(40, 160)
            out.append(self.line(sec, "WARN", "order-service", "com.zaxxer.hikari.pool.HikariPool",
                                 f"HikariPool-1 - Connection is not available, request timed out after 30000ms "
                                 f"(total=20, active=20, idle=0, waiting={waiting})"))
            msg = ("Request processing failed: org.springframework.transaction.CannotCreateTransactionException: "
                   "Could not open JPA EntityManager for transaction")
            if r.random() < 0.2:
                msg += ("\norg.springframework.transaction.CannotCreateTransactionException: Could not open JPA EntityManager for transaction"
                        "\n\tat org.springframework.orm.jpa.JpaTransactionManager.doBegin(JpaTransactionManager.java:466)"
                        "\n\tat org.springframework.transaction.support.AbstractPlatformTransactionManager.startTransaction(AbstractPlatformTransactionManager.java:531)"
                        "\n\tat com.shop.order.OrderHistoryService.recentOrders(OrderHistoryService.java:47)"
                        "\nCaused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms (total=20, active=20, idle=0, waiting=" + str(waiting) + ")"
                        "\n\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:686)"
                        "\n\tat com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:179)")
            out.append(self.line(sec, "ERROR", "order-service", "o.a.c.c.C.[.[.[/].[dispatcherServlet]", msg))
            method, path = r.choice((("POST", "/api/checkout"), ("GET", "/api/orders")))
            out.append(self.access(sec, method, path, 503, r.randint(30001, 30040), upstream="order-service"))
        return out

    def redis_failover(self, sec, p, st):
        r = self.r
        out = []
        if p < 0.85 and r.random() < 0.6:
            svc = r.choice(("cart-service", "inventory-service", "search-service"))
            if r.random() < 0.6:
                out.append(self.line(sec, "ERROR", svc, "c.s.c.RedisCacheClient",
                                     "Cache read failed key=product:" + str(r.randint(10000, 99999)) +
                                     ": io.lettuce.core.RedisCommandTimeoutException: Command timed out after 1 second(s)"))
            else:
                out.append(self.line(sec, "WARN", svc, "i.l.core.protocol.ConnectionWatchdog",
                                     "Reconnecting, last destination was redis-primary.cache.svc/10.0.4.21:6379"))
                if r.random() < 0.4:
                    out.append(self.line(sec, "WARN", svc, "i.l.core.protocol.ReconnectionHandler",
                                         "Cannot reconnect to [redis-primary.cache.svc/10.0.4.21:6379]: Connection refused: "
                                         "redis-primary.cache.svc/10.0.4.21:6379"))
        if p > 0.1 and r.random() < 0.25:
            out.append(self.line(sec, "WARN", r.choice(("cart-service", "inventory-service")), "o.h.e.j.s.SqlStatementLogger",
                                 f"Slow query {r.randint(900, 2600)}ms: SELECT * FROM products WHERE id = $1 (cache miss fallback)"))
        if p > 0.1 and r.random() < 0.2:
            out.append(self.access(sec, "GET", f"/api/products/{r.randint(10000, 99999)}", 200, r.randint(1200, 3400)))
        return out

    def kafka_rebalance(self, sec, p, st):
        r = self.r
        out = []
        pod = self.pod("notification-service")
        cid = f"consumer-notification-{r.randint(1, 2)}"
        if r.random() < 0.07:
            out.append(self.line(sec, "WARN", "notification-service", "c.s.notify.EmailSender",
                                 f"SMTP send slow took={r.randint(1500, 2600)}ms relay=smtp.relay.example:587", pod=pod))
        roll = r.random()
        if roll < 0.035:
            out.append(self.line(sec, "WARN", "notification-service", "o.a.k.c.c.internals.ConsumerCoordinator",
                                 f"[Consumer clientId={cid}, groupId=notification] consumer poll timeout has expired. This means "
                                 "the time between subsequent calls to poll() was longer than the configured "
                                 "max.poll.interval.ms, which typically implies that the poll loop is spending too much time "
                                 "processing messages. You can address this either by increasing max.poll.interval.ms or by "
                                 "reducing the maximum size of batches returned in poll() with max.poll.records.", pod=pod))
            out.append(self.line(sec, "INFO", "notification-service", "o.a.k.c.c.internals.ConsumerCoordinator",
                                 f"[Consumer clientId={cid}, groupId=notification] Member {cid}-{self.trace()[:12]} sending "
                                 "LeaveGroup request to coordinator kafka-1.kafka.svc:9092 (id: 2147483646 rack: null) due to "
                                 "consumer poll timeout has expired.", pod=pod))
        elif roll < 0.07:
            part = r.randint(0, 5)
            msg = ("Failed to commit offsets for order-events-" + str(part) + ": org.apache.kafka.clients.consumer."
                   "CommitFailedException: Offset commit cannot be completed since the consumer is not part of an active "
                   "group for auto partition assignment; it is likely that the consumer was kicked out of the group.")
            if r.random() < 0.3:
                msg += ("\norg.apache.kafka.clients.consumer.CommitFailedException: Offset commit cannot be completed since the consumer is not part of an active group for auto partition assignment; it is likely that the consumer was kicked out of the group."
                        "\n\tat org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.sendOffsetCommitRequest(ConsumerCoordinator.java:1351)"
                        "\n\tat org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.commitOffsetsSync(ConsumerCoordinator.java:1137)"
                        "\n\tat org.apache.kafka.clients.consumer.KafkaConsumer.commitSync(KafkaConsumer.java:1502)"
                        "\n\tat com.shop.notify.OrderEventsListener.onBatch(OrderEventsListener.java:73)")
            out.append(self.line(sec, "ERROR", "notification-service", "c.s.notify.OrderEventsListener", msg, pod=pod))
        elif roll < 0.09:
            parts = sorted(r.sample(range(6), 2))
            out.append(self.line(sec, "INFO", "notification-service", "o.a.k.c.c.internals.ConsumerCoordinator",
                                 f"[Consumer clientId={cid}, groupId=notification] Revoke previously assigned partitions "
                                 f"order-events-{parts[0]}, order-events-{parts[1]}", pod=pod))
            out.append(self.line(sec, "INFO", "notification-service", "o.a.k.c.c.internals.ConsumerCoordinator",
                                 f"[Consumer clientId={cid}, groupId=notification] (Re-)joining group", pod=pod))
        elif roll < 0.13:
            lag = int(4000 + 60000 * p * r.uniform(0.7, 1.1))
            out.append(self.line(sec, "WARN", "notification-service", "c.s.notify.LagMonitor",
                                 f"Consumer lag high group=notification topic=order-events partition={r.randint(0, 5)} lag={lag}", pod=pod))
        elif roll < 0.16:
            out.append(self.line(sec, "WARN", "notification-service", "c.s.notify.OrderEventsListener",
                                 f"Duplicate event suppressed order=O-{r.randint(1000000, 9999999)} template=order_confirmation "
                                 "(already sent; offset was re-delivered after rebalance)", pod=pod))
        return out

    def search_oom(self, sec, p, st):
        r = self.r
        out = []
        pod = r.choice(PODS["search-service"])
        if p < 0.45:
            if r.random() < 0.03:
                before = int(3300 + 700 * p / 0.45)
                out.append(self.line(sec, "WARN", "search-service", "gc",
                                     f"GC({r.randint(8000, 9999)}) Pause Full (G1 Compaction Pause) {before}M->{before - r.randint(5, 40)}M(4096M) "
                                     f"{r.uniform(900, 3200):.3f}ms", pod=pod))
            if r.random() < 0.01:
                out.append(self.line(sec, "WARN", "search-service", "c.s.search.HeapMonitor",
                                     f"Heap usage {int(86 + 12 * p / 0.45)}% (old gen {3.4 + 0.5 * p / 0.45:.2f} GB / 4.00 GB) after GC", pod=pod))
        else:
            roll = r.random()
            if roll < 0.06:
                msg = "Unhandled exception in GET /api/search: java.lang.OutOfMemoryError: Java heap space"
                if r.random() < 0.3:
                    msg += ("\njava.lang.OutOfMemoryError: Java heap space"
                            "\n\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)"
                            "\n\tat java.base/java.util.ArrayList.grow(ArrayList.java:237)"
                            "\n\tat java.base/java.util.ArrayList.add(ArrayList.java:455)"
                            "\n\tat com.shop.search.cache.QueryResultCache.put(QueryResultCache.java:112)"
                            "\n\tat com.shop.search.SearchController.search(SearchController.java:64)")
                out.append(self.line(sec, "ERROR", "search-service", "o.a.c.c.C.[.[.[/].[dispatcherServlet]", msg, pod=pod))
            elif roll < 0.0615:
                # kubelet restarts with exponential back-off (10s, 20s, ... capped at 5m)
                n = st["restarts"][pod] = st["restarts"].get(pod, 0) + 1
                out.append(self.line(sec, "WARN", "kubelet", "kubelet",
                                     f"Container search-service in pod {pod} was OOMKilled (exit code 137); restart count {n}",
                                     pod="node/ip-10-0-3-17"))
                out.append(self.line(sec, "WARN", "kubelet", "kubelet",
                                     f"Back-off restarting failed container search-service in pod {pod} (CrashLoopBackOff, "
                                     f"back-off {min(10 * 2 ** (n - 1), 300)}s)", pod="node/ip-10-0-3-17"))
            elif roll < 0.063:
                out.append(self.line(sec, "INFO", "search-service", "c.s.search.SearchApplication",
                                     f"Started SearchApplication in {r.uniform(11, 17):.1f} seconds (process running for {r.uniform(12, 18):.1f})", pod=pod))
            elif roll < 0.25:
                out.append(self.access(sec, "GET", f"/api/search?q={r.choice(QUERIES).replace(' ', '+')}", 503,
                                       r.randint(1, 6), upstream="search-service (no healthy upstream)"))
        return out

    def inventory_deadlock(self, sec, p, st):
        r = self.r
        out = []
        if r.random() < 0.09:
            pa, pb = r.randint(30000, 39999), r.randint(30000, 39999)
            ta = r.randint(8800000, 8899999)
            detail = (f"\n  Detail: Process {pa} waits for ShareLock on transaction {ta}; blocked by process {pb}."
                      f"\nProcess {pb} waits for ShareLock on transaction {ta - 2}; blocked by process {pa}."
                      "\n  Hint: See server log for query details."
                      f"\n  Where: while updating tuple ({r.randint(100, 900)},{r.randint(1, 40)}) in relation \"inventory\"")
            order = f"O-{r.randint(1000000, 9999999)}"
            msg = (f"Could not reserve stock order={order}: org.springframework.dao.CannotAcquireLockException: "
                   "could not execute batch; SQL [update inventory set reserved=reserved+? where sku=?]; nested exception "
                   "is org.postgresql.util.PSQLException: ERROR: deadlock detected")
            if r.random() < 0.35:
                msg += detail
            out.append(self.line(sec, "ERROR", "inventory-service", "c.s.inventory.ReservationService", msg))
            if r.random() < 0.5:
                out.append(self.line(sec, "ERROR", "postgres", "postgres", "ERROR:  deadlock detected" + detail, pod="orders-db-0"))
            out.append(self.access(sec, "POST", "/api/checkout", 409, r.randint(60, 900), upstream="inventory-service"))
            if r.random() < 0.6:
                out.append(self.line(sec, "WARN", "order-service", "c.s.order.CheckoutService",
                                     f"Retrying reservation order={order} attempt=2/3 cause=CannotAcquireLockException"))
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), ".data"))
    ap.add_argument("--target-bytes", type=int, default=1 << 30)
    ap.add_argument("--seed", type=int, default=20260715)
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    path = os.path.join(args.out_dir, "deeploglens-1gb.log")
    w = Writer(path, args.target_bytes)
    g = Gen(args.seed, w)
    r = g.r
    emit = {"cert-expiry": g.cert_expiry, "pool-exhaustion": g.pool_exhaustion, "redis-failover": g.redis_failover,
            "kafka-rebalance": g.kafka_rebalance, "search-oom": g.search_oom, "inventory-deadlock": g.inventory_deadlock}

    # One-off events: warnings before, triggers, and fixes (second → list of (mark, line builder)).
    def ev(sec, mark, fn):
        events.setdefault(sec, []).append((mark, fn))
    events: dict[int, list] = {}
    for hh, mm in ((8, 5), (8, 35), (9, 5)):
        mins = (at(9, 14) - at(hh, mm)) // 60
        ev(at(hh, mm), "cert-expiry", lambda s, m=mins: g.line(s, "WARN", "payment-service", "c.s.payment.tls.CertificateMonitor",
           f"TLS certificate for api.partner-bank.example expires in {m} minutes (notAfter=2026-07-15T09:14:00Z, "
           "subject=CN=api.partner-bank.example)", tenant="system"))
    ev(at(9, 27, 10), "cert-expiry", lambda s: g.line(s, "INFO", "payment-service", "c.s.payment.tls.TrustStoreReloader",
       "Reloaded truststore /etc/ssl/partner-bank/ca.pem: CN=api.partner-bank.example notAfter=2027-07-15T09:14:00Z",
       tenant="system"))
    ev(at(10, 38, 12), "pool-exhaustion", lambda s: g.line(s, "INFO", "kubelet", "deploy-controller",
       "Deployment order-service rolled out image registry.shop.io/order-service:5.4.0 (4/4 replicas ready)",
       pod="node/ip-10-0-2-11", tenant="system"))
    ev(at(11, 1, 40), "pool-exhaustion", lambda s: g.line(s, "INFO", "kubelet", "deploy-controller",
       "Deployment order-service rolled back to registry.shop.io/order-service:5.3.2 (4/4 replicas ready)",
       pod="node/ip-10-0-2-11", tenant="system"))
    ev(at(12, 22, 5), "redis-failover", lambda s: g.line(s, "WARN", "redis-sentinel", "sentinel",
       "+sdown master cache-primary 10.0.4.21 6379", pod="redis-sentinel-0", tenant="system"))
    ev(at(12, 22, 9), "redis-failover", lambda s: g.line(s, "WARN", "redis-sentinel", "sentinel",
       "+odown master cache-primary 10.0.4.21 6379 #quorum 2/2", pod="redis-sentinel-0", tenant="system"))
    ev(at(12, 22, 41), "redis-failover", lambda s: g.line(s, "WARN", "redis-sentinel", "sentinel",
       "+switch-master cache-primary 10.0.4.21 6379 10.0.4.22 6379", pod="redis-sentinel-0", tenant="system"))
    ev(at(12, 29, 22), "redis-failover", lambda s: g.line(s, "INFO", "cart-service", "i.l.core.protocol.ReconnectionHandler",
       "Reconnected to redis-primary.cache.svc/10.0.4.22:6379", tenant="system"))
    ev(at(14, 21, 30), "kafka-rebalance", lambda s: g.line(s, "INFO", "notification-service", "c.s.notify.ConsumerConfigReloader",
       "Applied consumer config max.poll.records=50 (was 500) group=notification", tenant="system"))
    ev(at(15, 52, 5), "search-oom", lambda s: g.line(s, "INFO", "kubelet", "deploy-controller",
       "Deployment search-service rolled out image registry.shop.io/search-service:3.9.1 "
       "(env SEARCH_RESULT_CACHE_MAX_ENTRIES=10000; 2/2 replicas ready)", pod="node/ip-10-0-3-17", tenant="system"))
    ev(at(17, 8), "inventory-deadlock", lambda s: g.line(s, "INFO", "order-service", "c.s.order.CampaignService",
       "Flash sale started campaign=summer-72h skus=40 discount=35%", tenant="system"))
    ev(at(17, 18, 40), "inventory-deadlock", lambda s: g.line(s, "INFO", "kubelet", "deploy-controller",
       "Deployment inventory-service rolled out image registry.shop.io/inventory-service:2.7.4 (2/2 replicas ready)",
       pod="node/ip-10-0-2-11", tenant="system"))

    w.write(g.line(0, "INFO", "kubelet", "deploy-controller", "Log export started: all services, namespace=shop-prod",
                   pod="node/ip-10-0-2-11", tenant="system"))
    sec = 0
    restarts: dict[str, int] = {}
    while w.bytes < args.target_bytes:
        active = next((i for i in INCIDENTS if i["start"] <= sec < i["end"]), None)
        state = {"restarts": restarts}  # restart counters persist across seconds
        if active and active["key"] == "redis-failover":
            state.update(hit_rate=0.35, sql_x=6, latency_x=2.5)
        if active and active["key"] == "pool-exhaustion":
            state.update(latency_x=3)
        if active and active["key"] == "inventory-deadlock":
            state.update(latency_x=1.6)
        n = RATE + r.randint(-30, 30) + (90 if active and active["key"] == "inventory-deadlock" else 0)
        offs = sorted(r.random() for _ in range(n))
        for mark, fn in events.get(sec, []):
            w.write(fn(sec), mark)
        for o in offs:
            s = sec + o
            # During an incident a share of request slots fails instead of logging normally.
            if active and r.random() < INTENSITY[active["key"]]:
                p = (sec - active["start"]) / (active["end"] - active["start"])
                lines = emit[active["key"]](s, p, state)
                if lines:
                    for ln in lines:
                        w.write(ln, active["key"])
                    continue
            w.write(g.noise(s) if r.random() < 0.012 else g.normal(s, state))
        sec += 1
    w.close()

    meta = {
        "file": os.path.basename(path), "bytes": w.bytes, "lines": w.lines, "sha256": w.sha.hexdigest(),
        "seed": args.seed, "start": START.isoformat().replace("+00:00", "Z"),
        "end": (START + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z"),
        "index_every": INDEX_EVERY, "index": w.index,
        "incidents": [{**i, "start": (START + timedelta(seconds=i["start"])).isoformat().replace("+00:00", "Z"),
                       "end": (START + timedelta(seconds=i["end"])).isoformat().replace("+00:00", "Z"),
                       "lines": len(w.marks.get(i["key"], [])),
                       "first_line": (w.marks.get(i["key"]) or [None])[0]} for i in INCIDENTS],
    }
    with open(os.path.join(args.out_dir, "meta.json"), "w") as f:
        json.dump(meta, f)
    print(json.dumps({k: meta[k] for k in ("file", "bytes", "lines", "sha256", "end")}))
    for i in meta["incidents"]:
        print(i["key"], i["start"], i["lines"], "lines, first at", i["first_line"])


if __name__ == "__main__":
    main()
