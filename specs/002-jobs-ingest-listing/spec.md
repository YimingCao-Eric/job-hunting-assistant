# Feature Specification: Jobs Ingest & Job-Listing Routes (As-Built)

**Feature Branch**: `docs/spec-baseline`

**Created**: 2026-07-14

**Status**: As-Built Baseline (documents current behavior; proposes no changes)

**Input**: User description: "Produce an AS-BUILT specification of the CURRENT behavior of the jobs/ingest and job-listing routes."

---

## Overview *(as-built context)*

This is an **as-built specification** (Constitution Principle I) of the HTTP routes in
`backend/routers/jobs.py` and `backend/routers/job_reports.py`. It documents exactly what the
code does today, including known limitations and surprising behavior; it proposes no changes.
Where prior prose docs disagree with the code, the code is authoritative.

**Scope:**

- `POST /jobs/ingest` — the three ingest paths and how a payload is routed to the correct
  per-source table (`linkedin_jobs` / `indeed_jobs` / `glassdoor_jobs`) or to the legacy
  `scraped_jobs` table, the ingest-time URL and content-hash dedup, and the
  `LINKEDIN_COLS` / `INDEED_COLS` / `GLASSDOOR_COLS` mapping contract.
- `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/skipped`, `PUT /jobs/{id}` — listing, filtering,
  the `has_report` indicator, detail, and partial update.
- The issue-report flow: `POST /jobs/{id}/report`, `GET /jobs/reports`,
  `GET /jobs/reports/stats`, `PUT /jobs/reports/{id}/action`.

**Out of scope (named only where they interact):** the dedup pipeline (`POST /jobs/dedup*`),
the matching endpoints (`/jobs/match*`), and the per-source post-scrape orchestrator (covered
by spec `001-post-scrape-phases-1-2`).

**Two data stores, one prefix.** A structural fact that governs everything below:
`POST /jobs/ingest` writes to **either** a per-source table (when `source_raw` is present)
**or** the legacy unified `scraped_jobs` table (skip-reason and fallback paths). But
`GET /jobs`, `GET /jobs/{id}`, `GET /jobs/skipped`, and `PUT /jobs/{id}` read/write **only
`scraped_jobs`**. Per-source-ingested rows are therefore **not** visible through the listing
routes (see KL-1).

**Authentication.** Every route in both files depends on `get_current_user` (bearer auth);
none is exempt (Constitution Principle VII — only `/health`, defined elsewhere, is exempt).

## Clarifications

### Session 2026-07-14

Authored directly from source (`routers/jobs.py`, `routers/job_reports.py`,
`schemas/scraped_job.py`, `schemas/job_report.py`) plus `docs/current-schemas.md` (CC-7 and the
`*_COLS` constants) and the API/ingest sections of `README.md`. No open questions required a
user decision; behavior was fully determined by the code.

**Verification pass (against `routers/jobs.py` and `routers/job_reports.py`):**

- Finding: the `*_COLS` constants disagree with the column enumeration in
  `docs/current-schemas.md`. → Correction: the constants are the **INSERT column subset**, not
  the full table. `LINKEDIN_COLS` inserts 36 columns but the doc documents 51; `INDEED_COLS`
  inserts 42 but the doc documents 61. Server-defaulted columns (`id`, `scrape_time`,
  `matched`) and ~a dozen site-specific columns that exist in the table are never written at
  ingest. `current-schemas.md:44` calling the constants "the live source of truth" for current
  columns conflates the INSERT list with the table shape. Captured as **DD-1**; FR-009 and Key
  Entities wording tightened to say "INSERT column list."
- Finding: the user asked about a "dual-write to legacy `scraped_jobs`." → Correction: **there
  is no dual-write.** Each `POST /jobs/ingest` request writes **exactly one** table — the
  per-source path returns immediately after its insert and never also writes `scraped_jobs`;
  the skip-reason and legacy paths write only `scraped_jobs`. This mutual exclusivity is the
  basis of KL-1. Stated explicitly in FR-004 and a new edge case.
