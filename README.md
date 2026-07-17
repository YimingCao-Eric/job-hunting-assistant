# Job Hunting Assistant

Chrome extension + **FastAPI** backend + **React (Vite)** web UI for job search scraping. The extension targets **LinkedIn** (Voyager API), **Indeed Canada** (`ca.indeed.com`), and **Glassdoor Canada**; jobs are stored in PostgreSQL via the REST API. The extension’s `background/scan_manual.js` reads **`GET /config`** to choose the site and URL builders.

## Architecture

```
extension/          Chrome Extension (Manifest V3) — see extension/README.md
  ├── background/       Service worker modules (importScripts)
  ├── content/          Shared + LinkedIn + Indeed + Glassdoor content scripts
  └── popup/            Settings UI and scan control

frontend/           Vite + React (Router), CSS modules + Tailwind for auto-scrape UI; `api.js` + `src/lib/api/*` (default port 5173)
  └── Routes: /, /profile, /jobs, /logs, /skills, /matching, /dedup, **/dashboard/auto-scrape** (see frontend/README.md)

backend/            FastAPI + SQLAlchemy async + PostgreSQL; optional **Redis** (post-scrape wake when `REDIS_URL` set)
  ├── routers/          /jobs, /config, /extension, /dedup, /match/*, /profile, /skills, **/admin/auto-scrape**, **/admin/cleanup-invalid-entries**, /ws/run-log, …
  ├── auto_scrape/      Post-scrape subscriber (Redis wake; APScheduler fallback)
  ├── dedup/            Pass 0/1/2 pipeline (hash + cosine), chain resolution, dedup reports
  ├── matching/         CPU/LLM JD extraction, gates, CPU pre-score, optional LLM re-score; pipeline stages for /jobs/match
  ├── profile/          Resume PDF/text parsing and profile JSON for matching
  ├── models/           SQLAlchemy ORM (scraped_jobs, job_reports, match_reports, skill_candidates, …)
  ├── schemas/          Pydantic v2 request/response models
  └── core/             Config file, database, auth, **`trace`** (in-memory pipeline debug buffer + stdlib log bridge), **`dedup_task_cleanup`** (startup)

docker-compose.yml  Backend + Postgres 16 + **Redis 7**; host **`./data`** mounted at **`/app/data`** so `config.json` and `profile.json` survive rebuilds (**`CONFIG_PATH`**, **`PROFILE_PATH`**)
```

## Documentation — per-source scrape fields

Canonical catalogs for **`POST /jobs/ingest`** payloads mapped to **`linkedin_jobs`**, **`indeed_jobs`**, and **`glassdoor_jobs`** (what each surface exposes, what we keep vs drop, and column lineage):

| Doc | Site |
| --- | --- |
| [**docs/scrape-fields-linkedin.md**](docs/scrape-fields-linkedin.md) | LinkedIn Voyager (`WebFullJobPosting`) |
| [**docs/scrape-fields-indeed.md**](docs/scrape-fields-indeed.md) | Indeed mosaic SERP + GraphQL |
| [**docs/scrape-fields-glassdoor.md**](docs/scrape-fields-glassdoor.md) | Glassdoor SERP / JSON-LD / RSC job detail |

Schema evolution (including **`matched`**, **`system_settings`**, cycle-5 drops) is in Alembic under **`backend/alembic/versions/`**.

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
- **Redis 7** on host port **6379** (Compose sets **`REDIS_URL=redis://redis:6379/0`** so the post-scrape subscriber runs when backend starts)

The backend container mounts **`./data` → `/app/data`** (create the folder beforehand if you want fixed permissions on Linux). Migrations run automatically on startup.

**Backend logs:** Application loggers (including ingest routes under `routers.jobs`) emit **INFO** and above to **stdout** with a timestamped format configured in `backend/main.py`, so they appear in Compose output:

```bash
docker compose logs -f backend
```

(Uvicorn keeps its own access/server lines; library and app messages use the standard logging format.)

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

