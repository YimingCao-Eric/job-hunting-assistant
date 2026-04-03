# Job Hunting Assistant — Backend

FastAPI service that stores scraped jobs in **PostgreSQL**, serves **JSON search config** from a file, coordinates the **Chrome extension** via extension state and run logs, and runs the **dedup** pipeline (Pass 0 / 1 / 2) on demand or after scans when configured.

For full-stack setup (Docker, extension, web UI), see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| API | [FastAPI](https://fastapi.tiangolo.com/) |
| DB | PostgreSQL 16, [SQLAlchemy 2](https://docs.sqlalchemy.org/) async, [asyncpg](https://magicstack.github.io/asyncpg/) |
| Migrations | [Alembic](https://alembic.sqlalchemy.org/) (runs `alembic upgrade head` on app startup) |
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
│   └── service.py       run_dedup, Pass 0/1/2, gate metrics, reports
├── models/              SQLAlchemy models (scraped jobs, extension state, run logs, dedup reports)
├── schemas/             Pydantic request/response models
├── routers/
│   ├── jobs.py          POST /jobs/ingest, GET/PUT /jobs, skipped, dedup triggers
│   ├── config.py        GET/PUT /config
│   ├── extension.py      State, scan/stop triggers, run logs, session errors, sync-dedup on run complete
│   └── dedup.py         GET dedup reports, POST /jobs/dedup/reset
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
| `GET` | `/jobs` | Paginated list; filters include `website`, `dismissed`, **`dedup_status`**, date filters, etc. |
| `GET` | `/jobs/skipped` | Rows skipped in a run (`scan_run_id` required) |
| `GET` | `/jobs/{job_id}` | Job detail |
| `PUT` | `/jobs/{job_id}` | Partial update (`JobUpdate`) |
| `POST` | `/jobs/dedup` | Run **`run_dedup()`** (manual) |
| `POST` | `/jobs/dedup/reset` | Clear dedup service skip reasons for eligible rows |

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
- **Production:** Replace `core/auth.py` dev-token logic with real authentication before exposing the API publicly.
