#!/usr/bin/env bash
# Sequential benchmark queue (each step gets the machine to itself).
set -u
cd "$(dirname "$0")/.."
PY=${PY:-python}
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
fuser -k 8080/tcp 8081/tcp 2>/dev/null
CHAOS_OUT=bench/results/chaos_after.json $PY bench/chaos.py --file evals/datasets/synthetic/eval_mediumnoise.log \
  --scenarios replay_ingest,replay_enrich,rebalance
log "chaos-after replay+rebalance done"
fuser -k 8080/tcp 8081/tcp 2>/dev/null
$PY bench/vector_bench.py; log "vector bench done"
$PY bench/ingest_bench.py --files bench/.work/data/bench_100m.log,bench/.work/data/bench_500m.log,bench/.work/data/bench_1g.log,bench/.work/data/bench_2g.log --heap 256m --conc 3
log "ingest heap done"
$PY bench/robustness.py; log "robustness done"
docker exec ll-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --alter --topic log.ingest.parts --partitions 8
$PY bench/ingest_bench.py --files bench/.work/data/bench_1g.log --heap 1g --conc 1,2,4,8 --out bench/results/parallelism.json
log "parallelism done"
JAR=bench/.work/loglens-before.jar CHAOS_OUT=bench/results/chaos_before_replay.json \
  $PY bench/chaos.py --file evals/datasets/synthetic/eval_mediumnoise.log --scenarios baseline,replay_enrich
log "chaos-before replay done"