- Finding: error-handling omissions. → Correction: documented the outer handler
  (`except HTTPException: raise`; `except Exception:` logs `ingest_error` and re-raises → 500)
  and the Indeed DB-level `CHECK (mosaic_present OR graphql_present)` that backs the app-level
  400 (defense in depth). Added to edge cases / DD.
- Verified with no discrepancy: path precedence (FR-001), the three per-source guards
  (FR-003), the CC-7 `ON CONFLICT (job_url) DO NOTHING` + CTE/`UNION ALL` `already_exists`
  pattern (FR-005), legacy URL then content-hash dedup reachable only when `source_raw is None`
  (FR-007/008), synthesized Indeed/Glassdoor `job_url` (KL-3), bearer auth on every route in
  both files (FR-020), the report upsert/validation/dismiss flow (FR-016…FR-019), and
  `SC-004`'s per-site `len(*_COLS) == len(build_*_params keys)` equality.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ingest a scraped job to the correct store (Priority: P1)

The Chrome extension posts one scraped job to `POST /jobs/ingest`. The backend decides, from
the payload, which of three paths to take and which table to write, deduplicating at ingest.

**Why this priority**: Ingest is the entry point for every job the system knows about; routing
and dedup correctness determine what downstream stages see.

**Independent Test**: Post payloads exercising each path (a `skip_reason` payload; a
per-source `source_raw` payload for each of the three sites; a legacy payload with only
`job_url`/`job_description`) and assert the response `id` / `already_exists` /
`content_duplicate` / `skip_reason` and the row landing in the expected table.

**Acceptance Scenarios**:

1. **Given** a payload with a non-empty `skip_reason`, **When** posted, **Then** a
   `scraped_jobs` row is written with `job_url = NULL` and `ingest_source = "extension"`, all
   dedup and per-source routing are bypassed, and the response is
   `{already_exists: false, content_duplicate: false, skip_reason: <the skip_reason>}`.
2. **Given** a payload with `source_raw` present, `website ∈ {linkedin, indeed, glassdoor}`,
   and `scan_run_id` set, **When** posted, **Then** the site-specific flattener builds the row,
   it is inserted into the matching per-source table via
   `INSERT … ON CONFLICT (job_url) DO NOTHING` (CC-7), and the response reports
   `already_exists = false` (new) or `true` (URL already present), always with
   `content_duplicate = false`.
3. **Given** a per-source payload whose `website` is not one of the three supported sites,
   **When** posted, **Then** the request is rejected with HTTP 400 ("Unsupported website for
   per-source ingest").
4. **Given** a per-source payload missing `scan_run_id`, **When** posted, **Then** it is
   rejected with HTTP 400 ("scan_run_id required for per-source ingest").
5. **Given** `source_raw` is absent (legacy fallback) and `job_url` matches an existing
   `scraped_jobs` row, **When** posted, **Then** no row is written and the response is
   `{already_exists: true, content_duplicate: false, skip_reason: "url_duplicate"}`.
6. **Given** `source_raw` is absent and `job_url` does not match, **When** posted, **Then** a
   new `scraped_jobs` row is written with `raw_description_hash = sha256(trim(lower(jd)))`;
   `content_duplicate` is `true` iff another row already had that hash, and when true
   `original_job_id` is set to that prior row's id.

---

### User Story 2 - Browse and filter the job list (Priority: P1)

A user (via the React dashboard) lists jobs with filters, sees which jobs have a pending issue
report, and opens details.

**Why this priority**: This is the primary read path the dashboard depends on; its filter
semantics define what "passed / removed" mean to the user.

**Independent Test**: Seed `scraped_jobs` rows with varied `skip_reason` / `dismissed` /
`match_*` values and a pending `job_reports` row, then call `GET /jobs` with different
`dedup_status`, `website`, and date filters and assert the returned set, `total`, and each
item's `has_report`.

**Acceptance Scenarios**:

1. **Given** no `dedup_status` param, **When** `GET /jobs` runs, **Then** only rows with
   `skip_reason IS NULL` are returned (the implicit default filter).
2. **Given** `dedup_status = "passed"`, **When** listed, **Then** only rows with
   `skip_reason IS NULL AND match_skip_reason IS NULL AND dismissed = false` are returned;
   `"removed"` returns rows with any of `skip_reason`, `match_skip_reason`, or `dismissed`;
   `"all"` applies no dedup filter.
3. **Given** a job with a pending `job_reports` row, **When** listed or fetched by id, **Then**
   that item's `has_report` is `true`; a job with only actioned/dismissed reports has
   `has_report = false` (pending-only semantics).
4. **Given** `order_by = "fit_score"`, **When** listed, **Then** rows sort by `fit_score`
   descending with NULLs last, then `created_at` descending; otherwise the default sort is
   `created_at` descending.
5. **Given** `limit` and `offset`, **When** listed, **Then** the response is
   `{items, total, limit, offset}` where `total` is the unpaginated count under the same
   filters, and `limit` is clamped to `1..500` (default 25), `offset ≥ 0`.
6. **Given** a non-existent job id, **When** `GET /jobs/{id}` runs, **Then** it returns
   HTTP 404 ("Job not found").

---

### User Story 3 - File and manage an issue report on a job (Priority: P2)

A user flags a job's match result as wrong (wrong match level, YOE, missing/false skills, wrong
gate, or other). Reviewers list, count, and dismiss these reports.

