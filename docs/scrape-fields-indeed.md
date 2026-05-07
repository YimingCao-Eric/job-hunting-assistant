# Scrape Fields — Indeed (`indeed_jobs`)

**Source of truth:** `current-schemas.md` (Alembic head: 029, as of 2026-05-07).  
**Table column count:** **61** (6 common + 55 site-specific).

The six common-prefix columns (`id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`, `matched`) are documented in the **Schema** section below; they're shared across all three per-source tables and not derived field-by-field from the scraped payload (except `job_url`, which mirrors a platform-specific URL field). They're not repeated in the field-decision table below.

This document catalogs every field exposed by the Indeed scrape surface and shows whether it's ingested into `indeed_jobs` (and under what column name) or dropped.

> Conventions:
> - **Field name** — the raw key as it appears in the source response (with prefix path where present).
> - **Description** — what the field encodes, with at least one example value.
> - **Encrypted?** — 🟢 unencrypted (plain readable), 🔴 encrypted (opaque hash/blob, cannot decode), or 🟡 parseable (URN, namespaced string, structured object whose format yields a human-meaningful value with format/parsed-form documented).
> - **In schema?** — `✅ Keep as <column>` (ingested under that column name) or `❌ Drop` (not ingested).

---

## Schema — `indeed_jobs` (61 columns)

