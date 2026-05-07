# Scrape Fields — Glassdoor (`glassdoor_jobs`)

**Source of truth:** `current-schemas.md` (Alembic head: 029, as of 2026-05-07).  
**Table column count:** **70** (6 common + 64 site-specific). *Note: `current-schemas.md` states 69 columns based on its own subsection-sum arithmetic which is off by 1; counting actual rows in the column tables yields 70. The schema below reproduces the actual rows.*

The six common-prefix columns (`id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`, `matched`) are documented in the **Schema** section below; they're shared across all three per-source tables and not derived field-by-field from the scraped payload (except `job_url`, which mirrors a platform-specific URL field). They're not repeated in the field-decision table below.

This document catalogs every field exposed by the Glassdoor scrape surface and shows whether it's ingested into `glassdoor_jobs` (and under what column name) or dropped.

> Conventions:
> - **Field name** — the raw key as it appears in the source response (with prefix path where present).
> - **Description** — what the field encodes, with at least one example value.
> - **Encrypted?** — 🟢 unencrypted (plain readable), 🔴 encrypted (opaque hash/blob, cannot decode), or 🟡 parseable (URN, namespaced string, structured object whose format yields a human-meaningful value with format/parsed-form documented).
> - **In schema?** — `✅ Keep as <column>` (ingested under that column name) or `❌ Drop` (not ingested).

---

## Schema — `glassdoor_jobs` (70 columns)

The DDL for `glassdoor_jobs` lives in Alembic migrations 025–029. Total 70 columns: 6 common-prefix + 64 site-specific. The site-specific columns are sourced from the Glassdoor scrape payload (see field-decision table below for which payload field feeds which column).

### Common columns (shared across all 3 per-source tables) — 6 cols

```sql
-- These six columns appear on linkedin_jobs, indeed_jobs, AND glassdoor_jobs:
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
scan_run_id   UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT
job_url       VARCHAR(2048) NOT NULL UNIQUE
scrape_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
source_raw    JSONB                                  -- dev/test only; dropped in production
matched       BOOLEAN NOT NULL DEFAULT FALSE         -- NEW from migration 028
```

Plus an FK index on `scan_run_id`:

```sql
CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id);
```

### Site-specific columns — 64 cols

#### Identity & taxonomy IDs (3)
| Column | Type | Source |
|---|---|---|
| `listing_id` | VARCHAR(32) | `jobDetailsData.listingId` |
| `goc_id` | INTEGER | `jobDetailsData.gocId` |
| `job_country_id` | INTEGER | `jobDetailsData.jobCountryId` |

#### Title (2)
| Column | Type | Source |
|---|---|---|
| `job_title` | TEXT | `jobDetailsData.jobTitle` |
| `normalized_job_title` | TEXT | `jobDetailsData.normalizedJobTitle` |

#### Lifecycle (2)
| Column | Type | Source |
|---|---|---|
| `expired` | BOOLEAN | `jobDetailsData.expired` |
| `employer_active_status` | VARCHAR(16) | `jobDetailsData.employerActiveStatus` |

#### Apply (3)
| Column | Type | Source |
|---|---|---|
| `is_easy_apply` | BOOLEAN | `jobDetailsData.isEasyApply` |
| `job_link` | TEXT | `jobDetailsData.jobLink` (RSC ref pre-resolution; raw `"$3f"` etc.) |
| `seo_job_link` | TEXT | `jobDetailsData.seoJobLink` |

#### Salary (4)
| Column | Type | Source |
|---|---|---|
| `salary_currency` | VARCHAR(3) | `jobDetailsData.payCurrency` |
| `salary_period` | VARCHAR(16) | `jobDetailsData.payPeriod` (`ANNUAL`/`HOURLY`/`MONTHLY`) |
| `salary_source` | VARCHAR(32) | `jobDetailsData.salarySource` |
| `pay_period_adjusted_pay` | JSONB | `jobDetailsData.payPeriodAdjustedPay` (`{p10, p50, p90}`; may be unresolved RSC ref) |