Opens the app at `http://localhost:5173` — **Config** (`/`), **Profile** (`/profile`), **Jobs** (`/jobs`), **Logs** (`/logs`), **Skills** (`/skills`), **Matching** (`/matching`), **Dedup** (`/dedup`; no top-nav link — open by URL or bookmark). On **Jobs**, the UI opens a **WebSocket** to **`/ws/run-log`** (same bearer token via subprotocols) so run-log rows update live; when connected, list polling backs off (see `frontend/README.md`). Use the Config page for `website`, Indeed/Glassdoor fields, dedup mode, LLM toggle, and filters (the extension popup only syncs a subset of fields). **Matching** runs dedup (optional) plus staged pipeline: CPU work, optional LLM extraction + gates, CPU pre-score, and optional **LLM re-score** (Button 4; requires **`llm`** in config and **`OPENAI_API_KEY`**). Long runs are scheduled with **`asyncio.create_task`** (not tied to the HTTP request lifecycle, so navigating away does not cancel the pipeline). The UI polls **`GET /match/reports`** for a new row and calls **`GET /match/status`** on mount to rehydrate the “running” spinner if a task is still active. **Logs → Dedup** and **Logs → Matching** can expand each run report to a **Debug trace** panel (`debug_log.events`, same shape as extension scan traces). On **Matching**, the **report flag** opens an **issue report** (extraction/scoring feedback); submitted reports are listed under **Logs → Reports** (separate from pipeline **Matching** run reports). Reports are stored in **`job_reports`** and do not modify job rows until you action them from the Reports tab.

### 7. Scan

Click **Scan Now** in the popup (or trigger a scan from the web UI **Jobs** page). The extension will:

1. Open a **LinkedIn**, **Indeed**, or **Glassdoor** search tab according to the trigger / config
2. Scrape job cards and fetch full descriptions (Voyager on LinkedIn, GraphQL/HTML on Indeed, listing HTML on Glassdoor — **`__NEXT_DATA__`** when present, otherwise **`jl=` + JSON-LD** when the page exposes **`JobPosting`** schema)
3. Send each job to the backend (`POST /jobs/ingest`) for URL/hash dedup and storage
4. Show live progress in the popup

**Scan All** (Jobs page) runs LinkedIn → Indeed → Glassdoor in series; each leg sends `scan_all` metadata to the backend so **sync dedup** (if enabled) runs once after the **last** site finishes, not after each leg.

## Auto-scrape (extension orchestrator)

The extension can run **unattended multi-site cycles** (LinkedIn, Indeed, Glassdoor × configured keywords) driven by backend state and the service worker:

- **Web dashboard:** `http://localhost:5173/dashboard/auto-scrape` — Enable / Pause / Stop and Exit, test cycle, session health (probe status, **Resolve CAPTCHA** / **Reset**), orchestrator config (sites, keywords, limits), recent cycles, multi-instance warning when more than one extension heartbeats in a 5-minute window. **Configuration** saves to **`PUT /admin/auto-scrape/config`** (`enabled_sites`, `keywords`, limits); the SW reloads that config **at the start of each cycle** (no cross-cycle cache). If the request fails or those arrays are empty, the extension falls back to compiled-in defaults.
- **Flow:** `POST /admin/auto-scrape/enable` (or dashboard) sets `enabled`; **`POST /enable`**, **`/pause`**, and **`/shutdown`** also clear **`config_change_pending`** so a stale abort flag cannot stick across runs. The SW mirrors state on **`jha_poll`** (~30s) and **self-bootstraps** `auto_scrape_next_cycle` only when **`state.cycle_phase`** is not **`scrape_running`** / **`postscrape_running`** and no alarm exists (avoids parallel cycles). On **`runOneCycle` entry**, the SW immediately **`PUT`**s **`cycle_phase: scrape_running`** so self-bootstrap does not fire during the pre-check window; **`finally`** (and graceful shutdown) return **`cycle_phase`** to **`idle`**. Each cycle: pre-check (health, **`GET /config`**, per-site **probe** — bare HTTP 403 without captcha markers is treated as **rate_limited**, not CAPTCHA), optional **Chrome notifications** for captcha sites, matrix of scans using orchestrator **sites × keywords**, cycle rows on the backend. **Post-scrape** dedup/matching may be a no-op depending on deployment; scrape completion is still recorded.
- **Popup hygiene:** **Stop and Exit** (**`handleGracefulExit`**) and **SW startup** (**`auto_scrape_init.js`**) close **popup** windows whose tabs look like job-board scrapes (LinkedIn / Indeed / Glassdoor URLs) so zombie popups cannot keep scraping or attach to the wrong run logs.
- **Hardening:** repeated pre-check failures **auto-pause** (`enabled: false`); explicit **Enable** clears the pre-check counter. Sites with high **consecutive_failures** or **`last_probe_status === captcha`** are skipped until **reset-session** / user resolves CAPTCHA. **`GET /admin/auto-scrape/instances`** supports the dashboard multi-instance banner. Backend startup can mark stale **`auto_scrape_cycles`** failed and reset **`cycle_phase`** to **`idle`** in **`auto_scrape_state`** when those rows are cleaned up.
- **Further reading:** extension `background/auto_scrape*.js`, `poll.js`; backend `routers/auto_scrape.py`, `core/auto_scrape_lifecycle.py`.

