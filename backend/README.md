# Job Hunting Assistant — Backend

FastAPI service that stores scraped jobs in **PostgreSQL**, serves **JSON search config** from a file, coordinates the **Chrome extension** via extension state and run logs, runs the **dedup** pipeline (Pass 0 / 1 / 2) on demand or after scans when configured, and runs the **matching** pipeline (CPU/LLM job-description extraction, gates, CPU pre-score) with persisted **match reports**.

For full-stack setup (Docker, extension, web UI), see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| API | [FastAPI](https://fastapi.tiangolo.com/) |
| DB | PostgreSQL 16, [SQLAlchemy 2](https://docs.sqlalchemy.org/) async, [asyncpg](https://magicstack.github.io/asyncpg/) |
| Migrations | [Alembic](https://alembic.sqlalchemy.org/) (runs `alembic upgrade head` on app startup) |
| Dedup ML | [langdetect](https://pypi.org/project/langdetect/), [scikit-learn](https://scikit-learn.org/) TF-IDF + cosine (Pass 2 fuzzy) |
| Matching | Rule-based + optional LLM JD extraction (`matching/`), hard gates, CPU pre-score; `POST /jobs/match` queues work asynchronously |
| Auth | Single shared bearer token (`Authorization: Bearer dev-token` in development) |

## Layout

```
backend/
├── main.py              FastAPI app, CORS, /health, router includes
├── core/
│   ├── config.py        Pydantic settings (env: DATABASE_URL, CONFIG_PATH, …)
│   ├── database.py      Async engine, AsyncSessionLocal, get_db, migration runner
│   ├── config_file.py   read/write config.json
│   └── auth.py          Bearer token check
├── dedup/
│   └── service.py       run_dedup, Pass 0/1/2, hash + cosine, _resolve_chains, DB chain repair helper
├── matching/            pipeline.py (Button stages), extractor, gates, scorer, skill alias JSON + persist
├── profile/             resume PDF extract, parser, profile service
├── models/              SQLAlchemy models (scraped jobs, job reports, match reports, skill candidates, extension state, …)
├── schemas/             Pydantic request/response models
├── routers/
│   ├── jobs.py          POST /jobs/ingest, GET/PUT /jobs (list + detail include `has_report` for pending issue reports), skipped, dedup triggers
│   ├── job_reports.py   POST /jobs/{id}/report; GET /jobs/reports, /jobs/reports/stats; PUT /jobs/reports/{id}/action
│   ├── matching.py      POST /jobs/match (+ gates, score, reset, undo, dismiss); GET /match/reports, /match/logs
│   ├── profile.py       GET/PUT /profile, upload/parse resume, extracted block
│   ├── skills.py        Skill candidate review + refresh aliases
│   ├── config.py        GET/PUT /config
│   ├── extension.py      State, scan/stop triggers, run logs, session errors, sync-dedup on run complete
│   └── dedup.py         GET dedup reports; POST /jobs/dedup, /reset, /resolve-chains
├── alembic/             Migration scripts
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
| `POST` | `/jobs/match` | **Queues** a run (FastAPI **`BackgroundTasks`**). Body JSON optional: **`mode`**: `cpu_only` (CPU extraction + language + hard gates), `llm_extraction_gates` (LLM extraction + gates; requires **`llm: true`** in config), `cpu_score` (CPU pre-score only), or omit for legacy Step-B extraction on all passed dedup jobs. **Response:** `{ "status": "started", "mode": … }` — not a full `MatchReport`. The task opens **`AsyncSessionLocal()`** (never reuse the request DB session). Clients should poll **`GET /match/reports`** until a new report appears or check job rows. |
| `GET` | `/jobs/match/extracted-count` | Count passed dedup jobs with Step B complete (`matched_at` set) |
| `POST` | `/jobs/match/gates` | Run hard gates on extracted jobs with no `match_skip_reason` yet |
| `POST` | `/jobs/match/score` | CPU pre-score for gate-ok, unscored jobs |
| `POST` | `/jobs/match/reset` | Clear matching fields on all jobs |
| `POST` | `/jobs/match/reset-gates` / `reset-score` | Clear gate or score fields only |
| `POST` | `/jobs/match/undo-button1` … `undo-button3` | Revert staged pipeline state (see router) |
| `POST` | `/jobs/match/dismiss/{id}` / `undismiss/{id}` | Dismiss or restore a scored job |
| `GET` | `/match/reports` | List recent match reports (`matching_mode`: e.g. `cpu_work`, `llm_extraction_gates`, `cpu_score`) |
| `GET` | `/match/reports/{id}` | Single report |
| `GET` | `/match/logs` | Tail of matching logger lines (debug UI) |

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
| `GET` | `/dedup/reports` | List dedup reports |
| `GET` | `/dedup/reports/{id}` | Single report |

### Config (`/config`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/config` | Read merged search config from JSON file |
| `PUT` | `/config` | Partial update (unset fields preserved). Includes **`dedup_mode`**: `"manual"` \| `"sync"`. |

### Extension (`/extension`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/extension/state` | Extension counters and flags |
| `POST` | `/extension/trigger-scan` | Request a scan; body may include `website`, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** (Scan All sequence). |
| `GET` | `/extension/pending-scan` | Consume pending scan; returns **`website`** and Scan All metadata |
| `POST` | `/extension/trigger-stop` | Request stop; marks running run logs failed |
| `GET` | `/extension/pending-stop` | Consume pending stop |
| `POST` | `/extension/run-log/start` | Start a run log; body may include **`scan_all`** fields |
| `PUT` | `/extension/run-log/{log_id}` | Update run log. On transition to **`status: completed`**, if **`dedup_mode == sync`**, schedules **`run_dedup`** in a **BackgroundTask** (new DB session): single-site always; Scan All only when **`scan_all_position == scan_all_total`**. |
| `GET` | `/extension/run-log` | List run logs |
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

## Development notes

- **Startup:** Stale `extension_run_logs` rows stuck in `running` for more than 2 hours are marked `failed` on API boot.
- **Sync dedup:** Implemented with FastAPI **`BackgroundTasks`**; the task opens **`AsyncSessionLocal`** and calls **`run_dedup(..., scan_run_id=log_id, trigger="post_scan")`**. Do not reuse the request `db` session in the task.
- **Matching (`POST /jobs/match`):** Same pattern as sync dedup: enqueue a background task that uses **`AsyncSessionLocal`** and **`matching.pipeline`** (`run_cpu_work`, `run_llm_extraction_gates`, `run_cpu_score_pipeline`, or legacy Step B in the router). Prevents HTTP timeouts on large job sets; **`GET /match/reports`** reflects completion.
- **Pass 2 / chains:** Cosine compares surviving jobs to a corpus of **`skip_reason IS NULL`** rows (excluding hash-flagged ids and pass survivors from the “extra” pool). Jobs flagged by cosine in an earlier batch are excluded as similarity “originals” for later batches. After Pass 2, **`_resolve_chains`** flattens any remaining **`dedup_original_job_id`** pointers before bulk UPDATE. **`POST /jobs/dedup/resolve-chains`** fixes historic DB rows if pointers still chain through removed jobs.
- **Production:** Replace `core/auth.py` dev-token logic with real authentication before exposing the API publicly.