**Why this priority**: A feedback channel on match quality; secondary to ingest and listing but
a complete, self-contained flow.

**Independent Test**: `POST /jobs/{id}/report` for each `report_type`, assert validation and
the at-most-one-pending-per-type upsert; then `GET /jobs/reports`, `/reports/stats`, and
`PUT /reports/{id}/action` with `dismiss`.

**Acceptance Scenarios**:

1. **Given** an existing job and a valid `report_type` with a valid `detail`, **When**
   `POST /jobs/{id}/report` runs and no pending report of that type exists, **Then** a new
   `pending` `job_reports` row is created and returned with joined job fields (title, company,
   match level, etc.); `scraped_jobs` is **not** modified.
2. **Given** a pending report of the same `(job_id, report_type)` already exists, **When**
   another is posted, **Then** the existing row's `detail` is updated in place (upsert — at
   most one pending per job per type) rather than creating a second row.
3. **Given** `report_type = "wrong_gate"` on a job with both `match_skip_reason` and
   `removal_stage` NULL, **When** posted, **Then** it is rejected with HTTP 422.
4. **Given** an invalid `detail` (e.g. `note` > 200 chars, `skills` on a non-skill report,
   `suggested_level`/`gate_name` outside the allowed sets, or an unknown detail key), **When**
   posted, **Then** it is rejected with HTTP 400 with a field-specific message.
5. **Given** a report id, **When** `PUT /jobs/reports/{id}/action` with `action = "dismiss"`,
   **Then** its `status` becomes `dismissed` and `actioned_at` is set; any other action returns
   HTTP 400, and a missing id returns HTTP 404.

---

### Edge Cases

- **Both `skip_reason` and `source_raw` present**: the `skip_reason` path wins (it is checked
  first) — the row goes to `scraped_jobs` with `job_url = NULL`, and `source_raw` is ignored
  for routing.