## Smoke tests / verification

With **`docker compose up`** running:

```bash
curl http://localhost:8000/health
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_matched_claim.py
docker compose exec backend python smoke_test_auto_expiration.py
docker compose exec backend python smoke_test_scraped_jobs_merge.py
docker compose exec backend python unit_test_scraped_job_projection.py
docker compose exec backend python scripts/verify_matched_column.py
```

> **Rebuild first.** The `backend` service has **no source mount** — code is baked into the image at
> build time, so a host edit changes nothing in the container until `docker compose up -d --build
> backend`. This fails *silently*: a new migration can report the old head and exit 0, exactly as if
> the file did not exist. If a change appears to have no effect, suspect a stale image before
> suspecting the code.

**`smoke_test_auto_scrape.py`** hits admin auto-scrape routes, extension/run-log flows, and post-scrape orchestration helpers. **`smoke_test_matched_claim.py`** asserts the post-scrape run leaves rows **unclaimed** (`matched=false`) now the auto-claim is retired (feature 010), plus the flag's surviving invariants — canonical/per-source agreement and the column contract. **`smoke_test_auto_expiration.py`** exercises DB helpers for shelf-life expiration (expect migrations through **031** and valid FK-backed **`extension_run_logs`** where noted in each script). **`smoke_test_scraped_jobs_merge.py`** is the behavioral contract for the unified `scraped_jobs` dual-write and its per-site projection (migrations **030**–**031**). **`unit_test_scraped_job_projection.py`** covers the projection's pure functions — no database, no HTTP. **`scripts/verify_matched_column.py`** confirms **`matched`** after migration **028**.

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
| `CONFIG_PATH` | Path to `config.json` (default **`/app/data/config.json`** in Compose) |
| `PROFILE_PATH` | Path to persisted profile JSON (default **`/app/data/profile.json`** in Compose) |
| `EXTENSION_ORIGIN_REGEX` | Regex to validate Chrome extension origin header |
| `DEDUP_COSINE_BATCH_SIZE` | Optional batch size hint for cosine dedup (**`dedup_cosine_batch_size`** in settings; default **1000**) |
| `OPENAI_API_KEY` | Optional; required for LLM JD extraction, LLM scoring (Button 4), and LLM resume/profile features when `llm` is enabled (see `.env.example`) |
| `DEBUG_LOG_RING_SIZE` | Optional; max events kept per **`debug_log`** (extension run logs, dedup reports, match reports). Default **10000** (see `core/config.py`). |
| `REDIS_URL` | When set (repo **Docker Compose always sets this**), the backend starts the Redis **post-scrape** subscriber (`/admin/auto-scrape/wake-orchestrator` publishes become effective). Omit for bare-metal/local runs if you do not run Redis |

## API Endpoints

All **HTTP** JSON endpoints except `/health` expect **`Authorization: Bearer <token>`** (e.g. `dev-token` locally). **`WebSocket /ws/run-log`** uses **`Sec-WebSocket-Protocol`** subprotocols **`bearer`**, **`<token>`** instead of `Authorization`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check with DB ping (no auth) |
| `WebSocket` | `/ws/run-log` | Run-log row fan-out (auth: subprotocols **`bearer`**, **`<token>`** — e.g. `dev-token`; same as REST). Payloads are JSON **`RunLogRead`** without **`debug_log`**. Opened by the **Jobs** page for live progress. |
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
| `PUT` | `/extension/run-log/{id}` | Merge-update counters/status; broadcasts to **`/ws/run-log`** clients. When status becomes **`completed`** and **`dedup_mode`** is **`sync`**, the backend may enqueue **dedup** (background task + **`dedup_tasks`** row; not cancelled when the client disconnects). |
| `POST` | `/extension/run-log/{id}/debug` | Append scan **debug trace** events (JSON body `events[]`). Ring-buffered (**`debug_log_ring_size`** in settings, default **10k**); used by the extension’s batched flushes and shared with dedup/match report traces. |
| `GET` | `/extension/run-log` | List runs; **`?limit=N`** for recent runs |
| `POST` | `/extension/trigger-scan` | Sets scan requested. Body may include `website`, and for Scan All: `scan_all`, `scan_all_position`, `scan_all_total`. Stored until consumed by **`GET /extension/pending-scan`**. |
| `POST` | `/extension/trigger-stop` | Sets stop flag for the extension poller |
| `GET` | `/extension/pending-scan` | Atomically read-and-clear scan request. Returns `pending`, `website`, `scan_all`, `scan_all_position`, `scan_all_total`. |
| `GET` | `/extension/pending-stop` | Atomically read-and-clear stop request |
| `POST` | `/extension/session-error` | Report session error from extension |

