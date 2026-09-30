# Anomaly detection and LLM gating eval (loglens.anomaly.mode=robust)

- Date: 2026-09-30T00:40:46+00:00  |  Commit: `297298b`  |  LLM calls made: 0  |  Cost: $0
- Config: window 60s, max 5000 chars/LLM call, WARN burst >= 5, latency > 3.0x corpus p95
- How: production chunker + parsers + AnomalyDetector run by `WindowEvalCli`; scored by this script.

## Synthetic app logs (labelled incidents)

| Dataset | Windows | Flagged | Precision | Recall | F1 | False alarms/h | Incident recall | LLM calls gated / ungated | Call reduction |
|---|---|---|---|---|---|---|---|---|---|
| eval_lownoise | 360 | 83 | 0.807 | 0.905 | 0.854 | 2.67 | 1.0 | 337 / 1415 | 76.2% |
| eval_mediumnoise | 360 | 77 | 0.883 | 0.919 | 0.901 | 1.5 | 1.0 | 315 / 1418 | 77.8% |
| eval_highnoise | 360 | 84 | 0.81 | 0.919 | 0.861 | 2.67 | 1.0 | 341 / 1409 | 75.8% |

### Per-incident detection (eval_lownoise)

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

## Held-out generator seeds (rules not tuned on these)

| Dataset | Precision | Recall | F1 | Incident recall | Missed | Call reduction |
|---|---|---|---|---|---|---|
| heldout_seed101 | 0.944 | 0.905 | 0.924 | 1.0 | - | 79.4% |
| heldout_seed202 | 0.932 | 0.932 | 0.932 | 1.0 | - | 78.3% |
| heldout_seed303 | 1.0 | 0.905 | 0.95 | 1.0 | - | 80.3% |

## Loghub 2k samples

| Dataset | Native timestamp recognition | Windows | Flagged share | Precision | Recall | F1 | Call reduction |
|---|---|---|---|---|---|---|---|
| Loghub BGL_2k | 0.0% | 1380 | 22.1% | 0.41 | 1.0 | 0.581 | 77.9% |
| Loghub Thunderbird_2k | 0.0% | 15 | 0.0% | 0.0 | 0.0 | 0.0 | 100.0% |
| Loghub HDFS_2k | 0.0% | 907 | 0.0% | n/a | n/a | n/a | 100.0% |
| Loghub Spark_2k | 0.0% | 2 | 0.0% | n/a | n/a | n/a | 100.0% |
| Loghub Apache_2k | 0.0% | 297 | 0.0% | n/a | n/a | n/a | 100.0% |

## Owner's 10k-line sample (the demo corpus)

16 of 167 windows flagged; LLM calls 43 gated vs 345 ungated (87.5% fewer). Rules: {'SPIKE:ERRORS|errors': 14, 'RARE_SIGNATURE': 11, 'SPIKE:LEVEL|warn_lines': 7, 'SPIKE:AUTH|auth_401': 4, 'SPIKE:AUTH|auth_403': 3, 'HARD:PerformanceParser': 1, 'SPIKE:ERRORS|exceptions': 1}

## Does the gate scale with traffic? (same generator, only lines/s changes)

| Lines/s | Windows | Flagged share | Call reduction | Precision | Recall |
|---|---|---|---|---|---|
| 1 | 120 | 26.7% | 71.5% | 0.812 | 0.867 |
| 2 | 120 | 25.0% | 73.3% | 0.867 | 0.867 |
| 5 | 120 | 24.2% | 72.6% | 0.897 | 0.867 |
| 20 | 121 | 22.3% | 75.3% | 1.0 | 0.871 |
| 50 | 245 | 24.1% | 74.3% | 0.898 | 0.869 |
