# Feature Specification: Dedup Pipeline (As-Built)

**Feature Branch**: `docs/spec-baseline`

**Created**: 2026-07-14

**Status**: As-Built Baseline (documents current behavior; proposes no changes)

**Input**: User description: "Produce an AS-BUILT specification of the CURRENT dedup pipeline."

---

## Overview *(as-built context)*

This is an **as-built specification** (Constitution Principle I) of the dedup pipeline in
`backend/dedup/service.py` and its HTTP surface in `backend/routers/dedup.py` (with the
post-scan trigger in `backend/routers/extension.py`). It documents what the code does today,
including known limitations and surprising behavior; it proposes no changes. Where prose docs
disagree with the code, the code is authoritative.

**Scope:**

- The two entry points: **manual** `POST /jobs/dedup` (synchronous) and **post-scan sync
  dedup** (background task on scan-run completion).
- The three-pass algorithm inside `run_dedup`: **Pass 0** (metadata filter gates), **Pass 1**
  (JD content filter gates), **Pass 2** (duplicate detection: `hash_exact` → `cosine`).
- How `skip_reason`, `dedup_similarity_score`, and `dedup_original_job_id` are written.
- In-run **chain resolution** (`_resolve_chains`) and the standalone DB repair
  `POST /jobs/dedup/resolve-chains` (`resolve_dedup_chains_in_db`).
- The `dedup_reports` metrics (`gate_results`, `skip_reason_counts`, totals, `duration_ms`),
  the `debug_log` ring buffer, and the report/reset routes.

**Terminology note (as-built).** Despite the name "dedup," only **Pass 2** does duplicate
detection. **Pass 0 and Pass 1 are content/metadata *filter* gates** (blacklists, job-type,
contract/remote/sponsorship/agency, title-mismatch) that assign non-duplicate `skip_reason`s.
The pipeline is really "filter + dedup" run as one pass (see KL-1).

**Store note (as-built).** The entire pipeline operates on the legacy `scraped_jobs` table
only (candidates are rows with `skip_reason IS NULL`). The per-source tables
(`linkedin_jobs`/`indeed_jobs`/`glassdoor_jobs`) are not involved (see spec
`002-jobs-ingest-listing` KL-1 — the dual-store split).

**Authentication.** Every route in `routers/dedup.py` requires bearer auth via
`get_current_user` (Constitution Principle VII).

## Clarifications

### Session 2026-07-14

Authored directly from source (`dedup/service.py`, `routers/dedup.py`,
`routers/extension.py` sync-dedup trigger, `models/dedup_report.py`, `schemas/dedup.py`) plus
the dedup notes in `README.md`. No open questions required a user decision; behavior was fully
determined by the code.

**Verification pass (against `dedup/service.py` and `routers/dedup.py`):**

- Finding: transaction boundaries were unspecified. → Correction: `run_dedup` **flushes but
  does not commit on success**. For the manual path the commit is performed by the `get_db()`
  dependency (`core/database.py`: `yield` then `await session.commit()`, `rollback()` on
  exception); for the sync path `_run_dedup_for_scan` commits explicitly
  (`extension.py`). All per-row decision UPDATEs plus the report flush therefore commit as **one
  atomic transaction** (all-or-nothing). The **only** in-function commit is the crash-stub path.
  Captured in new **FR-018** and the transaction edge cases.
- Finding: cosine batch sizing details were thin. → Correction: `batch_size = max(1,
  settings.dedup_cosine_batch_size)` (floored at 1; README default 1000). The TF-IDF matrix is
  `fit_transform`-ed **once** over the whole corpus (`max_features=10000`); similarity is then
  computed per batch of query rows against the **full** matrix
  (`cosine_similarity(batch_vectors, tfidf_matrix)`). Refined in FR-009.
- Finding: partial-failure behavior needed to be explicit. → Correction: a **cosine** failure is
  **non-fatal** (caught inside `_run_cosine`; partial cosine flags are kept and the run commits
  normally); any **other** exception in `run_dedup` triggers a full `db.rollback()` of the
  decision writes, then a zeroed stub report is committed and the error re-raised (KL-7).
- Finding: cosine tie-break edge omitted. → Correction: when two candidates have **equal**
  `created_at`, neither branch fires, so **neither is flagged** (no deterministic tie-break).
  Added to edge cases.
