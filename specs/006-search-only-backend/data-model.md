# Phase 1 Data Model: Search-Only Backend

This is a subtractive change. **No database schema changes** occur in this feature (D1 = leave,
FR-006a). The "data model" impact is therefore in three parts: (A) API response/request schema
fields pruned, (B) config fields dropped, and (C) an inventory of database objects that become
**orphaned** (retained physically, no longer referenced) for a possible future drop migration.

## A. API schema changes (Pydantic — `backend/schemas/`)

### `scraped_job.py` — MODIFIED

**`ScrapedJobRead`** (and `ScrapedJobDetail` which subclasses it): **prune** these fields
(all dedup/match-decision or issue-report data):

| Pruned field | Origin |
|--------------|--------|
| `dedup_similarity_score` | dedup pipeline |
| `dedup_original_job_id` | dedup pipeline |
| `match_level` | matching |
| `match_reason` | matching |
| `fit_score` | matching |
| `req_coverage` | matching |
| `match_confidence` (alias `confidence`) | matching |
| `match_skip_reason` | matching |
| `required_skills` | matching extraction |
| `nice_to_have_skills` | matching extraction |
| `extracted_yoe` | matching extraction |
| `extracted_salary_min` (alias `salary_min_extracted`) | matching extraction |
| `job_type` | matching extraction |
| `jd_incomplete` | matching |
| `matched_at` | matching |
| `education_req_degree` / `education_req_field` / `education_field_qualified` | matching gates |
| `visa_req` | matching gates |
| `blocking_gap` / `gap_adjacency` | LLM re-score |
| `matching_mode` | matching |
| `removal_stage` | matching |
| `has_report` | issue-report flow |

**Retained fields** (search-relevant): `id`, `website`, `job_title`, `company`, `location`,
`job_description`, `job_url`, `apply_url`, `easy_apply`, `post_datetime`, `search_filters`,
`raw_description_hash`, `ingest_source`, `scan_run_id`, `original_job_id` (ingest-time
content-duplicate pointer — part of ingest, FR-009), `dismissed`, `skip_reason`, `created_at`,
`updated_at`; `ScrapedJobDetail` additionally keeps `voyager_raw`.

> Note: `dismissed` and `skip_reason` are **retained** — they are set at ingest / by the user and
> are referenced by the retained `dedup_status` listing filter, not by the removed pipelines.

**`JobUpdate`** — prune the same match/dedup fields (`fit_score`, `match_level`, `match_reason`,
`required_skills`, `nice_to_have_skills`, `extracted_yoe`, `job_type`, `extracted_salary_min`,
`match_confidence`, `req_coverage`, `matched_at`, `jd_incomplete`, `match_skip_reason`,
`education_*`, `visa_req`, `blocking_gap`, `gap_adjacency`, `matching_mode`). **Retain**
`dismissed`. The `_normalize_job_update_payload` alias remaps in `routers/jobs.py` become dead
once these fields are gone (leave or trim — cosmetic).

**`ScrapedJobIngest` / `ScrapedJobIngestResponse`** — **UNCHANGED** (ingest is retained in full).

### `config.py` — MODIFIED

Drop from **both** `SearchConfigRead` and `SearchConfigUpdate`:

- `dedup_mode` (str) — governed the removed post-scan sync-dedup trigger.
- `llm` (bool) — enabled the removed LLM matching stages.

Existing config files carrying these keys still load (Pydantic default `extra="ignore"`; see
research D-6). Note: other matching-flavored config keys (`dedup_fuzzy_threshold`,
`nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold`, `no_agency`, `target_titles`,
etc.) are **not** in this feature's removal list (spec names only `llm` + `dedup_mode`); leave
them (future cleanup if desired).

### DELETED schema modules

`schemas/dedup.py`, `schemas/match_report.py`, `schemas/job_report.py`, `schemas/profile.py`,
`schemas/skill_candidate.py`. `schemas/__init__.py` does **not** import any of these → UNCHANGED.
`schemas/debug_log.py` is still used by `routers/extension.py` → **kept**.

## B. Retained data entities (unchanged tables/models)

- **`scraped_jobs`** (model `ScrapedJob`, UNCHANGED): still the store for skip-reason/legacy
  ingest and all `GET/PUT /jobs*`. Its dedup/match columns remain physically present and are
  still referenced by `list_jobs` filter clauses (harmless no-ops post-removal) but are no longer
  exposed in responses.
- **Per-source tables** (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`): UNCHANGED; subjects of
  Phase 1 expiration and Phase 2 matched-claim; `matched` column **retained** (D2).
- **`extension_run_logs`**, **`auto_scrape_cycles`**, **`auto_scrape_state`**,
  **`auto_scrape_config`**, **`site_session_state`**, **`extension_state`**: UNCHANGED.
  `auto_scrape_cycles.dedup_task_id` / `match_results` columns stay; the orchestrator writes
  `match_results = {"claim_summary": {...}}` and leaves `dedup_task_id` NULL as before.

## C. Orphaned database objects (retained now; inventory for a FUTURE drop migration)

These are **NOT dropped in this feature**. Listed only so a later migration (chained off `029`)
can remove them. **The future migration MUST derive the exact object list programmatically from
the SQLAlchemy model definitions + the source migrations below — do not hand-copy this list.**

### Orphaned tables (whole-table drops, if/when scheduled)

| Table | Introduced by | Backing model (deleted) |
|-------|---------------|-------------------------|
| `dedup_reports` | `011_dedup.py` | `models/dedup_report.py` |
| `dedup_tasks` | `022_dedup_tasks.py` (+ `024`) | `models/dedup_task.py` |
| `match_reports` | `014_matching_columns.py` | `models/match_report.py` |
| `skill_candidates` | `017_skill_candidates.py` | `models/skill_candidate.py` |
| `job_reports` | `019_job_reports.py` | `models/job_report.py` |

### Orphaned `scraped_jobs` columns (introduced by these migrations)

Source migrations to derive the exact column set from: `011_dedup.py`, `012_dedup_original_job_id.py`,
`014_matching_columns.py`, `015_education_field_qualified.py`, `018_scraped_jobs_removal_stage.py`,
`021_pipeline_debug_log.py` (and any dedup/match columns folded into `027_schema_reconciliation.py`).
Approximate set (confirm against models at drop time): `dedup_similarity_score`,
`dedup_original_job_id`, `match_level`, `match_reason`, `fit_score`, `req_coverage`, `confidence`,
`match_skip_reason`, `required_skills`, `nice_to_have_skills`, `extracted_yoe`,
`salary_min_extracted`, `job_type`, `jd_incomplete`, `matched_at`, `matching_mode`,
`removal_stage`, `education_req_degree`, `education_req_field`, `education_field_qualified`,
`visa_req`, `blocking_gap`, `gap_adjacency`.

> **Do NOT** drop `matched` (per-source tables), `scan_run_id`, `original_job_id`,
> `raw_description_hash`, `skip_reason`, `dismissed`, or any ingest/search column — those are
> retained.

### Constraints on the future migration (Constitution Principle IV)

- New migration file, chained off the current head (`029` today, or whatever is head then).
- Never edit/reorder existing migrations.
- Account for FK dependencies (e.g. `match_reports.dedup_run_id → dedup_reports`,
  `dedup_reports.scan_run_id → extension_run_logs`, `job_reports.job_id → scraped_jobs`) —
  drop in dependency order.

## State transitions

No new or changed state machines. The retained post-scrape cycle lifecycle is unchanged:
`scrape_complete → postscrape_running → post_scrape_complete` (or `failed`), with Phase 1 + Phase 2
only.
