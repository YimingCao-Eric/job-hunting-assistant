# Live per-source table schemas (as of 2026-07-15)

Captured directly from the running database (`\d` introspection), **post search-only split**.
This is **ground truth** for the per-source tables and the canonical mapping; it is the only
schema doc still maintained. (An older `docs/current-schemas.md` documented 51/61/69 columns
for these tables; it was deleted, and its counts never matched the live tables anyway.)

**The unified `scraped_jobs` table described below is implemented** (Alembic migration `030`)
and populated by dual-write at ingest. The "Proposed" heading below is historical — the
section now documents the table as built. Three details differ from this document's original
proposal; each is marked **[as-built]** where it appears.

## Column-count summary

| Table | Columns | Site-native ID |
|---|---|---|
| `linkedin_jobs` | 39 | `job_posting_id` |
| `indeed_jobs` | 45 | `jobkey` |
| `glassdoor_jobs` | 48 | `listing_id` |

**Common meta columns (all three):** `id`, `scan_run_id`, `job_url`, `scrape_time`,
`source_raw`, `matched`.

---

## `linkedin_jobs` (39 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | not null | gen_random_uuid() |
| scan_run_id | uuid | not null | |
| job_url | varchar(2048) | not null | |
| scrape_time | timestamptz | not null | now() |
| source_raw | jsonb | | |
| job_posting_id | varchar(32) | | |
| job_posting_url | text | | |
| listed_at | bigint | | |
| original_listed_at | bigint | | |
| formatted_location | text | | |
| country_urn | varchar(64) | | |
| location_urn | varchar(64) | | |
| location_visibility | varchar(32) | | |
| work_remote_allowed | boolean | | |
| workplace_types_urns | jsonb | | |
| workplace_types_labels | jsonb | | |
| formatted_employment_status | varchar(32) | | |
| employment_status_urn | varchar(64) | | |
| formatted_industries | jsonb | | |
| formatted_job_functions | jsonb | | |
| title | text | | |
| standardized_title | text | | |
| formatted_experience_level | varchar(32) | | |
| skills_description | text | | |
| apply_method_type | varchar(64) | | |
| company_apply_url | text | | |
| applicant_tracking_system | varchar(64) | | |
| salary_min | numeric | | |
| salary_max | numeric | | |
| salary_currency | varchar(3) | | |
| salary_period | varchar(16) | | |
| salary_provided_by_employer | boolean | | |
| description_text | text | | |
| inferred_benefits | jsonb | | |
| company_name | text | | |
| company_universal_name | varchar(128) | | |
| company_url | text | | |
| company_description | text | | |
| matched | boolean | not null | false |

**Indexes:** `linkedin_jobs_pkey` PK (id); `linkedin_jobs_job_url_key` UNIQUE (job_url);
`ix_linkedin_jobs_scan_run_id` (scan_run_id).
**FK:** `scan_run_id` → `extension_run_logs(id)` ON DELETE RESTRICT.

---

## `indeed_jobs` (45 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | not null | gen_random_uuid() |
| scan_run_id | uuid | not null | |
| job_url | varchar(2048) | not null | |
| scrape_time | timestamptz | not null | now() |
| source_raw | jsonb | | |
| mosaic_present | boolean | not null | false |
| graphql_present | boolean | not null | false |
| jobkey | varchar(32) | | |
| link | text | | |
| view_job_link | text | | |
| third_party_apply_url | text | | |
| pub_date | bigint | | |
| expiration_date | bigint | | |
| title | text | | |
| norm_title | text | | |
| job_types | jsonb | | |
| taxonomy_attributes | jsonb | | |
| formatted_location | text | | |
| job_location_city | varchar(128) | | |
| job_location_state | varchar(8) | | |
| job_location_postal | varchar(16) | | |
| location_count | integer | | |
| additional_location_link | text | | |
| remote_location | boolean | | |
| salary_min | numeric | | |
| salary_max | numeric | | |
| salary_period | varchar(16) | | |
| salary_currency | varchar(3) | | |
| salary_snippet_source | varchar(32) | | |
| company | text | | |
| indeed_apply_enabled | boolean | | |
| screener_questions_url | text | | |
| num_hires | integer | | |
| employer_canonical_url | text | | |
| graphql_normalized_title | text | | |
| attributes | jsonb | | |
| location_formatted_long | text | | |
| graphql_location_street_address | text | | |
| graphql_location_country_code | varchar(2) | | |
| description_text | text | | |
| language | varchar(8) | | |
| employer_name | text | | |
| employer_company_page_url | text | | |
| source_name | varchar(64) | | |
| matched | boolean | not null | false |

