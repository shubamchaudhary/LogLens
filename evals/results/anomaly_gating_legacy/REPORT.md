# Anomaly detection and LLM gating eval (loglens.anomaly.mode=legacy)

- Date: 2026-09-29T21:43:10+00:00  |  Commit: `d0e01c1-dirty`  |  LLM calls made: 0  |  Cost: $0
- Config: window 60s, max 5000 chars/LLM call, WARN burst >= 5, latency > 3.0x corpus p95
- How: production chunker + parsers + AnomalyDetector run by `WindowEvalCli`; scored by this script.

## Synthetic app logs (labelled incidents)

| Dataset | Windows | Flagged | Precision | Recall | F1 | False alarms/h | Incident recall | LLM calls gated / ungated | Call reduction |
|---|---|---|---|---|---|---|---|---|---|
| eval_lownoise | 360 | 101 | 0.634 | 0.865 | 0.731 | 6.17 | 0.917 | 407 / 1415 | 71.2% |
| eval_mediumnoise | 360 | 155 | 0.426 | 0.892 | 0.576 | 14.83 | 1.0 | 621 / 1418 | 56.2% |
| eval_highnoise | 360 | 238 | 0.29 | 0.932 | 0.442 | 28.17 | 1.0 | 946 / 1409 | 32.9% |

### Per-incident detection (eval_lownoise)

| Incident | Detectable by design | Windows | Flagged | Detected | Delay (s) | Rules that fired |
|---|---|---|---|---|---|---|
| db_pool_exhaustion | True | 9 | 9 | True | 0 | SqlParser:9, ErrorParser:5, LATENCY_P95:5, WARN_BURST:3 |
| payment_latency | True | 8 | 8 | True | 0 | LATENCY_P95:8, ErrorParser:2 |
| oom_crash | True | 7 | 5 | True | 0 | WARN_BURST:4, LATENCY_P95:4, ErrorParser:2, PerformanceParser:2 |
| auth_silent | False | 6 | 1 | True | 124 | ErrorParser:1 |
| deadlock | True | 4 | 4 | True | 0 | SqlParser:4, ErrorParser:4 |
| bad_deploy | True | 8 | 7 | True | 0 | ErrorParser:6, LifecycleParser:6, WARN_BURST:1 |
| thread_pool | True | 5 | 5 | True | 0 | ErrorParser:5, PerformanceParser:5 |
| slow_sql | True | 7 | 7 | True | 0 | LATENCY_P95:7, ErrorParser:1 |
| kafka_lag | True | 6 | 6 | True | 0 | WARN_BURST:6, ErrorParser:1 |
| disk_full | True | 4 | 4 | True | 0 | ErrorParser:4 |
| rate_limited_upstream | True | 5 | 5 | True | 0 | WARN_BURST:5, ErrorParser:2 |
| cert_expiry | True | 5 | 5 | True | 0 | ErrorParser:5 |

## Held-out generator seeds (rules not tuned on these)

| Dataset | Precision | Recall | F1 | Incident recall | Missed | Call reduction |
|---|---|---|---|---|---|---|
| heldout_seed101 | 0.441 | 0.865 | 0.584 | 1.0 | - | 59.1% |
| heldout_seed202 | 0.434 | 0.838 | 0.571 | 0.917 | auth_silent | 59.3% |
| heldout_seed303 | 0.475 | 0.892 | 0.62 | 1.0 | - | 60.5% |

## Loghub 2k samples

| Dataset | Native timestamp recognition | Windows | Flagged share | Precision | Recall | F1 | Call reduction |
|---|---|---|---|---|---|---|---|
| Loghub BGL_2k | 0.0% | 1380 | 27.1% | 0.334 | 1.0 | 0.501 | 72.9% |
| Loghub Thunderbird_2k | 0.0% | 15 | 6.7% | 0.0 | 0.0 | 0.0 | 77.5% |
| Loghub HDFS_2k | 0.0% | 907 | 0.0% | n/a | n/a | n/a | 100.0% |
| Loghub Spark_2k | 0.0% | 2 | 0.0% | n/a | n/a | n/a | 100.0% |
| Loghub Apache_2k | 0.0% | 297 | 68.4% | n/a | n/a | n/a | 31.6% |

## Owner's 10k-line sample (the demo corpus)

16 of 167 windows flagged; LLM calls 43 gated vs 345 ungated (87.5% fewer). Rules: {'ErrorParser': 14, 'WARN_BURST': 7, 'PerformanceParser': 1}

## Does the gate scale with traffic? (same generator, only lines/s changes)

| Lines/s | Windows | Flagged share | Call reduction | Precision | Recall |
|---|---|---|---|---|---|
| 1 | 120 | 20.8% | 77.2% | 0.64 | 0.533 |
| 2 | 120 | 33.3% | 64.9% | 0.375 | 0.5 |
| 5 | 120 | 82.5% | 17.2% | 0.232 | 0.767 |
| 20 | 120 | 100.0% | 0.0% | 0.25 | 1.0 |
| 50 | 120 | 100.0% | 0.0% | 0.25 | 1.0 |