The DDL for `indeed_jobs` lives in Alembic migrations 025–029. Total 61 columns: 6 common-prefix + 55 site-specific. The site-specific columns are sourced from the Indeed scrape payload (see field-decision table below for which payload field feeds which column).

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
CREATE INDEX ix_indeed_jobs_scan_run_id ON indeed_jobs(scan_run_id);
```

### Site-specific columns — 55 cols

#### Surface presence (2) — Indeed-specific
| Column | Type | Source |
|---|---|---|
| `mosaic_present` | BOOLEAN | derived at ingest — TRUE if mosaic block non-null |
| `graphql_present` | BOOLEAN | derived at ingest — TRUE if graphql block non-null |

**CHECK constraint:** `indeed_jobs_surface_present CHECK (mosaic_present OR graphql_present)` — rows with both surfaces failed are rejected at ingest.

#### Identity & URLs (mosaic) (5)
| Column | Type | Source |
|---|---|---|
| `jobkey` | VARCHAR(32) | `mosaic.jobkey` — 16-char hex stable Indeed ID |
| `link` | TEXT | `mosaic.link` |
| `view_job_link` | TEXT | `mosaic.viewJobLink` |
| `more_loc_url` | TEXT | `mosaic.moreLocUrl` |
| `third_party_apply_url` | TEXT | `mosaic.thirdPartyApplyUrl` |

#### Timing (mosaic) (4)
| Column | Type | Source |
|---|---|---|
| `pub_date` | BIGINT | `mosaic.pubDate` — epoch ms |
| `create_date` | BIGINT | `mosaic.createDate` |
| `expiration_date` | BIGINT | `mosaic.expirationDate` |
| `expired` | BOOLEAN | `mosaic.expired` |

#### Title & taxonomy (mosaic) (5)
| Column | Type | Source |
|---|---|---|
| `title` | TEXT | `mosaic.title` |
| `display_title` | TEXT | `mosaic.displayTitle` |
| `norm_title` | TEXT | `mosaic.normTitle` |
| `job_types` | JSONB | `mosaic.jobTypes` |
| `taxonomy_attributes` | JSONB | `mosaic.taxonomyAttributes` |

#### Location (mosaic) (7)
| Column | Type | Source |
|---|---|---|
| `formatted_location` | TEXT | `mosaic.formattedLocation` |
| `job_location_city` | VARCHAR(128) | `mosaic.jobLocationCity` |
| `job_location_state` | VARCHAR(8) | `mosaic.jobLocationState` |
| `job_location_postal` | VARCHAR(16) | `mosaic.jobLocationPostal` |
| `location_count` | INTEGER | `mosaic.locationCount` |
| `additional_location_link` | TEXT | `mosaic.additionalLocationLink` |
| `remote_location` | BOOLEAN | `mosaic.remoteLocation` |

#### Salary (mosaic) (6)
| Column | Type | Source |
|---|---|---|
| `salary_min` | NUMERIC | `mosaic.extractedSalary.min` |
| `salary_max` | NUMERIC | `mosaic.extractedSalary.max` |
| `salary_period` | VARCHAR(16) | `mosaic.extractedSalary.type` (`YEARLY`/`HOURLY`) |
| `salary_currency` | VARCHAR(3) | `mosaic.salarySnippet.currency` |
| `salary_text` | TEXT | `mosaic.salarySnippet.salaryTextFormatted` |
| `salary_snippet_source` | VARCHAR(32) | `mosaic.salarySnippet.source` |

#### Employer (mosaic) (1)
| Column | Type | Source |
|---|---|---|
| `company` | TEXT | `mosaic.company` |

#### Apply (mosaic) (3)
| Column | Type | Source |
|---|---|---|
| `indeed_apply_enabled` | BOOLEAN | `mosaic.indeedApplyEnabled` |
| `indeed_applyable` | BOOLEAN | `mosaic.indeedApplyable` |
| `screener_questions_url` | TEXT | `mosaic.screenerQuestionsURL` |

> Note: `apply_count` was dropped in migration 026.

#### Pre-extracted requirements (mosaic) (3)
| Column | Type | Source |
|---|---|---|
| `match_negative_taxonomy` | JSONB | `mosaic.jobSeekerMatchSummaryModel.taxoEntityMatchesNegative` |
| `match_mismatching_entities` | JSONB | `mosaic.jobSeekerMatchSummaryModel.sortedMisMatchingEntityDisplayText` |
| `num_hires` | INTEGER | `mosaic.numHires` |

#### Identity & URLs (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `employer_canonical_url` | TEXT | `graphql.job.url` |

#### Timing (graphql) (3)
| Column | Type | Source |
|---|---|---|
| `graphql_date_published` | DATE | `graphql.job.datePublished` |
| `graphql_date_on_indeed` | DATE | `graphql.job.dateOnIndeed` |
| `graphql_expired` | BOOLEAN | `graphql.job.expired` |

#### Title & taxonomy (graphql) (3)
| Column | Type | Source |
|---|---|---|
| `graphql_title` | TEXT | `graphql.job.title` |
| `graphql_normalized_title` | TEXT | `graphql.job.normalizedTitle` |
| `attributes` | JSONB | `graphql.job.attributes` |

#### Location (graphql) (6)
| Column | Type | Source |
|---|---|---|
| `location_formatted_long` | TEXT | `graphql.job.location.formatted.long` |
| `graphql_location_city` | VARCHAR(128) | `graphql.job.location.city` |
| `graphql_location_postal_code` | VARCHAR(16) | `graphql.job.location.postalCode` |
| `graphql_location_street_address` | TEXT | `graphql.job.location.streetAddress` |
| `graphql_location_admin1_code` | VARCHAR(8) | `graphql.job.location.admin1Code` |
| `graphql_location_country_code` | VARCHAR(2) | `graphql.job.location.countryCode` |

#### Description (graphql) (2)
| Column | Type | Source |
|---|---|---|
| `description_text` | TEXT | `graphql.job.description.text` — primary matching input |
| `language` | VARCHAR(8) | `graphql.job.language` |

#### Employer (graphql) (2)
| Column | Type | Source |
|---|---|---|
| `employer_name` | TEXT | `graphql.job.employer.name` |
| `employer_company_page_url` | TEXT | `graphql.job.employer.relativeCompanyPageUrl` |

#### Source / provenance (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `source_name` | VARCHAR(64) | `graphql.job.source.name` (e.g. `Greenhouse`) |

#### Salary (graphql) (1)
| Column | Type | Source |
|---|---|---|
| `graphql_salary_period` | VARCHAR(16) | `graphql.job.compensation.baseSalary.unitOfWork` (`YEAR`/`HOUR`/`WEEK`/`MONTH`) |

---

Three scrape sources:

- **SERP card DOM**: 4 `data-*` attributes from `<a class="jcs-JobTitle">`.
- **mosaic_job**: the SERP-embedded JSON object at `mosaic.providerData['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel.results[]`.
- **GraphQL Extended Query**: per-job fetch via `apis.indeed.com/graphql` with `jobData(jobKeys: [...])`.

### SERP card DOM

#### Identity & URLs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `data-jk` | Job key in card DOM (also in mosaic JSON). Example: `"c676d09fb51b868e"`. | 🟢 unencrypted | ❌ Drop |
| `data-mobtk` | Click-tracking token. Example: opaque 16-char alphanumeric like `"1jnios994i0in800"`. | 🔴 encrypted field cannot be parsed — opaque session-scoped tracking token. | ❌ Drop |
| `data-hiring-event` | Hiring-event flag. Example: `"false"` or `"true"`. | 🟢 unencrypted | ❌ Drop |
| `data-hide-spinner` | UI-render flag. Example: `"true"`. | 🟢 unencrypted | ❌ Drop |

### mosaic_job

#### Identity & URLs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobkey` | 16-character hex stable Indeed job ID. Example: `"c676d09fb51b868e"`. | 🟢 unencrypted | ✅ Keep as `jobkey` |
| `link` | Indeed display URL with tracking params. Example: `"/rc/clk?jk=c676d09fb51b868e&from=jasx&tk=..."`. | 🟢 unencrypted | ✅ Keep as `link` |
| `viewJobLink` | Alternate display URL. Example: `"/viewjob?jk=c676d09fb51b868e&from=jasx"`. | 🟢 unencrypted | ✅ Keep as `view_job_link` |
| `moreLocUrl` | URL to a multi-location detail page. Example: `"/jobs?q=Software+Engineer&l=&jt=fulltime&advn=1&vjk=..."`. | 🟢 unencrypted | ✅ Keep as `more_loc_url` |
| `thirdPartyApplyUrl` | `apply.indeed.com/...` redirect that forwards to the employer page after a click. Example: `"https://apply.indeed.com/indeedapply/jobs/123/apply"`. | 🟢 unencrypted | ✅ Keep as `third_party_apply_url` |
| `clickLoggingUrl` | Click-tracking URL. Example: `"https://ca.indeed.com/rc/clk?jk=c676d09fb51b868e&from=jasx&tk=...&bb=...&xkcb=...&vjs=3"`. | 🟡 Format: `https://...indeed.com/rc/clk?jk={jobkey}&from={page}&tk={token}&bb={blob}&xkcb={hmac}&vjs={src}`. Parsed: `{jobkey}` = stable Indeed job ID; `{page}` = source-page enum; `{token}` = session token (opaque); `{blob}` = 128-char base64 ranking blob (opaque); `{hmac}` = 28-char HMAC (opaque); `{src}` = click-source enum. | ❌ Drop |
| `encryptedResultData` | Server-side encrypted blob encoding search-session context. Example: `"VwIPTVJ1cTn5AN7Q-tSqGRXGNe2wB2..."` (43-char base64). | 🔴 encrypted field cannot be parsed — base64-decodable to 32 bytes of ciphertext, but encrypted with Indeed's server-side key. | ❌ Drop |
| `mobtk` | Mobile-specific tracking token. Example: `"1jnios994i0in800"` (16-char alphanumeric). | 🔴 encrypted field cannot be parsed — opaque session-scoped token. | ❌ Drop |
| `searchUID` | Unique search-session ID. Example: `"1jnios994i0in800"` (16-char alphanumeric; often same value as `mobtk`). | 🔴 encrypted field cannot be parsed — opaque session-scoped ID. | ❌ Drop |
| `blobKey` | Server-side blob retrieval key. Example: `"SoC167M3ky5-9KzSwZ0LbzkdCdPP"` (28-char alphanumeric). | 🔴 encrypted field cannot be parsed — opaque per-job key into Indeed's server-side ranking-state blob storage. | ❌ Drop |
| `feedId` | Numeric job-feed identifier. Example: `410768`. | 🟢 unencrypted | ❌ Drop |
| `sourceId` | Numeric Indeed source/crawl pipeline ID. Example: `16029657`. | 🟢 unencrypted | ❌ Drop |
| `homepageJobFeedSectionId` | String "section ID" for jobs surfaced via a homepage feed module. Example: `"0"`. | 🟢 unencrypted | ❌ Drop |
| `companyIdEncrypted` | 16-char hex hash, the actually-populated stable employer ID on Indeed. Example: `"3a7b8c9d2e1f0a5b"`. | 🟡 Format: 16-char hex hash. Parsed: opaque hash with no public reverse-lookup, but resolvable in-row via the parallel `company` field on the same row (e.g. `"Vretta Inc."`). Useful as exact-match dedup signal across Indeed listings. | ❌ Drop |
| `encryptedFccompanyId` | Encrypted form of `fccompanyId`. Example: similar 16-char hex hash. | 🟡 Format: 16-char hex hash. Parsed: same opacity as `companyIdEncrypted` — opaque on its own but resolvable in-row via the parallel `company` field on the same row. | ❌ Drop |
| `fccompanyId` | Numeric Indeed Company ID. Mostly `-1` (sentinel). Example: `-1` or `12345`. | 🟢 unencrypted | ❌ Drop |

#### Timing

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `pubDate` | Epoch ms when the job was published. Example: `1761926400000`. | 🟢 unencrypted | ✅ Keep as `pub_date` |
| `createDate` | Epoch ms when Indeed first ingested the listing. Example: `1761840000000`. | 🟢 unencrypted | ✅ Keep as `create_date` |
| `formattedRelativeTime` | "Posted 3 days ago" display string. Example: `"Posted 3 days ago"`. | 🟢 unencrypted | ❌ Drop |
| `showRelativeDate` | UI render flag. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `expirationDate` | Epoch ms when employer scheduled expiry. Example: `null` (rare) or `1764518400000`. | 🟢 unencrypted | ✅ Keep as `expiration_date` |
| `newJob` | Indeed's "new" badge state. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `expired` | Boolean — listing expired. Example: `false` on live results. | 🟢 unencrypted | ✅ Keep as `expired` |

#### Title & taxonomy

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `title` | Raw employer-typed job title. Example: `"Senior Software Engineer - Backend"`. | 🟢 unencrypted | ✅ Keep as `title` |
| `displayTitle` | HTML-decoded variant of `title`. Example: `"Senior Software Engineer & Tech Lead"` (where raw `title` had `&amp;`). | 🟢 unencrypted | ✅ Keep as `display_title` |
| `normTitle` | Indeed canonical title (title-case). Example: `"Senior Software Engineer"`. | 🟢 unencrypted | ✅ Keep as `norm_title` |
| `jobTypes` | Array of job-type strings. Example: `["fulltime"]` or `[]`. | 🟢 unencrypted | ✅ Keep as `job_types` |
| `taxonomyAttributes` | Nested JSONB tree covering job-types, shifts, remote, benefits, schedules. Example: `[{label: "job-types", attributes: [{label: "Full-time", suid: "CF3CP"}]}, {label: "remote", attributes: [{label: "Remote", suid: "DSQF7"}]}]`. | 🟡 Format per inner attribute: `{label: "{display}", suid: "{code}"}`. Parsed: `{display}` = unencrypted display string (e.g. `"Full-time"`); `{code}` = 5-char opaque taxonomy hash with no public mapping (use parallel `label` for display). | ✅ Keep as `taxonomy_attributes` |
| `taxoAttributesDisplayLimit` | Integer limit on taxonomy attributes per category. Example: `3`. | 🟢 unencrypted | ❌ Drop |
| `taxoAttributes` | Empty-array variant of `taxonomyAttributes` used by older client code. Example: `[]`. | 🟢 unencrypted | ❌ Drop |
| `taxoLogAttributes` | Logging-side taxonomy bundle. Example: `[]`. | 🟢 unencrypted | ❌ Drop |
| `translatedAttributes` | Localization-side taxonomy bundle for non-English locales. Example: `[]`. | 🟢 unencrypted | ❌ Drop |
| `translatedCmiJobTags` | Localization-side CMI (Candidate-Market-Insights) tag bundle. Example: `{}`. | 🟢 unencrypted | ❌ Drop |

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `formattedLocation` | Display-string location. Example: `"Toronto, ON"`. | 🟢 unencrypted | ✅ Keep as `formatted_location` |
| `jobLocationCity` | Structured city. Example: `"Toronto"`. | 🟢 unencrypted | ✅ Keep as `job_location_city` |
| `jobLocationState` | Structured province/state (2-letter). Example: `"ON"`. | 🟢 unencrypted | ✅ Keep as `job_location_state` |
| `jobLocationPostal` | Postal/ZIP code (when employer disclosed). Example: `"M5V 3A8"`. | 🟢 unencrypted | ✅ Keep as `job_location_postal` |
| `preciseLocationModel` | Object controlling whether the card shows the obfuscated "City, ST" form vs. precise lat/lng. Example: `{obfuscateLocation: false, overrideJCMPreciseLocationModel: false}`. | 🟢 unencrypted | ❌ Drop |
| `locationCount` | Integer — number of locations the listing covers. Example: `1` or `5`. | 🟢 unencrypted | ✅ Keep as `location_count` |
| `additionalLocationLink` | URL to the multi-location detail page. Example: `"/jobs?q=...&vjk=..."`. | 🟢 unencrypted | ✅ Keep as `additional_location_link` |
| `remoteLocation` | Boolean — does Indeed's SERP card show "Remote"? Example: `true`. | 🟢 unencrypted | ✅ Keep as `remote_location` |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `extractedSalary.min` | Min salary. Example: `80000`. | 🟢 unencrypted | ✅ Keep as `salary_min` |
| `extractedSalary.max` | Max salary. Example: `120000`. | 🟢 unencrypted | ✅ Keep as `salary_max` |
| `extractedSalary.type` | Salary period enum. Examples: `"YEARLY"`, `"HOURLY"`. | 🟢 unencrypted | ✅ Keep as `salary_period` |
| `salarySnippet.currency` | ISO currency code. Example: `"CAD"` or `""` when absent. | 🟢 unencrypted | ✅ Keep as `salary_currency` |
| `salarySnippet.salaryTextFormatted` (string variant) | Pre-formatted salary string when salary is disclosed. Example: `"$80,000 - $120,000 a year"` or `"From $30/hr"`. | 🟢 unencrypted | ✅ Keep as `salary_text` |
| `salarySnippet.salaryTextFormatted` (boolean variant) | Type-overloaded sentinel — when no salary is disclosed, this same key is `false` instead of absent. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `salarySnippet.source` | Source-flag string for the salary. Examples: `"EXTRACTED"`, `"EMPLOYER_PROVIDED"`, often absent. | 🟢 unencrypted | ✅ Keep as `salary_snippet_source` |

#### Company / brand

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `company` | Raw employer name. Example: `"Vretta Inc."`. | 🟢 unencrypted | ✅ Keep as `company` |
| `truncatedCompany` | Truncated form of `company` for narrow UI. Example: `"Vretta..."`. | 🟢 unencrypted | ❌ Drop |
| `companyBrandingAttributes` | Object describing employer's branded-job-package decoration. Example: `{brandingReasons: [...], brandingReasonsAsString: "...", headerImageUrl: "...", logoUrl: "...", showJobBranding: false, shownForBrandedJobPackage: false}`. | 🟢 unencrypted | ❌ Drop |
| `companyRating` | Numeric employer rating. Example: `1.5`. | 🟢 unencrypted | ❌ Drop |
| `companyReviewCount` | Numeric review count. Example: `42`. | 🟢 unencrypted | ❌ Drop |
| `companyOverviewLink` | Slug URL — Indeed Company page. Example: `"/cmp/Vretta-Inc.-1"`. | 🟡 Format: `/cmp/{slug}`. Parsed: `{slug}` = name-derived employer slug usable as a stable cross-job employer identifier. | ❌ Drop |
| `companyReviewLink` | Slug URL — company reviews page. Example: `"/cmp/Vretta-Inc.-1/reviews"`. | 🟢 unencrypted | ❌ Drop |
| `companyOverviewLinkCampaignId` | Campaign-tracking slug attached to overview link. Example: `"serp-linkcompanyname-content"`. | 🟢 unencrypted | ❌ Drop |
| `companyReviewLinkCampaignId` | Campaign-tracking slug attached to review link. Example: `"cmplinktst2"`. | 🟢 unencrypted | ❌ Drop |
| `featuredEmployer` | Boolean — employer paid for "featured" placement. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `featuredEmployerCandidate` | Boolean — listing is a candidate for featured placement. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `vjFeaturedEmployerCandidate` | Boolean — view-job page variant of `featuredEmployerCandidate`. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `featuredCompanyAttributes` | Object describing featured-employer attributes (custom hero image, logo, etc.). Example: `{}` for non-featured listings. | 🟢 unencrypted | ❌ Drop |
| `isTopRatedEmployer` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `isSubsidiaryJob` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |

#### Apply mechanics

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `indeedApplyEnabled` | Boolean — Indeed Apply (hosted form) is enabled. Example: `false`. | 🟢 unencrypted | ✅ Keep as `indeed_apply_enabled` |
| `indeedApplyable` | Boolean — listing is eligible for Indeed Apply. Example: `false`. | 🟢 unencrypted | ✅ Keep as `indeed_applyable` |
| `indeedApplyFinishAppUrlEnabled` | Apply-flow internal flag. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `appliedOrGreater` | Boolean — viewer has applied (or progressed beyond). Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `saved` | Boolean — viewer has saved this job. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `savedApplication` | Boolean — viewer has a saved (in-progress) application. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `isJobVisited` | Boolean — viewer has clicked through before. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `applyTime` | Epoch ms when viewer applied (or `0` if never). Example: `0`. | 🟢 unencrypted | ❌ Drop |
| `assistedApply` | Boolean — viewer used Indeed's assisted-apply flow. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `myApiJobState` | Object describing viewer's current state for this job. Example: `{stateLastChanged: 1777671006311, stateString: "VISITED"}`. | 🟢 unencrypted | ❌ Drop |
| `myJobsStateString` | Viewer's job-state enum. Examples: `"VISITED"`, `"SAVED"`, `"APPLIED"`. | 🟢 unencrypted | ❌ Drop |
| `myJobsStateChangeRelativeTime` | Display string. Example: `"29 minutes ago"`. | 🟢 unencrypted | ❌ Drop |
| `savedJobState` | Viewer's saved-job state enum. Example: `"VISITED"`. | 🟢 unencrypted | ❌ Drop |
| `applyCount` | Numeric count of applications received. Example: `47`. | 🟢 unencrypted | ❌ Drop |
| `organicApplyStartCount` | Variant counter. Example: `47`. | 🟢 unencrypted | ❌ Drop |
| `screenerQuestionsURL` | URL to screener-questions page. Example: `"/screener-questions/jk/c676d09fb51b868e"`. | 🟢 unencrypted | ✅ Keep as `screener_questions_url` |
| `isNoResumeJob` | Boolean — apply doesn't require a resume. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `isMobileThirdPartyApplyable` | Boolean — third-party apply works on mobile. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `redirectToThirdPartySite` | Boolean — apply click redirects to the employer's site. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `smartFillEnabled` | Boolean — Indeed's resume autofill is enabled. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `d2iEnabled` | Boolean — "Direct-to-Indeed" apply path enabled. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `smbD2iEnabled` | Boolean — small/mid-business variant of `d2iEnabled`. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `jsiEnabled` | Boolean — Job Search Insights enabled. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `indeedApplyResumeType` | Enum describing what kind of resume Indeed Apply expects. Example: `null` or `"REGULAR"`. | 🟢 unencrypted | ❌ Drop |

#### Ranking / ad surface

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `packageTier` | Sponsored package tier enum. Examples: `"NONE"`, `"BASIC"`, `"PREMIUM"`. | 🟢 unencrypted | ❌ Drop |
| `tier` | Object describing ranking tier. Example: `{type: "DEFAULT", matchedPreferences: {longMatchedPreferences: [], stringMatchedPreferences: []}}`. | 🟢 unencrypted | ❌ Drop |
| `adId` | Numeric ad ID. Example: `""` for organic, `"123456"` for sponsored. | 🟢 unencrypted | ❌ Drop |
| `adBlob` | Ad-attribution blob attached to sponsored placements. Example: `null` for organic. | 🔴 encrypted field cannot be parsed — opaque blob. | ❌ Drop |
| `advn` | Ad-vendor identifier attached to sponsored placements. Example: `""` for organic. | 🔴 encrypted field cannot be parsed — opaque vendor ID when populated. | ❌ Drop |
| `bidPosition` | Ranking position. Example: `-1` for organic. | 🟢 unencrypted | ❌ Drop |
| `sponsored` | Boolean — paid placement. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `showSponsoredLabel` | Boolean — UI should render the "Sponsored" label. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `organicBlob` | 160-char opaque tracking blob attached to organic placements. Example: a 160-char alphanumeric string. | 🔴 encrypted field cannot be parsed — opaque per-job tracking blob. | ❌ Drop |
| `rankingScoresModel` | Object with Indeed's ML predictions. Example: `{bid: 0, bidPosition: -1, eApply: 0.008713, eAttainability: 0.045683, eQualified: 0}`. `eApply` = probability the user applies; `eAttainability` = probability the user is qualified given the JD; `eQualified` = binary qualification flag (only set with resume on file). | 🟢 unencrypted | ❌ Drop |
| `recommendationReasonModel` | Object with `{reason}` — single string explaining "why this job?". Example: `{reason: null}` on organic; `{reason: "Based on your search history"}` for personalized. | 🟢 unencrypted | ❌ Drop |
| `minimumCount` | Result-count fence. Example: `0`. | 🟢 unencrypted | ❌ Drop |

#### Job seeker match model

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobSeekerMatchSummaryModel.trafficLight` | Match indicator enum. Examples: `"green"`, `"yellow"`, `"red"`. | 🟢 unencrypted | ❌ Drop |
| `jobSeekerMatchSummaryModel.taxoEntityMatchesNegative` | Pre-extracted JD requirements as taxonomy entities. Example: `[{rawName: "Bachelor's degree", suid: "4E4WW", source: "RESUME", strictness: "REQUIRED", displayText: "Bachelor's degree", id: 1234}]`. | 🟡 Format per element: `{rawName, suid, source, strictness, displayText, id}`. Parsed: `rawName` / `displayText` / `source` / `strictness` are unencrypted; `suid` is a 5-char opaque taxonomy hash with no public mapping (use `rawName` for display). | ✅ Keep as `match_negative_taxonomy` |
| `jobSeekerMatchSummaryModel.sortedMisMatchingEntityDisplayText` | Pre-extracted requirement labels. Example: `["5+ years experience", "Master's degree"]` or `[{rawName: "5+ years experience", strictness: "REQUIRED"}]`. | 🟢 unencrypted | ✅ Keep as `match_mismatching_entities` |
| `jobSeekerMatchSummaryModel.sortedEntityDisplayText` | Aggregated all-entity display text for matching UI. Example: `[]` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `jobSeekerMatchSummaryModel.sortedMatchingEntityDisplayText` | Pre-extracted **matching** requirement labels for the viewer's resume. Example: `[]` for unauthenticated. | 🟢 unencrypted | ❌ Drop |
| `jobSeekerMatchSummaryModel.taxoEntityMatchesPositive` | Structured form of positive taxonomy entities. Example: `[]` for unauthenticated. | 🟢 unencrypted | ❌ Drop |

#### Hiring / urgency / requirements

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `jobCardRequirementsModel` | UI rendering of card requirements. Example: `{additionalRequirementsCount: 0, jobOnlyRequirements: [], jobTagRequirements: [], requirementsHeaderShown: false, screenerQuestionRequirements: []}`. | 🟢 unencrypted | ❌ Drop |
| `rankedBenefits` | Ranked benefit list. Example: `[]`. | 🟢 unencrypted | ❌ Drop |
| `urgentlyHiring` | Boolean — "Urgently hiring" badge. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `hiringEventJob` | Boolean — listing tied to a hiring event. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `openInterviewsJob` | Boolean — open-interviews program participation. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `openInterviewsPhoneJob` | Boolean — open phone-interviews variant. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `openInterviewsInterviewsOnTheSpot` | Boolean — on-the-spot interviews variant. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `openInterviewsOffersOnTheSpot` | Boolean — on-the-spot offers variant. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `highVolumeHiringModel` | Object with `{highVolumeHiring}` — single boolean. Example: `{highVolumeHiring: false}`. | 🟢 unencrypted | ❌ Drop |
| `numHires` | Number of intended hires. Example: `1` or `5`. | 🟢 unencrypted | ✅ Keep as `num_hires` |
| `employerResponsive` | "Employer typically responds within X days" flag. Example: `null` or `"3 days"`. | 🟢 unencrypted | ❌ Drop |
| `employerAssistEnabled` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `autoSourcerJob` | Boolean — sourced by Indeed's auto-sourcer system. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `dradisJob` | Boolean — Dradis (internal Indeed system) job. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `resumeMatch` | Boolean — listing supports resume-match flow. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `gatedVjp` | Boolean — view-job page is "gated" (requires sign-in). Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `hiringMultipleCandidatesModel` | Object describing multi-hire metadata. Example: `null`. | 🟢 unencrypted | ❌ Drop |

#### Other UI / commute

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `loceJobTagModel` | Object describing the nearest transit station and lines. Example: `{station: "Dundas Station~TTC", stationTransitLines: ["TTC placeholder"], transitLines: ["TTC placeholder"]}`. | 🟢 unencrypted | ❌ Drop |
| `showCommutePromo` | Boolean — show the "X minute commute" promo. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `mouseDownHandlerOption` | Object containing click-handler config. Example: `{adId: "", advn: "", extractTrackingUrls: [], from: "vjs", jobKey: "c676d09fb51b868e", link: "...", tk: "1jnios994i0in800"}`. | 🟢 unencrypted | ❌ Drop |
| `overrideIndeedApplyText` | Boolean. Example: `true`. | 🟢 unencrypted | ❌ Drop |
| `showEarlyApply` | Boolean — show "Be one of the first applicants" badge. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `showStrongerAppliedLabel` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `showJobType` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `hideMetaData` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `enhancedAttributesModel` | Object containing enhanced-listing attributes. Example: `{}` for standard listings. | 🟢 unencrypted | ❌ Drop |
| `enticers` | Array of enticement labels. Example: `[]`. | 🟢 unencrypted | ❌ Drop |
| `extractTrackingUrls` | String of comma-separated tracking URLs to fire on click. Example: `""`. | 🟢 unencrypted | ❌ Drop |
| `jobFlairPackageEnabled` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |
| `resultBeforeExpansion` | Boolean. Example: `false`. | 🟢 unencrypted | ❌ Drop |

#### JD preview

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `snippet` | Short JD preview (first ~200 chars). Example: `"We are seeking a Senior Software Engineer with experience in..."`. | 🟢 unencrypted | ❌ Drop |

### GraphQL Extended Query

#### Identity & URLs

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.key` | Same as mosaic `jobkey`. Example: `"c676d09fb51b868e"`. | 🟢 unencrypted | ❌ Drop |
| `job.url` | The original employer-side URL (canonical apply URL). Example: `"https://boards.greenhouse.io/example/jobs/12345"`. | 🟢 unencrypted | ✅ Keep as `employer_canonical_url` |

#### Timing

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.datePublished` | Publish date. Example: `"2025-10-31"`. | 🟢 unencrypted | ✅ Keep as `graphql_date_published` |
| `job.dateOnIndeed` | Discovery-on-Indeed date. Example: `"2025-10-30"`. | 🟢 unencrypted | ✅ Keep as `graphql_date_on_indeed` |
| `job.expired` | Boolean. Example: `false`. | 🟢 unencrypted | ✅ Keep as `graphql_expired` |

#### Title & taxonomy

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.title` | Same as mosaic `title`. Example: `"Senior Software Engineer"`. | 🟢 unencrypted | ✅ Keep as `graphql_title` |
| `job.normalizedTitle` | Lowercase canonical title. Example: `"senior software engineer"`. | 🟢 unencrypted | ✅ Keep as `graphql_normalized_title` |
| `job.attributes` | Flat list mixing skills/education/tags. Example: `[{label: "Python", suid: "2V8EX"}, {label: "Bachelor's degree", suid: "HFDVW"}]`. | 🟡 Format per element: `{label, suid}`. Parsed: `label` = unencrypted display string; `suid` = opaque Indeed taxonomy hash. | ✅ Keep as `attributes` |

#### Location

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.location.formatted.short` | Short display location. Example: `"Toronto, ON"`. | 🟢 unencrypted | ❌ Drop |
| `job.location.formatted.long` | Long display string sometimes including postal code. Example: `"100 King St W, Toronto, ON M5X 1E1"`. | 🟢 unencrypted | ✅ Keep as `location_formatted_long` |
| `job.location.city` | Structured city. Example: `"Toronto"`. | 🟢 unencrypted | ✅ Keep as `graphql_location_city` |
| `job.location.postalCode` | Postal code. Example: `"M5X 1E1"`. | 🟢 unencrypted | ✅ Keep as `graphql_location_postal_code` |
| `job.location.streetAddress` | Street address. Example: `"100 King St W"`. | 🟢 unencrypted | ✅ Keep as `graphql_location_street_address` |
| `job.location.admin1Code` | ISO 3166-2 province/state code. Example: `"CA-ON"`. | 🟢 unencrypted | ✅ Keep as `graphql_location_admin1_code` |
| `job.location.countryCode` | ISO 2-letter country. Example: `"CA"`. | 🟢 unencrypted | ✅ Keep as `graphql_location_country_code` |
| `job.location.latitude` | Numeric latitude. Example: `0` (placeholder) or `43.6487`. | 🟢 unencrypted | ❌ Drop |
| `job.location.longitude` | Numeric longitude. Example: `0` or `-79.3789`. | 🟢 unencrypted | ❌ Drop |

#### Description

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.description.text` | Plain-text JD body. Example: full JD ~1,000-5,000 chars. | 🟢 unencrypted | ✅ Keep as `description_text` |
| `job.description.html` | HTML JD body. Example: `"<p>We are looking for...</p>..."`. | 🟢 unencrypted | ❌ Drop |
| `job.language` | ISO 2-letter detected JD language. Example: `"en"` or `"fr"`. | 🟢 unencrypted | ✅ Keep as `language` |

#### Employer

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.employer.name` | Employer name (normalized). Example: `"Acme Corp"`. | 🟢 unencrypted | ✅ Keep as `employer_name` |
| `job.employer.key` | Internal employer key. Example: an opaque alphanumeric string. | 🔴 encrypted field cannot be parsed — opaque internal employer key. | ❌ Drop |
| `job.employer.relativeCompanyPageUrl` | Indeed Company page URL. Example: `"/cmp/Acme-Corp"`. | 🟢 unencrypted | ✅ Keep as `employer_company_page_url` |
| `job.employer.dossier.employerDetails.addresses` | Employer addresses. Example: `[{streetAddress: "100 King St W", ...}]`. | 🟢 unencrypted | ❌ Drop |
| `job.employer.dossier.employerDetails.industry` | Employer's industry string. Example: `"Software Development"`. | 🟢 unencrypted | ❌ Drop |
| `job.employer.dossier.employerDetails.ceoName` | CEO display name. Example: `"Jane Smith"`. | 🟢 unencrypted | ❌ Drop |
| `job.employer.dossier.employerDetails.ceoPhotoUrl` | CEO photo URL. Example: `"https://d2q79iu7y748jz.cloudfront.net/..."`. | 🟢 unencrypted | ❌ Drop |
| `job.employer.dossier.employerDetails.employees` | Employee count or range. Example: `"51 to 200"`. | 🟢 unencrypted | ❌ Drop |
| `job.employer.dossier.employerDetails.revenue` | Revenue range. Example: `"$10M to $50M"`. | 🟢 unencrypted | ❌ Drop |

#### Source / provenance

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.source.name` | Crawl source name. Examples: `"Greenhouse"`, `"Workable"`, direct site name. | 🟢 unencrypted | ✅ Keep as `source_name` |
| `job.source.id` | Numeric crawl-source ID. Example: `12345`. | 🟢 unencrypted | ❌ Drop |
| `job.source.type` | Source-type enum. Examples: `"ATS"`, `"DIRECT"`. | 🟢 unencrypted | ❌ Drop |
| `job.source.url` | Source's homepage URL. Example: `"https://www.greenhouse.io"`. | 🟢 unencrypted | ❌ Drop |
| `job.source.code` | Internal source code. Example: `"GH"`. | 🟢 unencrypted | ❌ Drop |
| `job.source.displayName` | Display variant of `source.name`. Example: `"Greenhouse"`. | 🟢 unencrypted | ❌ Drop |
| `job.source.label` | UI label for the source. Example: `"via Greenhouse"`. | 🟢 unencrypted | ❌ Drop |

#### Salary

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.compensation.baseSalary.unitOfWork` | Pay period vocabulary. Examples: `"YEAR"`, `"HOUR"`, `"WEEK"`, `"MONTH"`. | 🟢 unencrypted | ✅ Keep as `graphql_salary_period` |
| `job.compensation.baseSalary.range.{...}` | Min/max range. Example: `{min: 80000, max: 120000}`. | 🟢 unencrypted | ❌ Drop |

#### Other

| Field name | Description | Encrypted? | In schema? |
|---|---|---|---|
| `job.hiringDemand` | Sparse hiring-demand indicator. Example: `null`. | 🟢 unencrypted | ❌ Drop |
| `job.shifts` | Sparse shift information. Example: `null` or `["Day shift"]`. | 🟢 unencrypted | ❌ Drop |
| `job.benefits` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.requirements` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.responsibilities` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.qualifications` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.salary` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.equity` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |
| `job.applicationDeadline` | Confirmed not to exist on GraphQL via probing. Example: n/a. | n/a | ❌ Drop |


---

