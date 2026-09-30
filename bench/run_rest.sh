#!/usr/bin/env bash
# Second half of the benchmark queue (after run_all.sh's ingest runs): robustness with the
# jar before the 73c1fbd fixes and after them, vector isolation, parallelism, and the
# enrich-replay chaos scenario on the pre-fix jar. A step whose result file exists is
# skipped, so the queue can be restarted after an interruption.
set -u
cd "$(dirname "$0")/.."
PY=${PY:-python}
R=bench/results
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
stop_app() { fuser -k 8080/tcp 8081/tcp 2>/dev/null; sleep 2; }

if [ ! -f $R/robustness_before.json ]; then
  stop_app
  # jar built at c5ea7d9: no line caps, NUL handling or gzip check yet
  JAR=bench/.work/loglens-c5ea7d9.jar ROBUST_OUT=$R/robustness_before.json $PY bench/robustness.py
  log "robustness before done"
fi
if [ ! -f $R/robustness_after.json ]; then
  stop_app
  touch bench/.work/jar-stamp
  ${GW:-./gradlew} :loglens-backend:bootJar -x test -q
  [ loglens-backend/build/libs/loglens-backend-1.0.0-SNAPSHOT.jar -nt bench/.work/jar-stamp ] \
    && log "jar rebuilt" || { log "jar build FAILED"; exit 1; }
  ROBUST_OUT=$R/robustness_after.json $PY bench/robustness.py
  log "robustness after done"
fi
if [ ! -f $R/vector_isolation.json ]; then
  stop_app
  $PY bench/vector_bench.py && log "vector bench done" || log "vector bench FAILED"
fi
if [ "$($PY -c "import json;print(len(json.load(open('$R/parallelism.json'))['runs']))" 2>/dev/null)" != 4 ]; then
  stop_app
  docker exec ll-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --alter --topic log.ingest.parts --partitions 8 2>/dev/null
  $PY bench/ingest_bench.py --files bench/.work/data/bench_1g.log --heap 1g --conc 1,2,4,8 --out $R/parallelism.json
  log "parallelism done"
fi
# enrich replay to lag 0 on the pre-fix jar and on the current one (chaos.py counts stub LLM calls)
if [ ! -f $R/chaos_replay_enrich_before.json ]; then
  stop_app
  JAR=bench/.work/loglens-before.jar CHAOS_OUT=$R/chaos_replay_enrich_before.json \
    $PY bench/chaos.py --file evals/datasets/synthetic/eval_mediumnoise.log --scenarios baseline,replay_enrich
  log "replay before done"
fi
if [ ! -f $R/chaos_replay_enrich_after.json ]; then
  stop_app
  CHAOS_OUT=$R/chaos_replay_enrich_after.json \
    $PY bench/chaos.py --file evals/datasets/synthetic/eval_mediumnoise.log --scenarios baseline,replay_enrich
  log "replay after done"
fi
$PY bench/make_report.py > /dev/null && log "BENCHMARKS.md rendered"
log "queue finished"
