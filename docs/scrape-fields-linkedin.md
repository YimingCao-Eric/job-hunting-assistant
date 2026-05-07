# Scrape Fields — LinkedIn (`linkedin_jobs`)

**Source of truth:** `current-schemas.md` (Alembic head: 029, as of 2026-05-07).  
**Table column count:** **52** (6 common + 46 site-specific). *Note: `current-schemas.md` states 51 columns based on its own subsection-sum arithmetic which is off by 1; counting actual rows in the column tables yields 52. The schema below reproduces the actual rows.*

The six common-prefix columns (`id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`, `matched`) are documented in the **Schema** section below; they're shared across all three per-source tables and not derived field-by-field from the scraped payload (except `job_url`, which mirrors a platform-specific URL field). They're not repeated in the field-decision table below.

This document catalogs every field exposed by the LinkedIn scrape surface and shows whether it's ingested into `linkedin_jobs` (and under what column name) or dropped.

> Conventions:
> - **Field name** — the raw key as it appears in the source response (with prefix path where present).
> - **Description** — what the field encodes, with at least one example value.
> - **Encrypted?** — 🟢 unencrypted (plain readable), 🔴 encrypted (opaque hash/blob, cannot decode), or 🟡 parseable (URN, namespaced string, structured object whose format yields a human-meaningful value with format/parsed-form documented).
> - **In schema?** — `✅ Keep as <column>` (ingested under that column name) or `❌ Drop` (not ingested).

---

## Schema — `linkedin_jobs` (52 columns)

