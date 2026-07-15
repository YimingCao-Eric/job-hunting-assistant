# API Surface Delta: Search-Only Backend

The "contract" for a subtractive backend change is the **delta** to the served HTTP surface:
which route groups disappear, which remain, and how retained response bodies change. Auth is
unchanged — every route except `/health` still requires bearer auth (Principle VII).

## Removed route groups (no longer served → 404)

| Router (deleted) | Prefix / representative routes | Reason |
|------------------|--------------------------------|--------|
| `routers/dedup.py` | `POST /jobs/dedup`, `POST /jobs/dedup/reset`, `POST /jobs/dedup/resolve-chains`, `GET /dedup/reports*`, `POST /dedup/reports/{id}/debug` | Dedup pipeline removed (FR-001) |
| `routers/matching.py` | `POST /jobs/match`, `GET /match/status`, `GET /match/logs`, `GET/POST /match/reports*`, `POST /jobs/match/{gates,score,dismiss,...}`, `undo-button*` / `reset*` | Matching pipeline removed (FR-002) |
| `routers/profile.py` | `/profile*` (profile read/update, resume upload/parse) | Profile surface removed (FR-003) |
| `routers/skills.py` | `/skills*` | Skills surface removed (FR-003) |
| `routers/job_reports.py` | `POST /jobs/{id}/report`, `GET /jobs/reports`, `GET /jobs/reports/stats`, `PUT /jobs/reports/{id}/action` | Issue-report flow removed (FR-003) |

Verification: enumerating `app.routes` after startup shows none of the above; a request to any
returns `404` (SC-003, US2 AC4).

## Retained route groups (must keep working)

| Router | Prefix | Status | Change |
|--------|--------|--------|--------|
| `routers/jobs.py` | `/jobs` | KEPT (modified) | Ingest/list/detail/update unchanged **except** responses drop dedup/match fields + `has_report` (see below) |
| `routers/config.py` | `/config` | KEPT | Response/request no longer include `llm`, `dedup_mode` |
| `routers/extension.py` | `/extension` | KEPT (modified) | Run-log completion no longer schedules sync-dedup; otherwise unchanged |
| `routers/auto_scrape.py` | `/admin/auto-scrape` | KEPT | Unchanged |
| `routers/admin_cleanup.py` | `/admin/...` | KEPT (modified) | `cleanup-invalid-entries` no longer marks dedup_tasks; response key `marked_failed_dedup_tasks` retained, always `0` |
| `routers/run_log_ws.py` | (ws) | KEPT | Unchanged |
| `GET /health` | — | KEPT | Unchanged (only unauthenticated route) |

## Retained-response body changes

### `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/skipped`, `PUT /jobs/{id}`

- Response objects (`ScrapedJobRead` / `ScrapedJobDetail`) **omit** all dedup/match fields and
  `has_report` (full list in [data-model.md](../data-model.md#a-api-schema-changes-pydantic--backendschemas)).
- Retained fields (identity, source, title, company, location, description, url, timestamps,
  `ingest_source`, `scan_run_id`, `original_job_id`, `dismissed`, `skip_reason`,
  `raw_description_hash`) are unchanged.
- `{items, total, limit, offset}` envelope, `dedup_status` semantics, filters, sorting, and
  pagination are unchanged (FR-010). Match/dedup filter query params still accepted (ignored/no-op
  against always-null columns).
- `PUT /jobs/{id}` accepts only `dismissed` (other match fields no longer in `JobUpdate`).

### `POST /jobs/ingest`

- **Unchanged.** All three paths (skip-reason, per-source, legacy) and the ingest-time URL +
  content-hash dedup behave exactly as spec 002 (FR-009). Response
  `{id, already_exists, content_duplicate, skip_reason}` unchanged.

### `GET/PUT /config`

- `SearchConfigRead` / `SearchConfigUpdate` no longer expose `llm` or `dedup_mode`. A stored
  config containing those keys still loads (extra keys ignored) and they drop out on next write.

## Behavioral (non-HTTP) contract changes

- **Post-scan sync-dedup trigger removed**: `PUT /extension/run-log/{id}` → `completed` no longer
  schedules a dedup background task (FR-004). Response behavior otherwise unchanged.
- **Post-scrape Phase 4–6 removed**: the orchestrator runs claim → Phase 1 → Phase 2 → finalize;
  persisted cycle output (`cleanup_results`, `match_results = {"claim_summary": {...}}`, terminal
  `post_scrape_complete`) is unchanged (FR-005, FR-014).
- **Startup**: the `dedup_task_cleanup` startup hook is removed; remaining startup steps
  (migrations, stale run-log cleanup, stale-cycle cleanup, scheduler, Redis subscriber) unchanged.
