# TL;DRun

Turn ML papers into runnable starter repos with an anti-hype reality check.

> Last updated: 2026-03-05

## Stack
- Frontend: Vite + React + Tailwind
- Backend: Express + Multer + JSZip
- Providers: Gemini / OpenRouter / OpenAI / Anthropic / Groq
- Paper sources: OpenAlex (+ OA fallbacks via Unpaywall, arXiv, Semantic Scholar)

## Local Run
1. `npm install`
2. `cp .env.example .env`
3. Fill at least `GEMINI_API_KEY` (or `OTHER_API_KEY`)
4. `npm run dev`
5. Open `http://localhost:3000`

## Core APIs
- `POST /api/auth/guest`
- `POST /api/generate`
- `GET /api/status/:jobId`
- `GET /api/download/:jobId`
- `POST /api/chat`
  - request supports `preferFullPaper` + `forceContextRefresh`
  - response includes `usedFullPaper`, `contextStatus`, `contextNotice`
- `GET /api/papers/search`
  - supports `minYear` (default `2023`) to keep discovery focused on recent papers
- `POST /api/papers/import`
  - response includes `contextStatus`, `contextSource`, `contextReason`

## Demo Quota (No Accounts Mode)
- Per-IP demo run quota is enforced on generation-triggering routes:
  - `POST /api/generate`
  - `POST /api/papers/import`
- Per-IP demo chat quota is enforced on:
  - `POST /api/chat`
- Default policy:
  - `3` runs per `24h` per IP
  - `20` chat requests per `24h` per IP
- Config:
  - `DEMO_DAILY_RUN_LIMIT`
  - `DEMO_DAILY_CHAT_LIMIT`
  - `DEMO_DAILY_WINDOW_MS`
  - `TRUST_PROXY` (set only behind trusted reverse proxy if you need real client IP forwarding)
- Quota headers returned:
  - `X-Demo-Run-Limit`
  - `X-Demo-Run-Remaining`
  - `X-Demo-Run-Reset-At`
- Exceeded quota returns `429` with `code=DEMO_QUOTA_EXCEEDED`.

## Data Storage (Demo Mode)
- No database is required for local demo use.
- Server jobs and quota buckets are in-memory (reset on server restart).
- Browser-side saved paper history is stored in IndexedDB.
- `DATABASE_URL` is optional and only used when enabling Neon persistence.

## Full-Paper Policy (OA-only)
- Resolver chain: OpenAlex -> Unpaywall (DOI) -> arXiv -> Semantic Scholar -> fallback.
- No paywall bypass.
- If OA full text is unavailable, app falls back to abstract/metadata and prompts user to upload PDF.

## Paper Discovery Defaults
- Curated paper cards are modern-first (2023+).
- Search endpoint is also modern-first by default (`minYear=2023`).
- You can raise/lower the year threshold via query parameter when needed.

## Reproduce From Generated ZIP
Each generated ZIP now includes deterministic artifacts:
- `scripts/bootstrap_venv.sh`
- `scripts/smoke_test.sh`
- `scripts/run_train.sh`
- `scripts/docker_build.sh`
- `scripts/docker_run.sh`
- `Makefile`
- `RUNBOOK.md`

### Quickstart (venv)
```bash
unzip tldrun-repo.zip -d tldrun-repo
cd tldrun-repo
chmod +x scripts/*.sh
./scripts/bootstrap_venv.sh
./scripts/smoke_test.sh
./scripts/run_train.sh
```

### Quickstart (docker)
```bash
unzip tldrun-repo.zip -d tldrun-repo
cd tldrun-repo
chmod +x scripts/*.sh
./scripts/docker_build.sh
./scripts/docker_run.sh smoke
./scripts/docker_run.sh train
```

## Security Baseline (VAPT)
Implemented:
- frontend hard-locked to backend-only provider calls (no browser env/provider key path)
- secure headers + production CSP/HSTS
- API rate limiting
- strict PDF upload checks + size limit
- short-lived signed bearer tokens on `/api/*`
- IP-based demo run quota with 24h rolling reset
- in-memory TTL cleanup
- OA-only full-text retrieval with explicit upload fallback

Still required before internet-facing launch:
- real user auth + per-user authorization on all resources
- persistent DB-backed jobs and ownership controls
- observability + alerting + abuse detection
- malware scanning for uploads

## Docs Map
- `TODO.md`: execution backlog
- `ROADMAP.md`: strategy
- `STATUS.md`: current status and risks
- `IMPLEMENTATIONS.md`: architecture and API details
- `SECURITY.md`: VAPT rules and controls
- `IMPLEMENTATION_PLAN_FULLTEXT_REPRO.md`: archived implementation plan + scope