The DDL for `linkedin_jobs` lives in Alembic migrations 025–029. Total 52 columns: 6 common-prefix + 46 site-specific. The site-specific columns are sourced from the LinkedIn scrape payload (see field-decision table below for which payload field feeds which column).

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
CREATE INDEX ix_linkedin_jobs_scan_run_id ON linkedin_jobs(scan_run_id);
```

### Site-specific columns — 46 cols

#### Identity (2)
| Column | Type | Source |
|---|---|---|
| `job_posting_id` | VARCHAR(32) | `data.jobPostingId` — LinkedIn's stable numeric ID |
| `job_posting_url` | TEXT | `data.jobPostingUrl` — same as `job_url` |

#### Timing & lifecycle (6)
| Column | Type | Source |
|---|---|---|
| `listed_at` | BIGINT | `data.listedAt` — epoch ms |
| `original_listed_at` | BIGINT | `data.originalListedAt` |
| `job_state` | VARCHAR(32) | `data.jobState` (`LISTED` / `CLOSED`) |
| `job_application_limit_reached` | BOOLEAN | `data.jobApplicationLimitReached` |
| `expire_at` | BIGINT | `data.expireAt` — epoch ms (LinkedIn auto-set ~30 days) |
| `closed_at` | BIGINT | `data.closedAt` — epoch ms (NULL while live) |

#### Location (7)
| Column | Type | Source |
|---|---|---|
| `formatted_location` | TEXT | `data.formattedLocation` |
| `country_urn` | VARCHAR(64) | `data.country` (full URN) |
| `location_urn` | VARCHAR(64) | `data.locationUrn` |
| `location_visibility` | VARCHAR(32) | `data.locationVisibility` (`ADDRESS` / `HIDDEN` / `REMOTE_ONLY`) |
| `postal_address` | JSONB | `data.postalAddress` |
| `standardized_addresses` | JSONB | `data.standardizedAddresses` |
| `job_region` | TEXT | `data.jobRegion` |

#### Work mode (3)
| Column | Type | Source |
|---|---|---|
| `work_remote_allowed` | BOOLEAN | `data.workRemoteAllowed` |
| `workplace_types_urns` | JSONB | `data.workplaceTypes` |
| `workplace_types_labels` | JSONB | `data.workplaceTypesResolutionResults` |

#### Employment & taxonomy (8)
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

#### Apply (4)
| Column | Type | Source |
|---|---|---|
| `apply_method_type` | VARCHAR(64) | `data.applyMethod.$type` (Java suffix dropped) |
| `company_apply_url` | TEXT | `data.applyMethod.companyApplyUrl` |
| `applicant_tracking_system` | VARCHAR(64) | `data.applicantTrackingSystem` |
| `top_level_company_apply_url` | TEXT | `data.companyApplyUrl` |

#### Salary (5)
| Column | Type | Source |
|---|---|---|
| `salary_min` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].minSalary` |
| `salary_max` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].maxSalary` |
| `salary_currency` | VARCHAR(3) | `data.salaryInsights.compensationBreakdown[0].currencyCode` |
| `salary_period` | VARCHAR(16) | `data.salaryInsights.compensationBreakdown[0].payPeriod` (`YEARLY`/`HOURLY`/`MONTHLY`) |
| `salary_provided_by_employer` | BOOLEAN | `data.salaryInsights.providedByEmployer` |

#### Description (1)
| Column | Type | Source |
|---|---|---|
| `description_text` | TEXT | `data.description.text` — primary matching input |

#### Benefits (2)
| Column | Type | Source |
|---|---|---|
| `inferred_benefits` | JSONB | `data.inferredBenefits` |
| `benefits` | JSONB | `data.benefits` |

#### Company — resolved from `included[]` (4)
| Column | Type | Source |
|---|---|---|
| `company_name` | TEXT | `included[].Company.name` — required for matching |
| `company_universal_name` | VARCHAR(128) | `included[].Company.universalName` |
| `company_url` | TEXT | `included[].Company.url` |
| `company_description` | TEXT | `included[].Company.description` |

#### Resolved URN companions (4)
| Column | Type | Source |
|---|---|---|
| `title_entity_urn` | VARCHAR(64) | `included[].Title.entityUrn` |
| `employment_status_label` | VARCHAR(32) | `included[].EmploymentStatus.localizedName` |
| `employment_status_entity_urn` | VARCHAR(64) | `included[].EmploymentStatus.entityUrn` |
| `workplace_type_entity_urn` | VARCHAR(64) | `included[].WorkplaceType.entityUrn` |

---

Source: Voyager API `WebFullJobPosting-65` decoration. The response
splits into two trees:

- **Voyager API — `data`** (top-level): all the row's primitive
  fields and URN references.
- **Voyager API — `included[]`**: a normalized side-table of
  entities (Company, Title, EmploymentStatus, WorkplaceType,
  JobApplyingInfo, JobSavingInfo, FollowingInfo, etc.) referenced
  by URN from `data`.

### Voyager API — `data`

#### Identity & URLs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobPostingId` | Numeric LinkedIn job ID — the canonical primary key. Example: `4407958631`. | 🟢 unencrypted | ✅ Keep as `job_posting_id` |
| `jobPostingUrl` | Full LinkedIn URL for the job's display page. Example: `https://www.linkedin.com/jobs/view/4407958631`. | 🟢 unencrypted | ✅ Keep as `job_posting_url` |
| `entityUrn` | URN for the normalized job-posting entity. Example: `urn:li:fs_normalized_jobPosting:4407958631`. | 🟡 Format: `urn:li:fs_normalized_jobPosting:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |
| `dashEntityUrn` | URN for the Dash-namespace job-posting entity. Example: `urn:li:fsd_jobPosting:4407958631`. | 🟡 Format: `urn:li:fsd_jobPosting:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |
| `dashJobPostingCardUrn` | URN for the job-posting **card** entity used by the Dash UI. The trailing tuple holds the card-rendering surface. Example: `urn:li:fsd_jobPostingCard:(4407958631,JOB_DETAILS)`. | 🟡 Format: `urn:li:fsd_jobPostingCard:({id},{variant})`. Parsed: `{id}` = `jobPostingId`; `{variant}` = card-rendering surface enum (`JOB_DETAILS` for the detail page, `JOBS_SEARCH` for the SERP card; every job exposes both). | ❌ Drop |
| `trackingUrn` | URN used for analytics tracking pings. Example: `urn:li:jobPosting:4407958631`. | 🟡 Format: `urn:li:jobPosting:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |

#### Timing & lifecycle

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `listedAt` | Epoch ms when the job was first published in this listing instance. Updates on re-post. Example: `1761926400000`. | 🟢 unencrypted | ✅ Keep as `listed_at` |
| `originalListedAt` | Epoch ms when the job was first listed across any instance. Differs from `listedAt` only on re-posts. Example: `1759334400000`. | 🟢 unencrypted | ✅ Keep as `original_listed_at` |
| `jobState` | Lifecycle enum. Examples: `LISTED` (live), `CLOSED` (employer closed it). | 🟢 unencrypted | ✅ Keep as `job_state` |
| `jobApplicationLimitReached` | Boolean — only `true` if the employer has set a max applicant cap and reached it. Example: `false`. | 🟢 unencrypted | ✅ Keep as `job_application_limit_reached` |
| `expireAt` | Epoch ms when LinkedIn auto-closes the job if the employer doesn't act first. Always populated (~30 days after `listedAt`). Example: `1764518400000`. | 🟢 unencrypted | ✅ Keep as `expire_at` |
| `closedAt` | Epoch ms when the employer (or LinkedIn) actually closed the listing. NULL while job is live. Example: `1762531200000` or `null`. | 🟢 unencrypted | ✅ Keep as `closed_at` |
| `new` | Boolean — LinkedIn's "newly posted" badge state. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `contentSource` | LinkedIn-internal placement / billing-tier code. Examples: `JOBS_PREMIUM_OFFLINE`, `JOBS_PREMIUM_ONLINE`, `JOBS_FREE_OFFLINE`. | 🟢 unencrypted | ❌ Drop |
| `repostedJobPosting` | URN reference to a previous-listing entity for re-posts. Example: `urn:li:fs_normalized_jobPosting:4123456789`. | 🟡 Format: `urn:li:fs_normalized_jobPosting:{id}`. Parsed: `{id}` = previous `jobPostingId`. | ❌ Drop |
| `trustReviewDecision` | LinkedIn moderation decision for trust/safety review. Examples: `APPROVED`, `REJECTED`, `null`. | 🟢 unencrypted | ❌ Drop |
| `trustReviewSla` | SLA timestamp for the moderation review (epoch ms by which it must be decided). Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `appeal` | Object describing an active employer appeal of a moderation decision. Example: `null`. | 🟢 unencrypted | ❌ Drop |

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `formattedLocation` | Display-string location. Examples: `"Toronto, ON, Canada"`, `"Canada"`, `"Remote"`. | 🟢 unencrypted | ✅ Keep as `formatted_location` |
| `country` | URN encoding the country. Example: `urn:li:fs_country:ca`. | 🟡 Format: `urn:li:fs_country:{iso2}`. Parsed: `{iso2}` = ISO 2-letter country code (e.g. `ca`, `us`). | ✅ Keep as `country_urn` |
| `locationUrn` | URN encoding the LinkedIn `geoId`. Example: `urn:li:fs_geo:101174742`. | 🟡 Format: `urn:li:fs_geo:{geoId}`. Parsed: `{geoId}` = numeric LinkedIn place ID — stable across jobs; the human-readable form lives in the parallel `formattedLocation` field on the same row (e.g. `"Toronto, ON, Canada"`). | ✅ Keep as `location_urn` |
| `locationVisibility` | Enum / flag describing whether location is public, hidden, or remote-only. Examples: `ADDRESS`, `HIDDEN`, `REMOTE_ONLY`. | 🟢 unencrypted | ✅ Keep as `location_visibility` |
| `postalAddress` | Structured postal address object when employer disclosed. Example: `{line1: "100 King St W", city: "Toronto", postalCode: "M5X 1E1", country: "CA"}` or `null`. | 🟢 unencrypted | ✅ Keep as `postal_address` |
| `standardizedAddresses` | Array of LinkedIn-canonicalized address objects. Example: `[{geographicArea: "Ontario", country: "Canada", city: "Toronto"}]` or `[]`. | 🟢 unencrypted | ✅ Keep as `standardized_addresses` |
| `jobRegion` | LinkedIn's region tag. Example: `"Greater Toronto Area"`. | 🟢 unencrypted | ✅ Keep as `job_region` |

#### Work mode

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `workRemoteAllowed` | Boolean — does the job allow remote? Example: `true`. | 🟢 unencrypted | ✅ Keep as `work_remote_allowed` |
| `workplaceTypes` | URN array encoding the workplace mode. Example: `["urn:li:fs_workplaceType:2"]`. | 🟡 Format: `urn:li:fs_workplaceType:{n}` per element. Parsed: `{n}` = `1` = on-site, `2` = remote, `3` = hybrid. | ✅ Keep as `workplace_types_urns` |
| `workplaceTypesResolutionResults` | Resolution dict mapping URN → human label. Example: `{"urn:li:fs_workplaceType:2": {"localizedName": "Remote"}}`. | 🟢 unencrypted | ✅ Keep as `workplace_types_labels` |

#### Employment & taxonomy

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `formattedEmploymentStatus` | Human-readable employment status. Examples: `"Full-time"`, `"Part-time"`, `"Contract"`, `"Internship"`, `"Volunteer"`. | 🟢 unencrypted | ✅ Keep as `formatted_employment_status` |
| `employmentStatus` | URN encoding the employment status. Example: `urn:li:fs_employmentStatus:FULL_TIME`. | 🟡 Format: `urn:li:fs_employmentStatus:{enum}`. Parsed: `{enum}` = enum key (`FULL_TIME`, `PART_TIME`, `CONTRACT`, `INTERNSHIP`, `VOLUNTEER`). | ✅ Keep as `employment_status_urn` |
| `formattedIndustries` | Array of human-readable industry strings. Example: `["Software Development", "Information Technology"]`. | 🟢 unencrypted | ✅ Keep as `formatted_industries` |
| `industries` | Array of numeric industry IDs paralleling `formattedIndustries`. Example: `[4]`. | 🟡 Format: array of numeric IDs `[{n}, ...]`. Parsed: `{n}` = stable LinkedIn industry ID; resolvable in-row via the parallel `formattedIndustries` field on the same row (e.g. `["Software Development"]`). | ❌ Drop |
| `formattedJobFunctions` | Array of human-readable function strings. Example: `["Engineering", "Information Technology"]`. | 🟢 unencrypted | ✅ Keep as `formatted_job_functions` |
| `jobFunctions` | Array of short-code function strings paralleling `formattedJobFunctions`. Example: `["ENG", "IT"]`. | 🟡 Format: array of short codes `["{code}", ...]`. Parsed: `{code}` = stable LinkedIn function code (e.g. `"ENG"`, `"IT"`, `"MGMT"`); resolvable in-row via the parallel `formattedJobFunctions` field on the same row (e.g. `["Engineering", "Information Technology"]`). | ❌ Drop |
| `title` | Raw employer-typed job title. Example: `"Senior Software Engineer (Backend)"`. | 🟢 unencrypted | ✅ Keep as `title` |
| `standardizedTitle` (URN) | URN pointer to a `Title` entity in `included[]`. Example: `urn:li:fs_title:25190`. | 🟡 Format: `urn:li:fs_title:{id}`. Parsed: `{id}` = numeric title ID; resolved in-row via `included[].Title.localizedName` (matching by `entityUrn`) → human-readable title (e.g. `"Software Engineer"`, `"Data Scientist"`). | ❌ Drop |

#### Experience & skills

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `formattedExperienceLevel` | Seniority display string. Examples: `"Entry level"`, `"Mid-Senior level"`, `"Director"`. | 🟢 unencrypted | ✅ Keep as `formatted_experience_level` |
| `skillsDescription` | Free-text comma-separated skills string from LinkedIn extraction. Example: `"Python, AWS, Docker, Kubernetes"`. | 🟢 unencrypted | ✅ Keep as `skills_description` |
| `skillMatches` | Authenticated viewer's skill-match summary. Example: `null` for unauthenticated; `{matchedSkills: [...]}` for viewer with skills on profile. | 🟢 unencrypted | ❌ Drop |
| `degreeMatches` | Authenticated viewer's education-credential match summary. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `yearsOfExperienceMatch` | Authenticated viewer's years-of-experience match indicator. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |

#### Apply

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `applyMethod` (parent object) | Container for apply-mechanism details. Shape varies by `$type`. Examples: for `OffsiteApply` `{$type, companyApplyUrl, applyStartersPreferenceVoid, inPageOffsiteApply}`; for `SimpleOnsiteApply` `{$type, type, unifyApplyEnabled}`. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.$type` | Java class name identifying the apply mechanism. Examples: `com.linkedin.voyager.jobs.OffsiteApply`, `com.linkedin.voyager.jobs.ComplexOnsiteApply`, `com.linkedin.voyager.jobs.SimpleOnsiteApply`. | 🟡 Format: `com.linkedin.voyager.jobs.{Variant}Apply`. Parsed: `{Variant}` = `Offsite` / `ComplexOnsite` / `SimpleOnsite`. | ✅ Keep as `apply_method_type` |
| `applyMethod.companyApplyUrl` | The employer-side URL for `OffsiteApply` / `ComplexOnsiteApply` mechanisms. Example: `"https://ats.rippling.com/sibros-technologies/jobs/603c5595-074d-40fe-a12c-7b2313cf9aa0"`. | 🟢 unencrypted | ✅ Keep as `company_apply_url` |
| `applyMethod.applyStartersPreferenceVoid` | Boolean — LinkedIn-internal preference flag for the apply-starter UX. Example: `false`. Only present on `OffsiteApply`. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.inPageOffsiteApply` | Boolean — render the offsite apply form embedded in the LinkedIn page rather than redirecting away. Example: `false`. Only present on `OffsiteApply`. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.type` | Enum on `SimpleOnsiteApply` indicating what the LinkedIn-hosted form collects. Example: `"CONTACT_INFORMATION"`. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.unifyApplyEnabled` | Boolean — whether LinkedIn's Unify Apply (newer onsite-form variant) is enabled. Example: `true`. Only present on `SimpleOnsiteApply`. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.easyApplyUrl` | LinkedIn-hosted Easy Apply URL. Example: `"https://www.linkedin.com/job-apply/4409050836"`. Appears under different decorations or older API versions. | 🟢 unencrypted | ❌ Drop |
| `applyMethod.cosUriRoot` | URI root for the COS (apply form hosting) endpoint. Example: `"https://www.linkedin.com/jobs-apply"`. | 🟢 unencrypted | ❌ Drop |
| `applicantTrackingSystem` | Display string of detected ATS. Examples: `"Workday"`, `"Greenhouse"`, `"LinkedIn"`, `"SMART_RECRUITERS"`. | 🟢 unencrypted | ✅ Keep as `applicant_tracking_system` |
| `sourceDomain` | Hostname of the original posting site when LinkedIn syndicated. Example: `"jobs.lever.co"`. | 🟢 unencrypted | ❌ Drop |
| `companyApplyUrl` (top-level) | Apply URL surfaced at the top level of `data`, distinct from `applyMethod.companyApplyUrl`. Example: `"https://careers.example.com/jobs/12345"`. | 🟢 unencrypted | ✅ Keep as `top_level_company_apply_url` |
| `applies` | Application count for this posting (recruiter-only field). Example: `0` for non-recruiters. | 🟢 unencrypted | ❌ Drop |
| `views` | View count for this posting (recruiter-only field). Example: `0` for non-recruiters. | 🟢 unencrypted | ❌ Drop |
| `draftApplicationInfo` | Authenticated viewer's draft-application state. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `messagingStatus` | Authenticated viewer's InMail / message status with the recruiter. Examples: `null` for unauthenticated; `"AVAILABLE"` for authenticated. | 🟢 unencrypted | ❌ Drop |
| `messagingToken` | Token authorizing the viewer to message the recruiter. Example: redacted opaque token. | 🔴 encrypted field cannot be parsed — opaque viewer-scoped messaging credential. | ❌ Drop |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `salaryInsights.compensationBreakdown[0].minSalary` | Min salary number. Example: `90000`. | 🟢 unencrypted | ✅ Keep as `salary_min` |
| `salaryInsights.compensationBreakdown[0].maxSalary` | Max salary number. Example: `120000`. | 🟢 unencrypted | ✅ Keep as `salary_max` |
| `salaryInsights.compensationBreakdown[0].currencyCode` | ISO currency code. Example: `"CAD"`, `"USD"`. | 🟢 unencrypted | ✅ Keep as `salary_currency` |
| `salaryInsights.compensationBreakdown[0].payPeriod` | Pay period enum. Examples: `"YEARLY"`, `"HOURLY"`, `"MONTHLY"`. | 🟢 unencrypted | ✅ Keep as `salary_period` |
| `salaryInsights.providedByEmployer` | Boolean — did the employer disclose vs. LinkedIn estimate? Example: `true`. | 🟢 unencrypted | ✅ Keep as `salary_provided_by_employer` |
| `salaryInsights.compensationBreakdown[1+]` | Multi-band breakdowns (rare). Example: a second entry for a different role variant. | 🟢 unencrypted | ❌ Drop |