#### Location (2)
| Column | Type | Source |
|---|---|---|
| `location_name` | TEXT | `jobDetailsData.locationName` |
| `location` | JSONB | `jobDetailsData.location` (`{id, name, type}`) |

#### Employer (2)
| Column | Type | Source |
|---|---|---|
| `employer_name` | TEXT | `jobDetailsData.employerName` |
| `employer_overview` | TEXT | `jobDetailsData.employerOverview` |

#### Pre-extracted skills/education (3)
| Column | Type | Source |
|---|---|---|
| `indeed_job_attribute` | JSONB | `jobDetailsData.indeedJobAttribute` |
| `skills_labels` | JSONB | `jobDetailsData.indeedJobAttribute.skillsLabel` |
| `education_labels` | JSONB | `jobDetailsData.indeedJobAttribute.educationLabel` |

#### Description (1)
| Column | Type | Source |
|---|---|---|
| `job_description_plain` | TEXT | `jobDetailsData.jobDescription` |

#### Reviews & benefits (2)
| Column | Type | Source |
|---|---|---|
| `employer_benefits_overview` | TEXT | `jobDetailsData.employerBenefitsOverview` |
| `employer_benefits_reviews` | JSONB | `jobDetailsData.employerBenefitsReviews` |

#### JSON-LD `JobPosting` (19)
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

#### `jobDetailsRawData.jobview.header` (11)
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

#### `jobDetailsRawData.jobview.map` (7)
| Column | Type | Source |
|---|---|---|
| `map_address` | TEXT | `map.address` |
| `map_city_name` | VARCHAR(128) | `map.cityName` |
| `map_country` | VARCHAR(64) | `map.country` |
| `map_state_name` | VARCHAR(64) | `map.stateName` |
| `map_location_name` | TEXT | `map.locationName` |
| `map_postal_code` | VARCHAR(16) | `map.postalCode` |
| `map_employer` | JSONB | `map.employer` |

#### `jobDetailsRawData.jobview.job` (3)
| Column | Type | Source |
|---|---|---|
| `discover_date` | TIMESTAMPTZ | `jobview.job.discoverDate` (parsed as UTC; source has no offset) |
| `job_title_text` | TEXT | `jobview.job.jobTitleText` |
| `jobview_job_description` | TEXT | `jobview.job.description` |

---

Five scrape sources:

- **SERP card DOM**: 4 `data-*` attributes from each job card.
- **JSON-LD `JobPosting`**: schema.org block embedded in `<script type="application/ld+json">`.
- **`jobDetailsData`** (top-level): extracted from `__next_f.push` RSC streaming chunks.
- **`jobDetailsRawData.jobview.header`**: nested header sub-tree inside `jobDetailsData`.
- **`jobDetailsRawData.jobview.map`**: nested map sub-tree.
- **`jobDetailsRawData.jobview.job`**: nested job sub-tree.
- **`jobDetailsRawData` other sub-trees** (`overview`, `employerAttributes`, `employerContent`, `gaTrackerData`).

### SERP card DOM

#### Identity & URLs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `data-jobid` | Listing ID in card. Example: `"1009401234567"`. | 🟢 unencrypted | ❌ Drop |
| `data-test` | Test attribute for QA. Example: `"job-card"`. | 🟢 unencrypted | ❌ Drop |
| `data-brandviews` | Brand-view tracking. Example: a compact JSON-like string. | 🟢 unencrypted | ❌ Drop |
| `data-srum` | Search-result tracking. Example: opaque blob. | 🔴 encrypted field cannot be parsed — opaque tracking blob. | ❌ Drop |

### JSON-LD `JobPosting`

#### Identity

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `@context` | Schema.org `@context` URL. Example: `"https://schema.org/"`. | 🟢 unencrypted | ❌ Drop |
| `@type` | Schema.org type. Example: `"JobPosting"`. | 🟢 unencrypted | ❌ Drop |
| `title` | Raw title. Example: `"Senior Software Engineer"`. | 🟢 unencrypted | ✅ Keep as `title` |

