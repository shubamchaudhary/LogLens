#!/usr/bin/env bash
# Starts the real backend jar against the local docker stack + LLM stub.
# Usage: bench/run_app.sh <heap e.g. 256m> <part-concurrency> <logfile> [extra spring args...]
set -euo pipefail
HEAP=${1:-256m}; CONC=${2:-3}; LOG=${3:-bench/.work/app.log}; shift 3 || true
SRC_JAR=${JAR:-loglens-backend/build/libs/loglens-backend-1.0.0-SNAPSHOT.jar}
# Run from a private copy: rebuilding the jar under a running JVM makes lazy class
# loading fail (ClassNotFoundException) and stops the Kafka listener containers.
JAR=bench/.work/run-$$.jar
cp "$SRC_JAR" "$JAR"
export JWT_SECRET=${JWT_SECRET:-bench-only-secret-bench-only-secret-bench-only-secret-0123456789}
exec java -Xmx$HEAP -Xms64m -XX:+UseSerialGC \
  -Xlog:gc*:file=${LOG%.log}.gc.log:uptime,level,tags \
  -jar $JAR \
  --server.port=${PORT:-8080} \
  --groq.base-url=http://127.0.0.1:8089/openai/v1 \
  --groq.api-keys=stub1,stub2,stub3,stub4 \
  --groq.rate-limit-per-min=60000 --groq.tpm-limit=1000000000 \
  --gemini.base-url=http://127.0.0.1:8089/v1beta \
  --gemini.api-keys=stubA,stubB \
  --gemini.embedding-rpm-limit=100000 --gemini.embedding-tpm-limit=1000000000 \
  --gemini.embedding-max-request-tokens=100000000 \
  --loglens.orchestrator.url=${ORCH_URL:-http://127.0.0.1:8000} \
  --loglens.ingest.part-concurrency=$CONC \
  --logging.level.com.loglens=INFO \
  "$@" >> "$LOG" 2>&1
