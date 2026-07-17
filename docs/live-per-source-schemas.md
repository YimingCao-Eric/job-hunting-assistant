# Live per-source table schemas (as of 2026-07-17)

Captured directly from the running database (`\d` introspection), **post search-only split**.
This is **ground truth** for the per-source tables and the canonical mapping; it is the only
schema doc still maintained. (An older `docs/current-schemas.md` documented 51/61/69 columns
for these tables; it was deleted, and its counts never matched the live tables anyway.)

**The unified `scraped_jobs` table described below is implemented** (Alembic migrations `030` +
`031`) and populated by dual-write at ingest. The "Proposed" heading below is historical — the
section now documents the table as built. Three details differ from this document's original
proposal; each is marked **[as-built]** where it appears.

`031` added five **filter attributes** (`employment_type`, `workplace_type`, `language`,
`education_requirements`, `salary_disclosed`) so a filtering/matching service can read
`scraped_jobs` alone — 22 → **27 columns**, still three indexes. Their per-site mapping,
consumer caveats, and live-verified vocabulary provenance are in
[Filter attributes (migration `031`)](#filter-attributes-migration-031--normalized-at-merge).

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

### Filter attributes (migration `031`) — normalized at merge

Five nullable columns added so a filtering/matching service can read `scraped_jobs` **alone**,
without joining the per-source tables. All five are populated by the same atomic dual-write; the
per-source tables are unchanged.

**NULL means "this site did not say" — never "no".** No column has a default.

| Merged column | Type | ← linkedin_jobs | ← indeed_jobs | ← glassdoor_jobs | Transform |
|---|---|---|---|---|---|
| `employment_type` | varchar(16) | `formatted_employment_status` | `job_types` (jsonb list) | `employment_type` (jsonb) → else `job_type` (jsonb) | **Normalize vocab** → closed seven-value set `FULL_TIME`/`PART_TIME`/`CONTRACT`/`TEMPORARY`/`INTERNSHIP`/`PERMANENT`/`VOLUNTEER`. **Single-valued**: several stated → precedence picks one, rest discarded. `Other` → NULL, *no warning*. Unrecognized → NULL + `projection_unknown_employment_type`. GD: structured field wins outright when non-empty (header ignored, never merged) |
| `workplace_type` | varchar(16) | `workplace_types_labels` (**URN enum**) | `remote_location` (boolean) | `remote_work_types` (jsonb) | → `REMOTE`/`HYBRID`/`ONSITE`. **LI: the live payload is a URN map** `{"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}` — no labels; codes **1=ONSITE, 2=REMOTE, 3=HYBRID**. Indeed: `true`→REMOTE, `false`→**ONSITE** (see caveat). Precedence `REMOTE › HYBRID › ONSITE` |
| `language` | varchar(8) | *(none → NULL)* | `language` | *(none → NULL)* | Bare lowercase base code (`en-US`→`en`); region subtag dropped. **Shape-validated, not membership**: 2–3 ASCII letters, no allow-list. Bad shape → NULL + `projection_bad_language` |
| `education_requirements` | text | *(none → NULL)* | *(none → NULL)* | `education_labels` (jsonb) → else `experience_requirements_description` | All labels joined `"; "` in source order, none dropped. Free text — **never validated, never warns** |
| `salary_disclosed` | boolean | `salary_provided_by_employer` | `salary_snippet_source` | `salary_source` | Tri-state provenance: `true`=employer stated the pay, `false`=the site estimated it, NULL=nothing said. **`false` is a claim, never a default**; an unrecognized token → NULL + `projection_unknown_salary_source`, never `false` |

**Per-site `salary_disclosed` tokens** (matched on the normalized token — uppercased, spaces/hyphens → `_`):

| Site | → `true` | → `false` | → NULL |
|---|---|---|---|
| LinkedIn | boolean `true` | boolean `false` | absent (the boolean admits no unrecognized state) |
| Indeed | `EMPLOYER`, **`EXTRACTION`** | `ESTIMATE`, `ESTIMATED`, `INDEED_ESTIMATE` | absent/empty; unrecognized → NULL + warn |
| Glassdoor | `EMPLOYER`, `EMPLOYER_PROVIDED`, `EMPLOYER_PROVIDED_SALARY` | `ESTIMATE`, `ESTIMATED`, `GLASSDOOR_ESTIMATE` | absent/empty; unrecognized → NULL + warn |

#### Caveats a consumer must know

- **`workplace_type` is NOT a refinement of `remote`, and the two legitimately disagree.** LinkedIn
  reads *different source fields* for each (`remote` ← `work_remote_allowed`; `workplace_type` ←
  `workplace_types_labels`; the labels win, and a contradiction logs
  `projection_workplace_remote_conflict`). Glassdoor reads the *same* field under different rules —
  a hybrid-only posting is `remote = true` **and** `workplace_type = HYBRID`. Only Indeed shares one
  source. **Pick one column per filter and never mix them.**
- **Indeed `ONSITE` means only "not remote".** Indeed cannot express hybrid, so its hybrid postings
  are recorded `ONSITE`. This is the one value in the table asserting more than the site said.
- **Glassdoor `workplace_type` is NULL on live rows.** `remote_work_types` comes back empty from the
  scraper, so there is nothing to map. This is a **scraper-layer gap, not a projection defect** —
  the projection is correct to write NULL for a field the row does not carry. Follow-up belongs in
  the extension, not here.
- **Glassdoor `salary_disclosed` may describe a different figure than the row's salary.**
  `salary_source` comes from `jobDetailsData`, while `jsonld_salary_min`/`max` come from the
  employer-authored JSON-LD `baseSalary` — two payloads. Inherited from `030`, which already reads
  `salary_period` from `jobDetailsData` while reading the amounts from JSON-LD.
- **`education_requirements` may duplicate `experience_level`.** When a Glassdoor posting has no
  education labels, both columns carry the same experience prose. Them agreeing is *not*
  corroboration — it is one value counted twice.
- **Multi-valued postings are lossy.** A posting tagged both `Full-time` and `Part-time` stores only
  `FULL_TIME` and will not answer a part-time filter. The discarded values survive only on the
  per-source row, via `source_row_id`.

#### Vocabulary provenance — verified against the 2026-07-17 scan

The `031` vocabularies shipped **reasoned, not observed** (only Glassdoor `remoteWorkTypes:
["REMOTE"]` was attested), with unrecognized tokens warning so the first real scan would correct
them. It did. Three gaps found and **closed**:

| Finding | Resolution |
|---|---|
| LinkedIn `workplace_types_labels` is a **URN map**, not labels — the original mapping assumed `localizedName` objects and NULLed every LinkedIn row | Map the enum codes `URN:LI:FS_WORKPLACETYPE:1/2/3` → `ONSITE`/`REMOTE`/`HYBRID`. Codes are locale-proof; labels are not |
| Indeed sends `"Permanent"` as a `job_types` entry | New canonical token **`PERMANENT`** (vocabulary 6 → 7). It is a *tenure* axis, not hours — a permanent part-time job exists — so it is not folded into `FULL_TIME`. Ranked **below** the hours tokens, so `["Full-time","Permanent"]` still yields `FULL_TIME` |
| Indeed `salary_snippet_source` is `"EXTRACTION"` for its entire salary population | **`true`** (employer-disclosed). Indeed parsed the pay from employer-authored prose; it estimated nothing, so the tri-state rule ruled `false` out, and NULL would strand every Indeed salary as "provenance unknown" when it is known. `salary_disclosed` encodes provenance, not parse reliability |

Still **deliberately unmapped**, pending evidence: `FREELANCE`, `PER_DIEM`, `APPRENTICESHIP`,
`COMMISSION`, `NEW_GRAD`. Each has a defensible mapping and a defensible objection; guessing writes
a wrong token no warning surfaces, while leaving them unmapped writes NULL and warns.

### Raw payload — NOT carried on the unified row

`source_raw` is **omitted** from the unified table (spec 008 FR-005a — decision Q3=A). The raw
payload already lives on the per-source row; anything needing it follows `source_row_id` back to
that row. This avoids duplicating the heaviest column in the schema for every posting.

### As-built DDL

This is what migrations `030` + `031` created — **27 columns, three indexes**. Verified against
`\d scraped_jobs` on the running database. `030` created the first 22; `031` added the five filter
attributes at the end, additively, with **no new index** (CC-12 — the consuming service does not
exist yet, so no query has demonstrated a need).

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

    posted_at       timestamptz,                    -- normalized from epoch-ms / date

    -- Filter attributes (031). Nullable, no defaults, no indexes.
    employment_type        varchar(16),  -- closed 7-value vocab; single-valued (precedence)
    workplace_type         varchar(16),  -- REMOTE|HYBRID|ONSITE; NOT a refinement of `remote`
    language               varchar(8),   -- Indeed only; bare base code, shape-validated
    education_requirements text,         -- Glassdoor only; free text, "; "-joined labels
    salary_disclosed       boolean       -- tri-state provenance; false is a claim, not a default
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