- Finding: no dedup smoke test. → Confirmed **testing gap**: the suite
  (`smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`, `smoke_test_matched_claim.py`)
  has **no** targeted coverage for the dedup pipeline — no pass ran against `run_dedup`, the gate
  rules, keep-oldest/older, chain resolution, reset, or the crash path. Elevated from an
  assumption to an explicit gap (SC-006).
- Verified with no discrepancy: candidate selection (`skip_reason IS NULL`), Pass 0/1 gate order
  and reasons (`agency_jd` → `"agency"`), `hash_exact` keep-oldest, cosine keep-older + the
  ≥10-rows/≥2-corpus/threshold==0 short-circuits, the `skip_reason IS NULL`-guarded writes, both
  chain resolvers (depth 20, cycle-guarded), the `dedup_reports` fields, the ring-buffered
  `debug_log`, reset scoped to `DEDUP_SERVICE_SKIP_REASONS`, and bearer auth on every route.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run dedup manually and get a report (Priority: P1)

A user triggers dedup from the dashboard. The backend loads all un-skipped jobs, runs the
three passes, writes `skip_reason` / dedup fields on flagged rows, and returns a metrics report.

**Why this priority**: Manual dedup is the on-demand cleanup path and the canonical way to
exercise the full pipeline.

**Independent Test**: Seed `scraped_jobs` with blacklisted, filter-matching, hash-duplicate,
and near-duplicate rows; `POST /jobs/dedup`; assert each row's resulting `skip_reason`,
`dedup_similarity_score`, and `dedup_original_job_id`, and the returned report's totals and
`gate_results`.

**Acceptance Scenarios**:

1. **Given** jobs with `skip_reason IS NULL`, **When** `POST /jobs/dedup` runs, **Then** the
   config is read from the config file, `run_dedup(trigger="manual", scan_run_id=None)`
   executes synchronously within the request, and a `DedupReportRead` is returned.
2. **Given** a row whose company/location/title matches a blacklist or whose title contains a
   job-type term, **When** Pass 0 runs, **Then** it is flagged with the first matching reason
   (`blacklisted_company` / `blacklisted_location` / `title_blacklisted` / `job_type` /
   `agency`) and excluded from later passes.
3. **Given** a Pass-0 survivor with a non-empty JD, **When** Pass 1 runs, **Then** the first
   matching content gate in order (`title_mismatch` → `contract_mismatch` → `remote_mismatch` →
   `sponsorship` → `agency_jd`, gated by config flags) sets its `skip_reason`
   (`agency_jd` records the reason as `"agency"`); an empty-JD job is not checked in Pass 1.
4. **Given** two Pass-2 survivors sharing a `raw_description_hash`, **When** `hash_exact` runs,
   **Then** the **oldest** (min `created_at`) is kept and the rest are flagged
   `skip_reason = "already_scraped"`, `dedup_similarity_score = NULL`,
   `dedup_original_job_id = <oldest id>`.
5. **Given** two survivors with cosine similarity ≥ threshold, **When** `cosine` runs, **Then**
   the **newer** row is flagged `already_scraped` with `dedup_similarity_score = <score>` and
   `dedup_original_job_id = <older id>`.
6. **Given** the run completes, **When** the report is written, **Then** a `dedup_reports` row
   records `total_processed`, `total_flagged`, `total_passed`, per-gate
   `{checked, flagged, duration_ms}`, `skip_reason_counts`, `duration_ms`, and a `debug_log`
   event stream.

---

### User Story 2 - Automatic dedup after a scan (post-scan sync) (Priority: P1)

When a scan run completes and dedup is configured as "sync," the backend automatically runs the
same pipeline in the background, tracked by a `dedup_tasks` row.

**Why this priority**: This is the hands-off path most cycles use; it must survive client
disconnect and not block the completion request.

**Independent Test**: `PUT /extension/run-log/{id}` to `status = "completed"` with
`dedup_mode = "sync"`; assert a `dedup_tasks` row goes `running → completed`, a
`dedup_reports` row with `trigger = "post_scan"` and `scan_run_id = <log id>` is written, and
the request returns without waiting for dedup.

**Acceptance Scenarios**:

1. **Given** a run-log PUT transitioning to `completed` with `dedup_mode = "sync"`, **When**
   it is a single-site scan (`scan_all_position`/`scan_all_total` null) **or** a Scan All where
   `scan_all_position == scan_all_total`, **Then** `_run_dedup_for_scan(log_id)` is scheduled
   via `asyncio.create_task` (not tied to the request).
