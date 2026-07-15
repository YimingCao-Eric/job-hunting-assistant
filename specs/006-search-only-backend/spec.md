# Feature Specification: Search-Only Backend

**Feature Branch**: `030-search-only-backend`

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "Reduce the JHA backend to a SEARCH-ONLY system by removing all dedup and matching functionality, keeping scraping/ingest, config, jobs storage, search run-logs, and the auto-scrape orchestrator."

---

## Overview

The JHA backend today does three broad things: (1) it **scrapes and ingests** jobs and runs
the auto-scrape orchestrator, (2) it **deduplicates** scraped jobs (the "dedup" pipeline), and
(3) it **matches** jobs against a candidate profile (extraction, gates, scoring, LLM re-scoring).
This feature **reduces the backend to search-only**: the deduplication and matching capabilities —
and the profile/skills/issue-report surfaces that exist only to serve them — are removed, while
scraping, ingest, configuration, job storage, search run-logs, and the auto-scrape orchestrator
(including its post-scrape expiration and matched-claim phases) continue to work exactly as before.

This is a **subtractive change spec**, not an as-built baseline. It describes the target
behavior after removal: what disappears, what must keep working unchanged, and how the result is
verified. The removed capabilities are mapped by the as-built baselines
`specs/003-dedup-pipeline` and `specs/004-matching-pipeline`; the capabilities that must survive
are mapped by `specs/002-jobs-ingest-listing`, `specs/005-scrape-orchestrator`, and
`specs/001-post-scrape-phases-1-2`.

**Why**: the dedup and matching pipelines are being retired pending a redesign (the post-scrape
orchestrator already treats their downstream phases as disabled stubs — see spec 001,
"Phase 4.5: pipeline disabled pending redesign"). Carrying their routers, packages, models,
schemas, config fields, and startup hooks adds boot-time surface, dead endpoints, and
maintenance cost with no active behavior. Reducing to search-only leaves a smaller, coherent
system focused on collecting and listing jobs.

## Clarifications

### Session 2026-07-14

- Q: Are the physical database tables and `scraped_jobs` columns belonging to dedup/matching
  dropped as part of this change? → A: No. This change removes the **application** surface
  (packages, routers, models, schemas, config fields, startup hooks) and stops reading/writing
  those fields; it does **not** run a destructive schema migration. The dedup/match tables and
  columns may remain in the database, orphaned and unreferenced. (See Assumptions.)
- Q: The jobs listing/ingest routes must keep working, but the issue-report flow
  (`job_reports`) is in the removal list — how is the read path affected? → A: Ingest, listing,
  detail, and update continue to work; the issue-report sub-feature is removed entirely, so the
  per-job `has_report` indicator and all `/jobs/reports*` and `/jobs/{id}/report` endpoints go
  away. (See US2 and Assumptions.)
- Q: Do we drop the dead dedup/match DB tables and columns via a new Alembic migration 030, or
  leave them? → A: Leave them (lower-risk). No new migration is introduced by this feature; the
  orphaned tables/columns stay at the current Alembic head, unreferenced. A destructive drop is
  deferred to a future migration. (See FR-006a and Assumptions.)
- Q: Do we remove the Phase-2 matched-claim and the `matched` column, or keep them as a harmless
  flag? → A: Keep (lower-risk). Phase 2 matched-claim and the one-way `matched` boolean are
  retained unchanged; removing them would alter per-source schemas and the post-scrape
  orchestrator and break `smoke_test_matched_claim.py`. (See FR-014 and Assumptions.)