**Indexes:** `indeed_jobs_pkey` PK (id); `indeed_jobs_job_url_key` UNIQUE (job_url);
`ix_indeed_jobs_scan_run_id` (scan_run_id).
**Check:** `indeed_jobs_surface_present` — `CHECK (mosaic_present OR graphql_present)`.
**FK:** `scan_run_id` → `extension_run_logs(id)` ON DELETE RESTRICT.

---

## `glassdoor_jobs` (48 columns)

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | not null | gen_random_uuid() |
| scan_run_id | uuid | not null | |
| job_url | varchar(2048) | not null | |
| scrape_time | timestamptz | not null | now() |
| source_raw | jsonb | | |
| listing_id | varchar(32) | | |
| goc_id | integer | | |
| job_country_id | integer | | |
| normalized_job_title | text | | |
| is_easy_apply | boolean | | |
| job_link | text | | |
| seo_job_link | text | | |
| salary_period | varchar(16) | | |
| salary_source | varchar(32) | | |
| pay_period_adjusted_pay | jsonb | | |
| location_name | text | | |
| location | jsonb | | |
| employer_name | text | | |
| employer_overview | text | | |
| indeed_job_attribute | jsonb | | |
| skills_labels | jsonb | | |
| education_labels | jsonb | | |
| employer_benefits_overview | text | | |
| employer_benefits_reviews | jsonb | | |
| title | text | | |
| date_posted | date | | |
| description | text | | |
| experience_requirements_description | text | | |
| employment_type | jsonb | | |
| jsonld_salary_currency_top | varchar(3) | | |
| jsonld_salary_min | numeric | | |
| jsonld_salary_max | numeric | | |
| job_location | jsonb | | |
| job_location_type | varchar(32) | | |
| hiring_organization | jsonb | | |
| industry | varchar(64) | | |
| direct_apply | boolean | | |
| job_benefits | text | | |
| header_goc | varchar(64) | | |
| job_type | jsonb | | |
| job_type_keys | jsonb | | |
| remote_work_types | jsonb | | |
| header_apply_url | text | | |
| header_employer | jsonb | | |
| map_city_name | varchar(128) | | |
| map_country | varchar(64) | | |
| map_state_name | varchar(64) | | |
| matched | boolean | not null | false |

**Indexes:** `glassdoor_jobs_pkey` PK (id); `glassdoor_jobs_job_url_key` UNIQUE (job_url);
`ix_glassdoor_jobs_scan_run_id` (scan_run_id).
**FK:** `scan_run_id` → `extension_run_logs(id)` ON DELETE RESTRICT.

---

## Cross-table mapping (business fields under different names)

| Canonical field | linkedin_jobs | indeed_jobs | glassdoor_jobs | Notes |
|---|---|---|---|---|
| Meta: row id | `id` | `id` | `id` | uuid |
| Meta: scan run | `scan_run_id` | `scan_run_id` | `scan_run_id` | FK → extension_run_logs |
| Meta: url (unique) | `job_url` | `job_url` | `job_url` | same everywhere |
| Meta: scraped at | `scrape_time` | `scrape_time` | `scrape_time` | timestamptz |
| Meta: claim flag | `matched` | `matched` | `matched` | boolean |
| Site-native id | `job_posting_id` | `jobkey` | `listing_id` | varchar(32) |
| **title** | `title` | `title` | `title` | all three literally `title` |
| **company** | `company_name` | `company` → `employer_name` | `employer_name` | Indeed: mosaic then graphql |
| **location (text)** | `formatted_location` | `formatted_location` | `location_name` | glassdoor also `location` jsonb |
| **description** | `description_text` | `description_text` | `description` | |
| salary min | `salary_min` | `salary_min` | `jsonld_salary_min` | |
| salary max | `salary_max` | `salary_max` | `jsonld_salary_max` | |
| salary currency | `salary_currency` | `salary_currency` | `jsonld_salary_currency_top` | |
| salary period | `salary_period` | `salary_period` | `salary_period` | vocab differs (YEARLY/YEAR/ANNUAL) |
| posted date | `listed_at` (bigint ms) | `pub_date` (bigint ms) | `date_posted` (date) | type mismatch |
| remote | `work_remote_allowed` | `remote_location` | `remote_work_types` (jsonb) | glassdoor structured |
| apply url | `company_apply_url` | `third_party_apply_url` | `header_apply_url` | |

---

## Proposed unified (merged) `scraped_jobs` table

A single canonical table the frontend `GET /jobs` reads and future matching consumes, populated
by **dual-write at ingest**: each `POST /jobs/ingest` writes its per-source table (unchanged)
**and** one canonical `scraped_jobs` row, in one transaction. Every canonical column below lists
**exactly which source column it comes from in each table** and the transform (if any).

