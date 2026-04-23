# Job Hunting Assistant

Chrome extension + **FastAPI** backend + **React (Vite)** web UI for job search scraping. The extension targets **LinkedIn** (Voyager API), **Indeed Canada** (`ca.indeed.com`), and **Glassdoor Canada**; jobs are stored in PostgreSQL via the REST API. The extension’s `background/scan_manual.js` reads **`GET /config`** to choose the site and URL builders.

## Architecture

```
extension/          Chrome Extension (Manifest V3) — see extension/README.md
  ├── background/       Service worker modules (importScripts)
  ├── content/          Shared + LinkedIn + Indeed + Glassdoor content scripts
  └── popup/            Settings UI and scan control

frontend/           Vite + React, CSS modules, api.js central client (default port 5173)
  └── Routes: /, /profile, /jobs, /logs, /skills, /matching, /dedup (see frontend/README.md)

backend/            FastAPI + SQLAlchemy async + PostgreSQL
  ├── routers/          /jobs (+ job issue reports), /config, /extension, /dedup, /match/*, /profile, /skills
  ├── dedup/            Pass 0/1/2 pipeline (hash + cosine), chain resolution, dedup reports
  ├── matching/         CPU/LLM JD extraction, gates, CPU pre-score, optional LLM re-score; pipeline stages for /jobs/match
  ├── profile/          Resume PDF/text parsing and profile JSON for matching
  ├── models/           SQLAlchemy ORM (scraped_jobs, job_reports, match_reports, skill_candidates, …)
  ├── schemas/          Pydantic v2 request/response models
  └── core/             Config file, database, auth, **`trace`** (in-memory pipeline debug buffer + stdlib log bridge)

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

Opens the app at `http://localhost:5173` — **Config** (`/`), **Profile** (`/profile`), **Jobs** (`/jobs`), **Logs** (`/logs`), **Skills** (`/skills`), **Matching** (`/matching`), **Dedup** (`/dedup`; no top-nav link — open by URL or bookmark). Use the Config page for `website`, Indeed/Glassdoor fields, dedup mode, LLM toggle, and filters (the extension popup only syncs a subset of fields). **Matching** runs dedup (optional) plus staged pipeline: CPU work, optional LLM extraction + gates, CPU pre-score, and optional **LLM re-score** (Button 4; requires **`llm`** in config and **`OPENAI_API_KEY`**). Long runs are scheduled with **`asyncio.create_task`** (not tied to the HTTP request lifecycle, so navigating away does not cancel the pipeline). The UI polls **`GET /match/reports`** for a new row and calls **`GET /match/status`** on mount to rehydrate the “running” spinner if a task is still active. **Logs → Dedup** and **Logs → Matching** can expand each run report to a **Debug trace** panel (`debug_log.events`, same shape as extension scan traces). On **Matching**, the **report flag** opens an **issue report** (extraction/scoring feedback); submitted reports are listed under **Logs → Reports** (separate from pipeline **Matching** run reports). Reports are stored in **`job_reports`** and do not modify job rows until you action them from the Reports tab.

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

This verifies: health, config, job ingest (including content-duplicate `original_job_id`), run log start/complete/list, extension state, and trigger-scan / pending-scan.

## Config Reference

Search parameters live in `config.json` (path set by `CONFIG_PATH` in Docker). Editable via **`PUT /config`**, the **web Config page** (`/`), or a subset of fields from the **extension popup**.

| Field | Description |
| --- | --- |
| `website` | `"linkedin"`, `"indeed"`, or `"glassdoor"` — default site when the extension opens a scan without a trigger override |
| `dedup_mode` | `"manual"` — dedup only when you run it from the **Dedup** page; `"sync"` — after each **completed** scan run log, the backend runs full dedup in a background task (Scan All: once after the final site only) |
| `llm` | When true, enables LLM-backed resume parsing and matching stages that require it (**Matching** buttons 2 and 4 — LLM extraction/gates and LLM re-score) |
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
| `OPENAI_API_KEY` | Optional; required for LLM JD extraction, LLM scoring (Button 4), and LLM resume/profile features when `llm` is enabled (see `.env.example`) |
| `DEBUG_LOG_RING_SIZE` | Optional; max events kept per **`debug_log`** (extension run logs, dedup reports, match reports). Default **10000** (see `core/config.py`). |

