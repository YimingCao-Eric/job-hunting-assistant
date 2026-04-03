# Job Hunting Assistant

Chrome extension + **FastAPI** backend + **React (Vite)** web UI for job search scraping. The extension targets **LinkedIn** (Voyager API), **Indeed Canada** (`ca.indeed.com`), and **Glassdoor Canada**; jobs are stored in PostgreSQL via the REST API. The extension’s `background/scan_manual.js` reads **`GET /config`** to choose the site and URL builders.

## Architecture

```
extension/          Chrome Extension (Manifest V3) — see extension/README.md
  ├── background/       Service worker modules (importScripts)
  ├── content/          Shared + LinkedIn + Indeed + Glassdoor content scripts
  └── popup/            Settings UI and scan control

frontend/           Vite + React, CSS modules, api.js central client (default port 5173)
  └── Routes: / → Config, /jobs → Jobs, /logs → Logs, /dedup → Dedup

backend/            FastAPI + SQLAlchemy async + PostgreSQL
  ├── routers/          /jobs, /config, /extension, /dedup
  ├── dedup/            Pass 0/1/2 pipeline, dedup reports
  ├── models/           SQLAlchemy ORM (scraped_jobs, extension_state, extension_run_logs, …)
  ├── schemas/          Pydantic v2 request/response models
  └── core/             Config file, database, auth

docker-compose.yml  Runs backend + Postgres 16
```

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

### 2. Start the backend

```bash
docker compose up --build -d
```

This launches:

- **FastAPI** on `http://localhost:8000`
- **PostgreSQL 16** with database `jha`

Migrations run automatically on startup.

### 3. Verify

```bash
curl http://localhost:8000/health
# → {"status":"ok","db":"ok"}
```

### 4. Load the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder

### 5. Configure the extension

Open the extension popup and set:

- **Backend URL**: `http://localhost:8000`
- **Auth Token**: `dev-token`
- Adjust search keyword, location, and filters as needed
- Click **Save Settings**

### 6. Web UI (optional)

```bash
cd frontend
npm install
npm run dev
```

Opens the app at `http://localhost:5173` — **Config** (`/`), **Jobs** (`/jobs`), **Logs** (`/logs`), **Dedup** (`/dedup`). Use the Config page for `website`, Indeed/Glassdoor fields, dedup mode, and filters (the extension popup only syncs a subset of fields).

### 7. Scan

Click **Scan Now** in the popup (or trigger a scan from the web UI **Jobs** page). The extension will:

1. Open a **LinkedIn**, **Indeed**, or **Glassdoor** search tab according to the trigger / config
2. Scrape job cards and fetch full descriptions (Voyager on LinkedIn, GraphQL/HTML on Indeed, listing HTML on Glassdoor)
3. Send each job to the backend (`POST /jobs/ingest`) for URL/hash dedup and storage
4. Show live progress in the popup

**Scan All** (Jobs page) runs LinkedIn → Indeed → Glassdoor in series; each leg sends `scan_all` metadata to the backend so **sync dedup** (if enabled) runs once after the **last** site finishes, not after each leg.

## Smoke Tests

Run the automated smoke test suite against a running backend:

```bash
docker compose exec backend python smoke_test.py
```

This verifies: health check, config read, job ingest, run log lifecycle, and extension state.

## Config Reference

Search parameters live in `config.json` (path set by `CONFIG_PATH` in Docker). Editable via **`PUT /config`**, the **web Config page** (`/`), or a subset of fields from the **extension popup**.

| Field | Description |
| --- | --- |
| `website` | `"linkedin"`, `"indeed"`, or `"glassdoor"` — default site when the extension opens a scan without a trigger override |
| `dedup_mode` | `"manual"` — dedup only when you run it from the **Dedup** page; `"sync"` — after each **completed** scan run log, the backend runs full dedup in a background task (Scan All: once after the final site only) |
| `keyword` | Job search keyword (LinkedIn default search) |
| `location` | Location filter (LinkedIn default search) |
| `f_tpr_bound` | Max look-back hours for LinkedIn time filter (`f_TPR` computation) |
| `f_experience` | LinkedIn experience codes (e.g. `"2,3,4"`) |
| `f_job_type` | LinkedIn job type codes |
| `f_remote` | LinkedIn remote / workplace codes |
| `salary_min` | Minimum salary (LinkedIn `f_SB2`); `0` = no filter |
| `single_page_mode` | If true, scan stops after the first results page (testing) |
| `indeed_*` | Indeed query, location, filters — see Config page |
| `glassdoor` | Nested keyword, location, filters for Glassdoor |