2. **Given** the background task starts, **When** it runs, **Then** it creates a `dedup_tasks`
   row (`status = "running"`, `trigger = "post_scan"`), runs a 30-second heartbeat updater,
   opens its **own** `AsyncSessionLocal`, and calls
   `run_dedup(scan_run_id=log_id, trigger="post_scan")`.
3. **Given** dedup finishes, **When** the task ends, **Then** the `dedup_tasks` row is set to
   `completed` with `completed_at`; on exception it is set to `failed` with `error_message` and
   the error is logged.
4. **Given** a Scan All leg where `scan_all_position != scan_all_total`, **When** it completes,
   **Then** dedup is **not** scheduled (only the final leg triggers it).
5. **Given** the backend restarts while a `dedup_tasks` row is still `running`, **When** it
   boots, **Then** that orphan row is marked `failed` and dedup is **not** auto-rerun
   (`mark_stale_dedup_tasks_failed`, B-18).

---

### User Story 3 - Maintain and inspect dedup results (Priority: P2)

A user resets dedup decisions, repairs dangling duplicate-chains, and inspects past reports.

**Why this priority**: Supporting operations for correcting and auditing dedup; secondary to
running it.

**Independent Test**: Flag rows via dedup, call `POST /jobs/dedup/reset` and assert only
dedup-owned reasons are cleared; construct a removed→removed chain and call
`POST /jobs/dedup/resolve-chains`; list and fetch reports.

**Acceptance Scenarios**:

1. **Given** rows flagged with dedup-owned reasons, **When** `POST /jobs/dedup/reset` runs,
   **Then** every row whose `skip_reason` is in `DEDUP_SERVICE_SKIP_REASONS` has
   `skip_reason`, `dedup_similarity_score`, and `dedup_original_job_id` cleared to NULL, and
   `{reset_count}` is returned; ingest-time skip reasons are untouched.
2. **Given** a removed job whose `dedup_original_job_id` points to another **removed** job,
   **When** `POST /jobs/dedup/resolve-chains` runs, **Then** the chain is walked (max depth 20,
   cycle-guarded) to the nearest **non-removed** ancestor and `dedup_original_job_id` is
   updated; the count of updated rows is returned; re-running on flat chains is a no-op.
3. **Given** stored reports, **When** `GET /dedup/reports` / `GET /dedup/reports/{id}` run,
   **Then** reports are returned newest-first / by id (404 if absent), and
   `POST /dedup/reports/{id}/debug` appends events to the report's `debug_log` ring buffer.

---

### Edge Cases

- **No candidates**: with zero `skip_reason IS NULL` rows, the pipeline processes 0, flags 0,
  and still writes a report (all-zero gates).
- **Empty JD**: Pass 1 skips content gates for empty/whitespace JD (no flag); `hash_exact`
  requires a non-null `raw_description_hash`; cosine drops empty-JD text from the corpus.
- **Cosine short-circuits**: cosine flags nothing when `cosine_set` is empty, when
  `dedup_fuzzy_threshold == 0`, when the total `scraped_jobs` count `< 10`, or when the built
  corpus has `< 2` texts.
- **Cosine failure**: any exception inside cosine is caught, logged as a warning, and the run
  continues with whatever cosine flagged so far (hash results are unaffected) — the run still
  commits normally.
- **Cosine created_at tie**: when two similar candidates have equal `created_at`, neither the
  "job newer" nor the "other newer" branch fires, so **neither is flagged** (no tie-break).
- **Chain cannot be resolved** (cycle or all-flagged chain): `_resolve_chains` keeps the
  original `dedup_original_job_id` rather than repointing.
- **Run crash**: any exception in `run_dedup` triggers `db.rollback()` (discarding partial
  `skip_reason` writes), then writes a **stub** `dedup_reports` row (all zeros) with a
  `run_crash` trace event, commits that stub, and re-raises.
- **Concurrent/overlapping dedup**: the flag-writing UPDATE is guarded by
  `WHERE skip_reason IS NULL`, so it will not overwrite a row already skipped by a concurrent
  run or a prior pass.
- **`language` reason**: `language` is listed in `DEDUP_SERVICE_SKIP_REASONS` (so reset clears
  it) but is **not** produced by Pass 0/1/2 — it originates elsewhere (matching). Documented as
  KL-4.

## Requirements *(mandatory)*

