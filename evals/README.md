# LogLens evals

Small, readable harness. Every run writes `results.json` + a dated `REPORT.md`
(date, commit SHA, dataset, config, model, LLM calls, cost) under `evals/results/<run>/`.

| Eval | What it measures | LLM? | Cost | Command |
|---|---|---|---|---|
| Anomaly + gating | window precision/recall/F1, incident recall, false alarms/hour, detection delay, LLM calls + tokens **with vs without** the gate, scaling with traffic | no | $0 | `python evals/run_anomaly_gating.py --mode robust` (or `--mode legacy`) |
| Retrieval | recall@5/10/30, MRR, nDCG@10 vs gold lines; vector vs FTS vs hybrid ablation; share of gold lines the model actually sees; latency | no (local embedder) | $0 | `python evals/run_retrieval.py [--session <id>]` |
| Answer quality | correctness (code-checked), abstention, citation validity/precision/recall, faithfulness (LLM judge), corrective-loop trigger rate | yes | cached; guard at $5 | `python evals/run_llm_evals.py --session <id> --judge anthropic` |

## Setup (once)

```bash
docker compose up -d                                   # Postgres+pgvector, Kafka, MinIO
bench/fetch_model.sh                                   # local bge-small ONNX embedder (no key)
pip install onnxruntime tokenizers numpy "psycopg[binary]" pgvector requests
./gradlew :loglens-backend:printTestClasspath          # eval CLI classpath
python evals/generate_corpus.py --name eval_mediumnoise --hours 6 --rate 2 --seed 7 --noise medium
python evals/prepare_loghub.py
python evals/build_golden_qa.py                        # -> datasets/golden_qa.json (checked in)
```

For retrieval and answer evals the backend must ingest the archive with the same
embedder the eval uses: run `bench/llm_stub.py --embed bge` and `bench/run_app.sh`
(see `bench/BENCHMARKS.md`), then the retrieval eval creates a session itself.

## Datasets

- `datasets/synthetic/` (generated, gitignored; byte-identical for a given seed):
  Spring-style app logs, 2 lines/s, 6 h, 12 injected incidents with gold
  timelines and gold line numbers; three background-noise levels; held-out seeds
  101/202/303 for generalisation. The generator's WARN share (1.7%) is matched to
  the owner's demo corpus.
- `datasets/loghub/`: Loghub 2k samples (BGL, Thunderbird, HDFS, Spark, Apache),
  from https://github.com/logpai/loghub (Zhu et al., ISSRE 2023), licence in
  `LICENSE_loghub`. BGL/Thunderbird carry line-level alert labels.
  Full HDFS_v1/BGL archives live on Zenodo, which this environment cannot reach.
- `datasets/owner_sample_10k.log`: the 10k-line demo corpus from the repo history.
- `datasets/golden_qa.json`: 65 questions over `eval_mediumnoise` (21.5%
  unanswerable). Gold answers and gold line numbers are **computed by code** from
  the incident labels; `verified_by` lists "generator" until the owner reviews an
  item and adds "owner".

## CI

`.github/workflows/ci.yml` runs unit + Testcontainers integration tests and the
fast eval subset (`--fast`: the medium-noise corpus only) and fails below
`evals/thresholds.json`. Thresholds come from the first robust-mode run; the
eval is deterministic, so a drop means behaviour changed.

## Honest limits

- The synthetic corpus is mine; rules could overfit it. Mitigations: held-out
  seeds, Loghub BGL (real labels), the owner's corpus, and standard statistics
  (modified z-score 3.5) instead of tuned constants.
- Retrieval uses bge-small (384-d, 512-token window) as a stand-in for
  gemini-embedding-001 (768-d, 8k chars): absolute vector numbers will differ.
- Answer-quality metrics need an API key; the checked-in `results/llm/dry_run`
  only proves the wiring against the stub.