### Provenance / meta

| Merged column | Type | ← linkedin_jobs | ← indeed_jobs | ← glassdoor_jobs | Transform |
|---|---|---|---|---|---|
| `id` | uuid PK | *(new)* | *(new)* | *(new)* | `gen_random_uuid()` for the merged row |
| `source_site` | varchar(16) | `'linkedin'` | `'indeed'` | `'glassdoor'` | constant per ingest path (also identifies the per-source table) |
| `source_row_id` | uuid | `id` | `id` | `id` | back-reference to the per-source row |
| `site_job_id` | varchar(32) | `job_posting_id` | `jobkey` | `listing_id` | site-native stable id |
| `scan_run_id` | uuid FK | `scan_run_id` | `scan_run_id` | `scan_run_id` | copy (FK → extension_run_logs) |
| `job_url` | varchar(2048) | `job_url` | `job_url` | `job_url` | copy; UNIQUE |
| `scrape_time` | timestamptz | `scrape_time` | `scrape_time` | `scrape_time` | copy |
| `matched` | boolean | `matched` | `matched` | `matched` | copied `false` at ingest; on claim, **both the per-source row and this unified row are flipped together** (spec 008 FR-028 — decision Q1=A) |

### Core business fields (what the Jobs page shows)

| Merged column | Type | ← linkedin_jobs | ← indeed_jobs | ← glassdoor_jobs | Transform |
|---|---|---|---|---|---|
| `title` | text | `title` | `title` | `title` | direct (all named `title`) |
| `company` | text | `company_name` | `company` → else `employer_name` | `employer_name` | Indeed: coalesce mosaic then graphql |
| `location_text` | text | `formatted_location` | `formatted_location` | `location_name` | direct |
| `description` | text | `description_text` | `description_text` | `description` | direct |
| `remote` | boolean | `work_remote_allowed` | `remote_location` | *(derive from `remote_work_types`)* | Glassdoor: jsonb non-empty → true |
| `apply_url` | text | `company_apply_url` | `third_party_apply_url` | `header_apply_url` | direct |
| `experience_level` | text | `formatted_experience_level` | *(none → NULL)* | `experience_requirements_description` | not aligned; best-available |
| `industry` | text | `formatted_industries` (jsonb) | *(none → NULL)* | `industry` | LinkedIn: flatten jsonb to text/first |

### Salary (normalized at merge — CC-10)

| Merged column | Type | ← linkedin_jobs | ← indeed_jobs | ← glassdoor_jobs | Transform |
|---|---|---|---|---|---|
| `salary_min` | numeric | `salary_min` | `salary_min` | `jsonld_salary_min` | direct |
| `salary_max` | numeric | `salary_max` | `salary_max` | `jsonld_salary_max` | direct |
| `salary_currency` | varchar(3) | `salary_currency` | `salary_currency` | `jsonld_salary_currency_top` | direct |
| `salary_period` | varchar(16) | `salary_period` | `salary_period` | `salary_period` | **normalize vocab** → canonical set `HOURLY` / `DAILY` / `WEEKLY` / `MONTHLY` / `ANNUAL`; unrecognized → NULL period (keep amounts). **No annualization** — amounts stored exactly as quoted (spec 008 FR-015a — decision Q2=A) |

### Dates (normalized to timestamptz)

| Merged column | Type | ← linkedin_jobs | ← indeed_jobs | ← glassdoor_jobs | Transform |
|---|---|---|---|---|---|
| `posted_at` | timestamptz | `listed_at` (bigint epoch-ms) | `pub_date` (bigint epoch-ms) | `date_posted` (date) | LI/Indeed: epoch-ms → UTC instant. GD: date → **midnight UTC**. **[as-built]** Done in Python, not SQL: a bare `date_posted::timestamptz` resolves midnight in the *server's* TimeZone, which would make `posted_at` depend on deployment config and shift Glassdoor rows against the other two sites' (inherently UTC) epoch values. Out-of-range/non-numeric → NULL + `projection_bad_posted_at` warning; never fails ingest |

### Raw payload — NOT carried on the unified row

`source_raw` is **omitted** from the unified table (spec 008 FR-005a — decision Q3=A). The raw
payload already lives on the per-source row; anything needing it follows `source_row_id` back to
that row. This avoids duplicating the heaviest column in the schema for every posting.

### As-built DDL

This is what migration `030` created — 22 columns, three indexes. Verified against `\d
scraped_jobs` on the running database.