### Functional Requirements

**Entry points**

- **FR-001**: `POST /jobs/dedup` MUST read the config from the config file, then call
  `run_dedup(db, config, settings, scan_run_id=None, trigger="manual")` **synchronously** in
  the request and return the resulting `DedupReportRead`.
- **FR-002**: On `PUT /extension/run-log/{id}` transitioning to `status = "completed"` with
  `dedup_mode = "sync"`, the system MUST schedule `_run_dedup_for_scan(log_id)` via
  `asyncio.create_task` when the run is single-site (`scan_all_position`/`scan_all_total` null)
  or is the final Scan All leg (`scan_all_position == scan_all_total`), and MUST NOT block the
  PUT response on dedup.
- **FR-003**: `_run_dedup_for_scan` MUST create a `dedup_tasks` row
  (`status = "running"`, `trigger = "post_scan"`), run a ~30s heartbeat updater, open its own
  `AsyncSessionLocal`, call `run_dedup(scan_run_id=log_id, trigger="post_scan")`, and then set
  the task `completed` (with `completed_at`) or, on exception, `failed` (with `error_message`).
  Orphan `running` tasks MUST be marked `failed` on backend startup with no auto-rerun.

**Candidate selection**

- **FR-004**: `run_dedup` MUST load candidates as all `scraped_jobs` rows with
  `skip_reason IS NULL`; `total_processed` is that count. Per-source tables are not consulted.

**Pass 0 — metadata filter gates**

- **FR-005**: For each candidate, Pass 0 (`run_pass_0`, no JD required) MUST return the **first**
  matching reason, in order: exact `blacklist_companies` match → `blacklisted_company`;
  `blacklist_locations` substring in location → `blacklisted_location`; `blacklist_titles`
  substring in title → `title_blacklisted`; `JOB_TYPE_TERMS` in title → `job_type`; and, when
  `config.no_agency`, `AGENCY_COMPANY_TERMS` in company → `agency`. Pass-0-flagged jobs are
  excluded from Pass 1 and Pass 2.

**Pass 1 — JD content filter gates**

- **FR-006**: For each Pass-0 survivor with a non-empty JD, Pass 1 MUST evaluate gates in
  `PASS1_GATE_ORDER` and flag on the first match: `title_mismatch` (config `target_titles` set
  and none appear in the title); `contract_mismatch` (config `no_contract` and `CONTRACT_TERMS`
  in title+JD); `remote_mismatch` (config `remote_only` and `REMOTE_MISMATCH_TERMS` in JD);
  `sponsorship` (config `needs_sponsorship` and `SPONSORSHIP_TERMS` in JD); `agency_jd` (config
  `no_agency` and `AGENCY_JD_TERMS` in JD → reason recorded as `"agency"`). Empty-JD jobs are
  not flagged in Pass 1. Gates disabled by config contribute zero checks.

**Pass 2 — duplicate detection**

- **FR-007**: Pass 2 MUST run only over Pass-0/Pass-1 survivors, as sequential sub-gates
  `hash_exact` then `cosine`, and `cosine` MUST NOT re-examine ids already flagged by
  `hash_exact`.
- **FR-008** (`hash_exact`): The system MUST group survivors by non-null `raw_description_hash`;
  for each group of ≥ 2, keep the **oldest** by `created_at` and flag the others
  `("already_scraped", None, <oldest id>)`.
- **FR-009** (`cosine`): The system MUST `fit_transform` a single TF-IDF matrix
  (`max_features=10000`) over the non-empty JD text of the cosine inputs **plus** other
  `skip_reason IS NULL` jobs (excluding hash-flagged and pass0/pass1 ids), then compute cosine
  similarity per batch of query rows against the **full** matrix with
  `batch_size = max(1, settings.dedup_cosine_batch_size)` (README default 1000), and flag a job
  `("already_scraped", <score>, <other id>)` when `score ≥ config.dedup_fuzzy_threshold/100`,
  keeping the **older** (`created_at`) row as the original (equal `created_at` → no flag). It
  MUST short-circuit to zero flags when the input set is empty, `dedup_fuzzy_threshold == 0`,
  total `scraped_jobs` `< 10`, or corpus `< 2`, and MUST swallow its own exceptions (log a
  warning, continue) so a cosine failure does not fail the run.

**Chain resolution**