- **LinkedIn `source_raw` missing `data.jobPostingUrl`**: HTTP 400 ("LinkedIn ingest missing
  jobPostingUrl").
- **Indeed `source_raw` with both `mosaic` and `graphql` null/missing**: HTTP 400 at the app
  layer (`build_indeed_params`); the `indeed_jobs` table also has a DB
  `CHECK (mosaic_present OR graphql_present)` as a second line of defense. Missing `jobkey`
  (from mosaic or graphql): HTTP 400. The stored `job_url` is **synthesized** as
  `https://ca.indeed.com/viewjob?jk=<jobkey>`, not the client-sent `job_url`.
- **Glassdoor `source_raw` missing `jobDetailsData.listingId`**: HTTP 400. The stored
  `job_url` is synthesized as `https://www.glassdoor.ca/job-listing/listing-<id>.htm?jl=<id>`.
- **Malformed `source_raw` shape**: an `AttributeError`/`TypeError` raised while flattening is
  caught and returned as HTTP 400 ("Malformed source_raw for website=<site>"). Other exception
  types are not caught here; the outer `try/except` in `ingest_job` re-raises `HTTPException`
  unchanged and, for any other `Exception`, logs an `ingest_error` record (type, message,
  context, elapsed ms) and re-raises — surfacing as HTTP 500.
- **Single-table write per request**: no ingest path writes more than one table. A per-source
  scan carrying a `skip_reason` writes only `scraped_jobs` (skip path wins); a normal
  per-source scan writes only its per-source table; a legacy payload writes only `scraped_jobs`.
- **Empty/whitespace `job_description`** on the legacy path: normalized to `NULL` before
  hashing, so all empty-JD jobs share the hash of the empty string and collide as
  `content_duplicate` with each other.
- **URL dedup scope**: the legacy `job_url` duplicate check queries **only `scraped_jobs`**, and
  each per-source table enforces `job_url` uniqueness **only within itself** (CC-7). There is no
  cross-table global URL uniqueness.
- **Per-source path never sets `content_duplicate`**: the response's `content_duplicate` is
  always `false` for per-source ingest; content-hash dedup applies only on the legacy path.
- **`GET /jobs` returns nothing for per-source rows**: because it reads `scraped_jobs` only
  (KL-1).
- **Report on a non-existent job**: HTTP 404 before any validation.
- **Invalid `report_type` filter** on `GET /jobs/reports`: HTTP 400.

## Requirements *(mandatory)*

### Functional Requirements

**Ingest routing & paths (`POST /jobs/ingest`)**

- **FR-001**: The system MUST evaluate ingest paths in this fixed precedence: (1) if
  `skip_reason` is truthy → skip-reason path; else (2) if `source_raw` is not `None` →
  per-source path; else (3) legacy `scraped_jobs` path. `job_title` defaults to `"Unknown"`
  when falsy.
- **FR-002** (skip-reason path): The system MUST write a `scraped_jobs` row from the payload
  (excluding `source_raw`) with `job_url` forced to `NULL` and `ingest_source = "extension"`,
  perform no dedup, and respond `{already_exists: false, content_duplicate: false,
  skip_reason: <payload skip_reason>}`.
- **FR-003** (per-source guard): On the per-source path the system MUST reject
  `website ∉ {linkedin, indeed, glassdoor}` (case-insensitive, trimmed) with HTTP 400, and MUST
  reject a missing `scan_run_id` with HTTP 400.
- **FR-004** (per-source routing): The system MUST route by normalized `website` to
  `build_linkedin_params` → `linkedin_jobs`, `build_indeed_params` → `indeed_jobs`, or
  `build_glassdoor_params` → `glassdoor_jobs`, execute the corresponding
  `INSERT_<SITE>_JOB` statement, and return `{id, already_exists, content_duplicate: false,
  skip_reason: null}` — returning immediately. The per-source path MUST NOT also write
  `scraped_jobs`: each ingest request writes **exactly one** table (there is no dual-write).
- **FR-005** (CC-7 dedup): Each `INSERT_<SITE>_JOB` MUST use
  `INSERT INTO <table> (...) VALUES (...) ON CONFLICT (job_url) DO NOTHING RETURNING id`,
  wrapped in a CTE that `UNION ALL`s a lookup of the existing row so the statement returns
  exactly one `(id, already_exists)` — `already_exists = false` for a fresh insert, `true` when
  the `job_url` already existed (re-scrape silently no-ops).
- **FR-006** (malformed handling): While building per-source params, an `AttributeError` or
  `TypeError` MUST be caught and returned as HTTP 400 ("Malformed source_raw…"); site-specific
  missing-key conditions MUST raise HTTP 400 (LinkedIn `jobPostingUrl`; Indeed
  mosaic+graphql-both-missing and `jobkey`; Glassdoor `listingId`).
- **FR-007** (legacy URL dedup): On the legacy path, if `job_url` is set and a `scraped_jobs`
  row already has that `job_url`, the system MUST return that row's id with
  `{already_exists: true, content_duplicate: false, skip_reason: "url_duplicate"}` and write
  nothing.
- **FR-008** (legacy content-hash dedup): Otherwise the system MUST normalize
  empty/whitespace `job_description` to `NULL`, compute
  `raw_description_hash = sha256(trim(lower(job_description or "")))`, set `content_duplicate`
  `true` iff a `scraped_jobs` row already has that hash, insert a new `scraped_jobs` row with
  the hash, `ingest_source = "extension"`, and `original_job_id` = the matching row's id (when
  a content duplicate) or `NULL`, and respond with `skip_reason` = the row's own `skip_reason`
  or `"content_duplicate"` when a content duplicate (else `null`).