- Q: Is collapsing the dual store (per-source tables vs `scraped_jobs`) in scope now, or
  deferred? → A: Deferred (lower-risk). Both stores are retained as-is; unifying them is a
  separate architectural change outside this subtractive reduction. (See Assumptions.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The backend boots and serves search-only (Priority: P1)

An operator starts the backend after the reduction. It comes up cleanly with no import,
registration, or startup-hook references to any removed capability, and reports healthy.

**Why this priority**: Boot + health is the acceptance gate for the whole change; if the backend
cannot start with the removed modules gone, nothing else matters.

**Independent Test**: Start the backend from a clean environment and call the health endpoint;
assert the process starts without error and health reports `ok`. Enumerate the live routes and
confirm none of the removed surfaces are present.

**Acceptance Scenarios**:

1. **Given** the dedup, matching, and profile packages and the dedup/matching/profile/skills/
   job_reports routers, models, and schemas have been removed, **When** the backend starts,
   **Then** it boots with no unresolved import or router-registration referencing a removed
   module, and no startup step references the removed dedup-task cleanup hook.
2. **Given** the backend is running, **When** the health endpoint is called, **Then** it returns
   a healthy status (`status = "ok"`, database reachable) exactly as before.
3. **Given** the backend is running, **When** the set of registered routes is inspected, **Then**
   no dedup, matching, profile, skills, or issue-report routes are served, while the ingest,
   listing, config, extension/run-log, auto-scrape, and admin-cleanup routes remain.

---

### User Story 2 - Scrape, ingest, and browse jobs still work (Priority: P1)

The Chrome extension scrapes jobs and posts them to ingest; a user browses and filters the job
list on the dashboard. All of this behaves as documented in spec 002, minus any dedup/match
data and the issue-report flow.

**Why this priority**: Collecting and listing jobs is the entire remaining purpose of the
system; it must be preserved byte-for-byte in its search-relevant behavior.

**Independent Test**: Post payloads exercising each ingest path (skip-reason, per-source, legacy)
and assert the same routing, ingest-time URL/content-hash dedup, and response fields as spec 002.
List jobs with the same filters and pagination and assert the same result sets and totals — with
the job response no longer carrying dedup/match fields or a `has_report` indicator.

**Acceptance Scenarios**:

1. **Given** the ingest route, **When** the three ingest paths run (skip-reason, per-source,
   legacy), **Then** each writes to the same table and returns the same `id` / `already_exists` /
   `content_duplicate` / `skip_reason` outcomes as spec 002 (ingest-time URL and content-hash
   dedup are **retained** — they are part of ingest, not the removed dedup pipeline).
2. **Given** the listing route, **When** jobs are listed with `dedup_status`, `website`, date,
   and pagination filters, **Then** the same row sets and `{items, total, limit, offset}`
   envelope are returned as spec 002.
3. **Given** the job list/detail responses, **When** a job is returned, **Then** it no longer
   exposes matching or dedup-decision fields (e.g. match level/score/reason, confidence,
   dedup similarity/original pointer, extraction fields) and no longer exposes a `has_report`
   indicator; the search-relevant fields (identity, source, title, company, location,
   description, url, timestamps, ingest-time skip reason) remain.
4. **Given** the issue-report surface has been removed, **When** any `/jobs/reports*` or
   per-job report endpoint is called, **Then** it is not served (no report creation, listing,
   stats, or action flow exists).

---

### User Story 3 - Auto-scrape and post-scrape expiration/claim still run (Priority: P1)

The auto-scrape orchestrator runs cycles end to end, and the post-scrape orchestrator claims
completed cycles and runs Phase 1 (auto-expiration) and Phase 2 (matched-claim), finalizing the
cycle — with no attempt to run the now-removed dedup/matching phases and no post-scan sync-dedup.

**Why this priority**: The auto-scrape orchestrator is explicitly in scope to keep; its behavioral
contract (`smoke_test_auto_scrape.py`, `smoke_test_auto_expiration.py`) is the acceptance gate.

**Independent Test**: Run `smoke_test_auto_scrape.py` and `smoke_test_auto_expiration.py` and
assert both pass unchanged. Drive a completed scan run-log to `completed` and confirm no
sync-dedup background task is scheduled. Drive a cycle from `scrape_complete` and confirm it
reaches `post_scrape_complete` via Phase 1 and Phase 2 alone, with no dedup/matching phase calls.

**Acceptance Scenarios**:

1. **Given** the auto-scrape backend endpoints (state, config, cycle, sessions), **When**
   `smoke_test_auto_scrape.py` runs, **Then** it passes unchanged.
2. **Given** old and fresh per-source rows, **When** `smoke_test_auto_expiration.py` runs,
   **Then** Phase 1 deletes the expired rows and preserves the fresh ones, and the test passes
   unchanged.
3. **Given** a scan run-log transitions to `completed`, **When** the run-log update is handled,
   **Then** **no** post-scan sync-dedup background task is scheduled (that trigger is removed);
   the completion response behaves otherwise as before.
4. **Given** a cycle in `scrape_complete`, **When** the post-scrape orchestrator processes it,
   **Then** it runs the cycle claim → Phase 1 (auto-expiration, writing `cleanup_results`) →
   Phase 2 (matched-claim, writing `claim_summary`) → finalize `post_scrape_complete`, with
   **no** calls to the removed Phase 4–6 stubs (build match-candidates, dedup, matching, compute
   match-results); the persisted cycle output is unchanged from spec 001.

---

### Edge Cases

- **Config file with legacy `llm` / `dedup_mode` keys**: an existing config document that still
  contains the dropped `llm` and/or `dedup_mode` fields MUST NOT cause a load/validation failure;
  the fields are simply not part of the search-only config surface and are ignored.
- **Orphaned dedup/match data at rest**: any pre-existing dedup/match tables, `dedup_tasks`
  rows, or dedup/match columns on `scraped_jobs` remain in the database but are never read or
  written; their presence MUST NOT affect boot, health, listing, or the auto-scrape/post-scrape
  flows.
- **A `scan_all_position != scan_all_total` / final-leg run-log completes**: because the post-scan
  sync-dedup trigger is removed, neither the final-leg nor any run-log completion schedules
  dedup — this is the intended new behavior (auto-scrape already relied on the post-scrape
  orchestrator, not the sync-dedup trigger, per spec 005 KL-2).
- **Client calls a removed endpoint**: requests to any dedup, matching, profile, skills, or
  issue-report path receive a not-found response (the route no longer exists); no removed
  behavior is reachable.
- **Startup with no dedup-task cleanup hook**: the backend startup sequence completes without the
  removed dedup-task cleanup step; the retained startup steps (migrations, stale run-log cleanup,
  stale-cycle cleanup, scheduler, Redis subscriber) run unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Removed capabilities (must no longer exist or run)**

- **FR-001**: The system MUST NOT contain or serve the deduplication pipeline: the dedup package,
  the dedup router and its endpoints, and the dedup models and schemas are removed. No dedup run,
  report, reset, or chain-resolution behavior is reachable.
- **FR-002**: The system MUST NOT contain or serve the matching pipeline: the matching package,
  the matching router and its endpoints, and the matching models and schemas are removed. No
  extraction, gating, scoring, LLM re-scoring, match-status, or match-report behavior is
  reachable.
- **FR-003**: The system MUST NOT contain or serve the profile, skills, and issue-report
  surfaces: the profile package and the profile, skills, and job-reports routers, models, and
  schemas are removed. No profile management, skills, or per-job issue-report behavior is
  reachable.
- **FR-004**: On a scan run-log transitioning to `completed`, the system MUST NOT schedule the
  post-scan sync-dedup background task; that trigger is removed. Run-log completion otherwise
  behaves as before.
- **FR-005**: The post-scrape orchestrator MUST NOT invoke the Phase 4–6 stubs (build
  match-candidates, dedup-for-cycle, matching-for-cycle, compute-match-results). Those calls are
  removed from the cycle flow; the cycle output (`cleanup_results`, `match_results` containing
  the Phase 2 `claim_summary`, terminal `post_scrape_complete`) is unchanged.
- **FR-006**: The configuration surface MUST NOT include the `llm` or `dedup_mode` fields; they
  are dropped from the config schema. A config document that still carries these keys MUST load
  without error (the extra keys are ignored, not rejected).
- **FR-006a**: This feature MUST NOT introduce a destructive database migration. No new Alembic
  migration is created to drop the dead dedup/match tables or the dedup/match columns on
  `scraped_jobs`; the database schema stays at its current head, with those objects orphaned and
  unreferenced. (Dropping them is deferred to a future, separate migration.)
- **FR-007**: The application entry point MUST NOT register any removed router and MUST NOT run
  the removed dedup-task cleanup startup hook. No import or registration referencing a removed
  module remains.
- **FR-008**: The job **response schema** MUST NOT expose dedup-decision or matching fields
  (e.g. dedup similarity score, dedup original-job pointer, match level/reason/score, confidence,
  extraction fields, match skip reason, matching mode, removal stage, `jd_incomplete`,
  `matched_at`) or the `has_report` indicator. These are pruned from the `scraped_job` response
  schema (`ScrapedJobRead`/`ScrapedJobDetail`) and from `JobUpdate`. The vestigial match/dedup
  **listing query-filter parameters** on `GET /jobs` (e.g. `skip_reason_filter`,
  `match_skip_reason_filter`, `blacklist_filter`, `blacklist_reason`, `dedup_type`,
  `removal_stage`, `matching_mode`, `match_level`, `match_status`, `llm_step_d`, `jd_incomplete`,
  and the `order_by=fit_score` sort) are ALSO removed; the retained `dedup_status` filter is
  simplified to reference only `skip_reason`/`dismissed` (behavior-identical while the match
  columns are always null). Search-relevant filters (`website`, `dismissed`, `scan_run_id`,
  `easy_apply`, posting/scrape date ranges) remain.

**Retained capabilities (must keep working unchanged)**

- **FR-009**: Job ingest MUST keep working exactly as documented in spec 002: the three ingest
  paths (skip-reason, per-source, legacy), per-source routing to the correct table, and the
  **ingest-time** URL-duplicate and content-hash dedup (which are part of ingest, distinct from
  the removed dedup pipeline) all behave unchanged, including the same response fields.
- **FR-010**: Job listing, detail, and partial update MUST keep working as documented in
  spec 002 — the same `dedup_status` (`passed`/`removed`/`all`/default) and optional filters,
  sorting, pagination, and `{items, total, limit, offset}` envelope — except that the response no
  longer carries the fields pruned in FR-008 and there is no `has_report` computation.
- **FR-011**: Configuration read and write MUST keep working for all retained fields; only `llm`
  and `dedup_mode` are removed from the surface.
- **FR-012**: The extension/run-log surface and search run-logs MUST keep working unchanged,
  except for the removed post-scan sync-dedup trigger (FR-004).
- **FR-013**: The auto-scrape orchestrator (cycle trigger, probes, matrix loop, scan polling,
  status transitions, Redis wake, hardening, scheduling, and cleanup) MUST keep working as
  documented in spec 005; its backend endpoint contract MUST continue to pass
  `smoke_test_auto_scrape.py` unchanged.
- **FR-014**: The post-scrape orchestrator MUST keep working as documented in spec 001 for the
  cycle claim, Phase 1 (auto-expiration), Phase 2 (matched-claim), heartbeat, finalization, and
  the stale-cycle reaper — with the removed Phase 4–6 calls (FR-005) as the only difference. The
  Phase 2 matched-claim and the per-source `matched` boolean column MUST be **retained**
  unchanged (they are part of the kept post-scrape flow, not the removed matching pipeline).
- **FR-015**: The health endpoint MUST keep working unchanged (reporting overall and database
  status).

**Acceptance**

- **FR-016**: After the reduction, the backend MUST boot successfully, the health endpoint MUST
  report `ok`, and `smoke_test_auto_scrape.py` and `smoke_test_auto_expiration.py` MUST both
  pass unchanged.

### Key Entities

- **`scraped_jobs`**: the legacy unified job store, remaining the sole backing table for ingest
  (skip-reason/legacy paths) and all job listing/detail/update. Its search-relevant columns are
  retained and exposed; its dedup/match-decision columns remain physically present but are no
  longer read, written, or exposed (see Assumptions).
- **Per-source tables** (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`): retained as the
  per-source ingest store and the subject of Phase 1 expiration and Phase 2 matched-claim.
- **Search configuration**: the retained config surface (scan keywords, sites, blacklists, and
  other search-relevant settings), minus the removed `llm` and `dedup_mode` fields.
- **`extension_run_logs`**: retained search run-log records driving auto-scrape and post-scrape.
- **`auto_scrape_cycles` / `auto_scrape_state` / `auto_scrape_config` / `site_session_state`**:
  retained; the cycle output (`cleanup_results`, `match_results.claim_summary`,
  `post_scrape_complete`) is unchanged.
- **Removed entities**: dedup reports/tasks, match reports, skill candidates, and job reports —
  no longer part of the application (their tables, if present, are orphaned and unreferenced).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The backend starts from a clean environment with zero import, router-registration,
  or startup-hook references to any removed module (dedup, matching, profile, skills, job_reports,
  dedup-task cleanup), and the health endpoint returns `ok`.
- **SC-002**: `smoke_test_auto_scrape.py` and `smoke_test_auto_expiration.py` both pass unchanged
  against the reduced backend.
- **SC-003**: Enumerating the served routes shows **zero** dedup, matching, profile, skills, or
  issue-report endpoints, and the ingest, listing, config, extension/run-log, auto-scrape, and
  admin-cleanup endpoints all remain served.
- **SC-004**: For each of the three ingest paths, a representative payload produces the same
  table target, ingest-time dedup behavior, and response fields as spec 002; and a job listed or
  fetched afterward carries none of the pruned dedup/match fields and no `has_report` indicator.
- **SC-005**: A scan run-log transition to `completed` schedules **no** sync-dedup task, and a
  cycle processed from `scrape_complete` reaches `post_scrape_complete` through Phase 1 and
  Phase 2 only, with the same persisted output as spec 001 (no dedup/matching phase side effects).
- **SC-006**: A configuration document that still contains legacy `llm` and/or `dedup_mode` keys
  loads without error, and neither field is present in the config surface after the reduction.

## Assumptions

- **No destructive schema migration (resolved)**: this change removes the application-level
  surface only and introduces **no new Alembic migration** (no migration 030 that drops objects).
  The dedup/match tables (e.g. dedup reports/tasks, match reports, skill candidates, job reports)
  and the dedup/match columns on `scraped_jobs` remain in the database at the current head,
  orphaned and unreferenced. Physically dropping them is deferred to a future, separate migration
  (FR-006a).
- **Phase 2 matched-claim and `matched` column retained (resolved)**: the per-source `matched`
  boolean and the Phase 2 matched-claim behavior are kept as-is (a harmless one-way flag), not
  removed. This keeps the post-scrape flow and `smoke_test_matched_claim.py` intact (FR-014).
- **Dual store not collapsed (resolved, deferred)**: the two job stores — the per-source tables
  (`linkedin_jobs`/`indeed_jobs`/`glassdoor_jobs`) and the legacy unified `scraped_jobs` — are
  both retained with their current split (spec 002 KL-1). Unifying/collapsing them is a separate
  architectural change and is explicitly **out of scope** for this subtractive reduction.
- **Issue-report flow is removed with the read path preserved**: removing the `job_reports`
  router/model/schema removes the per-job `has_report` indicator and the `/jobs/reports*` and
  per-job report endpoints. The core ingest/listing/detail/update behavior of spec 002 is
  otherwise preserved. This is treated as an intended consequence of the explicit removal list,
  not a regression.
- **Ingest-time dedup is not the dedup pipeline**: the URL-duplicate and content-hash dedup that
  happen inside `POST /jobs/ingest` (spec 002 FR-007/FR-008) are part of ingest and are retained;
  only the separate dedup *pipeline* (spec 003) is removed.
- **`smoke_test_matched_claim.py` is unaffected**: Phase 2 matched-claim is retained (spec 001),
  so this test is expected to continue passing, but only `smoke_test_auto_scrape.py` and
  `smoke_test_auto_expiration.py` are the stated acceptance gates for this feature.
- **The redesign is deferred**: dedup and matching are removed pending a future redesign; this
  feature does not attempt to preserve or migrate any dedup/match state or results.
- "As described" refers to the retained behavior documented in the as-built baselines
  `specs/001`, `specs/002`, and `specs/005`; this feature introduces no new behavior beyond the
  removals and the fields/endpoints they take with them.