- **FR-010** (in-run): After Pass 2, `_resolve_chains` MUST, for any flagged job whose
  `original_id` is itself in the flagged set, walk the chain (max depth 20, cycle-guarded) to an
  original **not** in the flagged set and repoint to it; if none is found, keep the original
  `original_id`. It MUST report `{chain_count, max_depth_observed}` (traced as
  `chain_resolve_done`).
- **FR-011** (DB repair): `POST /jobs/dedup/resolve-chains` (`resolve_dedup_chains_in_db`) MUST,
  for removed jobs (`skip_reason IS NOT NULL`) whose `dedup_original_job_id` points to another
  removed job, walk to the nearest non-removed ancestor (max depth 20, cycle-guarded) and UPDATE
  `dedup_original_job_id`, returning the count updated; it MUST be idempotent on already-flat
  chains.

**Writing decisions**

- **FR-012**: The system MUST merge flags with Pass 0/Pass 1 taking precedence
  (recorded as `(reason, None, None)`) and Pass 2 triples for the rest, then UPDATE each flagged
  `scraped_jobs` row **guarded by `skip_reason IS NULL`**: for `already_scraped`, set
  `skip_reason`, `dedup_similarity_score` (the score or NULL), and `dedup_original_job_id`; for
  every other reason, set `skip_reason` and force `dedup_original_job_id = NULL` (no similarity).

**Report, metrics, and debug log**

- **FR-013**: The system MUST write a `dedup_reports` row with `scan_run_id`, `trigger`,
  `total_processed`, `total_flagged` (count of all flagged), `total_passed`
  (`processed − flagged`), `gate_results` (per-gate `{checked, flagged, duration_ms}` for
  `pass_0`, the five Pass-1 gates, `hash_exact`, `cosine`), `skip_reason_counts`, and
  `duration_ms`, then return `DedupReportRead`.
- **FR-014**: The system MUST accumulate a `debug_log` event stream via `core.trace` and flush
  it into the report's `debug_log` JSONB as `{"events": [...]}`, capped to
  `settings.debug_log_ring_size` (ring buffer). On a run crash it MUST persist a zeroed stub
  report plus a `run_crash` trace, commit it, and re-raise.

**Maintenance & inspection**

- **FR-015**: `POST /jobs/dedup/reset` MUST clear `skip_reason`, `dedup_similarity_score`, and
  `dedup_original_job_id` for every `scraped_jobs` row whose `skip_reason` is in
  `DEDUP_SERVICE_SKIP_REASONS`, returning `{reset_count}`, and MUST NOT touch ingest-time
  skip reasons.
- **FR-016**: `GET /dedup/reports` MUST return all reports newest-first; `GET /dedup/reports/{id}`
  MUST return one (404 if absent); `POST /dedup/reports/{id}/debug` MUST append events to the
  report's `debug_log`, trimming to the ring size (404 if absent).

**Transaction boundary**

- **FR-018**: `run_dedup` MUST `flush` (not `commit`) its decision UPDATEs and the report on the
  success path, leaving the commit to the caller: the `get_db()` dependency commits the manual
  path (and rolls back on exception), while `_run_dedup_for_scan` commits the sync path with its
  own session. Consequently all per-row `skip_reason`/dedup-field writes and the `dedup_reports`
  row commit **together or not at all**. The **only** commit inside `run_dedup` is the crash path
  (`rollback` decisions → flush a zeroed stub report → `commit` → re-raise).

**Cross-cutting**

- **FR-017**: Every route in `routers/dedup.py` MUST require bearer auth via `get_current_user`.

### Known Limitations *(as-built; not defects to fix in this round)*

- **KL-1 — "Dedup" conflates filtering and deduplication**: Pass 0 and Pass 1 assign
  non-duplicate `skip_reason`s (blacklists, job-type, contract/remote/sponsorship/agency,
  title-mismatch); only Pass 2 detects duplicates. The single report and the `run_dedup` name
  cover both concerns.
- **KL-2 — Manual dedup blocks the request**: `POST /jobs/dedup` runs the entire pipeline
  (including O(n²)-ish cosine) synchronously inside the HTTP request; large corpora make the
  request long-running (only the post-scan path is backgrounded).
- **KL-3 — Scraped-jobs-only**: dedup never considers the per-source tables; jobs ingested only
  into `linkedin_jobs`/`indeed_jobs`/`glassdoor_jobs` are invisible to it (ties to spec 002
  KL-1).