**`*_COLS` mapping contract**

- **FR-009**: `LINKEDIN_COLS`, `INDEED_COLS`, and `GLASSDOOR_COLS` MUST be the single source of
  truth for each table's **INSERT column list and order** (the columns written at ingest — a
  subset of the full table shape; see DD-1); the `VALUES (:col, …)` placeholders and the
  `build_<site>_params` dict keys MUST match those lists exactly (one param per column, same
  names).
- **FR-010**: Columns listed in `LINKEDIN_JSONB_COLS` / `INDEED_JSONB_COLS` /
  `GLASSDOOR_JSONB_COLS` MUST be bound as `JSONB(none_as_null=True)` so Python dicts/lists
  serialize as JSON (and empty/sentinel values become SQL `NULL` via `_jsonb_or_null`).
- **FR-011**: Value coercion MUST follow the helpers: `_to_str_or_none` (numbers→str for VARCHAR,
  else pass-through/`None`), `_to_int_or_none` (numeric strings/floats→int, bool/non-numeric→
  `None`), `_jsonb_or_null` (empty list/dict/bool→`None`), `_parse_iso_date` (ISO `YYYY-MM-DD`
  prefix→`date`, unparseable→`None` with a warning). Per CC-10/CC-11, salary and nested values
  are stored faithfully to source vocabulary; no normalization at ingest.

**Listing & detail (`GET /jobs`, `/jobs/{id}`, `/jobs/skipped`, `PUT /jobs/{id}`)**

- **FR-012**: `GET /jobs` MUST query the `scraped_jobs` table only, apply the default filter
  `skip_reason IS NULL` when `dedup_status` is unset, and otherwise apply the
  `passed` / `removed` / `all` semantics defined in US2/AC2, plus the many optional filters
  (`website`, `dismissed`, `scan_run_id`, `easy_apply`, posting-date `date_from/to`,
  scrape-date `scraped_from/to`, `skip_reason_filter`, `match_skip_reason_filter`,
  `blacklist_filter`, `blacklist_reason`, `dedup_type`, `removal_stage`, `matching_mode`,
  `match_level`, `match_status`, `llm_step_d`, `jd_incomplete`).
- **FR-013**: `GET /jobs` MUST compute each item's `has_report` from a correlated `EXISTS` over
  `job_reports` where `job_id` matches and `status = "pending"`, sort per `order_by`
  (`fit_score` desc nulls-last then `created_at` desc, else `created_at` desc), paginate with
  `limit` (1..500, default 25) / `offset` (≥0), and return `{items, total, limit, offset}`.
- **FR-014**: `GET /jobs/{id}` MUST return the `scraped_jobs` row (404 if absent) as
  `ScrapedJobDetail` (including `voyager_raw`) with `has_report` computed as in FR-013;
  `GET /jobs/skipped` MUST return `scraped_jobs` rows for a required `scan_run_id` having
  `skip_reason IS NOT NULL`, newest first, paginated.
- **FR-015**: `PUT /jobs/{id}` MUST partially update a `scraped_jobs` row (404 if absent) from
  the provided fields only (`exclude_unset`), after remapping legacy aliases
  (`extracted_salary_min` → `salary_min_extracted`, `match_confidence` → `confidence`), and
  return the updated row.

**Issue reports (`job_reports.py`)**