#### Timing

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `datePosted` | ISO date string when published. Example: `"2025-10-31"`. Date-only precision. | 🟢 unencrypted | ✅ Keep as `date_posted` |
| `validThrough` | ISO date string for posting validity end. Example: `"2026-02-28"`. | 🟢 unencrypted | ✅ Keep as `valid_through` |

#### Description & requirements

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `description` | HTML JD body. Example: full HTML JD ~3,000-8,000 chars. | 🟢 unencrypted | ✅ Keep as `description` |
| `experienceRequirements.description` | Comma-separated requirement summary. Example: `"5+ years of software engineering, Bachelor's degree, Python"`. | 🟢 unencrypted | ✅ Keep as `experience_requirements_description` |
| `experienceRequirements.@type` | Schema metadata. Example: `"OccupationalExperienceRequirements"`. | 🟢 unencrypted | ❌ Drop |
| `experienceRequirements.monthsOfExperience` | Numeric experience requirement. Example: `60` (= 5 years). | 🟢 unencrypted | ✅ Keep as `experience_requirements_months` |
| `educationRequirements.credentialCategory` | Credential category. Examples: `"bachelor's degree"`, `"high school"`. | 🟢 unencrypted | ✅ Keep as `education_requirements_credential` |
| `educationRequirements.@type` | Schema metadata. Example: `"EducationalOccupationalCredential"`. | 🟢 unencrypted | ❌ Drop |
| `experienceInPlaceOfEducation` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |

#### Employment type

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `employmentType` | Schema.org enum array. Examples: `["FULL_TIME"]`, `["CONTRACTOR"]`. | 🟢 unencrypted | ✅ Keep as `employment_type` |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `salaryCurrency` | ISO currency code. Example: `"CAD"`. | 🟢 unencrypted | ✅ Keep as `jsonld_salary_currency_top` |
| `baseSalary.currency` | ISO currency from salary block. Example: `"CAD"`. | 🟢 unencrypted | ✅ Keep as `jsonld_salary_currency` |
| `baseSalary.value.minValue` | Min salary. Example: `80000`. | 🟢 unencrypted | ✅ Keep as `jsonld_salary_min` |
| `baseSalary.value.maxValue` | Max salary. Example: `120000`. | 🟢 unencrypted | ✅ Keep as `jsonld_salary_max` |
| `baseSalary.value.unitText` | Pay period. Examples: `"YEAR"`, `"HOUR"`, `"MONTH"`, `"WEEK"`. | 🟢 unencrypted | ✅ Keep as `jsonld_salary_period` |
| `baseSalary.@type` | Schema metadata for the salary block. Example: `"MonetaryAmount"`. | 🟢 unencrypted | ❌ Drop |
| `baseSalary.value.@type` | Schema metadata for the value sub-object. Example: `"QuantitativeValue"`. | 🟢 unencrypted | ❌ Drop |
| `estimatedSalary` | Glassdoor's algorithmic salary estimate. Example: `{currency: "CAD", value: {minValue: 75000, maxValue: 130000, unitText: "YEAR"}}`. | 🟢 unencrypted | ❌ Drop |

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobLocation` | Full schema.org Place object. Example: `{address: {addressCountry: "CA", addressLocality: "Toronto", addressRegion: "ON", postalCode: "M5X 1E1", streetAddress: "100 King St W"}}`. | 🟢 unencrypted | ✅ Keep as `job_location` |
| `jobLocationType` | Remote indicator. Example: `"TELECOMMUTE"` when fully remote, absent otherwise. | 🟢 unencrypted | ✅ Keep as `job_location_type` |

#### Employer

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `hiringOrganization` | schema.org Organization. Example: `{@type: "Organization", name: "Acme Corp", sameAs: "https://acme.com", logo: "https://..."}`. | 🟢 unencrypted | ✅ Keep as `hiring_organization` |

#### Misc

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `industry` | Industry string. Example: `"Software Development"`. | 🟢 unencrypted | ✅ Keep as `industry` |
| `directApply` | Boolean — schema.org "candidate can apply directly". Example: `true`. | 🟢 unencrypted | ✅ Keep as `direct_apply` |
| `jobBenefits` | Free-text benefits string. Example: `"Health insurance, 401k, paid time off"`. | 🟢 unencrypted | ✅ Keep as `job_benefits` |

### `jobDetailsData` (top-level)

#### Identity & taxonomy IDs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `listingId` | 13-digit numeric — stable Glassdoor job ID. Example: `1009401234567`. | 🟢 unencrypted | ✅ Keep as `listing_id` |
| `employerId` | Stable Glassdoor employer ID. Example: `1234567`. | 🟢 unencrypted | ❌ Drop |
| `employerBestProfileId` | Alternative employer profile ID. Example: `7654321`. | 🟢 unencrypted | ❌ Drop |
| `gocId` | Numeric General Occupation Code ID. Example: `102643`. | 🟡 Format: numeric ID `{n}`. Parsed: `{n}` = stable Glassdoor occupation ID; resolvable in-row via the parallel `header_goc` field on the same row (e.g. `"full stack engineer"`). | ✅ Keep as `goc_id` |
| `categoryMgocId` | Meta-occupation category ID. Example: `10132`. | 🔴 encrypted field cannot be parsed standalone — numeric ID with no captured display name and no public Glassdoor MGOC mapping. | ❌ Drop |
| `jobCountryId` | Glassdoor country ID. Examples: `1` (US), `2` (UK), `3` (Canada). | 🟡 Format: small integer `{n}`. Parsed: `{n}` = country code via lookup `{1: 'US', 2: 'UK', 3: 'CA', ...}` — matches Glassdoor URL parameter `_IN{n}`. | ✅ Keep as `job_country_id` |

#### Title

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobTitle` | Display title (mostly duplicate of JSON-LD `title`). Example: `"Senior Software Engineer"`. | 🟢 unencrypted | ✅ Keep as `job_title` |
| `normalizedJobTitle` | Lowercase canonical title. Example: `"senior software engineer"`. | 🟢 unencrypted | ✅ Keep as `normalized_job_title` |

