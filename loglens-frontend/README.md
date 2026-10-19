# DeepLogLens frontend

React + Vite + Tailwind, plus two Vercel serverless functions in `api/`.

- `/`: landing page
- `/app`: sessions → upload → live pipeline progress → **Overview**, **Incidents**, **Ask**
- `/demo`: straight into the guest session (no account)

```bash
npm install
npm run dev        # http://localhost:5173 (proxies /api to :3001)
npm run dev:api    # the api/ functions locally on :3001
npm run lint && npm run build
```

## Guest session: the 1 GB log

Guests analyze `deeploglens-1gb.log`: one day (08:00–17:50 UTC) of an e-commerce
platform, 1 GiB, 5.37 M lines, with six outages modelled on real failure modes
(expired TLS certificate, a release that exhausts the DB pool, Redis failover,
Kafka `max.poll.interval.ms` rebalance loop, OOM crash loop, Postgres deadlocks).

The pipeline results are precomputed: the production parsers and anomaly gate
(`WindowEvalCli`, the same Java code the backend runs) produce the metrics and
flags; `build-dataset.mjs` turns them into incidents with exact counts and evidence
lines; an LLM writes each incident's explanation. The UI replays the run, then
serves the results from `src/demo/fixture.json`.

**Ask is live.** `api/ask.js` searches the log's database (pgvector + Postgres
full-text, fused with RRF), gives the model numbered log lines and exact counts,
and drops any citation the model makes that wasn't in that context. `api/log.js`
serves any slice of the file with an HTTP Range read, for the preview.

### Rebuild the data (from `loglens-frontend/`)

```bash
npm run demo:generate        # 1 GB log, byte-identical every run (sha256 in .data/meta.json)
npm run demo:extract         # events, failure templates, minute stats, line→byte index
(cd .. && ./gradlew :loglens-backend:printTestClasspath && \
  java -Xmx12g -cp "$(cat loglens-backend/build/test-classpath.txt)" com.loglens.ingest.WindowEvalCli \
  loglens-frontend/scripts/demo/.data/deeploglens-1gb.log loglens-frontend/scripts/demo/.data/windows.json 60 5000 robust)
npm run demo:build           # incidents + src/demo/fixture.json + api/_lib/log-index.json
GROQ_API_KEYS=... npm run demo:explain                       # LLM writes the incident explanations
DATABASE_URL=... GEMINI_API_KEYS=... npm run demo:load-db    # schema, 127k events, embeddings
```

### Environment variables (Vercel → Settings → Environment Variables)

| Name | Used by | Value |
|---|---|---|
| `DATABASE_URL` | `api/ask` | Postgres with pgvector, e.g. Neon (`...?sslmode=require`) |
| `GROQ_API_KEYS` | `api/ask` | comma-separated Groq keys (rotated, 429s skip to the next) |
| `GEMINI_API_KEYS` | `api/ask` | comma-separated Gemini keys (query embeddings) |
| `LOG_FILE_URL` | `api/log` | public URL of the raw file that honours `Range` (e.g. a GitHub release asset) |
| `LOG_FILE_GZ_URL` | `api/log` | optional: compressed download |
| `GROQ_MODEL` | `api/ask` | optional, default `llama-3.3-70b-versatile` |
| `ASK_DAILY_LIMIT` / `ASK_GLOBAL_DAILY_LIMIT` | `api/ask` | optional quotas (default 25 per visitor, 1500 total per day) |
| `VITE_GUEST_MODE` | build | `live` sends guests to the backend's guest session instead |

Never prefix secrets with `VITE_`: those are compiled into the browser bundle.

Local testing without keys: `node scripts/demo/llm-stub.mjs` and point
`GROQ_BASE_URL` / `GEMINI_BASE_URL` at it (see the file header).