### Auto-scrape (`/admin/auto-scrape`)

Admin routes for the **extension-driven** auto-scrape orchestrator (bearer auth). Highlights:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/auto-scrape/state` | Singleton row: JSON **`state`** (enabled, probes, counters, `next_cycle_at`, …) + heartbeat timestamp |
| `PUT` | `/admin/auto-scrape/state` | **Full** JSON state replace (`{ "state": { … } }`) |
| `POST` | `/admin/auto-scrape/enable` | Set `enabled`, clear pre-check failure counter and **`config_change_pending`** |
| `POST` | `/admin/auto-scrape/pause` | Set `enabled: false`; clears **`config_change_pending`** |
| `POST` | `/admin/auto-scrape/shutdown` | Request graceful exit (`exit_requested`); clears **`config_change_pending`** |
| `POST` | `/admin/auto-scrape/test-cycle` | `test_cycle_pending` |
| `POST` | `/admin/auto-scrape/heartbeat` | SW heartbeat; tracks instance ids for **`GET /admin/auto-scrape/instances`** |
| `GET` | `/admin/auto-scrape/instances` | Recent extension instance ids (in-memory, ~5 min window) |
| `GET` | `/admin/auto-scrape/cycles` | Cycle history (`?limit=`) |
| `GET` | `/admin/auto-scrape/config` | Orchestrator config (sites, keywords, thresholds) |
| `PUT` | `/admin/auto-scrape/config` | Update orchestrator config (validated) |
| `GET` | `/admin/auto-scrape/sessions` | Per-site session probe / failure state |
| `PUT` | `/admin/auto-scrape/sessions/{site}` | Update probe status (admin / extension) |
| `POST` | `/admin/auto-scrape/reset-session/{site}` | Reset failure counters for a site |

See **`routers/auto_scrape.py`** for the full list (cycle CRUD, wake-orchestrator, cleanup, etc.).

### Admin maintenance (`/admin`)

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/admin/cleanup-invalid-entries` | Deletes scraped rows with unusable titles/companies/job descriptions or bad `website`, marks short-timeout stale **`extension_run_logs`** / **`dedup_tasks`** failed. Bearer auth (see **`routers/admin_cleanup.py`**). |

### `GET /jobs` response shape (high level)

Each job includes identifiers, `website`, title, company, location, URLs, `skip_reason`, **`dedup_similarity_score`**, **`dedup_original_job_id`** (when set by dedup), `original_job_id` (ingest-time content duplicate), matching pipeline fields, **`has_report`** (pending issue report), timestamps, etc.

### `GET /extension/run-log` list item shape

Includes run metadata, counters, `search_filters`, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** (when present), `errors`, optional **`debug_log`** (`{ "events": [ … ] }` — scan instrumentation from the extension), `created_at`, etc. On the **Logs** page, expand a **Search** run, **Dedup** report, or **Matching** report to view or download the **Debug trace** when **`debug_log.events`** exists.

## Database notes