#### Lifecycle / state

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `expired` | Boolean. Example: `false` on live jobs. | 🟢 unencrypted | ✅ Keep as `expired` |
| `employerActiveStatus` | Employer profile status. Examples: `"ACTIVE"`, `"INACTIVE"`. | 🟢 unencrypted | ✅ Keep as `employer_active_status` |
| `isIndexable` | Boolean — search-engine indexability. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `isSponsoredEmployer` | Boolean — paid-promotion at employer level. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `isSponsoredJob` | Boolean — paid-promotion at job level. Example: `true`. | 🟢 unencrypted | ❌ Drop |

#### Apply

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `isEasyApply` | Boolean — Glassdoor's one-click apply. Example: `true`. | 🟢 unencrypted | ✅ Keep as `is_easy_apply` |
| `jobLink` | The employer apply URL. Example: pre-resolution `"$3f"`; resolved `"https://boards.greenhouse.io/example/jobs/12345"`. | 🟡 Format pre-resolution: RSC reference `"${chunkId}"`. Parsed: `{chunkId}` = Next.js streaming chunk pointer — must walk other RSC chunks to dereference into a real URL. | ✅ Keep as `job_link` |
| `seoJobLink` | Glassdoor canonical URL with `jl=` param. Example: `"/job-listing/senior-software-engineer-acme-corp-JV_IC2281069_KO0,25_KE26,35.htm?jl=1009401234567"`. | 🟢 unencrypted | ✅ Keep as `seo_job_link` |
| `adOrderId` | Ad-tracking identifier. Example: `0`. | 🟢 unencrypted | ❌ Drop |
| `campaignKeys` | Ad-campaign keys. Example: opaque alphanumeric strings. | 🔴 encrypted field cannot be parsed — opaque campaign keys. | ❌ Drop |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `payCurrency` | ISO currency. Example: `"CAD"`. | 🟢 unencrypted | ✅ Keep as `salary_currency` |
| `payPeriod` | Pay period. Examples: `"ANNUAL"`, `"HOURLY"`, `"MONTHLY"`. | 🟢 unencrypted | ✅ Keep as `salary_period` |
| `salarySource` | Salary provenance enum. Examples: `"EMPLOYER_PROVIDED"`, `"ESTIMATED"`. | 🟢 unencrypted | ✅ Keep as `salary_source` |
| `payPeriodAdjustedPay` | Salary percentile distribution. Example: `{p10: 82000, p50: 101000, p90: 120000}`. | 🟢 unencrypted | ✅ Keep as `pay_period_adjusted_pay` |

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `locationName` | Display city string. Example: `"Toronto, ON"`. | 🟢 unencrypted | ✅ Keep as `location_name` |
| `location` | Glassdoor's structured location reference. Example: `{id: 2347, name: "Toronto", type: "C"}`. | 🟡 Format: `{id, name, type}`. Parsed: `name` and `type` are unencrypted (`type` enum: `C` = City, `S` = State, `N` = Country); `id` = opaque numeric Glassdoor city/place ID with no public mapping. | ✅ Keep as `location` |

