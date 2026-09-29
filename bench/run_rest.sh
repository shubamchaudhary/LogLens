#!/usr/bin/env bash
# Second half of the queue, after the "before" robustness run: rebuild the jar with the
# current code, then robustness "after", vector isolation, parallelism, chaos replay (before jar).
set -u
cd "$(dirname "$0")/.."
PY=${PY:-python}
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
fuser -k 8080/tcp 8081/tcp 2>/dev/null
touch bench/.work/jar-stamp
${GW:-./gradlew} :loglens-backend:bootJar -x test -q
[ loglens-backend/build/libs/loglens-backend-1.0.0-SNAPSHOT.jar -nt bench/.work/jar-stamp ] && log "jar rebuilt" || { log "jar build FAILED"; exit 1; }
ROBUST_OUT=bench/results/robustness_after.json $PY bench/robustness.py; log "robustness after done"
fuser -k 8080/tcp 8081/tcp 2>/dev/null
$PY bench/vector_bench.py && log "vector bench done" || log "vector bench FAILED"
docker exec ll-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --alter --topic log.ingest.parts --partitions 8
$PY bench/ingest_bench.py --files bench/.work/data/bench_1g.log --heap 1g --conc 1,2,4,8 --out bench/results/parallelism.json
log "parallelism done"
JAR=bench/.work/loglens-before.jar CHAOS_OUT=bench/results/chaos_before_replay.json \
  $PY bench/chaos.py --file evals/datasets/synthetic/eval_mediumnoise.log --scenarios baseline,replay_enrich
log "chaos-before replay done"