#### Description

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `description.text` | Plain-text JD body. Example: `"We are looking for a Senior Software Engineer to join our backend team..."` (full JD, ~1,000-5,000 chars). | 🟢 unencrypted | ✅ Keep as `description_text` |
| `description.html` | HTML-formatted JD body. Example: `"<p>We are looking for...</p><ul><li>5+ years experience</li>..."`. | 🟢 unencrypted | ❌ Drop |

#### Company (top-level references)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `companyDetails` | URN reference to a Company entity in `included[]`. Example: `urn:li:fs_normalized_company:91390405`. | 🟡 Format: `urn:li:fs_normalized_company:{id}`. Parsed: `{id}` = numeric company ID; resolved in-row via `included[].Company.name` (matching by `entityUrn`) → human-readable employer name (e.g. `"Jobright.ai"`). | ❌ Drop |
| `companyDescription` | Free-text employer summary. Example: `"Acme Corp is a leading provider of widgets..."`. | 🟢 unencrypted | ❌ Drop |

#### Misc UI / framework flags

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `thirdPartySourced` | Boolean — was this listing scraped from an aggregator before LinkedIn ingested it? Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `allowedToEdit` | Boolean — viewer can edit this job. Example: `false` for scrapers. | 🟢 unencrypted | ❌ Drop |
| `claimableByViewer` | Boolean — viewer can claim ownership of this job. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `eligibleForLearningCourseRecsUpsell` | Boolean — viewer is eligible for a Learning-course upsell on this job. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `eligibleForReferrals` | Boolean — viewer can request a referral from connections at this employer. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `eligibleForSharingProfileWithPoster` | Boolean — viewer can share their profile with the job poster. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `hiringDashboardViewEnabled` | Boolean — viewer is the job poster and can see the hiring dashboard. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `ownerViewEnabled` | Boolean — viewer is the listing owner and sees owner-mode UI. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `talentHubJob` | Boolean — listing is sourced from LinkedIn Talent Hub. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `jobPosterEntitlements` | Object describing what the job poster can do on this listing. Example: `{$type, entitledToAccessJobDashboard: true, entitledToCopyJob: true, entitledToEditJob: true, entitledToPromoteJob: false, entitledToViewBillingInfo: true, entitledToViewFreeJobInfo: false}`. | 🟢 unencrypted | ❌ Drop |
| `encryptedPricingParams` | LinkedIn-side encrypted ad-pricing params (sponsored-listing internal). Example: a 231-character opaque blob. | 🔴 encrypted field cannot be parsed — opaque blob with no public reverse-lookup. | ❌ Drop |
| `trackingPixelUrl` | URL of a tracking pixel to fire on view. Example: `null` or `"https://www.linkedin.com/jobs/track/view?id=..."`. | 🟢 unencrypted | ❌ Drop |
| `matchType` | Enum describing how this job matched the viewer's preferences. Examples: `null` for unauthenticated, `"RECOMMENDED"`, `"SEARCH"`. | 🟢 unencrypted | ❌ Drop |
| `poster` | Reference to the recruiter / job poster Member entity. Example: `null` for unauthenticated, `urn:li:fs_member:12345678` for authenticated. | 🟢 unencrypted | ❌ Drop |
| `hiringTeamEntitlements` | Object describing hiring team's permissions on this listing. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `inferredBenefits` | Array of benefit tags LinkedIn extracted from JD text. Example: `null` or `["health insurance", "401k"]`. | 🟢 unencrypted | ✅ Keep as `inferred_benefits` |
| `benefits` | Array of employer-declared benefit tags. Example: `[]` or `["Health insurance", "Paid time off"]`. | 🟢 unencrypted | ✅ Keep as `benefits` |
| `benefitsDataSource` | Enum describing where the benefit tags came from. Examples: `"JOB_POSTER"`, `"INFERRED"`. | 🟢 unencrypted | ❌ Drop |