#### Company ratings

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `companyRatings` | 9-dimension rating object. Example: `{overallRating: 3.8, careerOpportunitiesRating: 4.1, ceoRating: null, ceoRatingsCount: 0, compensationAndBenefitsRating: 4.1, cultureAndValuesRating: 4.1, recommendToFriendRating: 0.81, seniorManagementRating: 4.1, workLifeBalanceRating: 4}`. | 🟢 unencrypted | ❌ Drop |
| `employerRating` | Single overall rating. Example: `3.8`. | 🟢 unencrypted | ❌ Drop |

#### Employer

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `employerName` | Display employer name. Example: `"Acme Corp"`. | 🟢 unencrypted | ✅ Keep as `employer_name` |
| `employerOverview` | Long-form employer profile text. Example: `"Acme Corp is a leading provider of widgets..."`. | 🟢 unencrypted | ✅ Keep as `employer_overview` |

#### Pre-extracted skills/education

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `indeedJobAttribute` (parent) | Container object holding skills/education sub-fields. Example: `{skills: ["2V8EX", "84K74"], skillsLabel: ["CI/CD", "React"], education: ["HFDVW"], educationLabel: ["Bachelor's degree"]}`. | 🟢 unencrypted | ✅ Keep as `indeed_job_attribute` |
| `indeedJobAttribute.skillsLabel` | Clean array of skill display strings. Example: `["CI/CD", "React"]`. | 🟢 unencrypted | ✅ Keep as `skills_labels` |
| `indeedJobAttribute.educationLabel` | Clean array of credential strings. Example: `["Bachelor's degree"]`. | 🟢 unencrypted | ✅ Keep as `education_labels` |
| `indeedJobAttribute.skills` (suid array) | Stable Glassdoor skill IDs paralleling `skillsLabel`. Example: `["2V8EX", "84K74"]`. | 🟡 Format: array of 5-char hashes `["{suid}", ...]`. Parsed: `{suid}` = stable Glassdoor skill ID; resolvable in-row via the parallel `skillsLabel` array at the same positional index (e.g. `["CI/CD", "React"]`). | ❌ Drop |
| `indeedJobAttribute.education` (suid array) | Stable Glassdoor education IDs. Example: `["HFDVW"]`. | 🟡 Format: array of 5-char hashes `["{suid}", ...]`. Parsed: `{suid}` = stable Glassdoor education ID; resolvable in-row via the parallel `educationLabel` array at the same positional index (e.g. `["Bachelor's degree"]`). | ❌ Drop |