## API Endpoints

All endpoints except `/health` expect **`Authorization: Bearer <token>`** (e.g. `dev-token` locally).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check with DB ping (no auth) |
| `GET` | `/config` | Read search config |
| `PUT` | `/config` | Merge-update search config |
| `POST` | `/jobs/ingest` | Ingest a scraped job (URL + content-hash dedup at ingest; no per-row Pass 0/1 here) |
| `GET` | `/jobs` | List jobs. Query params include `website`, `dismissed`, `dedup_status` (`passed` / `removed` / `all`), dates, pagination. Each item includes **`has_report`** (true when a **pending** row exists in **`job_reports`**). |
| `GET` | `/jobs/{id}` | Job detail (includes **`has_report`** for pending issue reports) |
| `PUT` | `/jobs/{id}` | Update job (e.g. dismiss) |
| `POST` | `/jobs/{id}/report` | Create or update a **pending** issue report for the job (`report_type`, `detail` JSON). Does not change **`scraped_jobs`**. At most one pending report per job per `report_type` (upsert). |
| `GET` | `/jobs/reports` | List issue reports (`status`, `report_type`, pagination). Joins job title/company/match fields for display. |
| `GET` | `/jobs/reports/stats` | Counts: pending total, pending by type, grand total. |
| `PUT` | `/jobs/reports/{id}/action` | Action on an issue report (e.g. **`dismiss`**). |
| `POST` | `/jobs/dedup` | Run full dedup pipeline (manual) |
| `POST` | `/jobs/dedup/reset` | Clear dedup-assigned `skip_reason` for whitelisted reasons (see backend) |
| `POST` | `/jobs/dedup/resolve-chains` | One-time repair: walk `dedup_original_job_id` chains so removed rows point at a **passed** job (idempotent; safe after upgrades) |
| `POST` | `/jobs/match` | Queue matching pipeline work. JSON body optional: `mode`: `cpu_only` (Button 1: CPU extraction + gates), `llm_extraction_gates` (Button 2; requires `llm` in config), `cpu_score` (Button 3), `llm_score` (Button 4: LLM re-score; requires `llm` and **`OPENAI_API_KEY`**), or omit for legacy Step-B extraction. Returns immediately **`{ "status": "started", "mode": … }`**; work runs in an **`asyncio` background task** with a fresh DB session (not cancelled when the client disconnects). Poll **`GET /match/reports`** (new row) or job fields to detect completion. |
| `POST` | `/jobs/match/gates` | Run hard gates on extracted jobs (separate from button flows) |
| `POST` | `/jobs/match/score` | CPU pre-score endpoint (legacy path; Button 3 uses `/jobs/match` with `cpu_score`) |
| `GET` | `/jobs/match/extracted-count` | Count of passed dedup jobs with `matched_at` set |
| `GET` | `/match/reports` | Recent match run reports (metrics, `matching_mode`, durations, optional **`debug_log`**) |
| `GET` | `/match/reports/{id}` | Single match report |
| `POST` | `/match/reports/{id}/debug` | Append trace events to a match report’s **`debug_log`** (ring buffer; same payload shape as extension debug append) |
| `GET` | `/match/status` | **`{ "running": bool, "mode": string \| null }`** — whether a matching pipeline task is still in flight (for UI rehydration) |
| `GET` | `/match/logs` | Recent matching pipeline log lines (ring buffer) |
| `GET` | `/profile` | Read profile JSON used for matching |
| `PUT` | `/profile` | Update profile |
| `GET` | `/profile/extracted` | Read `_extracted` resume-derived block |
| `POST` | `/profile/upload-resume` | Upload resume file (PDF) |
| `POST` | `/profile/parse-resume` | Parse resume markdown into structured fields |
| `GET` | `/skills/candidates` | Skill alias candidates (pagination/filter; see backend README) |
| `PUT` | `/skills/candidates/{id}/approve` | Approve a candidate (and optional canonical) |
| `PUT` | `/skills/candidates/{id}/merge` | Merge into another canonical |
| `PUT` | `/skills/candidates/{id}/reject` | Reject a candidate |
| `POST` | `/skills/candidates/refresh-aliases` | Refresh persisted alias map from DB |
| `GET` | `/jobs/skipped` | Skipped rows for a run (`scan_run_id` required) |
| `GET` | `/dedup/reports` | List dedup reports (optional **`debug_log`**) |
| `GET` | `/dedup/reports/{id}` | Single dedup report |
| `POST` | `/dedup/reports/{id}/debug` | Append trace events to a dedup report’s **`debug_log`** (ring buffer) |
| `GET` | `/extension/state` | Extension state row |
| `PUT` | `/extension/state` | Update extension state |
| `POST` | `/extension/run-log/start` | Start a scan run (body may include `scan_all`, `scan_all_position`, `scan_all_total`) |
| `PUT` | `/extension/run-log/{id}` | Complete or fail a run. When status becomes **`completed`** and **`dedup_mode`** is **`sync`**, the backend may enqueue **dedup** (own session, after response). |
| `POST` | `/extension/run-log/{id}/debug` | Append scan **debug trace** events (JSON body `events[]`). Ring-buffered (**`debug_log_ring_size`** in settings, default **10k**); used by the extension’s batched flushes and shared with dedup/match report traces. |
| `GET` | `/extension/run-log` | List runs; **`?limit=N`** for recent runs |
| `POST` | `/extension/trigger-scan` | Sets scan requested. Body may include `website`, and for Scan All: `scan_all`, `scan_all_position`, `scan_all_total`. Stored until consumed by **`GET /extension/pending-scan`**. |
| `POST` | `/extension/trigger-stop` | Sets stop flag for the extension poller |
| `GET` | `/extension/pending-scan` | Atomically read-and-clear scan request. Returns `pending`, `website`, `scan_all`, `scan_all_position`, `scan_all_total`. |
| `GET` | `/extension/pending-stop` | Atomically read-and-clear stop request |
| `POST` | `/extension/session-error` | Report session error from extension |