### Voyager API — `included[]` entities

The `included[]` array is a normalized side-table. URNs in `data`
point into it. We resolve specific entities at ingest and extract
the useful fields onto the row.

#### Company (resolved by `companyDetails` URN)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `Company.name` | Display employer name. Example: `"Jobright.ai"`. | 🟢 unencrypted | ✅ Keep as `company_name` |
| `Company.entityUrn` | URN form of the company. Example: `urn:li:fs_normalized_company:91390405`. | 🟡 Format: `urn:li:fs_normalized_company:{id}`. Parsed: `{id}` = numeric company ID; the same `Company` entity carries `Company.name` on the same object (e.g. `"Jobright.ai"`) for the human-readable form. | ❌ Drop |
| `Company.universalName` | URL-safe company slug. Example: `"jobright-ai"`. | 🟢 unencrypted | ✅ Keep as `company_universal_name` |
| `Company.url` | Company's LinkedIn page URL. Example: `"https://www.linkedin.com/company/jobright-ai"`. | 🟢 unencrypted | ✅ Keep as `company_url` |
| `Company.logo` | Image reference object. Example: `{image: "urn:li:fsd_image:C4D0BAQH..", type: "SQUARE_LOGO_IMAGE", $type: "..."}`. | 🟢 unencrypted | ❌ Drop |
| `Company.backgroundCoverImage` | Larger cover image. Example: `{image: {...}, $type: "...", cropInfo: {...}}`. | 🟢 unencrypted | ❌ Drop |
| `Company.coverPhoto` | Alt cover photo. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `Company.description` | Long-form company description text. Example: `"Jobright is the first AI-native hiring platform that connects..."`. | 🟢 unencrypted | ✅ Keep as `company_description` |
| `Company.industries` | Array of industry display strings (already resolved in `included[]`, unlike `data.industries` which is numeric IDs). Example: `["Software Development"]`. | 🟢 unencrypted | ❌ Drop |
| `Company.staffCount` | Numeric employee count. Example: `91`. | 🟢 unencrypted | ❌ Drop |
| `Company.staffCountRange` | Object describing employee-count bucket. Example: `{start: 51, end: 200, $type: "..."}`. | 🟢 unencrypted | ❌ Drop |
| `Company.specialities` | Array of specialty tags. Example: `["AI", "recruiting", "matching"]` or `[]`. | 🟢 unencrypted | ❌ Drop |
| `Company.headquarter` | Object describing the HQ address. Example: `{geographicArea: "California", country: "United States", city: "San Francisco", postalCode: "94103", line1: "100 Market St"}`. | 🟢 unencrypted | ❌ Drop |
| `Company.lcpTreatment` | Boolean — internal "LCP" (LinkedIn Career Page) treatment flag. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `Company.viewerFollowingJobsUpdates` | Boolean — viewer is subscribed to job updates from this company. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `Company.*followingInfo` | URN reference into `included[]` to a `FollowingInfo` entity. Example: `urn:li:fs_followingInfo:urn:li:company:91390405`. | 🟡 Format: `urn:li:fs_followingInfo:urn:li:company:{id}`. Parsed: `{id}` = numeric company ID; resolvable in-row via the parallel `Company.name` field on the same Company entity (e.g. `"Jobright.ai"`). | ❌ Drop |