#### Description

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobDescription` | Plain-text JD body. Example: full plain-text JD ~3,000-8,000 chars. | 🟢 unencrypted | ✅ Keep as `job_description_plain` |

#### Reviews & benefits content

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `employerBenefitsOverview` | Aggregated free-text overview of employer benefits. Example: `"Comprehensive health benefits including..."`. | 🟢 unencrypted | ✅ Keep as `employer_benefits_overview` |
| `employerBenefitsReviews` | Aggregated review snippets specifically about benefits. Example: array of review objects. | 🟢 unencrypted | ✅ Keep as `employer_benefits_reviews` |
| `employerReviewHighlights` | Aggregated highlight snippets from employer reviews. Example: array of highlight objects. | 🟢 unencrypted | ❌ Drop |

#### Tracking & metadata

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `adOrderId` | Ad-tracking numeric ID. Example: `0`. | 🟢 unencrypted | ❌ Drop |
| `campaignKeys` | Ad-campaign keys. Example: opaque strings. | 🔴 encrypted field cannot be parsed — opaque keys. | ❌ Drop |
| `jobResultTrackingKey` | Click-tracking key. Example: opaque session-scoped string. | 🔴 encrypted field cannot be parsed — opaque session-scoped tracking key. | ❌ Drop |
| `trackingData` | Bundle of tracking metadata. Example: opaque object. | 🔴 encrypted field cannot be parsed — opaque tracking blob. | ❌ Drop |

### `jobDetailsRawData.jobview.header`

#### Title & taxonomy

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `goc` | Display form of `gocId`. Example: `"full stack engineer"`. | 🟢 unencrypted | ✅ Keep as `header_goc` |
| `sgocId` | Sub-occupation ID. Example: `1007`. | 🔴 encrypted field cannot be parsed standalone — numeric ID with no captured display name and no public Glassdoor SGOC mapping. | ❌ Drop |

#### Employment type / work mode

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobType` | Display string array. Example: `["Full-time"]`. | 🟢 unencrypted | ✅ Keep as `job_type` |
| `jobTypeKeys` | Namespaced array. Example: `["search-jobs.job-type-options.fulltime"]`. | 🟡 Format per element: `{namespace}.{category}.{key}`. Parsed: `{key}` (after last `.`) = bare key (e.g. `fulltime`, `parttime`, `contract`, `permanent`, `temporary`, `freelance`, `internship`, `fixed`). | ✅ Keep as `job_type_keys` |
| `remoteWorkTypes` | Enum array. Examples: `["WORK_FROM_HOME"]`, `["FULLY_ON_SITE"]`, `["PARTIALLY_REMOTE"]`. | 🟢 unencrypted | ✅ Keep as `remote_work_types` |

#### Timing

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `ageInDays` | Numeric — days since posting. Example: `3`. | 🟢 unencrypted | ❌ Drop |
| `expired` (header) | Boolean. Example: `false`. | 🟢 unencrypted | ✅ Keep as `header_expired` |

#### Apply

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `easyApply` (header) | Boolean. Example: `true`. | 🟢 unencrypted | ✅ Keep as `header_easy_apply` |
| `applyUrl` (header) | The header-level apply URL. Example: pre-resolution `"$3f"`; resolved `"https://..."`. | 🟡 Format pre-resolution: RSC reference `"${chunkId}"`. Parsed: `{chunkId}` = Next.js streaming chunk pointer. | ✅ Keep as `header_apply_url` |

#### Sponsorship

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `isSponsoredJob` (header) | Boolean. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `isSponsoredEmployer` (header) | Boolean. Example: `true`. | 🟢 unencrypted | ❌ Drop |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `salarySource` (header) | Salary provenance. Examples: `"EMPLOYER_PROVIDED"`, `"ESTIMATED"`. | 🟢 unencrypted | ✅ Keep as `header_salary_source` |
| `payCurrency` (header) | ISO currency. Example: `"CAD"`. | 🟢 unencrypted | ✅ Keep as `header_salary_currency` |
| `payPeriod` (header) | Pay period. Example: `"ANNUAL"`. | 🟢 unencrypted | ✅ Keep as `header_salary_period` |
| `payPeriodAdjustedPay` (header) | Salary percentiles. Example: `{p10: 82000, p50: 101000, p90: 120000}`. | 🟢 unencrypted | ❌ Drop |

#### Employer

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `employer` (header) | Employer reference at header level. Example: `{name: "Acme Corp", id: 1234567}`. | 🟢 unencrypted | ✅ Keep as `header_employer` |
| `profileAttributes` | Personalized matching attributes. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |

