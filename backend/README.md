# Job Hunting Assistant — Backend

FastAPI service that ingests scraped jobs into **PostgreSQL** (per-source tables + a unified
canonical `scraped_jobs` table), serves JSON search config from a file, coordinates the **Chrome
extension** via extension state and run logs, and runs the **auto-scrape orchestrator**
(post-scrape auto-expiration → finalize).

This is a **search-only** backend. The dedup, matching, and profile pipelines were removed — there
are no `dedup/`, `matching/`, or `profile/` packages and no `/dedup`, `/match`, `/profile`, or
`/skills` routes. For full-stack setup (Docker, extension, web UI), see the
[repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| API | [FastAPI](https://fastapi.tiangolo.com/) |
| DB | PostgreSQL 16, [SQLAlchemy 2](https://docs.sqlalchemy.org/) async, [asyncpg](https://magicstack.github.io/asyncpg/) |
| Migrations | [Alembic](https://alembic.sqlalchemy.org/) (runs `alembic upgrade head` on app startup; head **031**) |
| Auth | Single shared bearer token (`Authorization: Bearer dev-token` in development) |

## Layout

```
backend/
├── main.py              FastAPI app, CORS, /health, lifespan (migrations, Redis subscriber,
│                        auto-scrape cycle cleanup, scheduler); logging.basicConfig on stdout at INFO
├── core/
│   ├── config.py                 Pydantic settings (env: DATABASE_URL, CONFIG_PATH, REDIS_URL, …)
│   ├── config_file.py            read/write config.json
│   ├── database.py               Async engine, AsyncSessionLocal, get_db, migration runner
│   ├── auth.py                   Bearer token check
│   ├── trace.py                  Context-scoped debug_log buffer + stdlib log bridge
│   ├── scraped_job_projection.py Pure per-site → canonical projection (no ORM/HTTP/IO)
│   ├── redis_client.py           Redis channel constants / client
│   ├── auto_scrape_lifecycle.py  Startup: mark stale cycles failed; reset cycle_phase to idle
│   └── auto_scrape_validation.py Orchestrator config limits + validate()
├── models/              SQLAlchemy models: scraped_job (scraped_jobs), extension_state,
│                        extension_run_log, auto_scrape_config/state/cycle, site_session_state
├── schemas/             Pydantic request/response models
├── routers/
│   ├── jobs.py          POST /jobs/ingest (per-source + canonical dual-write), GET/PUT /jobs
│   ├── config.py        GET/PUT /config
│   ├── extension.py     State, scan/stop triggers, run logs, session errors, run-log broadcast
│   ├── auto_scrape.py   /admin/auto-scrape — state, config, cycles, sessions, lifecycle controls
│   ├── admin_cleanup.py POST /admin/cleanup-invalid-entries (stale run-log sweep)
│   └── run_log_ws.py    WebSocket /ws/run-log — fan-out run-log updates (bearer subprotocol)
├── auto_scrape/         post_scrape_orchestrator (Redis subscriber + cycle claim; auto-expiration →
│                        finalize — no matched-claim phase since feature 010) and auto_expiration
├── alembic/             migrations 001–031 (head 031)
├── smoke_test_auto_scrape.py         HTTP + DB smoke (auto-scrape, orchestrator) — run vs live API
├── smoke_test_matched_claim.py       asserts post-scrape leaves rows unclaimed + flag invariants
├── smoke_test_auto_expiration.py     shelf-life expiration; no orphaned canonical rows
├── smoke_test_scraped_jobs_merge.py  dual-write + per-site projection contract (030–031)
├── unit_test_scraped_job_projection.py  projection pure functions (no DB, no HTTP)
├── Dockerfile · requirements.txt · alembic.ini
└── scripts/             helpers (e.g. verify_matched_column.py)
```

The per-source tables (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`) have **no ORM model** —
they are written via raw SQL in `routers/jobs.py` and managed by migrations. `scraped_jobs` is the
only per-posting ORM model. Authoritative per-site → canonical mapping:
[**docs/live-per-source-schemas.md**](../docs/live-per-source-schemas.md).

## Environment

Read from a `.env` file (see [`.env.example`](../.env.example) at the repo root).

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Async SQLAlchemy URL, e.g. `postgresql+asyncpg://user:pass@host:5432/db` |
| `CONFIG_PATH` | Path to `config.json` (default `/app/data/config.json`; host `./data` bind mount) |
| `REDIS_URL` | Compose sets `redis://redis:6379/0`, enabling the `redis_subscriber` in `main.py`. Omit for Redis-free bare-metal runs |
| `EXTENSION_ORIGIN_REGEX` | Optional; stricter extension-origin checks |
| `DEBUG_LOG_RING_SIZE` | Max events per run-log `debug_log` ring buffer (default 10000) |
| `PROFILE_PATH`, `DEDUP_COSINE_BATCH_SIZE` | **Vestigial** — still read (defaults `/app/data/profile.json`, `1000`) but the profile/dedup features that used them are gone |

## Run locally (Docker — recommended)

From the **repository root**:

```bash
cp .env.example .env
docker compose up --build -d
curl http://localhost:8000/health      # {"status":"ok","db":"ok"}
```

Migrations apply on startup. **The backend image bakes code at build time (no source mount)** — a
host edit changes nothing until you rebuild: `docker compose up -d --build backend`.

## Run locally (without Docker)

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate    # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
alembic upgrade head
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Ensure `CONFIG_PATH` points to a writable `config.json`.

## API overview

All JSON endpoints except `/health` expect `Authorization: Bearer dev-token`.

### `GET /health`
No auth. Returns `{ "status": "ok", "db": "ok" | "error" }`.

### Jobs (`/jobs`)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/jobs/ingest` | Ingest a job: dual-writes the per-source row **and** one canonical `scraped_jobs` row in a single transaction. URL/content-hash dedup at ingest. |
| `GET` | `/jobs` | Paginated canonical list; filters `source_site`, `dismissed`, `scan_run_id`, date/scrape ranges, `limit`, `offset`. Response omits the 031 filter columns. |
| `GET` | `/jobs/{job_id}` | Canonical posting detail |
| `PUT` | `/jobs/{job_id}` | Partial update (e.g. `dismissed`, `matched`) |

### Config (`/config`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/config` | Read merged search config from JSON file |
| `PUT` | `/config` | Partial update (unset fields preserved). No `dedup_mode` / `llm` — those were removed. |

### Extension (`/extension`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/extension/state` | Extension counters and flags |
| `POST` | `/extension/trigger-scan` / `trigger-stop` | Request a scan (body may carry `website`, `scan_all*`) / request stop |
| `GET` | `/extension/pending-scan` / `pending-stop` / `pending` | Atomic read-and-clear of pending flags |
| `POST` | `/extension/run-log/start` | Start a run log (body may carry `scan_all*`) |
| `PUT` | `/extension/run-log/{id}` | Update run log; `broadcast_run_log_update` notifies `/ws/run-log` clients |
| `GET` | `/extension/run-log` | List run logs (`?limit=`) |
| `POST` | `/extension/run-log/{id}/debug` | Append `DebugLogAppend.events` to the run's `debug_log` (ring buffer) |
| `POST` | `/extension/session-error` | Attach a session error to the latest running log |

### WebSocket (`/ws/run-log`)

Connect with **subprotocols** `["bearer", "<token>"]` (same token as REST). The server pushes JSON
run-log payloads (same shape as `GET /extension/run-log` items, `debug_log` omitted) when
`PUT /extension/run-log/{id}` broadcasts.

### Auto-scrape (`/admin/auto-scrape`)

Bearer-authenticated admin API for the Chrome extension auto-scrape orchestrator: singleton
`auto_scrape_state` (JSON `state`: `enabled`, `cycle_phase` ∈ `idle`/`scrape_running`/
`postscrape_running`, probes, counters, `next_cycle_at`, `config_change_pending`),
`auto_scrape_config` (`enabled_sites`, `keywords`, limits), `auto_scrape_cycles`, and
`site_session_states`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/state` | Read / full-replace the state document |
| `GET` / `PUT` | `/config` (+ `POST /config/reset`, `GET /config/limits`) | Orchestrator config; `PUT` returns warnings over soft scan limits |
| `POST` | `/cycle` · `PUT` `/cycle/{id}` · `GET` `/cycles` · `POST` `/cleanup-orphan-cycles` | Cycle CRUD + cleanup |
| `POST` | `/enable` · `/pause` · `/shutdown` · `/test-cycle` · `/restart-cycle` · `/reset-counters` | Lifecycle controls (`enable`/`pause`/`shutdown` clear `config_change_pending`) |
| `POST` | `/heartbeat` · `GET` `/instances` | SW heartbeat + ~5-min in-memory instance tracker |
| `GET` | `/sessions` · `PUT` `/sessions/{site}` · `POST` `/reset-session/{site}` | Per-site probe / failure state |
| `POST` | `/wake-orchestrator` | Redis publish to nudge the post-scrape worker (best-effort) |

Implementation: `routers/auto_scrape.py`; the post-scrape worker is
`auto_scrape/post_scrape_orchestrator.py` (gated on `REDIS_URL`).

### Admin maintenance (`/admin`)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/cleanup-invalid-entries` | Marks briefly-stale `extension_run_logs` failed. Legacy dedup/job-row response keys remain in the payload, hardcoded to 0 — that work is retired. Bearer auth. |

### CORS

`main.py` allows `chrome-extension://…` and `http://localhost|127.0.0.1:any-port` via regex, so the
Vite dev server and the extension can call the API from the browser.

## Smoke tests / verification

From the repo root with Compose running:

```bash
curl http://localhost:8000/health
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_matched_claim.py
docker compose exec backend python smoke_test_auto_expiration.py
docker compose exec backend python smoke_test_scraped_jobs_merge.py
docker compose exec backend python unit_test_scraped_job_projection.py
```

(`WORKDIR` in the container is `/app`; `scripts/` sits beside `main.py`.)

## Logging

On import, `main.py` calls `logging.basicConfig(level=INFO, stream=sys.stdout, force=True)` so INFO
records from modules such as `routers.jobs` (ingest diagnostics) show in `docker compose logs
backend`. Uvicorn keeps its own access/server lines; everything else uses the configured
`%(asctime)s %(levelname)s %(name)s: %(message)s` pattern.

## Development notes

- **Per-source ingest + canonical projection (`routers/jobs.py`):** When `POST /jobs/ingest` carries
  `source_raw` + `scan_run_id`, rows go to `linkedin_jobs` / `indeed_jobs` / `glassdoor_jobs` via
  `build_linkedin_params` / `build_indeed_params` / `build_glassdoor_params`, then a canonical
  `scraped_jobs` row is projected from the same params by `core/scraped_job_projection.py` and
  written in the **same transaction**. Helpers normalize types before the raw SQL inserts because
  asyncpg does not coerce across mismatched column kinds (`_to_str_or_none` for numbers landing in
  `VARCHAR`/`TEXT`; `_to_int_or_none` for numeric strings landing in `INTEGER`; leave `NUMERIC`
  salary fields unwrapped). Column lists `LINKEDIN_COLS` / `INDEED_COLS` / `GLASSDOOR_COLS` and
  `CANONICAL_COLS` must stay aligned with the live schema.
- **Projection is pure:** `core/scraped_job_projection.py` has no ORM/HTTP/IO and is covered by
  `unit_test_scraped_job_projection.py`. NULL on the five 031 filter columns always means "this site
  did not say" — never "no", never a default. Unmappable source tokens log a `projection_*` warning.
- **The `matched` flag:** one-way `false → true`, kept in sync between each `scraped_jobs` row and
  its per-source origin. As of feature 010 nothing auto-claims — a post-scrape cycle leaves rows
  `matched = false` and records `match_results = {"claim_summary": null, "claim_retired": true}`.
- **Startup:** run logs stuck in `running` > 2h are marked `failed`; stale auto-scrape cycles are
  marked failed and `cycle_phase` reset to `idle`.
- **Production:** replace `core/auth.py` dev-token logic with real authentication before exposing
  the API publicly.
```