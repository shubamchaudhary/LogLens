# LogLens frontend

React + Vite + Tailwind. Pages: a landing page (`/`), sign-in/registration, and the
app (`/app`): sessions, upload, live pipeline progress, and the result tabs
(overview, report, findings, incidents, metrics, Ask).

```bash
npm install
npm run dev        # http://localhost:5173, talks to VITE_API_BASE_URL (default http://localhost:8080/api/v1)
npm run lint
npm run build
```

## Demo mode (what recruiters see)

The hosted backend is paused to keep hosting free, so "View demo" (and the `/demo`
deep link) runs **entirely in the browser**: `src/demo/demoApi.js` stands in for
the API and replays the pipeline from `src/demo/fixture.json`. Components call the
same `services/api.js` functions either way; `demoAware()` routes each call.

| Env var | Values | Effect |
|---|---|---|
| `VITE_GUEST_MODE` | `replay` (default) | "View demo" = in-browser replay, no backend call |
| | `live` | "View demo" = `POST /auth/guest` against the real backend |
| `VITE_API_BASE_URL` | URL | Real backend base URL |

### What's in the fixture

- **Real**: metrics, anomaly flags, rules fired and LLM-call counts are the output of
  the production Java parsers and anomaly detector (`WindowEvalCli`) on
  `evals/datasets/owner_sample_10k.log`; evidence shows the actual log lines.
- **Sample, until you record one**: the AI-written text (finding explanations, incident
  narratives, report, answers) in `scripts/demo/narratives.mjs`. Every number in it is
  a placeholder filled from the log by the build script.

The demo's "What's real here?" panel says the same thing to visitors.

Rebuild the fixture (from the repo root):

```bash
./gradlew :loglens-backend:printTestClasspath
java -cp "$(cat loglens-backend/build/test-classpath.txt)" com.loglens.ingest.WindowEvalCli \
  evals/datasets/owner_sample_10k.log loglens-frontend/scripts/demo/windows.json 60 5000 robust
node loglens-frontend/scripts/demo/build-fixture.mjs
```

Replace the sample AI text with a **recorded live run**: start the full stack with real
keys, upload `owner_sample_10k.log` to a session, wait for DONE, then:

```bash
node loglens-frontend/scripts/demo/capture-fixture.mjs --api http://localhost:8080/api/v1 \
  --email you@example.com --password '...' --session <session-uuid>
```

The demo banner then says the AI text is recorded.
