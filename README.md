# Job Hunting Assistant (JHA)

A **search-only** job aggregator: a Chrome extension scrapes the major Canadian job boards into one
canonical PostgreSQL table, a FastAPI backend serves it, and a React console lets you configure
searches, browse jobs, watch scan logs, and run an unattended auto-scraper.

The extension targets **LinkedIn** (Voyager API), **Indeed Canada** (`ca.indeed.com`), and
**Glassdoor Canada** (JSON-LD / RSC). Each scraped job is posted to the backend and stored in
Postgres via the REST API.

> **Scope note.** JHA *used to* also de-duplicate and AI-match jobs against a resume. That half was
> removed in the search-only split — the project is now **scrape → store → browse**. The removed
> dedup/matching logic is being rebuilt as a **separate** standalone service that consumes the
> canonical `scraped_jobs` table (see `docs/filter-matching-service-design.md`).

## Architecture

```
extension/          Chrome extension (Manifest V3) — the scraper. See extension/README.md
  ├── background/       Service worker modules (scan orchestration, auto-scrape, polling)
  ├── content/          Shared + LinkedIn / Indeed / Glassdoor content scripts
  └── popup/            Settings UI and scan control

backend/            FastAPI + async SQLAlchemy + PostgreSQL (+ optional Redis)
  ├── routers/          jobs (ingest + listing), config, extension, run-log WebSocket,
  │                     admin/auto-scrape, admin cleanup
  ├── auto_scrape/      Post-scrape orchestrator: auto-expiration → finalize
  ├── models/           SQLAlchemy ORM (scraped_jobs + auto-scrape/extension state tables)
  ├── schemas/          Pydantic v2 request/response models
  └── core/             config, database, auth, trace (in-memory debug buffer), redis, lifecycle

frontend/           Vite + React + TypeScript; Tailwind + TanStack Query. Four pages:
                    Config (/), Jobs (/jobs), Logs (/logs), Auto-Scrape (/dashboard/auto-scrape)

docker-compose.yml  backend :8000 · frontend :5173 · PostgreSQL 16 · Redis 7
```

There is **no** `dedup/`, `matching/`, or `profile/` package, and no `/dedup`, `/match`, `/profile`,
or `/skills` routes — all removed in the search-only split.

## Data model

Each `POST /jobs/ingest` writes to **two places at once** (an atomic dual-write):

1. **Per-source tables** — `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`. These stay faithful to
   each site's own field shape (the raw, append-only record, `source_raw` JSONB). Written via raw
   SQL in `routers/jobs.py`; managed by Alembic, no ORM model.
2. **`scraped_jobs`** — the unified, site-agnostic **canonical** table (**27 columns**, three
   indexes; Alembic **030** + **031**). A *derived* table: every ingest writes its per-source row
   **and** one canonical row in a single transaction. All normalization lives here; the per-source
   tables stay unnormalized. `source_raw` is not carried — follow **`source_row_id`** back to the
   per-source row. Authoritative per-site → canonical mapping:
   [**docs/live-per-source-schemas.md**](docs/live-per-source-schemas.md).

`scraped_jobs` permits exactly three mutations: `matched` false→true (claim), `dismissed` set by the
user, and auto-expiration DELETE. Salaries are stored exactly as quoted (never annualized), periods
normalized to `HOURLY/DAILY/WEEKLY/MONTHLY/ANNUAL`; dates normalized to `timestamptz`.

### `031` filter attributes

Five nullable columns so a future filtering/matching service can read this table alone:
**`employment_type`**, **`workplace_type`**, **`language`**, **`education_requirements`**,
**`salary_disclosed`**. **NULL always means "this site did not say"** — never "no", never a default.
They are deliberately **not** exposed by `GET /jobs`.

- **`employment_type`** — a closed **seven**-token vocabulary: `FULL_TIME`, `PART_TIME`, `CONTRACT`,
  `TEMPORARY`, `INTERNSHIP`, **`PERMANENT`**, `VOLUNTEER`. Single-valued: where a site states
  several, precedence picks one and the rest are discarded (they survive on the per-source row).
  `PERMANENT` is a **tenure** axis, not hours — a permanent part-time job exists — so it ranks below
  the hours tokens and surfaces only when it is the sole signal.
- **`workplace_type`** — `REMOTE` / `HYBRID` / `ONSITE`, populated for **LinkedIn and Indeed only**.
  Every live **Glassdoor** row is NULL because the scraper returns `remote_work_types` empty; the
  projection is correct and the mapping is in place, so it populates the moment the extension
  supplies the field (spec 009 FR-005f / SC-002a — scraper-layer work, not a projection defect). It
  is **not** a refinement of `remote`; the two may legitimately disagree, so pick one column per
  filter and don't mix them.
- **`language`** — Indeed-only (LinkedIn/Glassdoor NULL). **`salary_disclosed`** — tri-state
  provenance (true = employer-stated, false = site estimate, NULL = unsaid); for Indeed, `EXTRACTION`
  (pay parsed from JD prose) counts as employer-disclosed (true).

### The `matched` flag