- **FR-016**: `POST /jobs/{job_id}/report` MUST 404 if the job is absent; MUST 422 for
  `report_type = "wrong_gate"` unless the job has `match_skip_reason` or `removal_stage` set;
  MUST validate `detail` via `_validate_detail` (per-type field rules; `note` ≤ 200 chars;
  `skills` only on `missing_skills`/`false_skills`, ≤ 10 items each ≤ 50 chars;
  `suggested_level` ∈ MATCH_LEVEL_VALUES only on `match_level`; `actual_yoe` numeric only on
  `yoe`; `gate_name` ∈ GATE_NAME_VALUES only on `wrong_gate`; unknown keys → 400).
- **FR-017**: `POST /jobs/{job_id}/report` MUST enforce at most one `pending` report per
  `(job_id, report_type)`: if one exists, update its `detail`; otherwise insert a new `pending`
  row. It MUST NOT modify `scraped_jobs`. The response is `JobReportRead` with joined job fields.
- **FR-018**: `GET /jobs/reports` MUST filter by `status` (`pending`/`actioned`/`dismissed`/
  `all`, default `pending`) and optional `report_type` (400 if invalid), join `scraped_jobs`,
  order by `created_at` desc, paginate, and return `{items, total}`.
  `GET /jobs/reports/stats` MUST return `{pending, by_type (pending counts, all report types
  zero-initialized), total}`.
- **FR-019**: `PUT /jobs/reports/{report_id}/action` (integer `report_id`) MUST 404 if absent;
  for `action = "dismiss"` set `status = "dismissed"` and `actioned_at = now`; any other action
  MUST return HTTP 400.

**Cross-cutting**

- **FR-020**: Every route in `jobs.py` and `job_reports.py` MUST require bearer auth via
  `get_current_user`.

### Known Limitations *(as-built; not defects to fix in this round)*

- **KL-1 — Per-source rows are invisible to the listing routes**: `POST /jobs/ingest` writes
  per-source tables when `source_raw` is present, but `GET /jobs`, `GET /jobs/{id}`,
  `GET /jobs/skipped`, and `PUT /jobs/{id}` operate solely on `scraped_jobs`. A per-source
  ingested job cannot be listed, fetched, updated, or reported through these routes.
- **KL-2 — `content_duplicate` is legacy-path only**: the flag is always `false` for
  per-source ingest even if an identical description was seen; content-hash dedup exists only
  on the `scraped_jobs` path.
- **KL-3 — Dedup key mismatch on Indeed/Glassdoor**: the CC-7 uniqueness/`ON CONFLICT` key is a
  **synthesized** `job_url` (from `jobkey` / `listingId`), not the client-sent `job_url`; the
  client `job_url` field is unused for per-source routing.
- **KL-4 — Empty-JD hash collisions**: whitespace/empty `job_description` normalizes to `NULL`,
  so every empty-JD legacy job hashes to the empty-string digest and flags every subsequent one
  as a `content_duplicate` of the first.
- **KL-5 — Skip-reason rows drop `job_url`**: the skip-reason path forces `job_url = NULL`
  regardless of the payload, so those rows never participate in URL dedup.
- **KL-6 — Non-`AttributeError`/`TypeError` malformations surface as 500**: only those two
  exception types are converted to 400 during flattening; anything else propagates.

### Documentation Discrepancy *(as-built note)*

- **DD-1 — `*_COLS` constants are the INSERT subset, not the full table**: `LINKEDIN_COLS`,
  `INDEED_COLS`, and `GLASSDOOR_COLS` list only the columns written at ingest. `LINKEDIN_COLS`
  has 36 entries; `INDEED_COLS` has 42. But `docs/current-schemas.md` documents the tables at
  **51** (linkedin) and **61** (indeed) columns and (line 44) calls the constants "the live
  source of truth" for current columns. The gap is (a) server-defaulted common columns not in
  the INSERT list (`id`, `scrape_time`, `matched`) and (b) site-specific columns that exist in
  the table but are never populated at ingest — e.g. for LinkedIn: `job_state`, `expire_at`,
  `closed_at`, `job_application_limit_reached`, `postal_address`, `standardized_addresses`,
  `job_region`, `top_level_company_apply_url`, `benefits`, `title_entity_urn`,
  `employment_status_label`, `employment_status_entity_urn`, `workplace_type_entity_urn`; for
  Indeed: `more_loc_url`, `create_date`, `expired`, `display_title`, `salary_text`,
  `indeed_applyable`, and others. The constants are authoritative for **what ingest writes**;
  the schema doc is authoritative for **what columns the table has**. They are not the same set,
  and the doc's "source of truth" phrasing blurs that. This spec follows the code: the `*_COLS`
  contract (FR-009, SC-004) is about the INSERT list only.