- **KL-4 — `language` reset is vestigial**: `language` is in `DEDUP_SERVICE_SKIP_REASONS`
  (cleared by reset) but is never produced by the dedup passes; it comes from matching.
- **KL-5 — Cosine corpus exceeds the survivor set**: cosine compares survivors against a broader
  corpus of other `skip_reason IS NULL` jobs, so a survivor can be flagged as a duplicate of a
  job that was not itself a Pass-2 survivor.
- **KL-6 — Two independent chain resolutions**: the in-run `_resolve_chains` (Pass-2 flags,
  in-memory) and the DB-repair `resolve_dedup_chains_in_db` (persisted removed rows) implement
  the same walk separately; the DB repair exists because the in-run pass does not catch all
  cross-run chains.
- **KL-7 — Crash leaves a zeroed report**: on failure, partial `skip_reason` writes are rolled
  back but a zero-valued `dedup_reports` stub is committed, so the report history contains an
  all-zero row that did not reflect a real "no-op" run.

### Key Entities

- **`scraped_jobs`** (candidate/target rows): read where `skip_reason IS NULL`; dedup writes
  `skip_reason`, `dedup_similarity_score`, and `dedup_original_job_id`. `raw_description_hash`
  and `created_at` drive Pass 2; `job_title`/`company`/`location`/`job_description` feed the
  gates.
- **`dedup_reports`**: one row per run (manual or post_scan). Fields: integer `id`, `scan_run_id`
  (FK → `extension_run_logs`, ON DELETE SET NULL, nullable), `trigger`, `total_processed`,
  `total_flagged`, `total_passed`, `gate_results` (JSONB), `skip_reason_counts` (JSONB),
  `duration_ms`, `debug_log` (JSONB `{"events": [...]}`), `created_at`.
- **`dedup_tasks`**: one row per post-scan background run; `status` (`running`/`completed`/
  `failed`), `trigger = "post_scan"`, `scan_run_id`, `last_heartbeat_at`, `completed_at`,
  `error_message`.
- **Config (`SearchConfigRead`)**: supplies the gate toggles and lists —
  `blacklist_companies/locations/titles`, `target_titles`, `no_contract`, `remote_only`,
  `needs_sponsorship`, `no_agency`, `dedup_fuzzy_threshold`, plus `dedup_mode` (governs the
  sync trigger).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every functional requirement (FR-001…FR-018) is traceable to a specific
  line/area in `dedup/service.py`, `routers/dedup.py`, `routers/extension.py`, or
  `core/database.py` (FR-018) with no contradiction.
- **SC-002**: For a seeded corpus, the resulting per-row `skip_reason` /
  `dedup_similarity_score` / `dedup_original_job_id` match the pass rules in US1/US2, and the
  report's `total_flagged + total_passed == total_processed`.
- **SC-003**: The post-scan path runs off the request (the PUT returns before dedup finishes),
  produces a `dedup_reports` row with `trigger = "post_scan"` and the scan's `scan_run_id`, and
  drives its `dedup_tasks` row `running → completed`/`failed`.
- **SC-004**: `hash_exact` and `cosine` both keep the **oldest**/**older** row as the original;
  reset clears exactly the reasons in `DEDUP_SERVICE_SKIP_REASONS`; resolve-chains is idempotent
  on flat chains.
- **SC-005**: Each Known Limitation (KL-1…KL-7) is reproducible against the current code and
  none describes an intended future design.
- **SC-006** (testing gap): There is **no** targeted smoke/contract test for the dedup pipeline
  in the current suite — the gate rules, keep-oldest/older, chain resolution, reset, the
  transaction boundary (FR-018), and the crash path are all unverified by an automated test.
  Closing this gap is prerequisite to any behavior-preserving change (Constitution Principle II).

## Assumptions

- The `scraped_jobs`, `dedup_reports`, and `dedup_tasks` tables exist at the current Alembic
  head; `raw_description_hash` is populated at ingest (spec `002-jobs-ingest-listing`).
- "As implemented" refers to the code on branch `docs/spec-baseline` at 2026-07-14; this spec
  introduces no requirements beyond describing existing behavior.
- The scikit-learn TF-IDF/cosine dependency is available; `dedup_cosine_batch_size` and
  `dedup_fuzzy_threshold` come from settings/config.
- There is no dedicated smoke test for the dedup pipeline in the current suite
  (`smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`, `smoke_test_matched_claim.py`);
  behavior is documented from the source and README.
