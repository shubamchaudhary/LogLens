#!/usr/bin/env bash
# Full benchmark queue (each step gets the machine to itself): ingest throughput + heap at
# -Xmx256m for 100 MB to 2 GB, then run_rest.sh (robustness before/after, vector isolation,
# parallelism, enrich-replay chaos). Both halves skip work whose results already exist.
set -u
cd "$(dirname "$0")/.."
PY=${PY:-python}
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
fuser -k 8080/tcp 8081/tcp 2>/dev/null
$PY bench/ingest_bench.py --files bench/.work/data/bench_100m.log,bench/.work/data/bench_500m.log,bench/.work/data/bench_1g.log,bench/.work/data/bench_2g.log --heap 256m --conc 3
log "ingest heap done"
PY=$PY bash bench/run_rest.sh