### `jobDetailsRawData.jobview.map`

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `address` | Full street address. Example: `"100 King St W"`. | 🟢 unencrypted | ✅ Keep as `map_address` |
| `cityName` | Structured city. Example: `"Toronto"`. | 🟢 unencrypted | ✅ Keep as `map_city_name` |
| `country` | ISO country code or name. Example: `"Canada"` or `"CA"`. | 🟢 unencrypted | ✅ Keep as `map_country` |
| `stateName` | Structured province/state. Example: `"Ontario"` (full name). | 🟢 unencrypted | ✅ Keep as `map_state_name` |
| `locationName` | Display city. Example: `"Toronto, ON"`. | 🟢 unencrypted | ✅ Keep as `map_location_name` |
| `lat` | Latitude. Example: `43.6487`. | 🟢 unencrypted | ❌ Drop |
| `lng` | Longitude. Example: `-79.3789`. | 🟢 unencrypted | ❌ Drop |
| `postalCode` | Postal/ZIP code. Example: `"M5X 1E1"`. | 🟢 unencrypted | ✅ Keep as `map_postal_code` |

#### Employer

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `employer` (map) | Map-side employer reference. Example: `{name: "Acme Corp"}`. | 🟢 unencrypted | ✅ Keep as `map_employer` |

### `jobDetailsRawData.jobview.job`

#### Identity & timing

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `discoverDate` | When Glassdoor first crawled the listing. Example: `"2025-10-30T00:00:00"`. | 🟢 unencrypted | ✅ Keep as `discover_date` |
| `listingId` (in jobview.job) | Same as top-level `listingId`. Example: `1009401234567`. | 🟢 unencrypted | ❌ Drop |

#### Title

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobTitleText` | Title plain text. Example: `"Senior Software Engineer"`. | 🟢 unencrypted | ✅ Keep as `job_title_text` |
| `jobTitleId` | Stable title ID. Example: `42`. | 🔴 encrypted field cannot be parsed standalone — opaque numeric title ID. | ❌ Drop |

#### Description

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `description` | JD body. Example: full HTML JD. | 🟢 unencrypted | ✅ Keep as `jobview_job_description` |

#### Internal

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `eolHashCode` | Internal hash used by Glassdoor's EOL (end-of-life) routing. Example: opaque alphanumeric. | 🔴 encrypted field cannot be parsed — opaque internal hash. | ❌ Drop |
| `importConfigId` | Internal config ID for the listing's import pipeline. Example: opaque numeric. | 🔴 encrypted field cannot be parsed — opaque internal config ID. | ❌ Drop |

### `jobDetailsRawData` — other sub-trees

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobview.overview` | Aggregated overview block (employer rating + benefits summary). Example pre-resolution: `"$1d:props:pageProps:jobViewPage:..."`; resolved: object containing employer overview content. | 🟡 Format pre-resolution: RSC reference `"${chunkId}:{path}"`. Parsed: `{chunkId}` = Next.js streaming chunk pointer; `{path}` = colon-separated property path within the chunk. Must walk other RSC chunks to dereference. | ❌ Drop |
| `jobview.employerAttributes` | Object with single sub-key `{attributes}` where `attributes` is itself an RSC reference. Example: `{attributes: "$1d:props:pageProps:jobViewPage:jobDetailsData:employerAttributes"}`. | 🟡 Format of inner `attributes` value: RSC reference (same scheme as `jobview.overview`). | ❌ Drop |
| `jobview.employerContent` | Long-form employer marketing content. Example: `null` (only populated for Glassdoor Premium employer profiles). | 🟢 unencrypted | ❌ Drop |
| `jobview.gaTrackerData` | Google Analytics tracking metadata. Example: `{jobViewDisplayTimeMillis: 0, pageRequestGuid: opaque-guid, requiresTracking: true, searchTypeCode: "NS", trackingUrl: "$20"}`. | 🟡 Format: object with mixed sub-fields. Parsed: `requiresTracking` (bool), `searchTypeCode` (enum like `"NS"`), `jobViewDisplayTimeMillis` (numeric) are unencrypted; `pageRequestGuid` is an opaque GUID; `trackingUrl` is an RSC reference pre-resolution. | ❌ Drop |