#### Title (resolved by `standardizedTitle` URN)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `Title.localizedName` | Canonical title display string. Example: `"Software Engineer"`, `"Data Scientist"`. | 🟢 unencrypted | ✅ Keep as `standardized_title` |
| `Title.entityUrn` | URN form. Example: `urn:li:fs_title:25190`. | 🟡 Format: `urn:li:fs_title:{id}`. Parsed: `{id}` = numeric title ID; the same `Title` entity carries `Title.localizedName` on the same object (e.g. `"Software Engineer"`) for the human-readable form. | ✅ Keep as `title_entity_urn` |

#### EmploymentStatus (resolved by `employmentStatus` URN)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `EmploymentStatus.localizedName` | Display string. Examples: `"Full-time"`, `"Part-time"`. | 🟢 unencrypted | ✅ Keep as `employment_status_label` |
| `EmploymentStatus.entityUrn` | URN form. Example: `urn:li:fs_employmentStatus:FULL_TIME`. | 🟡 Format: `urn:li:fs_employmentStatus:{enum}`. Parsed: `{enum}` = enum key. | ✅ Keep as `employment_status_entity_urn` |

#### WorkplaceType (resolved by `workplaceTypes` URNs)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `WorkplaceType.localizedName` | Display string. Examples: `"On-site"`, `"Remote"`, `"Hybrid"`. | 🟢 unencrypted | ❌ Drop |
| `WorkplaceType.entityUrn` | URN form. Example: `urn:li:fs_workplaceType:2`. | 🟡 Format: `urn:li:fs_workplaceType:{n}`. Parsed: `{n}` = `1` / `2` / `3`. | ✅ Keep as `workplace_type_entity_urn` |