```sql
CREATE TABLE scraped_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_site     varchar(16)  NOT NULL,          -- 'linkedin' | 'indeed' | 'glassdoor' (also identifies the per-source table)
    source_row_id   uuid         NOT NULL,          -- → the per-source row. Polymorphic: NO FK is possible (see note below)
    site_job_id     varchar(32),
    scan_run_id     uuid         NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url         varchar(2048) NOT NULL UNIQUE,
    scrape_time     timestamptz  NOT NULL DEFAULT now(),   -- always copied from the per-source row, never defaulted
    matched         boolean      NOT NULL DEFAULT false,
    dismissed       boolean      NOT NULL DEFAULT false,   -- [as-built] user decision; not in this doc's original proposal

    title           text,
    company         text,
    location_text   text,
    description     text,
    remote          boolean,                        -- tri-state: true / false / NULL ("the site didn't say")
    apply_url       text,
    experience_level text,
    industry        text,

    salary_min      numeric,
    salary_max      numeric,
    salary_currency varchar(3),
    salary_period   varchar(16),                    -- normalized vocab; NULL when unrecognized

    posted_at       timestamptz                     -- normalized from epoch-ms / date
    -- no source_raw: raw payload stays on the per-source row, reached via source_row_id
);
CREATE INDEX ix_scraped_jobs_scan_run_id ON scraped_jobs(scan_run_id);
```

**[as-built] Only three indexes exist** — the `id` PK, `UNIQUE (job_url)`, and the
`scan_run_id` FK index. This document originally also proposed
`ix_scraped_jobs_source` and `ix_scraped_jobs_posted_at`; **both were deliberately not
created.** The project forbids indexes beyond primary-key/unique/foreign-key without a
demonstrated need (CC-12), and neither has one: `source_site` has cardinality 3, so an index
on it would rarely beat a sequential scan, and `posted_at` is speculative until a slow query
exists. Either is one migration away if measurement justifies it.

### Notes / decisions

- **Population strategy = dual-write at ingest** — each `POST /jobs/ingest` writes its per-source
  table **and** the `scraped_jobs` row atomically (one transaction). Gives the Jobs page data
  immediately; the per-source tables remain the faithful raw store.
- **`company` for Indeed** — precedence: mosaic `company` first, else graphql `employer_name`.
- **`remote` for Glassdoor** — no boolean exists; derive from `remote_work_types` (jsonb) being
  present/non-empty, else NULL (raw stays in `source_raw`).
- **`posted_at`** — unify the three date representations to one `timestamptz` on write; don't
  store the raw epoch/date in the canonical column.
- **Uniqueness / cross-site dedup** — `job_url` is unique per site, so a UNIQUE on `job_url`
  handles same-site re-scrapes; the *same posting on two sites* has two URLs and appears twice.
  True cross-site dedup (title+company similarity) is a separate concern — out of scope here.
- **Matching fields** — the split removed dedup/match columns; when matching returns, add its
  columns (`match_score`, etc.) here rather than back on the per-source tables.
- **[as-built] `source_row_id` has no foreign key, and cannot.** It is polymorphic — it points
  at `linkedin_jobs`, `indeed_jobs`, or `glassdoor_jobs` depending on `source_site`, and a
  Postgres FK targets exactly one table. There is therefore **no `ON DELETE CASCADE`** to keep
  the tables in step. The 1:1 correspondence is a *code* invariant, held in three places:
  ingest (dual-write in one transaction), claim, and auto-expiration. Anyone reaching for a
  cascading FK here will find it cannot be created.
- **[as-built] `scrape_time` is copied, never defaulted.** The per-source INSERT returns it and
  the canonical write binds that exact value. Auto-expiration deletes from both tables using the
  same `scrape_time` predicate, so if the canonical row ever defaulted to its own `now()` the two
  sets would drift at the shelf-life boundary and orphan canonical rows.
- **[as-built] Lifecycle is symmetric.** `matched` is flipped on both rows by the same claim
  operation — it is copied as `false` at ingest, so nothing else would ever set it true, and the
  canonical flag would be permanently wrong. Auto-expiration deletes canonical rows alongside
  per-source rows, so a canonical row never outlives its source.
- **Migration** — done: `030_unified_scraped_jobs.py` (drop-and-recreate; the legacy table held
  0 rows, so nothing was preserved). It is **one-way**: `downgrade()` raises rather than
  reconstruct a ~48-column legacy schema whose code no longer exists.

---

*Source: live `information_schema` / `\d` on the running Postgres, 2026-07-15; unified table
verified against migration `030` as applied. This is the only maintained schema doc — the older
`docs/current-schemas.md` it once cross-referenced has been deleted. For source-field lineage
(what each column maps from in the site payloads), the extraction in
`backend/routers/jobs.py::build_*_params` is authoritative, and the per-site projection onto the
canonical row lives in `backend/core/scraped_job_projection.py`.*