`matched` is a one-way `false→true` claim, kept in sync between each `scraped_jobs` row and its
per-source origin. As of feature **010** the backend **no longer auto-claims** — a completed
post-scrape cycle leaves rows `matched = false` and records
`match_results = {"claim_summary": null, "claim_retired": true}`. The flag now exists for the
standalone filter/matcher service to claim rows itself.

Schema history is in Alembic under `backend/alembic/versions/` (head **031**).

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

### 2. Start the backend

```bash
docker compose up --build -d
```

Launches **FastAPI** on `http://localhost:8000`, **PostgreSQL 16** (database `jha`), and **Redis 7**
(Compose sets `REDIS_URL` so the post-scrape subscriber runs). Migrations run automatically on
startup. The backend mounts `./data → /app/data` for `config.json`.

```bash
docker compose logs -f backend      # app + ingest logs (INFO+) on stdout
```

### 3. Verify

```bash
curl http://localhost:8000/health
# → {"status":"ok","db":"ok"}
```

### 4. Load the Chrome extension

1. Open `chrome://extensions/`, enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. In the popup, set Backend URL `http://localhost:8000`, Auth Token `dev-token`, adjust
   keyword/location/filters, **Save Settings**

### 5. Web UI

```bash
cd frontend && npm install && npm run dev
```

Opens at `http://localhost:5173` with four pages: **Config** (`/`), **Jobs** (`/jobs`), **Logs**
(`/logs`), **Auto-Scrape** (`/dashboard/auto-scrape`). The Jobs page opens a **WebSocket** to
`/ws/run-log` (bearer token via subprotocols) so run-log rows update live; when connected, list
polling backs off. Job descriptions render through **DOMPurify**.

### 6. Scan

Click **Scan Now** in the popup (or trigger from the Jobs page). The extension opens a search tab,
scrapes cards + full descriptions, and posts each job to `POST /jobs/ingest` (URL/content-hash dedup
at ingest). **Scan All** runs LinkedIn → Indeed → Glassdoor in series.

## Auto-scrape (extension orchestrator)

The extension can run **unattended multi-site cycles** (sites × keywords) driven by backend state
and the service worker.

- **Dashboard:** `http://localhost:5173/dashboard/auto-scrape` — Enable / Pause / Stop, test cycle,
  per-site session health (probe status, Resolve CAPTCHA / Reset), orchestrator config (sites,
  keywords, limits), recent cycles, and a multi-instance warning. Config saves to
  `PUT /admin/auto-scrape/config`; the SW reloads it at the start of each cycle.
- **Cycle flow:** enable → the SW self-bootstraps the next cycle when idle → each cycle does a
  pre-check (health, `GET /config`, per-site probe), runs the sites × keywords scan matrix, and
  records a cycle row. **Post-scrape** then runs **auto-expiration → finalize** (the dedup/matching
  phases and the vestigial matched-claim were removed; scrape completion is still recorded).
- **Hardening:** repeated pre-check failures auto-pause; sites with high consecutive failures or a
  CAPTCHA probe are skipped until reset; stale cycles are marked failed on startup.
- **Further reading:** extension `background/auto_scrape*.js`, `poll.js`; backend
  `routers/auto_scrape.py`, `core/auto_scrape_lifecycle.py`, `auto_scrape/post_scrape_orchestrator.py`.

## Smoke tests / verification

With `docker compose up` running:

```bash
curl http://localhost:8000/health
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_matched_claim.py
docker compose exec backend python smoke_test_auto_expiration.py
docker compose exec backend python smoke_test_scraped_jobs_merge.py
docker compose exec backend python unit_test_scraped_job_projection.py
```

> **Rebuild first.** The `backend` service has **no source mount** — code is baked into the image at
> build time, so a host edit changes nothing in the container until `docker compose up -d --build
> backend`. This fails *silently*: a new migration can report the old head and exit 0, exactly as if
> the file did not exist. If a change appears to have no effect, suspect a stale image first.

- **`smoke_test_auto_scrape.py`** — admin auto-scrape routes, extension/run-log flows, and the
  post-scrape orchestrator (Phase 1 expiration + finalize).
- **`smoke_test_matched_claim.py`** — asserts a post-scrape run leaves rows **unclaimed**
  (`matched = false`) now the auto-claim is retired (feature 010), plus the flag's surviving
  invariants (canonical/per-source agreement, the column contract).
- **`smoke_test_auto_expiration.py`** — shelf-life expiration deletes canonical rows with their
  per-source rows, no orphans.
- **`smoke_test_scraped_jobs_merge.py`** — the behavioral contract for the unified `scraped_jobs`
  dual-write and its per-site projection (migrations **030**–**031**).
- **`unit_test_scraped_job_projection.py`** — the projection's pure functions; no database, no HTTP.

## Config reference

Search parameters live in `config.json` (path set by `CONFIG_PATH`). Editable via `PUT /config` or
the web **Config** page (`/`). Key fields:

| Field | Description |
| --- | --- |
| `website` | `"linkedin"`, `"indeed"`, or `"glassdoor"` — default site when a scan has no trigger override |
| `keyword`, `location` | LinkedIn default search terms |
| `f_tpr_bound`, `f_experience`, `f_job_type`, `f_remote`, `salary_min`, `linkedin_f_tpr` | LinkedIn search filters |
| `indeed_*` | Indeed query/location/filters (`indeed_keyword`, `indeed_location`, `indeed_fromage`, `indeed_remotejob`, `indeed_jt`, `indeed_sort`, `indeed_radius`, `indeed_explvl`, `indeed_lang`) |
| `glassdoor` | Nested keyword/location/filters for Glassdoor |
| `general_date_posted`, `general_internship_only`, `general_remote_only` | Cross-site search knobs |
| `blacklist_companies`, `blacklist_locations`, `blacklist_titles`, `target_titles`, `allowed_languages`, `no_contract`, `remote_only`, `needs_sponsorship`, `no_agency` | Search/preference filters |

> Some scoring/dedup fields (`dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`,
> `cpu_binary_threshold`) remain in the config schema as **vestigial residue** of the removed
> matching layer — they are validated but the code that consumed them is gone. `dedup_mode` and
> `llm` no longer exist.

**Local defaults:** backend `http://localhost:8000`, auth header `Authorization: Bearer dev-token`.

## Environment variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Async PostgreSQL connection string (required) |
| `REDIS_URL` | When set (Compose always sets it), starts the Redis post-scrape subscriber; omit for bare-metal runs without Redis |
| `CONFIG_PATH` | Path to `config.json` (default `/app/data/config.json`) |
| `EXTENSION_ORIGIN_REGEX` | Regex validating the Chrome extension origin header |
| `DEBUG_LOG_RING_SIZE` | Max events kept per run-log `debug_log` (default 10000) |
| `PROFILE_PATH`, `DEDUP_COSINE_BATCH_SIZE` | **Vestigial** — still wired (default `/app/data/profile.json`, `1000`) but the profile/dedup features that used them are gone |
| `VITE_API_URL`, `VITE_AUTH_TOKEN` | Frontend: backend URL + bearer token |

## API endpoints

All HTTP JSON endpoints except `/health` expect `Authorization: Bearer <token>` (e.g. `dev-token`
locally). `WebSocket /ws/run-log` authenticates via `Sec-WebSocket-Protocol` subprotocols
(`bearer`, `<token>`).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check with DB ping (no auth) |
| `WebSocket` | `/ws/run-log` | Run-log row fan-out; opened by the Jobs page for live progress |
| `GET` / `PUT` | `/config` | Read / merge-update search config |
| `POST` | `/jobs/ingest` | Ingest a scraped job (per-source + canonical dual-write; URL/content-hash dedup at ingest) |
| `GET` | `/jobs` | List canonical postings (filters: `source_site`, `dismissed`, `scan_run_id`, date/scrape ranges, `limit`, `offset`) |
| `GET` | `/jobs/{id}` | Canonical posting detail |
| `PUT` | `/jobs/{id}` | Update a posting (e.g. `dismissed`, `matched`) |
| `GET` / `PUT` | `/extension/state` | Extension mailbox state |
| `POST` | `/extension/trigger-scan` / `trigger-stop` | Request a scan / stop |
| `GET` | `/extension/pending-scan` / `pending-stop` / `pending` | Atomic read-and-clear of scan/stop flags |
| `POST` | `/extension/run-log/start` | Create a run log |
| `PUT` | `/extension/run-log/{id}` | Update counters/status; broadcasts to `/ws/run-log` |
| `GET` | `/extension/run-log` | List runs (`?limit=`) |
| `POST` | `/extension/run-log/{id}/debug` | Append scan debug-trace events (ring-buffered) |
| `POST` | `/extension/session-error` | Attach a session error to the running run log |

### Auto-scrape (`/admin/auto-scrape`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/state` | Singleton orchestrator state |
| `POST` | `/heartbeat` · `GET` `/instances` · `POST` `/wake-orchestrator` | SW heartbeat, instance tracking, manual wake |
| `GET` / `PUT` | `/config` (+ `POST /config/reset`, `GET /config/limits`) | Orchestrator config (sites, keywords, limits) |
| `POST` `/cycle` · `PUT` `/cycle/{id}` · `GET` `/cycles` · `POST` `/cleanup-orphan-cycles` | Cycle CRUD + cleanup |
| `POST` | `/enable` · `/pause` · `/shutdown` · `/test-cycle` · `/restart-cycle` · `/reset-counters` | Lifecycle controls |
| `GET` `/sessions` · `PUT` `/sessions/{site}` · `POST` `/reset-session/{site}` | Per-site probe / failure state |

### Admin maintenance

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/admin/cleanup-invalid-entries` | Marks short-timeout stale `extension_run_logs` failed. (Legacy dedup/job-row response keys remain, hardcoded to 0 — that work is retired.) |

## Development

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

See `docs/filter-matching-service-design.md` for the next component (the standalone filter/matcher
service) and `docs/PROJECT-SUMMARY.md` for the full project history.