#### JobApplyingInfo (resolved viewer's apply state for this job)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `JobApplyingInfo.entityUrn` | URN form. Example: `urn:li:fs_jobApplyingInfo:4407958631`. | 🟡 Format: `urn:li:fs_jobApplyingInfo:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |
| `JobApplyingInfo.applied` | Boolean — has the viewer applied to this job? Example: `false` for scrapers. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.appliedAt` | Epoch ms when viewer applied. Example: `null` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.appliedTime` | Older variant of `appliedAt`. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.activities` | Array of activity events. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.closed` | Boolean — has the viewer's application been closed/rejected? Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.resumeDownloadUrl` | URL to the resume the viewer attached. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.resumeFileName` | Filename of attached resume. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.resumeFileType` | MIME type / file extension of attached resume. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobApplyingInfo.viewedByJobPosterAt` | Epoch ms when the recruiter viewed the viewer's application. Example: `null`. | 🟢 unencrypted | ❌ Drop |

#### JobSavingInfo (resolved viewer's saved state for this job)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `JobSavingInfo.entityUrn` | URN form. Example: `urn:li:fs_jobSavingInfo:4407958631`. | 🟡 Format: `urn:li:fs_jobSavingInfo:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |
| `JobSavingInfo.saved` | Boolean — has the viewer saved this job? Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `JobSavingInfo.savedAt` | Epoch ms when viewer saved. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `JobSavingInfo.dashSaveStateUrn` | Dash-namespace URN for the save-state entity. Example: `urn:li:fsd_saveState:(SAVE,urn:li:fsd_jobPosting:4407958631)`. | 🟡 Format: `urn:li:fsd_saveState:({action},urn:li:fsd_jobPosting:{id})`. Parsed: `{action}` = action enum (`SAVE` is fixed); `{id}` = `jobPostingId`. | ❌ Drop |