- **`linkedin_jobs`**, **`indeed_jobs`**, **`glassdoor_jobs`**: per-source tables holding full scrape payloads (`source_raw` JSONB) when the extension sends **`POST /jobs/ingest`** with **`source_raw`** + **`scan_run_id`**. LinkedIn still carries a legacy **`job_url`** column (duplicate of **`job_posting_url`**) for **`ON CONFLICT (job_url)`** until a later migration moves uniqueness to **`job_posting_url`**. Column counts and payload→column mapping are documented in [**docs/scrape-fields-linkedin.md**](docs/scrape-fields-linkedin.md), [**docs/scrape-fields-indeed.md**](docs/scrape-fields-indeed.md), and [**docs/scrape-fields-glassdoor.md**](docs/scrape-fields-glassdoor.md) (Alembic **025**–**029**, including **`matched`** from **028**). Older cycle-5 column drops: **`026_cycle5_drops`**, **`027_schema_reconciliation`**.
- **`auto_scrape_state`**, **`auto_scrape_config`**, **`auto_scrape_cycles`**, **`site_session_states`**: orchestrator singleton state, validated config, per-cycle rows, and per-site probe / `consecutive_failures` (see Alembic migrations).
- **`extension_state`**: includes `scan_requested`, `stop_requested`, `scan_website`, and pending **Scan All** fields (`scan_all`, `scan_all_position`, `scan_all_total`) cleared when **`GET /pending-scan`** consumes a request.
- **`dedup_tasks`**: one row per **post-scan sync dedup** background run (ties to **`extension_run_logs.id`** via **`scan_run_id`**); **`last_heartbeat_at`** updated while running. Orphan **`running`** rows are marked **failed** on API startup (**`dedup_task_cleanup`**).
- **`extension_run_logs`**: stores per-run **`scan_all`** metadata so the backend knows whether to run **sync dedup** only on the last leg of Scan All; optional **`debug_log`** (JSONB) holds a ring-buffered event stream for scan troubleshooting (**`POST /extension/run-log/{id}/debug`**). Updates are broadcast to **`/ws/run-log`** subscribers when the extension PUTs completion or mirrored progress (**`broadcast_run_log_update`**).
- **`scraped_jobs`** — the unified, site-agnostic canonical table (**27 columns**, three indexes;
  Alembic **030** + **031**). A **derived** table: every `POST /jobs/ingest` writes its per-source
  row **and** one canonical row in a single transaction. The per-source tables stay source-shaped
  and unnormalized; all normalization lives here. `source_raw` is **not** carried — follow
  **`source_row_id`** back to the per-source row. Authoritative mapping:
  [**docs/live-per-source-schemas.md**](docs/live-per-source-schemas.md).
  - **`031` filter attributes** — five nullable columns so a future filtering/matching service can
    read this table alone: **`employment_type`**, **`workplace_type`**, **`language`**,
    **`education_requirements`**, **`salary_disclosed`**. **NULL always means "this site did not
    say"** — never "no", never a default. They are deliberately **not** exposed by `GET /jobs`.
  - **`employment_type`** — a closed **seven**-token vocabulary: `FULL_TIME`, `PART_TIME`,
    `CONTRACT`, `TEMPORARY`, `INTERNSHIP`, **`PERMANENT`**, `VOLUNTEER`. Single-valued: where a site
    states several, precedence picks one and the rest are discarded (they survive on the per-source
    row). `PERMANENT` is a **tenure** axis, not hours — a permanent part-time job exists — so it
    ranks below the hours tokens and surfaces only when it is the sole signal.
  - **`workplace_type`** — `REMOTE` / `HYBRID` / `ONSITE`, populated for **LinkedIn and Indeed
    only**. Every live **Glassdoor** row is NULL because the scraper returns `remote_work_types`
    empty; the projection is correct and the mapping is already in place, so it populates the moment
    the extension supplies the field (spec 009 **FR-005f** / **SC-002a** — scraper-layer work, not a
    projection defect). Note `workplace_type` is **not** a refinement of `remote` and the two may
    legitimately disagree: pick one column per filter and do not mix them.
- ⚠️ **Stale below this line (pre-`030`).** The `GET /jobs` shape and `scraped_jobs` notes elsewhere
  in this README still describe the **legacy** LinkedIn-shaped table and the retired dedup/matching
  pipeline — `original_job_id`, `dedup_original_job_id`, `dedup_similarity_score`, `website`,
  `skip_reason`, `has_report`, "matching pipeline fields". **None of those columns exist**: the
  `dedup/`, `matching/`, and `profile/` packages were removed by the search-only split, and `030`
  drop-and-recreated `scraped_jobs`. The live `GET /jobs` item carries 22 fields (`source_site`,
  `title`, `company`, `location_text`, `description`, `remote`, `apply_url`, `experience_level`,
  `industry`, `salary_*`, `posted_at`, `matched`, `dismissed`, provenance). Flagged rather than
  rewritten here: that rot predates this feature and spans the split, so correcting it is its own
  docs pass (already tracked in the constitution's follow-up TODOs). Trust
  [**docs/live-per-source-schemas.md**](docs/live-per-source-schemas.md) over this file.
- **`dedup_reports`**: persisted metrics per manual or post-scan dedup run; optional **`debug_log`** JSONB (`{ "events": [ … ] }`) flushed at end of **`run_dedup`**.
- **`match_reports`**: pipeline run metrics; optional **`debug_log`** JSONB flushed at end of each matching **`run_*`** stage.
- **`job_reports`**: user-submitted issue reports (match level, YOE, skills, wrong gate, etc.). Status `pending` \| `dismissed` \| `actioned`. Not cleared by matching/dedup undo endpoints; **`has_report`** on job API responses reflects **pending** rows only.

## Development

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```
