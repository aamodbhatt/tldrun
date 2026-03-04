# TL;DRun

Convert ML papers into runnable starter repositories with an anti-hype implementation lens.

<p align="center">
  <img src="public/favicon.svg" alt="TL;DRun icon" width="80" height="80" />
</p>

> Last updated: 2026-03-05

## Overview
TL;DRun helps you move from paper text to executable code quickly, while surfacing hidden implementation risk.

Core flow:
1. Upload a PDF or import a paper from discovery search.
2. Generate a runnable scaffold (`train.py`, config, Docker, run scripts).
3. Interrogate the paper context (full OA text when available; explicit fallback otherwise).
4. Download a reproducible ZIP bundle with deterministic commands.

## Highlights
- Backend-only model execution (no browser provider keys).
- OA-first full-text resolver for interrogation:
  - OpenAlex -> Unpaywall -> arXiv -> Semantic Scholar -> metadata fallback.
- Paper discovery focused on recent work with year bands (`2023+`, `2024+`, `2025+`, `2026+`).
- Demo guardrails for spend control (IP-based run/chat quotas).
- Repro bundle includes `venv` and Docker paths with smoke testing.

## Stack
| Layer | Technology |
|---|---|
| Frontend | Vite, React, Tailwind |
| Backend | Express, Multer, JSZip |
| Model Providers | Gemini, OpenRouter, OpenAI, Anthropic, Groq |
| Paper Sources | OpenAlex, Unpaywall, arXiv, Semantic Scholar |

## Quick Start
```bash
npm install
cp .env.example .env
# set GEMINI_API_KEY (or OTHER_API_KEY)
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

## Environment Variables
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes* | - | Primary backend provider key |
| `OTHER_API_KEY` | No | - | Fallback provider key |
| `APP_AUTH_SECRET` | Prod only | random in dev | Token signing secret |
| `AUTH_REQUIRED` | No | `true` | Require guest bearer token on `/api/*` |
| `DEMO_DAILY_RUN_LIMIT` | No | `3` | Daily generate/import cap per IP |
| `DEMO_DAILY_CHAT_LIMIT` | No | `20` | Daily chat cap per IP |
| `DEMO_DAILY_WINDOW_MS` | No | `86400000` | Quota window length |
| `TRUST_PROXY` | No | `false` | Enable correct client IP behind trusted proxy |
| `FULLTEXT_RESOLVER_TIMEOUT_MS` | No | `12000` | OA full-text fetch timeout |
| `FULLTEXT_CACHE_TTL_MS` | No | `900000` | Full-text resolver cache TTL |
| `UNPAYWALL_EMAIL` | No | empty | Unpaywall API identity |
| `SEMANTIC_SCHOLAR_API_KEY` | No | empty | Optional higher-limit Semantic Scholar usage |
| `DATABASE_URL` | No | empty | Optional Neon persistence |

`*` At least one of `GEMINI_API_KEY` or `OTHER_API_KEY` is required.

## Demo Quota Model (No Accounts)
Run quota applies to:
- `POST /api/generate`
- `POST /api/papers/import`

Chat quota applies to:
- `POST /api/chat`

Quota headers:
- `X-Demo-Run-Limit`
- `X-Demo-Run-Remaining`
- `X-Demo-Run-Reset-At`
- `X-Demo-Chat-Limit`
- `X-Demo-Chat-Remaining`
- `X-Demo-Chat-Reset-At`

## API Surface
| Endpoint | Purpose |
|---|---|
| `POST /api/auth/guest` | Issue short-lived guest token |
| `POST /api/generate` | Start pipeline generation from uploaded PDF |
| `GET /api/status/:jobId` | Poll generation status |
| `GET /api/download/:jobId` | Download generated ZIP |
| `POST /api/chat` | Interrogate paper context |
| `GET /api/papers/search` | Search papers (`minYear` supported; default `2023`) |
| `POST /api/papers/import` | Import a discovered paper into generation pipeline |
| `GET /api/demo/quota` | Fetch run/chat quota snapshot |

## Full-Paper Interrogation Policy
- OA-only retrieval. No paywall bypass.
- If full text is unavailable, TL;DRun is explicit:
  - `contextStatus = abstract_only` or `upload_required`
  - user is prompted to upload PDF for full interrogation.

## Generated ZIP Contents
Each bundle includes generated code plus deterministic tooling:
- `train.py`, `config.yaml`, `requirements.txt`, `Dockerfile`, `README.md`
- `scripts/bootstrap_venv.sh`
- `scripts/smoke_test.sh`
- `scripts/run_train.sh`
- `scripts/docker_build.sh`
- `scripts/docker_run.sh`
- `Makefile`
- `RUNBOOK.md`
- `HOW_TO_IMPLEMENT.txt`

## Reproduction Commands
### venv
```bash
unzip tldrun-repo.zip -d tldrun-repo
cd tldrun-repo
chmod +x scripts/*.sh
./scripts/bootstrap_venv.sh
./scripts/smoke_test.sh
./scripts/run_train.sh
```

### Docker
```bash
unzip tldrun-repo.zip -d tldrun-repo
cd tldrun-repo
chmod +x scripts/*.sh
./scripts/docker_build.sh
./scripts/docker_run.sh smoke
./scripts/docker_run.sh train
```

## Security Posture (Current)
Implemented now:
- Backend-only key usage path.
- Secure response headers + production CSP/HSTS.
- API rate limiting and authenticated `/api/*` access.
- Strict PDF upload validation and size limits.
- IP-based daily quotas for run and chat.
- OA-only full-text resolver with explicit fallback state.

Still needed before broad public rollout:
- Real user auth + per-user authorization.
- Durable job ownership model in DB.
- Full observability and abuse detection.
- Upload malware scanning.

## Notes
- Local dev works without a database.
- In demo mode, server jobs/quotas are in-memory and reset on restart.
- Browser history of analyzed papers is stored locally (IndexedDB).