### `GET /jobs` response shape (high level)

Each job includes identifiers, `website`, title, company, location, URLs, `skip_reason`, **`dedup_similarity_score`**, **`dedup_original_job_id`** (when set by dedup), `original_job_id` (ingest-time content duplicate), matching pipeline fields, **`has_report`** (pending issue report), timestamps, etc.

### `GET /extension/run-log` list item shape

Includes run metadata, counters, `search_filters`, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** (when present), `errors`, optional **`debug_log`** (`{ "events": [ … ] }` — scan instrumentation from the extension), `created_at`, etc. On the **Logs** page, expand a **Search** run, **Dedup** report, or **Matching** report to view or download the **Debug trace** when **`debug_log.events`** exists.

## Database notes

- **`extension_state`**: includes `scan_requested`, `stop_requested`, `scan_website`, and pending **Scan All** fields (`scan_all`, `scan_all_position`, `scan_all_total`) cleared when **`GET /pending-scan`** consumes a request.
- **`extension_run_logs`**: stores per-run **`scan_all`** metadata so the backend knows whether to run **sync dedup** only on the last leg of Scan All; optional **`debug_log`** (JSONB) holds a ring-buffered event stream for scan troubleshooting (**`POST /extension/run-log/{id}/debug`**).
- **`scraped_jobs`**: `original_job_id` for ingest-time content duplicate; **`dedup_original_job_id`** for dedup “kept” row when removed as duplicate; optional **`dedup_similarity_score`** for cosine matches. Pass 2 resolves in-memory chains before writing; cosine skips jobs already flagged in the same run as similarity “originals.”
- **`dedup_reports`**: persisted metrics per manual or post-scan dedup run; optional **`debug_log`** JSONB (`{ "events": [ … ] }`) flushed at end of **`run_dedup`**.
- **`match_reports`**: pipeline run metrics; optional **`debug_log`** JSONB flushed at end of each matching **`run_*`** stage.
- **`job_reports`**: user-submitted issue reports (match level, YOE, skills, wrong gate, etc.). Status `pending` \| `dismissed` \| `actioned`. Not cleared by matching/dedup undo endpoints; **`has_report`** on job API responses reflects **pending** rows only.

## Development

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
