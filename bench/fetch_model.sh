#!/usr/bin/env bash
# Downloads the local embedding model used by evals/benchmarks (no API key needed).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/evals/.models"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL -o bge.tar.gz https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz
echo "3858004b3822f64f940280874b8f2d2dc25b34a4f3eb3cdf617bdceeb21ed9ed  bge.tar.gz" | sha256sum -c -
tar xzf bge.tar.gz && rm bge.tar.gz
