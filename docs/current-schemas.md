# JHA — Current schemas (as of 2026-05-07)

> Single source of truth for what's in the database right now, post-implementation of the matched mechanism and the cycle 455 bug fix.
>
> **Alembic head:** `029`
> **Last migration:** `029_system_settings.py`
> **Effective for:** Backend code reading `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`, `system_settings`, `auto_scrape_cycles`
>
> For the design rationale behind these schemas, see `step1-schema-design.md` (the 12 cross-cutting decisions). For session history, see `session-record-2026-05-07.md`. This document is the snapshot of *what exists*, not why.

---

## Table of contents

1. [Migration history](#1-migration-history)
2. [Cross-cutting decisions (CCs) — the 12 rules](#2-cross-cutting-decisions-ccs--the-12-rules)
3. [Common columns (every per-source table)](#3-common-columns-every-per-source-table)
4. [`linkedin_jobs` (51 columns)](#4-linkedin_jobs-51-columns)
5. [`indeed_jobs` (61 columns)](#5-indeed_jobs-61-columns)
6. [`glassdoor_jobs` (69 columns)](#6-glassdoor_jobs-69-columns)
7. [`system_settings` (NEW from 029)](#7-system_settings-new-from-029)
8. [`auto_scrape_cycles` JSONB columns — current shapes](#8-auto_scrape_cycles-jsonb-columns--current-shapes)
9. [`extension_run_logs` — relevant columns for orchestration](#9-extension_run_logs--relevant-columns-for-orchestration)
10. [Indexes and constraints](#10-indexes-and-constraints)
11. [What's NOT in the per-source tables (still on `scraped_jobs`)](#11-whats-not-in-the-per-source-tables-still-on-scraped_jobs)
12. [Quick column-count summary](#12-quick-column-count-summary)

---

## 1. Migration history

```
023 → 024 → 025 (per-source tables created — linkedin/indeed/glassdoor)
            → 026 (cycle5 column drops — e.g. apply_count from indeed)
            → 027 (schema reconciliation — final drift cleanup)
            → 028 (NEW — matched BOOLEAN added to all 3 per-source tables)
            → 029 (NEW — system_settings k/v table seeded with shelf_life_days=7)

Alembic head: 029
```

**Important for code readers:** the `025_per_source_scrape_tables.py` source file still embeds the original `CREATE TABLE` text including columns that 026/027 later dropped. Don't infer "current columns" from 025 alone. The effective schema after 029 is captured in:

- `backend/routers/jobs.py` — `LINKEDIN_COLS`, `INDEED_COLS`, `GLASSDOOR_COLS` constants are the live source of truth
- This document — kept synchronized with reality
- `information_schema` introspection on a live DB — ground truth

---

## 2. Cross-cutting decisions (CCs) — the 12 rules

These apply uniformly across all three per-source tables.

| ID | Decision |
|---|---|
| **CC-1 (amended 2026-05-06)** | Append-only by **convention**, with two carve-outs: (a) the `matched` column transitions `false → true` once per row (never back to false), written by the post-scrape orchestrator; (b) the auto-expiration job DELETEs rows by `scrape_time + shelf_life`. No other UPDATE or DELETE. |
| **CC-2** | UUID primary key per table, `DEFAULT gen_random_uuid()` |
| **CC-3** | `scan_run_id UUID` FK → `extension_run_logs.id` ON DELETE RESTRICT |
| **CC-4** | Dev/test keeps `source_raw JSONB`; production drops it |
| **CC-5** | No `search_filters` column on per-source tables — filters live on the run-log row |
| **CC-6** | Flatten LinkedIn `data` + `included[]` onto row columns at ingest |
| **CC-7** | `job_url UNIQUE` per table; `ON CONFLICT (job_url) DO NOTHING RETURNING id`; re-scrape silently no-ops |
| **CC-8** | `scrape_time TIMESTAMPTZ DEFAULT NOW()` — server-side, never client-supplied |
| **CC-9** | Site-stable PKs (`job_posting_id`, `jobkey`, `listing_id`) as `VARCHAR(32)`, not BIGINT |
| **CC-10** | No salary normalization at ingest — per-source tables stay faithful to source vocab (`YEARLY` vs `YEAR` vs `ANNUAL`) |
| **CC-11** | Nested objects stay JSONB on per-source tables — flattening is a merge concern |
| **CC-12** | Minimum index set: PK (auto), `job_url UNIQUE` (auto), explicit FK index on `scan_run_id`. No speculative indexes. |

### Naming conventions

- **Casing:** All columns are `snake_case`. Source-side camelCase mapped at ingest (e.g. `jobPostingId` → `job_posting_id`)
- **URN handling:** URNs captured as raw strings; parsing deferred
- **Glassdoor sub-tree prefixes:** `*` (no prefix) for canonical `jobDetailsData`; `header_*`, `map_*`, `jobview_job_*` for sub-trees of `jobDetailsRawData.jobview`; `jsonld_*` for separate JSON-LD block
- **Indeed cross-surface prefixes:** `*` (no prefix) for canonical mosaic; `graphql_*` for GraphQL alt
- **Salary column names:** mechanically standardized to `salary_*` for canonical; surface prefixes for alts. Source vocabulary preserved for **values** per CC-10

---

## 3. Common columns (every per-source table)

```sql
-- These six columns appear on linkedin_jobs, indeed_jobs, AND glassdoor_jobs:

id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
scan_run_id   UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT
job_url       VARCHAR(2048) NOT NULL UNIQUE
scrape_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
source_raw    JSONB                                  -- dev/test only; dropped in production
matched       BOOLEAN NOT NULL DEFAULT FALSE         -- NEW from migration 028
```

Plus all three tables get an explicit FK index per CC-12:

```sql
CREATE INDEX ix_linkedin_jobs_scan_run_id ON linkedin_jobs(scan_run_id);
CREATE INDEX ix_indeed_jobs_scan_run_id ON indeed_jobs(scan_run_id);
CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id);
```

---

## 4. `linkedin_jobs` (51 columns)

Source: Voyager API `WebFullJobPosting-65` decoration. `data` → row columns; `included[]` → resolved entity fields → row columns.

### Identity (2)
| Column | Type | Source |
|---|---|---|
| `job_posting_id` | VARCHAR(32) | `data.jobPostingId` — LinkedIn's stable numeric ID |
| `job_posting_url` | TEXT | `data.jobPostingUrl` — same as `job_url` |

### Timing & lifecycle (6)
| Column | Type | Source |
|---|---|---|
| `listed_at` | BIGINT | `data.listedAt` — epoch ms |
| `original_listed_at` | BIGINT | `data.originalListedAt` |
| `job_state` | VARCHAR(32) | `data.jobState` (`LISTED` / `CLOSED`) |
| `job_application_limit_reached` | BOOLEAN | `data.jobApplicationLimitReached` |
| `expire_at` | BIGINT | `data.expireAt` — epoch ms (LinkedIn auto-set ~30 days) |
| `closed_at` | BIGINT | `data.closedAt` — epoch ms (NULL while live) |

### Location (7)
| Column | Type | Source |
|---|---|---|
| `formatted_location` | TEXT | `data.formattedLocation` |
| `country_urn` | VARCHAR(64) | `data.country` (full URN) |
| `location_urn` | VARCHAR(64) | `data.locationUrn` |
| `location_visibility` | VARCHAR(32) | `data.locationVisibility` (`ADDRESS` / `HIDDEN` / `REMOTE_ONLY`) |
| `postal_address` | JSONB | `data.postalAddress` |
| `standardized_addresses` | JSONB | `data.standardizedAddresses` |
| `job_region` | TEXT | `data.jobRegion` |

### Work mode (3)
| Column | Type | Source |
|---|---|---|
| `work_remote_allowed` | BOOLEAN | `data.workRemoteAllowed` |
| `workplace_types_urns` | JSONB | `data.workplaceTypes` |
| `workplace_types_labels` | JSONB | `data.workplaceTypesResolutionResults` |

### Employment & taxonomy (8)
| Column | Type | Source |
|---|---|---|
| `formatted_employment_status` | VARCHAR(32) | `data.formattedEmploymentStatus` |
| `employment_status_urn` | VARCHAR(64) | `data.employmentStatus` |
| `formatted_industries` | JSONB | `data.formattedIndustries` |
| `formatted_job_functions` | JSONB | `data.formattedJobFunctions` |
| `title` | TEXT | `data.title` |
| `standardized_title` | TEXT | `included[].Title.localizedName` (URN-resolved) |
| `formatted_experience_level` | VARCHAR(32) | `data.formattedExperienceLevel` |
| `skills_description` | TEXT | `data.skillsDescription` |

### Apply (4)
| Column | Type | Source |
|---|---|---|
| `apply_method_type` | VARCHAR(64) | `data.applyMethod.$type` (Java suffix dropped) |
| `company_apply_url` | TEXT | `data.applyMethod.companyApplyUrl` |
| `applicant_tracking_system` | VARCHAR(64) | `data.applicantTrackingSystem` |
| `top_level_company_apply_url` | TEXT | `data.companyApplyUrl` |

### Salary (5)
| Column | Type | Source |
|---|---|---|
| `salary_min` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].minSalary` |
| `salary_max` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].maxSalary` |
| `salary_currency` | VARCHAR(3) | `data.salaryInsights.compensationBreakdown[0].currencyCode` |
| `salary_period` | VARCHAR(16) | `data.salaryInsights.compensationBreakdown[0].payPeriod` (`YEARLY`/`HOURLY`/`MONTHLY`) |
| `salary_provided_by_employer` | BOOLEAN | `data.salaryInsights.providedByEmployer` |

### Description (1)
| Column | Type | Source |
|---|---|---|
| `description_text` | TEXT | `data.description.text` — primary matching input |

### Benefits (2)
| Column | Type | Source |
|---|---|---|
| `inferred_benefits` | JSONB | `data.inferredBenefits` |
| `benefits` | JSONB | `data.benefits` |

### Company — resolved from `included[]` (4)
| Column | Type | Source |
|---|---|---|
| `company_name` | TEXT | `included[].Company.name` — required for matching |
| `company_universal_name` | VARCHAR(128) | `included[].Company.universalName` |
| `company_url` | TEXT | `included[].Company.url` |
| `company_description` | TEXT | `included[].Company.description` |

### Resolved URN companions (4)
| Column | Type | Source |
|---|---|---|
| `title_entity_urn` | VARCHAR(64) | `included[].Title.entityUrn` |
| `employment_status_label` | VARCHAR(32) | `included[].EmploymentStatus.localizedName` |
| `employment_status_entity_urn` | VARCHAR(64) | `included[].EmploymentStatus.entityUrn` |
| `workplace_type_entity_urn` | VARCHAR(64) | `included[].WorkplaceType.entityUrn` |

**Total: 6 common + 2 identity + 6 timing + 7 location + 3 work mode + 8 employment + 4 apply + 5 salary + 1 description + 2 benefits + 4 company + 4 URN companions = 51 columns**

---

## 5. `indeed_jobs` (61 columns)

Source: `mosaic_job` (SERP-side) + `GraphQL Extended Query` (detail-side), both fetched per scrape. Either side may be NULL if that surface failed.

### Surface presence (2) — Indeed-specific
| Column | Type | Source |
|---|---|---|
| `mosaic_present` | BOOLEAN | derived at ingest — TRUE if mosaic block non-null |
| `graphql_present` | BOOLEAN | derived at ingest — TRUE if graphql block non-null |

**CHECK constraint:** `indeed_jobs_surface_present CHECK (mosaic_present OR graphql_present)` — rows with both surfaces failed are rejected at ingest.

### Identity & URLs (mosaic) (5)
| Column | Type | Source |
|---|---|---|
| `jobkey` | VARCHAR(32) | `mosaic.jobkey` — 16-char hex stable Indeed ID |
| `link` | TEXT | `mosaic.link` |
| `view_job_link` | TEXT | `mosaic.viewJobLink` |
| `more_loc_url` | TEXT | `mosaic.moreLocUrl` |
| `third_party_apply_url` | TEXT | `mosaic.thirdPartyApplyUrl` |

### Timing (mosaic) (4)
| Column | Type | Source |
|---|---|---|
| `pub_date` | BIGINT | `mosaic.pubDate` — epoch ms |
| `create_date` | BIGINT | `mosaic.createDate` |
| `expiration_date` | BIGINT | `mosaic.expirationDate` |
| `expired` | BOOLEAN | `mosaic.expired` |

### Title & taxonomy (mosaic) (5)
| Column | Type | Source |
|---|---|---|
| `title` | TEXT | `mosaic.title` |
| `display_title` | TEXT | `mosaic.displayTitle` |
| `norm_title` | TEXT | `mosaic.normTitle` |
| `job_types` | JSONB | `mosaic.jobTypes` |
| `taxonomy_attributes` | JSONB | `mosaic.taxonomyAttributes` |

### Location (mosaic) (7)
| Column | Type | Source |
|---|---|---|
| `formatted_location` | TEXT | `mosaic.formattedLocation` |
| `job_location_city` | VARCHAR(128) | `mosaic.jobLocationCity` |
| `job_location_state` | VARCHAR(8) | `mosaic.jobLocationState` |
| `job_location_postal` | VARCHAR(16) | `mosaic.jobLocationPostal` |
| `location_count` | INTEGER | `mosaic.locationCount` |
| `additional_location_link` | TEXT | `mosaic.additionalLocationLink` |
| `remote_location` | BOOLEAN | `mosaic.remoteLocation` |

### Salary (mosaic) (6)
| Column | Type | Source |
|---|---|---|
| `salary_min` | NUMERIC | `mosaic.extractedSalary.min` |
| `salary_max` | NUMERIC | `mosaic.extractedSalary.max` |
| `salary_period` | VARCHAR(16) | `mosaic.extractedSalary.type` (`YEARLY`/`HOURLY`) |
| `salary_currency` | VARCHAR(3) | `mosaic.salarySnippet.currency` |
| `salary_text` | TEXT | `mosaic.salarySnippet.salaryTextFormatted` |
| `salary_snippet_source` | VARCHAR(32) | `mosaic.salarySnippet.source` |

### Employer (mosaic) (1)
| Column | Type | Source |
|---|---|---|
| `company` | TEXT | `mosaic.company` |

### Apply (mosaic) (3)
| Column | Type | Source |
|---|---|---|
| `indeed_apply_enabled` | BOOLEAN | `mosaic.indeedApplyEnabled` |
| `indeed_applyable` | BOOLEAN | `mosaic.indeedApplyable` |
| `screener_questions_url` | TEXT | `mosaic.screenerQuestionsURL` |

> Note: `apply_count` was dropped in migration 026.

### Pre-extracted requirements (mosaic) (3)
| Column | Type | Source |
|---|---|---|
| `match_negative_taxonomy` | JSONB | `mosaic.jobSeekerMatchSummaryModel.taxoEntityMatchesNegative` |
| `match_mismatching_entities` | JSONB | `mosaic.jobSeekerMatchSummaryModel.sortedMisMatchingEntityDisplayText` |
| `num_hires` | INTEGER | `mosaic.numHires` |

### Identity & URLs (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `employer_canonical_url` | TEXT | `graphql.job.url` |

### Timing (graphql) (3)
| Column | Type | Source |
|---|---|---|
| `graphql_date_published` | DATE | `graphql.job.datePublished` |
| `graphql_date_on_indeed` | DATE | `graphql.job.dateOnIndeed` |
| `graphql_expired` | BOOLEAN | `graphql.job.expired` |

### Title & taxonomy (graphql) (3)
| Column | Type | Source |
|---|---|---|
| `graphql_title` | TEXT | `graphql.job.title` |
| `graphql_normalized_title` | TEXT | `graphql.job.normalizedTitle` |
| `attributes` | JSONB | `graphql.job.attributes` |

### Location (graphql) (6)
| Column | Type | Source |
|---|---|---|
| `location_formatted_long` | TEXT | `graphql.job.location.formatted.long` |
| `graphql_location_city` | VARCHAR(128) | `graphql.job.location.city` |
| `graphql_location_postal_code` | VARCHAR(16) | `graphql.job.location.postalCode` |
| `graphql_location_street_address` | TEXT | `graphql.job.location.streetAddress` |
| `graphql_location_admin1_code` | VARCHAR(8) | `graphql.job.location.admin1Code` |
| `graphql_location_country_code` | VARCHAR(2) | `graphql.job.location.countryCode` |

### Description (graphql) (2)
| Column | Type | Source |
|---|---|---|
| `description_text` | TEXT | `graphql.job.description.text` — primary matching input |
| `language` | VARCHAR(8) | `graphql.job.language` |

### Employer (graphql) (2)
| Column | Type | Source |
|---|---|---|
| `employer_name` | TEXT | `graphql.job.employer.name` |
| `employer_company_page_url` | TEXT | `graphql.job.employer.relativeCompanyPageUrl` |

### Source / provenance (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `source_name` | VARCHAR(64) | `graphql.job.source.name` (e.g. `Greenhouse`) |

### Salary (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `graphql_salary_period` | VARCHAR(16) | `graphql.job.compensation.baseSalary.unitOfWork` (`YEAR`/`HOUR`/`WEEK`/`MONTH`) |

**Total: 6 common + 2 surface presence + 5 identity (mosaic) + 4 timing (mosaic) + 5 title/tax (mosaic) + 7 location (mosaic) + 6 salary (mosaic) + 1 employer (mosaic) + 3 apply (mosaic) + 3 reqs (mosaic) + 1 graphql identity + 3 graphql timing + 3 graphql title/tax + 6 graphql location + 2 graphql description + 2 graphql employer + 1 graphql source + 1 graphql salary = 61 columns**

---

## 6. `glassdoor_jobs` (69 columns)

Source: JSON-LD `JobPosting` + `jobDetailsData` top-level + three `jobDetailsRawData.jobview.*` sub-trees (header / map / job).

### Identity & taxonomy IDs (3)
| Column | Type | Source |
|---|---|---|
| `listing_id` | VARCHAR(32) | `jobDetailsData.listingId` |
| `goc_id` | INTEGER | `jobDetailsData.gocId` |
| `job_country_id` | INTEGER | `jobDetailsData.jobCountryId` |

### Title (2)
| Column | Type | Source |
|---|---|---|
| `job_title` | TEXT | `jobDetailsData.jobTitle` |
| `normalized_job_title` | TEXT | `jobDetailsData.normalizedJobTitle` |

### Lifecycle (2)
| Column | Type | Source |
|---|---|---|
| `expired` | BOOLEAN | `jobDetailsData.expired` |
| `employer_active_status` | VARCHAR(16) | `jobDetailsData.employerActiveStatus` |

### Apply (3)
| Column | Type | Source |
|---|---|---|
| `is_easy_apply` | BOOLEAN | `jobDetailsData.isEasyApply` |
| `job_link` | TEXT | `jobDetailsData.jobLink` (RSC ref pre-resolution; raw `"$3f"` etc.) |
| `seo_job_link` | TEXT | `jobDetailsData.seoJobLink` |

### Salary (4)
| Column | Type | Source |
|---|---|---|
| `salary_currency` | VARCHAR(3) | `jobDetailsData.payCurrency` |
| `salary_period` | VARCHAR(16) | `jobDetailsData.payPeriod` (`ANNUAL`/`HOURLY`/`MONTHLY`) |
| `salary_source` | VARCHAR(32) | `jobDetailsData.salarySource` |
| `pay_period_adjusted_pay` | JSONB | `jobDetailsData.payPeriodAdjustedPay` (`{p10, p50, p90}`; may be unresolved RSC ref) |

### Location (2)
| Column | Type | Source |
|---|---|---|
| `location_name` | TEXT | `jobDetailsData.locationName` |
| `location` | JSONB | `jobDetailsData.location` (`{id, name, type}`) |

### Employer (2)
| Column | Type | Source |
|---|---|---|
| `employer_name` | TEXT | `jobDetailsData.employerName` |
| `employer_overview` | TEXT | `jobDetailsData.employerOverview` |

### Pre-extracted skills/education (3)
| Column | Type | Source |
|---|---|---|
| `indeed_job_attribute` | JSONB | `jobDetailsData.indeedJobAttribute` |
| `skills_labels` | JSONB | `jobDetailsData.indeedJobAttribute.skillsLabel` |
| `education_labels` | JSONB | `jobDetailsData.indeedJobAttribute.educationLabel` |

### Description (1)
| Column | Type | Source |
|---|---|---|
| `job_description_plain` | TEXT | `jobDetailsData.jobDescription` |

### Reviews & benefits (2)
| Column | Type | Source |
|---|---|---|
| `employer_benefits_overview` | TEXT | `jobDetailsData.employerBenefitsOverview` |
| `employer_benefits_reviews` | JSONB | `jobDetailsData.employerBenefitsReviews` |

### JSON-LD `JobPosting` (19)
| Column | Type | Source |
|---|---|---|
| `title` | TEXT | `JobPosting.title` |
| `date_posted` | DATE | `JobPosting.datePosted` |
| `valid_through` | DATE | `JobPosting.validThrough` (NOT a real expiry signal — forensic only) |
| `description` | TEXT | `JobPosting.description` (HTML JD body — often longest) |
| `experience_requirements_description` | TEXT | `JobPosting.experienceRequirements.description` |
| `experience_requirements_months` | INTEGER | `JobPosting.experienceRequirements.monthsOfExperience` |
| `education_requirements_credential` | VARCHAR(64) | `JobPosting.educationRequirements.credentialCategory` |
| `employment_type` | JSONB | `JobPosting.employmentType` |
| `jsonld_salary_currency_top` | VARCHAR(3) | `JobPosting.salaryCurrency` |
| `jsonld_salary_currency` | VARCHAR(3) | `JobPosting.baseSalary.currency` |
| `jsonld_salary_min` | NUMERIC | `JobPosting.baseSalary.value.minValue` |
| `jsonld_salary_max` | NUMERIC | `JobPosting.baseSalary.value.maxValue` |
| `jsonld_salary_period` | VARCHAR(16) | `JobPosting.baseSalary.value.unitText` (`YEAR`/`HOUR`/`MONTH`/`WEEK`) |
| `job_location` | JSONB | `JobPosting.jobLocation` |
| `job_location_type` | VARCHAR(32) | `JobPosting.jobLocationType` |
| `hiring_organization` | JSONB | `JobPosting.hiringOrganization` |
| `industry` | VARCHAR(64) | `JobPosting.industry` |
| `direct_apply` | BOOLEAN | `JobPosting.directApply` |
| `job_benefits` | TEXT | `JobPosting.jobBenefits` |

### `jobDetailsRawData.jobview.header` (11)
| Column | Type | Source |
|---|---|---|
| `header_goc` | VARCHAR(64) | `header.goc` |
| `job_type` | JSONB | `header.jobType` |
| `job_type_keys` | JSONB | `header.jobTypeKeys` |
| `remote_work_types` | JSONB | `header.remoteWorkTypes` |
| `header_expired` | BOOLEAN | `header.expired` |
| `header_easy_apply` | BOOLEAN | `header.easyApply` |
| `header_apply_url` | TEXT | `header.applyUrl` (RSC ref pre-resolution) |
| `header_salary_source` | VARCHAR(32) | `header.salarySource` |
| `header_salary_currency` | VARCHAR(3) | `header.payCurrency` |
| `header_salary_period` | VARCHAR(16) | `header.payPeriod` |
| `header_employer` | JSONB | `header.employer` |

### `jobDetailsRawData.jobview.map` (7)
| Column | Type | Source |
|---|---|---|
| `map_address` | TEXT | `map.address` |
| `map_city_name` | VARCHAR(128) | `map.cityName` |
| `map_country` | VARCHAR(64) | `map.country` |
| `map_state_name` | VARCHAR(64) | `map.stateName` |
| `map_location_name` | TEXT | `map.locationName` |
| `map_postal_code` | VARCHAR(16) | `map.postalCode` |
| `map_employer` | JSONB | `map.employer` |

### `jobDetailsRawData.jobview.job` (3)
| Column | Type | Source |
|---|---|---|
| `discover_date` | TIMESTAMPTZ | `jobview.job.discoverDate` (parsed as UTC; source has no offset) |
| `job_title_text` | TEXT | `jobview.job.jobTitleText` |
| `jobview_job_description` | TEXT | `jobview.job.description` |

**Total: 6 common + 3 identity + 2 title + 2 lifecycle + 3 apply + 4 salary + 2 location + 2 employer + 3 skills/edu + 1 description + 2 reviews + 19 JSON-LD + 11 header + 7 map + 3 jobview.job = 69 columns**

---

## 7. `system_settings` (NEW from 029)

Key-value store for tunable settings.

```sql
CREATE TABLE system_settings (
    key VARCHAR(64) PRIMARY KEY,
    value VARCHAR(256) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value) VALUES ('shelf_life_days', '7');
```

### Currently seeded keys

| Key | Value | Used by |
|---|---|---|
| `shelf_life_days` | `'7'` | `auto_expiration.run_auto_expiration` — DELETE rows where `scrape_time + shelf_life_days < NOW()` |

### Accessors

`backend/core/system_settings.py`:

- `get_setting(db, key) -> Optional[str]` — generic raw-SQL accessor
- `get_shelf_life_days(db) -> int` — typed wrapper. Returns 7 on missing/malformed values (defensive default; never raises)

### Adding new settings

Future settings reuse this table. Pattern:

1. Insert via Alembic migration: `INSERT INTO system_settings (key, value) VALUES ('new_key', '...')`
2. Add typed accessor in `core/system_settings.py` with safety default
3. Read in code: `value = await get_my_setting(db)`

No schema change needed for new settings — just new keys.

---

## 8. `auto_scrape_cycles` JSONB columns — current shapes

Both `cleanup_results` and `match_results` are existing JSONB columns (created in migration 023). After this session they're now actively populated by the post-scrape orchestrator's Phase 1 and Phase 2.

### `cleanup_results` — populated by Phase 1 (auto-expiration)

```json
{
  "shelf_life_days": 7,
  "deleted_per_table": {
    "linkedin_jobs": 23,
    "indeed_jobs": 8,
    "glassdoor_jobs": 11
  }
}
```

Written immediately after the auto-expiration helper runs. Counts are how many rows were aged out per table this cycle.

### `match_results` — populated by Phase 2 (matched-claim) + Phase 3 (dedup/matching, currently stubbed)

```json
{
  "claim_summary": {
    "linkedin": 952,
    "indeed": 197,
    "glassdoor": 157
  }
  // Future dedup/matching keys will land here:
  // "dedup_skipped": ...
  // "matched_count": ...
  // "gate_failures": ...
}
```

`claim_summary` always populated. Other keys are forward-compatible — Phase 4c smoke test specifically validates `claim_summary` shape if present and tolerates additional unknown keys (so dedup/matching can land more keys without breaking the assertion).

### Edge case: cycle fails between Phase 2 and final write

If the cycle crashes after Phase 1 but before the final `_update_cycle(match_results=...)`:
- `cleanup_results` reflects the auto-expiration that ran (written immediately in Phase 1)
- `match_results` is empty `{}` even though per-source rows are flagged `matched=true`
- Recovery: manual re-evaluation if needed; auto-expiration will eventually delete the orphaned rows at shelf_life

This is documented as Known Limitation §15.2 in `step1-schema-design.md`.

---

## 9. `extension_run_logs` — relevant columns for orchestration

Schema unchanged this session; documented here because matched mechanism + cycle 455 fix interact with it.

```sql
-- Key columns for matched mechanism / orchestration:
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
strategy        VARCHAR NOT NULL DEFAULT 'C'
status          VARCHAR NOT NULL DEFAULT 'running'   -- 'running' / 'completed' / 'failed'
started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
completed_at    TIMESTAMPTZ
search_filters  JSONB                                 -- includes website + scan_run_id metadata
search_keyword  VARCHAR
error_message   TEXT                                  -- cleared on terminal-success per cycle 455 fix
failure_reason  TEXT
failure_category TEXT
debug_log       JSONB                                 -- in-scan structured trace
```

### Status transitions

```
running → completed   (terminal-success, cleared error_message per cycle 455 fix)
running → failed      (terminal-failure, error_message preserved)
```

**NOT a one-way state machine** (per Bug 3 deferred rationale): `failed → completed` transition is allowed today because the content script's terminal-success write recovered cycle 455's data. Locking this down requires upstream write-path audit first.

### Stale-row cleanup (post cycle 455 fix)

In `routers/extension.py` `trigger_scan` endpoint:

```python
stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=60)  # was 5
# Mark running rows older than 60 min as failed with error_message:
# "Scan exceeded 60 minutes without completion; backend likely lost contact during scan. Please retry."
```

60-minute threshold accommodates LinkedIn full-pagination scans (~33 min legitimate) while still catching genuine B-23 stuck rows.

---

## 10. Indexes and constraints

### Per-source tables — auto from PK and UNIQUE

```sql
-- All three tables get these automatically:
PRIMARY KEY (id)              -- creates ix_<table>_pkey
UNIQUE (job_url)              -- creates ix_<table>_job_url_key
```

### Per-source tables — explicit FK indexes (CC-12)

```sql
CREATE INDEX ix_linkedin_jobs_scan_run_id ON linkedin_jobs(scan_run_id);
CREATE INDEX ix_indeed_jobs_scan_run_id ON indeed_jobs(scan_run_id);
CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id);
```

PostgreSQL does NOT auto-create indexes on FK columns. These are needed for cleanup queries that filter by `scan_run_id`.

### `indeed_jobs` CHECK constraint

```sql
CONSTRAINT indeed_jobs_surface_present CHECK (mosaic_present OR graphql_present)
```

Rows where both surfaces failed are rejected at ingest. Important for INSERT testing — must populate at least one of `mosaic_present=TRUE` or `graphql_present=TRUE` (the smoke tests use a `_TABLE_EXTRAS` dict that sets `mosaic_present=True` for indeed inserts).

### Foreign keys

```sql
linkedin_jobs.scan_run_id  → extension_run_logs.id  ON DELETE RESTRICT
indeed_jobs.scan_run_id    → extension_run_logs.id  ON DELETE RESTRICT
glassdoor_jobs.scan_run_id → extension_run_logs.id  ON DELETE RESTRICT
scraped_jobs.scan_run_id   → extension_run_logs.id  (no ON DELETE rule — legacy)
dedup_reports.scan_run_id  → extension_run_logs.id  ON DELETE SET NULL
dedup_tasks.scan_run_id    → extension_run_logs.id  ON DELETE CASCADE
```

The `RESTRICT` policy on per-source tables means run-logs cannot be deleted while per-source rows reference them. Prevents accidental data loss; cleanup must happen via per-source DELETE first.

### No speculative indexes

Per CC-12, no additional indexes added. The minimum set above covers PK lookups, conflict-resolution by `job_url`, and cleanup/dedup queries by `scan_run_id`. Add more only when a specific query proves slow.

---

## 11. What's NOT in the per-source tables (still on `scraped_jobs`)

These remain on the legacy `scraped_jobs` unified table:

| Column | Purpose |
|---|---|
| `skip_reason` | Dedup pipeline output (which dedup rule fired) |
| `dedup_original_job_id` | FK pointing to the original of a duplicate |
| `matched_at` | JD-extraction/matching pipeline completion timestamp — DIFFERENT from `matched` BOOLEAN on per-source tables |
| `embedding` | Vector embedding for cosine dedup |
| `match_score` | Numeric match score from matching pipeline |
| `match_report_id` | FK to `match_reports` for full breakdown |

### Important naming overlap

`scraped_jobs.matched_at` (legacy) vs `linkedin_jobs.matched` etc. (new) are **different concepts**:
- `matched_at TIMESTAMPTZ` — when the matching pipeline finished processing this row (legacy)
- `matched BOOLEAN` — orchestrator-claimed flag for per-cycle batch processing (new)

Both will coexist until `scraped_jobs` is retired (after dedup/matching pipelines wire into the per-source path).

### Why `scraped_jobs` is still active

The legacy `scraped_jobs` table is still receiving ingest writes during the transition. It will be retired once the dedup/matching pipelines are wired into the new merged-jobs flow. Current state: both per-source tables AND `scraped_jobs` get writes for the same job (the ingest router writes to both as part of the migration period).

---

## 12. Quick column-count summary

| Table | Total | Common | Site-specific |
|---|---|---|---|
| `linkedin_jobs` | 51 | 6 | 45 |
| `indeed_jobs` | 61 | 6 | 55 |
| `glassdoor_jobs` | 69 | 6 | 63 |
| `system_settings` | 3 | — | — |

All three per-source tables share the 6-column common prefix (`id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`, `matched`).

For the equivalent "what fields are sourced from where" mapping at field granularity, see `scrape-fields-master.md`.

---

*End of schema reference. Source-of-truth files: `step1-schema-design.md` v12 (design rationale), `backend/routers/jobs.py` `*_COLS` constants (live ingest contract), Alembic migrations 025-029 (DDL history). When live DB and this doc disagree, use `information_schema` introspection on the live DB as ground truth.*