#### FollowingInfo (resolved viewer's "following this company" state)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `FollowingInfo.entityUrn` | URN form. Example: `urn:li:fs_followingInfo:urn:li:company:91390405`. | 🟡 Format: `urn:li:fs_followingInfo:urn:li:company:{id}`. Parsed: `{id}` = numeric company ID; resolvable in-row via `included[].Company.name` (e.g. `"Jobright.ai"`). | ❌ Drop |
| `FollowingInfo.following` | Boolean — does the viewer follow this company? Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `FollowingInfo.followerCount` | Numeric count of followers for the company. Example: `58833`. | 🟢 unencrypted | ❌ Drop |
| `FollowingInfo.followingCount` | Numeric count of who the viewer is following. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `FollowingInfo.followingType` | Enum describing follow type. Example: `"DEFAULT"`. | 🟢 unencrypted | ❌ Drop |
| `FollowingInfo.trackingUrn` | URN for analytics tracking of the follow relationship. Example: `null` for unauthenticated; a tracking URN like `urn:li:tracking:abc123def456` when populated. | 🔴 encrypted field cannot be parsed — extraction yields an opaque tracking-event ID without external Analytics access. | ❌ Drop |
| `FollowingInfo.dashFollowingStateUrn` | Dash-namespace URN for the following-state entity. Example: `urn:li:fsd_followingState:urn:li:fsd_company:91390405`. | 🟡 Format: `urn:li:fsd_followingState:urn:li:fsd_company:{id}`. Parsed: `{id}` = numeric company ID; resolvable in-row via `included[].Company.name` (e.g. `"Jobright.ai"`). | ❌ Drop |

#### JobHiringTeam (resolved hiring team for this job)

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `JobHiringTeam.entityUrn` | URN form. Example: `urn:li:fs_jobHiringTeam:4407958631`. | 🟡 Format: `urn:li:fs_jobHiringTeam:{id}`. Parsed: `{id}` = `jobPostingId`. | ❌ Drop |
| `JobHiringTeam.hiringTeamMembers` | Array of recruiter / hiring-manager profile references. Example: `[]` for unauthenticated viewers; `[{member: "urn:li:fs_member:...", title: "Senior Recruiter"}]` for authenticated. | 🟢 unencrypted | ❌ Drop |


---

