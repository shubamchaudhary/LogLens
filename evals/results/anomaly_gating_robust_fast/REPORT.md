# Anomaly detection and LLM gating eval (loglens.anomaly.mode=robust)

- Date: 2026-09-29T22:02:12+00:00  |  Commit: `42bdb4a`  |  LLM calls made: 0  |  Cost: $0
- Config: window 60s, max 5000 chars/LLM call, WARN burst >= 5, latency > 3.0x corpus p95
- How: production chunker + parsers + AnomalyDetector run by `WindowEvalCli`; scored by this script.

## Synthetic app logs (labelled incidents)

| Dataset | Windows | Flagged | Precision | Recall | F1 | False alarms/h | Incident recall | LLM calls gated / ungated | Call reduction |
|---|---|---|---|---|---|---|---|---|---|
| eval_mediumnoise | 360 | 77 | 0.883 | 0.919 | 0.901 | 1.5 | 1.0 | 315 / 1418 | 77.8% |

### Per-incident detection (eval_mediumnoise)

| Incident | Detectable by design | Windows | Flagged | Detected | Delay (s) | Rules that fired |
|---|---|---|---|---|---|---|
| db_pool_exhaustion | True | 9 | 7 | True | 0 | HARD:SqlParser:7, RARE_SIGNATURE:7, LATENCY:API|api_latency_ms:5, SPIKE:API|api_5xx:5, SPIKE:ERRORS|errors:5, SPIKE:ERRORS|exceptions:5, SPIKE:LEVEL|warn_lines:3 |
| payment_latency | True | 8 | 8 | True | 0 | LATENCY:API|api_latency_ms:8 |
| oom_crash | True | 7 | 5 | True | 0 | RARE_SIGNATURE:5, LATENCY:PERFORMANCE|gc_pause_ms:4, SPIKE:LEVEL|warn_lines:4, HARD:PerformanceParser:2, SPIKE:ERRORS|errors:2, SPIKE:ERRORS|exceptions:2 |
| auth_silent | False | 6 | 6 | True | 0 | SPIKE:AUTH|auth_401:6 |
| deadlock | True | 4 | 4 | True | 0 | HARD:SqlParser:4, RARE_SIGNATURE:4, SPIKE:ERRORS|errors:3, LATENCY:DATABASE|sql_latency_ms:2 |
| bad_deploy | True | 8 | 6 | True | 23 | HARD:LifecycleParser:6, RARE_SIGNATURE:6, SPIKE:ERRORS|errors:6, LATENCY:DATABASE|sql_latency_ms:1 |
| thread_pool | True | 5 | 5 | True | 0 | HARD:PerformanceParser:5, RARE_SIGNATURE:5, SPIKE:ERRORS|errors:5, SPIKE:ERRORS|exceptions:5 |
| slow_sql | True | 7 | 7 | True | 0 | LATENCY:DATABASE|sql_latency_ms:7 |
| kafka_lag | True | 6 | 6 | True | 0 | RARE_SIGNATURE:6, SPIKE:LEVEL|warn_lines:6 |
| disk_full | True | 4 | 4 | True | 0 | RARE_SIGNATURE:4, SPIKE:ERRORS|errors:4 |
| rate_limited_upstream | True | 5 | 5 | True | 0 | RARE_SIGNATURE:5, SPIKE:LEVEL|warn_lines:5 |
| cert_expiry | True | 5 | 5 | True | 0 | RARE_SIGNATURE:5, SPIKE:ERRORS|errors:5, SPIKE:ERRORS|exceptions:5 |