**Local defaults (development):** backend `http://localhost:8000`, API auth header `Authorization: Bearer dev-token`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Async PostgreSQL connection string |
| `CONFIG_PATH` | Path to `config.json` inside the container |
| `EXTENSION_ORIGIN_REGEX` | Regex to validate Chrome extension origin header |

## API Endpoints

All endpoints except `/health` expect **`Authorization: Bearer <token>`** (e.g. `dev-token` locally).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check with DB ping (no auth) |
| `GET` | `/config` | Read search config |
| `PUT` | `/config` | Merge-update search config |
| `POST` | `/jobs/ingest` | Ingest a scraped job (URL + content-hash dedup at ingest; no per-row Pass 0/1 here) |
| `GET` | `/jobs` | List jobs. Query params include `website`, `dismissed`, `dedup_status` (`passed` / `removed` / `all`), dates, pagination. |
| `GET` | `/jobs/{id}` | Job detail |
| `PUT` | `/jobs/{id}` | Update job (e.g. dismiss) |
| `POST` | `/jobs/dedup` | Run full dedup pipeline (manual) |
| `POST` | `/jobs/dedup/reset` | Clear dedup-assigned `skip_reason` for whitelisted reasons (see backend) |
| `GET` | `/jobs/skipped` | Skipped rows for a run (`scan_run_id` required) |
| `GET` | `/dedup/reports` | List dedup reports |
| `GET` | `/dedup/reports/{id}` | Single dedup report |
| `GET` | `/extension/state` | Extension state row |
| `PUT` | `/extension/state` | Update extension state |
| `POST` | `/extension/run-log/start` | Start a scan run (body may include `scan_all`, `scan_all_position`, `scan_all_total`) |
| `PUT` | `/extension/run-log/{id}` | Complete or fail a run. When status becomes **`completed`** and **`dedup_mode`** is **`sync`**, the backend may enqueue **dedup** (own session, after response). |
| `GET` | `/extension/run-log` | List runs; **`?limit=N`** for recent runs |
| `POST` | `/extension/trigger-scan` | Sets scan requested. Body may include `website`, and for Scan All: `scan_all`, `scan_all_position`, `scan_all_total`. Stored until consumed by **`GET /extension/pending-scan`**. |
| `POST` | `/extension/trigger-stop` | Sets stop flag for the extension poller |
| `GET` | `/extension/pending-scan` | Atomically read-and-clear scan request. Returns `pending`, `website`, `scan_all`, `scan_all_position`, `scan_all_total`. |
| `GET` | `/extension/pending-stop` | Atomically read-and-clear stop request |
| `POST` | `/extension/session-error` | Report session error from extension |

### `GET /jobs` response shape (high level)

Each job includes identifiers, `website`, title, company, location, URLs, `skip_reason`, **`dedup_similarity_score`**, **`dedup_original_job_id`** (when set by dedup), `original_job_id` (ingest-time content duplicate), matching pipeline fields, timestamps, etc.

### `GET /extension/run-log` list item shape

Includes run metadata, counters, `search_filters`, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** (when present), `errors`, `created_at`, etc.

## Database notes

- **`extension_state`**: includes `scan_requested`, `stop_requested`, `scan_website`, and pending **Scan All** fields (`scan_all`, `scan_all_position`, `scan_all_total`) cleared when **`GET /pending-scan`** consumes a request.
- **`extension_run_logs`**: stores per-run **`scan_all`** metadata so the backend knows whether to run **sync dedup** only on the last leg of Scan All.
- **`scraped_jobs`**: `original_job_id` for ingest-time content duplicate; **`dedup_original_job_id`** for dedup “kept” row when removed as duplicate; optional **`dedup_similarity_score`** for cosine matches.

## Development

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
