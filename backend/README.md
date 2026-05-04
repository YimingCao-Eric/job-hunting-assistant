# Job Hunting Assistant — Backend

FastAPI service that stores scraped jobs in **PostgreSQL**, serves **JSON search config** from a file, coordinates the **Chrome extension** via extension state and run logs, runs the **dedup** pipeline (Pass 0 / 1 / 2) on demand or after scans when configured, and runs the **matching** pipeline (CPU/LLM job-description extraction, gates, CPU pre-score, optional LLM re-score) with persisted **match reports**.

For full-stack setup (Docker, extension, web UI), see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| API | [FastAPI](https://fastapi.tiangolo.com/) |
| DB | PostgreSQL 16, [SQLAlchemy 2](https://docs.sqlalchemy.org/) async, [asyncpg](https://magicstack.github.io/asyncpg/) |
| Migrations | [Alembic](https://alembic.sqlalchemy.org/) (runs `alembic upgrade head` on app startup) |
| Dedup ML | [langdetect](https://pypi.org/project/langdetect/), [scikit-learn](https://scikit-learn.org/) TF-IDF + cosine (Pass 2 fuzzy) |
| Matching | Rule-based + optional LLM JD extraction (`matching/`), hard gates, CPU pre-score, optional LLM re-score (Step D); `POST /jobs/match` queues work via **`asyncio.create_task`** (detached from request lifecycle) |
| Auth | Single shared bearer token (`Authorization: Bearer dev-token` in development) |

## Layout

```
backend/
├── main.py              FastAPI app, CORS, /health, lifespan (migrations, Redis subscriber, auto-scrape cycle cleanup, scheduler); **`logging.basicConfig`** on stdout at **INFO** so router/app logs show in `docker compose logs backend`
├── core/
│   ├── auto_scrape_lifecycle.py  Startup: mark stale auto-scrape cycles failed; reset **`auto_scrape_state.cycle_phase`** to **`idle`** when rows are cleaned
│   ├── auto_scrape_validation.py  Orchestrator config limits + validate()
│   ├── config.py        Pydantic settings (env: DATABASE_URL, CONFIG_PATH, **`debug_log_ring_size`**, …)
│   ├── database.py      Async engine, AsyncSessionLocal, get_db, migration runner
│   ├── trace.py         Context-scoped pipeline **`debug_log`** buffer, **`JhaTrace.emit`**, stdlib log bridge, LLM trace helper
│   ├── dedup_task_cleanup.py  Startup: mark stale **`dedup_tasks`** rows failed
│   ├── config_file.py   read/write config.json
│   └── auth.py          Bearer token check
├── dedup/
│   └── service.py       run_dedup, Pass 0/1/2, hash + cosine, _resolve_chains, DB chain repair helper
├── matching/            pipeline.py (Button stages), extractor, gates, scorer, skill alias JSON + persist
├── profile/             resume PDF extract, parser, profile service
├── models/              SQLAlchemy models (scraped jobs, job reports, match reports, skill candidates, extension state, **`dedup_tasks`**, …)
├── schemas/             Pydantic request/response models (incl. `debug_log` append payload)
├── routers/
│   ├── jobs.py          POST /jobs/ingest, GET/PUT /jobs (list + detail include `has_report` for pending issue reports), skipped, dedup triggers
│   ├── job_reports.py   POST /jobs/{id}/report; GET /jobs/reports, /jobs/reports/stats; PUT /jobs/reports/{id}/action
│   ├── matching.py      POST /jobs/match (+ gates, score, reset, undo, dismiss); GET /match/status, /match/reports, /match/logs; POST /match/reports/{id}/debug
│   ├── profile.py       GET/PUT /profile, upload/parse resume, extracted block
│   ├── skills.py        Skill candidate review + refresh aliases
│   ├── config.py        GET/PUT /config
│   ├── extension.py      State, scan/stop triggers, run logs, session errors, sync-dedup on run complete, **`broadcast_run_log_update`**
│   ├── auto_scrape.py   **`/admin/auto-scrape`** — state, config, cycles, sessions, enable/pause/shutdown, heartbeat, instances, wake-orchestrator, …
│   ├── run_log_ws.py    **`WebSocket /ws/run-log`** — fan-out run-log updates (`bearer` subprotocol auth)
│   └── dedup.py         GET dedup reports; POST /dedup/reports/{id}/debug; POST /jobs/dedup, /reset, /resolve-chains
├── auto_scrape/         **`post_scrape_orchestrator`** — optional Redis subscriber + post-scrape cycle claims (extension also uses **APScheduler** in `main.py` when configured)
├── alembic.ini
├── requirements.txt
├── Dockerfile
└── smoke_test.py        HTTP smoke tests (run against a live API)
```

## Environment

Variables are read from a `.env` file (see [`.env.example`](../.env.example) at the repo root).

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Async SQLAlchemy URL, e.g. `postgresql+asyncpg://user:pass@host:5432/db` |
| `CONFIG_PATH` | Path to `config.json` (default `/app/config.json` in Docker) |
| `EXTENSION_ORIGIN_REGEX` | Optional; reserved for stricter extension-origin checks |
| `OPENAI_API_KEY` | Optional; required when running LLM extraction/gates or **`llm_score`** if `llm` is enabled (see repo root `.env.example`) |
| `REDIS_URL` | Optional; when set, enables the post-scrape **`wake-orchestrator`** subscriber (`auto_scrape/post_scrape_orchestrator.py`). Compose can run a Redis service when configured in `.env` |
| `DEBUG_LOG_RING_SIZE` | Optional; max events per run **`debug_log`** ring buffer (default **10000**; see `core/config.py`) |

When using **Docker Compose** from the repo root, `DATABASE_URL` typically points at the `postgres` service hostname.

## Run locally (Docker — recommended)

From the **repository root**:

```bash
cp .env.example .env   # adjust if needed
docker compose up --build -d
```

The API listens on **http://localhost:8000**. Migrations apply on startup.

```bash
curl http://localhost:8000/health
# {"status":"ok","db":"ok"}
```

## Run locally (without Docker)

1. Create a PostgreSQL database and set `DATABASE_URL` in `backend/.env` (or export it).
2. Install dependencies and apply migrations:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
alembic upgrade head
```

3. Ensure `CONFIG_PATH` points to a writable `config.json` (or copy the repo root `config.json`).

4. Start Uvicorn:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## API overview

All JSON endpoints (except `/health`) expect:

```http
Authorization: Bearer dev-token
```

### `GET /health`

No auth. Returns `{ "status": "ok", "db": "ok" | "error" }`.

### Jobs (`/jobs`)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/jobs/ingest` | Ingest a job (URL uniqueness, content-hash duplicate handling). Does **not** run Pass 0/1 per row; **`dedup_mode`** does not affect ingest. |
| `GET` | `/jobs` | Paginated list; filters include `website`, `dismissed`, **`dedup_status`**, date filters, etc. Each row includes **`has_report`** if a **pending** **`job_reports`** row exists for that job. |
| `GET` | `/jobs/skipped` | Rows skipped in a run (`scan_run_id` required) |
| `GET` | `/jobs/{job_id}` | Job detail (includes **`has_report`**; same pending-report rule as list) |
| `PUT` | `/jobs/{job_id}` | Partial update (`JobUpdate`) |
| `POST` | `/jobs/{job_id}/report` | Create or upsert a **pending** issue report (`report_type`, `detail`). Does not modify **`scraped_jobs`**. `wrong_gate` only when the job has **`match_skip_reason`** or **`removal_stage`** (else **422**). |
| `GET` | `/jobs/reports` | List issue reports: query `status` (`pending` / `actioned` / `dismissed` / `all`), optional `report_type`, `limit`, `offset`. |
| `GET` | `/jobs/reports/stats` | Pending counts, pending by type, total rows. |
| `PUT` | `/jobs/reports/{report_id}/action` | e.g. **`{ "action": "dismiss" }`** — sets status and **`actioned_at`**. |
| `POST` | `/jobs/dedup` | Run **`run_dedup()`** (manual) |
| `POST` | `/jobs/dedup/reset` | Clear dedup service skip reasons for eligible rows |
| `POST` | `/jobs/dedup/resolve-chains` | Repair rows where **`dedup_original_job_id`** points at another removed job; walks to a passed job. Idempotent. |

### Matching (`/jobs/match` and `/match/*`)

Matching stages write into **`scraped_jobs`** (extraction fields, `match_skip_reason`, `match_level`, etc.) and append rows to **`match_reports`**.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/jobs/match` | **Queues** a run (**`asyncio.create_task`**, held in a module-level map so it is not GC’d and is not cancelled when the HTTP client disconnects). Body JSON optional: **`mode`**: `cpu_only` (CPU extraction + language + hard gates), `llm_extraction_gates` (LLM extraction + gates; requires **`llm: true`** in config), `cpu_score` (CPU pre-score only), `llm_score` (LLM re-score / Step D; requires **`llm: true`** and **`OPENAI_API_KEY`**), or omit for legacy Step-B extraction on all passed dedup jobs. **Response:** `{ "status": "started", "mode": … }` — not a full `MatchReport`. The task opens **`AsyncSessionLocal()`** (never reuse the request DB session). Clients should poll **`GET /match/reports`** until a new report appears or check job rows. |
| `GET` | `/jobs/match/extracted-count` | Count passed dedup jobs with Step B complete (`matched_at` set) |
| `POST` | `/jobs/match/gates` | Run hard gates on extracted jobs with no `match_skip_reason` yet |
| `POST` | `/jobs/match/score` | CPU pre-score for gate-ok, unscored jobs |
| `POST` | `/jobs/match/reset` | Clear matching fields on all jobs |
| `POST` | `/jobs/match/reset-gates` / `reset-score` | Clear gate or score fields only |
| `POST` | `/jobs/match/undo-button1` … `undo-button4` | Revert staged pipeline state (see router; **button4** clears LLM score fields) |
| `POST` | `/jobs/match/dismiss/{id}` / `undismiss/{id}` | Dismiss or restore a scored job |
| `GET` | `/match/reports` | List recent match reports (`matching_mode`: e.g. `cpu_work`, `llm_extraction_gates`, `cpu_score`, `llm_score`; optional **`debug_log`**) |
| `GET` | `/match/reports/{id}` | Single report |
| `POST` | `/match/reports/{id}/debug` | Append **`DebugLogAppend.events`** to **`debug_log`** (trimmed to **`settings.debug_log_ring_size`**) |
| `GET` | `/match/status` | **`{ "running": bool, "mode": str \| null }`** — live matching task for UI rehydration |
| `GET` | `/match/logs` | Tail of matching logger lines (debug UI; separate from persisted **`debug_log`**) |

Per-job CPU extraction failures set **`match_skip_reason`** to **`extraction_failed`** and **`removal_stage`** to **`cpu_work`** so one bad JD does not abort the whole run.

### Profile (`/profile`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/profile` | Read profile JSON from disk |
| `PUT` | `/profile` | Merge-update profile |
| `GET` | `/profile/extracted` | Resume-derived `_extracted` payload |
| `POST` | `/profile/upload-resume` | Multipart PDF upload → markdown extract |
| `POST` | `/profile/parse-resume` | Parse markdown into structured profile (LLM when enabled) |

### Skills (`/skills`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/skills/candidates` | List skill alias candidates |
| `GET` | `/skills/candidates/stats` | Aggregate stats |
| `PUT` | `/skills/candidates/{id}/approve` | Approve (optional canonical) |
| `PUT` | `/skills/candidates/{id}/merge` | Merge into target |
| `PUT` | `/skills/candidates/{id}/reject` | Reject |
| `POST` | `/skills/candidates/refresh-aliases` | Rebuild alias file from DB |

### Job issue reports (`/jobs/.../report`, `/jobs/reports`)

User-facing diagnostics for bad extraction or scoring. Persisted in **`job_reports`** (see Alembic migration). Not cleared by matching undo/reset endpoints. **`has_report`** on **`GET /jobs`** and **`GET /jobs/{id}`** is **true** only when at least one **pending** report exists for that job.

### Dedup (`/dedup` and job-scoped)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dedup/reports` | List dedup reports (optional **`debug_log`**) |
| `GET` | `/dedup/reports/{id}` | Single report |
| `POST` | `/dedup/reports/{id}/debug` | Append events to dedup **`debug_log`** (ring buffer) |

### Config (`/config`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/config` | Read merged search config from JSON file |
| `PUT` | `/config` | Partial update (unset fields preserved). Includes **`dedup_mode`**: `"manual"` \| `"sync"`. |

### WebSocket (`/ws/run-log`)

| Protocol | Path | Purpose |
| --- | --- | --- |
| `WebSocket` | `/ws/run-log` | Connect with **subprotocols** **`["bearer", "<token>"]`** (same token as **`Authorization`** on REST). Server accepts and pushes JSON run-log payloads (same shape as **`GET /extension/run-log`** items, **`debug_log`** omitted) when **`update_run_log`** broadcasts after **`PUT /extension/run-log/{id}`**. |

### Auto-scrape (`/admin/auto-scrape`)

Bearer-authenticated **admin** API for the Chrome extension **auto-scrape orchestrator**: singleton **`auto_scrape_state`** (JSON `state`: `enabled`, **`cycle_phase`** (`idle` \| `scrape_running` \| `postscrape_running`), probes, counters, `next_cycle_at`, **`config_change_pending`**, …), **`auto_scrape_config`** (`enabled_sites`, `keywords`, intervals, thresholds — consumed by the SW each cycle), **`auto_scrape_cycles`** rows, and **`site_session_states`** (per-site `last_probe_status`, `consecutive_failures`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/admin/auto-scrape/state` | Read / **full replace** state document |
| `GET` / `PUT` | `/admin/auto-scrape/config` | Orchestrator config; `PUT` returns warnings when over soft scan limits |
| `GET` | `/admin/auto-scrape/config/limits` | Field limits + derived caps (`max_keywords`, scans/cycle) |
| `POST` | `/admin/auto-scrape/config/reset` | Reset orchestrator config to defaults |
| `POST` | `/admin/auto-scrape/enable` / `pause` / `shutdown` / `test-cycle` | Control flags; **`enable`**, **`pause`**, and **`shutdown`** clear **`config_change_pending`**; **`shutdown`** sets `exit_requested` for graceful SW exit |
| `POST` | `/admin/auto-scrape/heartbeat` | Updates `last_sw_heartbeat_at`; optional body `extension_instance_id`; in-memory **`/instances`** tracker |
| `GET` | `/admin/auto-scrape/instances` | Instance ids seen via heartbeat in the last ~5 minutes (process-local) |
| `GET` | `/admin/auto-scrape/cycles` | List cycles (`limit` query) |
| `POST` | `/admin/auto-scrape/cycle` | Create cycle row (extension) |
| `PUT` | `/admin/auto-scrape/cycle/{id}` | Update cycle (extension) |
| `GET` | `/admin/auto-scrape/sessions` | List **`site_session_states`** |
| `PUT` | `/admin/auto-scrape/sessions/{site}` | Set `last_probe_status` |
| `POST` | `/admin/auto-scrape/reset-session/{site}` | Reset failure counters / backoff for a site |
| `POST` | `/admin/auto-scrape/wake-orchestrator` | Redis publish to nudge post-scrape worker (best-effort) |

Implementation: **`routers/auto_scrape.py`**. Post-scrape pipeline steps may be simplified in some deployments; **`REDIS_URL`** enables the subscriber in **`auto_scrape/post_scrape_orchestrator.py`**.

### Extension (`/extension`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/extension/state` | Extension counters and flags |
| `POST` | `/extension/trigger-scan` | Request a scan; body may include `website`, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** (Scan All sequence). |
| `GET` | `/extension/pending-scan` | Consume pending scan; returns **`website`** and Scan All metadata |
| `POST` | `/extension/trigger-stop` | Request stop; marks running run logs failed |
| `GET` | `/extension/pending-stop` | Consume pending stop |
| `POST` | `/extension/run-log/start` | Start a run log; body may include **`scan_all`** fields |
| `PUT` | `/extension/run-log/{log_id}` | Update run log; **`broadcast_run_log_update`** notifies **`/ws/run-log`** clients. On transition to **`status: completed`**, if **`dedup_mode == sync`**, schedules **`run_dedup`** via **`asyncio.create_task`** (new DB session): creates a **`dedup_tasks`** row (heartbeat while running); single-site always; Scan All only when **`scan_all_position == scan_all_total`**. |
| `POST` | `/extension/run-log/{log_id}/debug` | Append **`DebugLogAppend.events`** to the run’s **`debug_log`** JSONB (ring buffer size **`settings.debug_log_ring_size`**, default **10k**). Extension content scripts batch-flush via the service worker. |
| `GET` | `/extension/run-log` | List run logs (each item may include **`debug_log`**) |
| `POST` | `/extension/session-error` | Attach session error to the latest running log |

### CORS

`main.py` allows `chrome-extension://…` and `http://localhost|127.0.0.1:any-port` via regex, plus fixed origins for `localhost:3000` and `localhost:8000`, so the Vite dev server and extension can call the API from the browser.

## Smoke tests

With the stack running:

```bash
docker compose exec backend python smoke_test.py
```

Or from `backend/` with `DATABASE_URL` and API reachable:

```bash
python smoke_test.py
```

## Logging

On import, **`main.py`** calls **`logging.basicConfig(..., level=INFO, stream=sys.stdout, force=True)`** so the root logger has a handler and **INFO** records from modules such as **`routers.jobs`** (ingest diagnostics) are visible in Docker and terminal output. Uvicorn’s own lines use its default formatting; everything else uses the configured `%(asctime)s %(levelname)s %(name)s: %(message)s` pattern.

Per-logger levels are also set near the top of **`main.py`** (e.g. **`routers.jobs`** at INFO, matching loggers at DEBUG) before **`basicConfig`** runs; child loggers propagate records to the configured root handler.

## Development notes

- **Scan debug trace:** `extension_run_logs.debug_log` is optional JSONB (`{ "events": [ … ] }`). The extension appends via **`POST /extension/run-log/{id}/debug`**; ring size is **`settings.debug_log_ring_size`** (default **10,000**), shared with dedup/match report append endpoints.
- **Pipeline debug trace:** `dedup_reports.debug_log` and `match_reports.debug_log` use the same `{ "events": [ … ] }` shape. Populated by **`core.trace`** during **`run_dedup`** and matching **`run_*`** pipelines (flush at end of run; optional crash stub row + flush on failure).
- **Startup:** Stale `extension_run_logs` rows stuck in `running` for more than 2 hours are marked `failed` on API boot; stale **`dedup_tasks`** in **`running`** are marked **`failed`** (**`dedup_task_cleanup`**).
- **Sync dedup:** After a completed scan, **`run_dedup`** is scheduled with **`asyncio.create_task`** (see **`routers/extension.py`**); the task opens **`AsyncSessionLocal`** and calls **`run_dedup(..., scan_run_id=log_id, trigger="post_scan")`**. Do not reuse the request `db` session in the task.
- **Matching (`POST /jobs/match`):** **`asyncio.create_task`** + module **`_BACKGROUND_TASKS`** map (mode label per task); **`GET /match/status`** exposes whether a run is still active. The worker uses **`AsyncSessionLocal`** and **`matching.pipeline`** (`run_cpu_work`, `run_llm_extraction_gates`, `run_cpu_score_pipeline`, `run_llm_score_pipeline`, or legacy Step B in the router). Prevents HTTP timeouts on large job sets; **`GET /match/reports`** reflects completion.
- **Pass 2 / chains:** Cosine compares surviving jobs to a corpus of **`skip_reason IS NULL`** rows (excluding hash-flagged ids and pass survivors from the “extra” pool). Jobs flagged by cosine in an earlier batch are excluded as similarity “originals” for later batches. After Pass 2, **`_resolve_chains`** flattens any remaining **`dedup_original_job_id`** pointers before bulk UPDATE. **`POST /jobs/dedup/resolve-chains`** fixes historic DB rows if pointers still chain through removed jobs.
- **Production:** Replace `core/auth.py` dev-token logic with real authentication before exposing the API publicly.
