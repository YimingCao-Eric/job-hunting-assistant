# Job Hunting Assistant

Chrome extension + **FastAPI** backend + **React (Vite)** web UI for job search scraping. The extension targets **LinkedIn** (Voyager API) and **Indeed Canada** (`ca.indeed.com`); jobs are stored in PostgreSQL via the REST API. The extension’s `background/scan_manual.js` reads **`config.website`** from `GET /config` to choose the LinkedIn or Indeed search URL builder.

## Architecture

```
extension/          Chrome Extension (Manifest V3) — see extension/README.md
  ├── background/       Service worker modules (importScripts)
  ├── content/          Shared + LinkedIn + Indeed content scripts
  └── popup/            Settings UI and scan control

frontend/           Vite + React, plain CSS modules, api.js central client (default port 5173)
  └── Pages: / → ConfigPage, /jobs → JobsPage

backend/            FastAPI + SQLAlchemy async + PostgreSQL
  ├── routers/          /jobs, /config, /extension endpoints
  ├── models/           SQLAlchemy ORM (scraped_jobs, extension_state, run_logs)
  ├── schemas/          Pydantic v2 request/response models
  └── core/             Config, database, auth

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

Opens the app at `http://localhost:5173` — **Config** (`/`) and **Jobs** (`/jobs`). Use the Config page for `website`, Indeed fields, and `single_page_mode` (the extension popup only syncs a subset of LinkedIn-oriented fields).

### 7. Scan

Click **Scan Now** in the popup (or trigger a scan from the web UI). The extension will:
1. Open a **LinkedIn** or **Indeed** search tab according to `config.website`
2. Scrape job cards and fetch full descriptions (Voyager on LinkedIn, `viewjob` HTML on Indeed)
3. Send each job to the backend for deduplication and storage
4. Show live progress in the popup

## Smoke Tests

Run the automated smoke test suite against a running backend:

```bash
docker compose exec backend python smoke_test.py
```

This verifies: health check, config read, job ingest + dedup, run log lifecycle, and extension state.

## Config Reference

Search parameters live in `config.json` (path set by `CONFIG_PATH` in Docker). Editable via **`PUT /config`**, the **web Config page** (`/`), or a subset of fields from the **extension popup**.

| Field | Description |
|---|---|
| `website` | `"linkedin"` or `"indeed"` — which site the extension opens when scanning |
| `keyword` | Job search keyword (LinkedIn default search) |
| `location` | Location filter (LinkedIn default search) |
| `f_tpr_bound` | Max look-back hours for LinkedIn time filter (`f_TPR` computation) |
| `f_experience` | LinkedIn experience codes (e.g. `"2,3,4"`) |
| `f_job_type` | LinkedIn job type codes |
| `f_remote` | LinkedIn remote / workplace codes |
| `salary_min` | Minimum salary (LinkedIn `f_SB2`); `0` = no filter |
| `scan_delay` | `fast` / `normal` / `slow` — delay between cards |
| `single_page_mode` | If true, scan stops after the first results page (testing) |
| `indeed_keyword` | Indeed query `q` |
| `indeed_location` | Indeed query `l` |
| `indeed_fromage` | Indeed days filter (`fromage`) |
| `indeed_remotejob` | Remote-only filter |
| `indeed_jt` | Indeed job type (`jt`) |
| `indeed_sort` | Indeed sort (`date` / `relevance`) |
| `indeed_radius` | Radius (km) |
| `indeed_explvl` | Experience level (`ENTRY_LEVEL`, etc.) |
| `indeed_lang` | Language (`en`, `fr`, …) |

**Local defaults (development):** backend `http://localhost:8000`, API auth header `Authorization: Bearer dev-token`.

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Async PostgreSQL connection string |
| `CONFIG_PATH` | Path to `config.json` inside the container |
| `EXTENSION_ORIGIN_REGEX` | Regex to validate Chrome extension origin header |

## API Endpoints

All endpoints except `/health` expect **`Authorization: Bearer <token>`** (e.g. `dev-token` locally).

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check with DB ping (no auth) |
| `GET` | `/config` | Read search config |
| `PUT` | `/config` | Merge-update search config |
| `POST` | `/jobs/ingest` | Ingest a scraped job (dedup by URL + content hash) |
| `GET` | `/jobs` | List jobs (paginated / filterable). Optional **`?website=`** filters to that site (`linkedin`, `indeed`, …). |
| `GET` | `/jobs/{id}` | Job detail (includes `voyager_raw` where present) |
| `PUT` | `/jobs/{id}` | Update job (e.g. dismiss) |
| `GET` | `/jobs/skipped` | Skipped / filtered rows for a run (`scan_run_id` required) |
| `GET` | `/extension/state` | Extension state row |
| `PUT` | `/extension/state` | Update extension state |
| `POST` | `/extension/run-log/start` | Start a scan run |
| `PUT` | `/extension/run-log/{id}` | Complete or fail a run |
| `GET` | `/extension/run-log` | List runs; **`?limit=1`** returns the most recent |
| `POST` | `/extension/trigger-scan` | Sets “scan requested” for the extension poller. Optional JSON body `{"website": "linkedin" \| "indeed" \| null}` — stored in `extension_state.scan_website` and returned once from **`GET /extension/pending-scan`** (then cleared). |
| `POST` | `/extension/trigger-stop` | Sets stop flag for the extension poller |
| `GET` | `/extension/pending-scan` | Atomically read-and-clear scan request. Response `{ "pending": bool, "website": string \| null }` — `website` is the `trigger-scan` override, cleared after a successful `pending: true` read. |
| `GET` | `/extension/pending-stop` | Atomically read-and-clear stop request |
| `POST` | `/extension/session-error` | Report session/session error from extension |

### `GET /jobs` response shape

Each job includes: `id`, `website`, `job_title`, `company`, `location`, `job_description`, `job_url`, `apply_url`, `easy_apply`, `post_datetime`, `search_filters`, `raw_description_hash`, `ingest_source`, `scan_run_id`, `original_job_id` (set when a **content-duplicate** row is inserted — points at the earlier job with the same description hash; `null` for URL duplicates and new unique rows), `dismissed`, `skip_reason`, `created_at`, `updated_at`, `match_level`, `match_reason`, `fit_score`, `req_coverage`, `confidence`, `skipped_reason`, `required_skills`, `nice_to_have_skills`, `critical_skills`, `extracted_yoe`, `salary_min_extracted`, `salary_max_extracted`, `remote_type`, `seniority_level`, `job_type`, `jd_incomplete`, `matched_at`.

### `GET /extension/run-log` list item shape

`id`, `strategy`, `status`, `started_at`, `completed_at`, `pages_scanned`, `scraped`, `new_jobs`, `existing`, `stale_skipped`, `jd_failed`, `early_stop`, `session_error`, `search_keyword`, `search_location`, `search_filters`, `error_message`, `created_at`.

## Database notes

- **`extension_state`** columns: `id`, `current_search_date`, `current_page`, `search_exhausted`, `consecutive_empty_runs`, `last_search_time`, `today_searches`, `scan_requested`, `stop_requested`, `scan_website` (optional `POST /trigger-scan` override, consumed by `GET /pending-scan`), `updated_at`.
- **`scraped_jobs`**: optional self-referential **`original_job_id`** → `scraped_jobs.id` for content-duplicate rows (same JD hash, different URL).

## Development

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