### Key Entities

- **`scraped_jobs` (legacy unified table)**: the store for the skip-reason and legacy fallback
  ingest paths and the sole backing table for all `GET/PUT /jobs*` routes. Notable columns:
  `id` (UUID), `website`, `job_title`, `company`, `location`, `job_description`, `job_url`
  (nullable), `raw_description_hash`, `ingest_source`, `scan_run_id`, `original_job_id`
  (ingest-time content-duplicate pointer), `dismissed`, `skip_reason`, `match_skip_reason`,
  `removal_stage`, `match_level`, `fit_score`, `matching_mode`, `dedup_similarity_score`,
  `dedup_original_job_id`, `jd_incomplete`, `created_at`, `updated_at`.
- **Per-source tables** (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`): the store for the
  per-source ingest path. Their **insert** columns are defined by `LINKEDIN_COLS` /
  `INDEED_COLS` / `GLASSDOOR_COLS` (a subset of the full table — see DD-1); every table carries
  the common prefix (`id`, `scan_run_id`, `job_url` UNIQUE, `scrape_time`, `source_raw`,
  `matched`). Governed by CC-1…CC-12.
- **`job_reports`**: user-submitted issue reports. Columns: integer `id`, `job_id` (FK →
  `scraped_jobs`), `report_type` ∈ REPORT_TYPES, `detail` (validated JSONB), `status`
  (`pending`/`actioned`/`dismissed`), `actioned_at`, `created_at`. `has_report` on job
  responses reflects **pending** rows only.
- **Ingest request/response**: `ScrapedJobIngest` (accepts both legacy unified fields and
  `source_raw`; `website` default `"linkedin"`, `easy_apply` default `false`) and
  `ScrapedJobIngestResponse` (`id`, `already_exists`, `content_duplicate`, `skip_reason`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every functional requirement (FR-001…FR-020) is traceable to a specific line/area
  in `routers/jobs.py` or `routers/job_reports.py` with no contradiction.
- **SC-002**: For each of the three ingest paths, a reviewer can post a representative payload
  and observe the documented table target, dedup behavior, and response fields exactly.
- **SC-003**: `GET /jobs` with each `dedup_status` value (`unset`/`passed`/`removed`/`all`)
  returns precisely the row set defined in US2/AC2, and `has_report` matches the presence of a
  pending `job_reports` row.
- **SC-004**: The `*_COLS` contract holds: for each site, `len(<SITE>_COLS)` equals the number
  of `build_<site>_params` keys and the two are the same set, and JSONB columns are exactly
  those in `<SITE>_JSONB_COLS` (consistency check passes with zero mismatches).
- **SC-005**: Each Known Limitation (KL-1…KL-6) and the discrepancy (DD-1) is reproducible
  against the current code/schema and none describes an intended future design. In particular,
  `len(LINKEDIN_COLS) == 36` and `len(INDEED_COLS) == 42`, both smaller than the 51/61 column
  counts in `docs/current-schemas.md`.

## Assumptions

- The `scraped_jobs`, per-source, and `job_reports` tables exist at the current Alembic head
  (per-source tables through migration 029; `matched` via 028), consistent with
  `docs/current-schemas.md`.
- "As implemented" refers to the code on branch `docs/spec-baseline` at 2026-07-14; this spec
  introduces no requirements beyond describing existing behavior.
- Bearer auth (`get_current_user`) is configured; request bodies validate against the Pydantic
  schemas in `schemas/scraped_job.py` and `schemas/job_report.py` before route logic runs.
- There is no dedicated smoke test named for these routes in scope; behavior is documented from
  the source and the README API contract. (The broader `smoke_test_auto_scrape.py` exercises
  some `/jobs` endpoints at the HTTP level but is not a targeted contract for this spec.)
