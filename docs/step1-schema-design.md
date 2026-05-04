# Step 1 — Per-Source Scrape Tables: Schema Design

**Status:** Design v12 — final, implementation-ready
**Scope:** Stage 1 (scraping) database schema only
**Supersedes:** `scraped_jobs` for new scrape ingestion (existing table retained
during transition; deprecated when merged-table design lands)
**Related docs:** `scrape-fields-master.md` (field-by-field decisions),
`jha-onboarding.md` Phase 6 (extension ingest path)

## Changelog (v11 → v12)

- **Indeed and Glassdoor JSONB column lists (11-1C):** Added explicit
  `INDEED_JSONB_COLS` (6 entries) and `GLASSDOOR_JSONB_COLS` (15 entries)
  in §10.3. Full INDEED_COLS / GLASSDOOR_COLS column lists are derived
  from §8 (mechanical transcription); only the JSONB subsets (which
  carry real correctness risk) are spelled out here.

## Changelog (v10 → v11)

- **Inline JSONB markers in column lists (10-11D):** Each JSONB column
  in `LINKEDIN_COLS` carries a `# JSONB` inline comment so the
  implementer can visually cross-check against `LINKEDIN_JSONB_COLS`.
  Eliminates the divergence risk where adding a JSONB column to one
  list but forgetting the other produces a runtime
  `invalid input syntax for type json` error.

## Changelog (v9 → v10)

- **All four LinkedIn entity URN-resolutions (9-1A):** §10.2 now shows
  call sites for Title, Company, EmploymentStatus, and WorkplaceType.
  Company specifically requires reaching into the nested
  `data.companyDetails[<$type wrapper>].company` URN, not a top-level
  URN string.
- **Programmatic CTE column-list generation (9-6B):** §10.3 now shows
  the recommended pattern: define a Python list of column names per
  table; build `cols_sql` and `vals_sql` from it; substitute into the
  `text()` template. Eliminates 153 hand-typed column-placeholder
  pairs and makes future schema changes trivial.
- **`build_*_params(body)` builder fragment (9-7A):** §10.3 shows a
  ~20-line fragment of `build_linkedin_params` covering the diverse
  cases (scalar reads, JSONB pass-through, URN-resolved fields). The
  bulk of the builder (mostly identical scalar reads) follows from
  §5/§6/§7 column source paths.
- **Explicit response construction (9-8A):** §10.4 now shows the
  exact `ScrapedJobIngestResponse` construction for the new path.
- **Migration `upgrade()` `op.execute(text(...))` option (9-13B):**
  §14 now mentions that the §8 SQL can be run directly via
  `op.execute(text(...))`, which is significantly simpler than
  translating 180+ columns into Alembic op syntax.

## Changelog (v8 → v9)

- **Indeed `graphql.job.X` notation translation (8-1B):** Added a note
  to §10.2 access-rule clarifying that §6.1's `graphql.job.X` paths
  drop the `.job.` prefix in `source_raw` access (because `graphql` is
  pre-navigated to the per-card `job` object per §3).
- **LinkedIn URN-resolution helper (8-2A):** §10.2 now shows a worked
  `_resolve_linkedin_included()` helper for walking `included[]` and
  resolving `data.standardizedTitle` URN references to entity objects.
- **Migration `downgrade()` (8-5C):** §14 now states the downgrade
  pattern in prose: three `op.drop_table()` calls in reverse order.
- **`discover_date` log style (8-6A):** Helper now logs structured
  `{"raw": ..., "error": ...}` matching the `ingest_ok %s` precedent
  in `routers/jobs.py`.
- **`malformed_source_raw` log prefix (8-7A):** Renamed to
  `ingest_malformed_source_raw` to match the `ingest_*` family (so
  `grep '^ingest_'` finds all ingest events).
- **`scan_run_id` required on new path (8-10A):** Route handler guards
  the per-source path with `if body.scan_run_id is None: raise
  HTTPException(400, "scan_run_id required")`. Pydantic shape stays
  `UUID | None` so legacy skip-row path is unaffected.
- **Params dict construction (8-11B):** §10.3 notes that `:job_url`
  appears twice in SQL but only once in the params dict; SQLAlchemy
  binds the same value to both occurrences.
- **Three-INSERT dispatch (8-12B):** §10.3 notes the three prepared
  `text()` statements (`INSERT_LINKEDIN_JOB`, `INSERT_INDEED_JOB`,
  `INSERT_GLASSDOOR_JOB`) and three `build_*_params(body)` helpers
  pattern.

## Changelog (v7 → v8)

- **Source-path → access-pattern bridge (v7-1A+B):** §10.2 now states
  the universal `.get()` chain rule for translating master-doc source
  paths to `body.source_raw[...]` Python access, plus a worked
  `_parse_glassdoor_discover_date` call site as a concrete example.
  Eliminates the per-column re-derivation cost during implementation.
- **Malformed `source_raw` robustness (v7-3B):** §10.2 wraps per-site
  extraction in a `try/except (AttributeError, TypeError)` returning
  HTTP 400 with sanitized message. Prevents 500 stack traces when the
  extension sends `{"jobListing": "string"}` or other invalid nesting.

## Changelog (v6 → v7)

This round covers the fourth pre-implementation review.

- **`timezone` import alias (v6-1A):** The
  `_parse_glassdoor_discover_date` helper in §10.2 step 4 now uses
  `dt_timezone.utc` to match the existing `routers/jobs.py` import
  (`from datetime import ..., timezone as dt_timezone`). Copy-paste of
  the helper now works without import collisions.
- **JSONB binding via `text()` (v6-2B):** §10.3 now shows the CTE with
  explicit `bindparam("col", type_=JSONB)` declarations attached to
  the prepared `text()` statement. Without these, SQLAlchemy passes
  Python dicts as `str(dict)` (Python repr) which produces invalid
  JSON and fails INSERT with `invalid input syntax for type json`.
  All JSONB columns on each table need a corresponding `bindparam`.
- **Glassdoor `source_raw` shape (v6-3A):** §3 now specifies that
  Glassdoor `source_raw` is a two-key wrapper:
  `{jobListing, json_ld}` — mirroring Indeed's `{mosaic, graphql}`
  pattern. Without this, the 19 JSON-LD-sourced columns
  (`jsonld_*` plus `title`, `date_posted`, `description`, etc.) would
  always be NULL because JSON-LD is in a separate `<script>` block,
  not inside `__NEXT_DATA__.props.pageProps.jobListing`. §11
  Glassdoor follow-up updated to require the content script to send
  this two-key wrapper.

## Changelog (v5 → v6)

This round covers the third pre-implementation review.

- **Transition fallback telemetry (v5-1A):** §10.2 step 2 now logs
  `ingest_transition_fallback` events with the `website` field. Cleanup
  criterion stated explicitly: after 30 consecutive days of zero
  `ingest_transition_fallback` log entries, the legacy non-skip branch
  is unreachable code and can be deleted in a follow-up cleanup.
  Aligns with the `logger.info("ingest_ok %s", ...)` precedent already
  in `routers/jobs.py`.
- **Strict `{}` vs `None` boundary on `source_raw` (v5-2B):** §10.2
  documents the boundary explicitly — `body.source_raw is None`
  triggers the transition fallback (extension hasn't updated yet); an
  empty dict `{}` does NOT trigger fallback (it indicates an extension
  bug worth surfacing). Empty dict proceeds to step 3 routing where
  Indeed's per-site checks return 400 with structured detail.
- **Indeed `source_raw` sub-shape spec (v5-3A):** §3 now specifies
  Indeed's per-side shapes alongside LinkedIn and Glassdoor:
  `mosaic` is the `mosaic_job` object directly (not the wrapper);
  `graphql` is the `data.jobData.results[0].job` object directly (not
  the full GraphQL response with envelope/errors). Eliminates an
  ambiguity that would have surfaced during column extraction
  implementation.

## Changelog (v4 → v5)

This round covers the second pre-implementation review (issues 1–5
from v4 review).

- **Transition path (1B):** Added §10.2 item 1.5 — when `body.source_raw`
  is missing on a non-skip row, fall through to the legacy `scraped_jobs`
  write path. Per-source tables only receive rows when real source data
  is present. Eliminates CHECK constraint violations during the rollout
  window before extension content scripts are updated.
- **`voyager_raw` coexistence (2A):** Added §10.1 clarification — this
  PR does not modify `voyager_raw` (column or field). Legacy ingest
  continues to populate `scraped_jobs.voyager_raw` from the existing
  field; new ingest populates `*_jobs.source_raw` from the new field.
  Eventual rename/cleanup deferred.
- **CTE result extraction (3D):** Augmented §10.3 single-row property
  bullet with `result.one()` consumption hint (`.scalar()` and
  `.first()` are wrong for different reasons).
- **Safe dict access for Glassdoor `listing_id` (4A):** Replaced the
  unsafe `[...]` access in §10.2 with a `.get()` chain plus
  `HTTPException(400)` fallback. Aligns with B4's permissive-dict
  `source_raw` philosophy.
- **`parse_glassdoor_discover_date` placement (5A):** Added implementer
  hint to §10.2 — the helper lives alongside `_hash_description` as a
  private module-level function in `routers/jobs.py`.

## Changelog (v3 → v4)

This round covers the pre-implementation review (issues A through I).

- **§10 contradiction (A1):** Rewrote §10 opening — "wire format
  unchanged, payload contents expand" — to remove the false claim that
  the extension does not change. Backend ingest path is in scope for this
  PR; extension scraper changes are tracked separately in §11.
- **Pydantic schema (B4):** Added §10.1 specifying the new
  `ScrapedJobIngest` shape: extend the existing class with a single
  `source_raw: dict | None` field; backend introspects per-site sub-blocks
  based on `body.website`. Field name aligns with the DB column.
- **Skip-row precedence (C1):** Clarified §10 item 1 — the `skip_reason`
  branch is checked first; only non-skip rows reach per-source routing.
- **CTE placeholder syntax (D2):** Rewrote the §10 CTE example using
  SQLAlchemy `:name` placeholders. Note that `:job_url` appears twice
  (in INSERT VALUES and in the fallback SELECT WHERE clause).
- **FK ON DELETE clause (F1):** Verification-gated. Before applying the
  migration, grep the backend for any DELETE on `extension_run_logs`. If
  empty, the existing `ON DELETE RESTRICT` choice ships as-is. Documented
  in §10.7 and §12.
- **`source_raw` shape per site (G1):** Tightened §3 to specify exactly
  what each site's `source_raw` contains: LinkedIn = `{data, included}`
  (top-level Voyager keys); Indeed = `{mosaic, graphql}` wrapper;
  Glassdoor = `__NEXT_DATA__.props.pageProps.jobListing` subtree (RSC
  dereferences inject back into this same shape, no schema revision
  needed).
- **Migration filename (H1):** Confirmed `025_per_source_scrape_tables.py`.
  Added §14.
- **`discover_date` parsing (I1+I4 hybrid):** §10 now shows a
  parse-with-warning helper that uses strict `fromisoformat`, falls to
  NULL on parse failure, and logs a warning so format drift is observable.

## Changelog (v2 → v3)

- **CC-12 / §8.4 contradiction (Issue 1.1):** Removed misleading "Postgres
  creates the FK index automatically" wording from CC-12. PostgreSQL does
  NOT auto-create FK indexes; §8.4 is the single source of truth for the
  three explicit `CREATE INDEX` statements.
- **`job_url` length cap (Issue 1.2):** Changed all three tables from
  `VARCHAR` to `VARCHAR(2048)`. Bounded ceiling, friendlier error if a
  future scraper bug generates a giant URL.
- **Glassdoor `job_url` derivation (Issue 1.3, with v3 variant):** Made
  Glassdoor `job_url` purely synthetic from `listing_id`:
  `https://www.glassdoor.ca/job-listing/listing-{listing_id}.htm?jl={listing_id}`.
  Deterministic — never NULL when `listing_id` is present, no risk of
  duplicate rows from URL variation. `seo_job_link` remains as a separate
  display-URL column when available.
- **FK ON DELETE clause (Issue 1.4):** All three `scan_run_id` FKs now
  have explicit `ON DELETE RESTRICT`. Behaviorally identical to the
  silent `NO ACTION` default but reads as deliberate intent matching
  CC-1's append-only semantics.
- **`scrape_time` semantics (Issue 1.5):** One-sentence clarification in
  §4 that this is the row-insert timestamp, not a per-card observation
  timestamp.
- **CTE concurrency assumption (Issue 1.6):** One-line concurrency
  assumption note added to §10. Alternative `ON CONFLICT DO UPDATE` was
  rejected — adopting it would silently retire CC-1's append-only
  invariant.
- **Indeed mosaic/graphql presence (Issue 1.7):** Added
  `mosaic_present BOOLEAN NOT NULL DEFAULT FALSE` +
  `graphql_present BOOLEAN NOT NULL DEFAULT FALSE` +
  `CHECK (mosaic_present OR graphql_present)` on `indeed_jobs`.
  Eliminates downstream `COALESCE` boilerplate and prevents junk rows.
- **Ingest contract additions:** §10 now specifies (a) Glassdoor
  synthetic-`job_url` construction rule, (b) Indeed presence-flag
  derivation rule.

## Changelog (v1 → v2)

- **Issue 1 (salary naming):** Standardized `salary_currency` + `salary_period`
  on every primary salary; alts use existing prefix convention. Renamed
  LinkedIn `salary_currency_code`/`salary_pay_period`, Indeed
  `graphql_compensation_unit_of_work`, Glassdoor `pay_currency`/`pay_period`/
  `header_pay_currency`/`header_pay_period`/`salary_unit_text`/
  `salary_currency_top`. Added `jsonld_*` Glassdoor source prefix; JSON-LD
  `salary_min`/`salary_max` also prefixed for consistency.
- **Issue 2 (`discover_date` TZ):** Changed `glassdoor_jobs.discover_date`
  type from `TIMESTAMP` to `TIMESTAMPTZ`. Documented UTC parsing at ingest.
- **Issue 3 (Glassdoor duplicates):** Added §12 deferred decision on cross-
  surface duplicate consolidation pre-production. Generalized beyond
  descriptions to all duplicated alts.
- **Issue 5 (`goc_id` type):** Changed `goc_id` from `VARCHAR(32)` to
  `INTEGER` for consistency with `job_country_id`. Added §3 clarification
  scoping CC-9's VARCHAR rule to PKs only.
- **Issue 10 (CTE ingest):** Replaced naive `ON CONFLICT DO NOTHING
  RETURNING id` prose in §10 with literal CTE-based single-statement SQL.
  Added run-log ordering invariant.


## 1. Goals and pipeline context

The Job Hunting Assistant pipeline is being restructured around per-source
append-only scrape tables. Each scrape produces one row in exactly one of
three tables:

```
linkedin_jobs   indeed_jobs   glassdoor_jobs   ← append-only, permanent
       ↓               ↓               ↓
       └───────────────┼───────────────┘
                       ↓
              merged_jobs (later — ephemeral, cycle-scoped)
                       ↓
              dedup → matching → pre_apply → frontend
                       ↓
              cleanup at end of cycle
```

This document covers **only** the three per-source tables. The merged table,
dedup pipeline, matching pipeline, and pre-apply table are out of scope and
will be designed against test data produced by these three tables.

The three tables are the canonical archive of every scrape ever performed.
Per-source rows are **never updated and never deleted** during the
development phase. Cleanup and update rules are deferred and will be
introduced after the cycle architecture is validated.


## 2. Cross-cutting decisions (locked-in)

The following decisions apply uniformly across all three tables.

| ID | Decision | Notes |
|---|---|---|
| **CC-1** | Append-only by **convention** (not DB-enforced) | Code never issues UPDATE or DELETE during dev. REVOKE-based enforcement deferred until update/delete rules are designed. |
| **CC-2** | **UUID primary key** per table, default `gen_random_uuid()` | Matches the project-wide convention (`scraped_jobs.id`, `extension_run_logs.id` are UUID). No need for predictable monotonic order. |
| **CC-3** | **`scan_run_id UUID` FK → `extension_run_logs.id`** | Every scrape row carries the run that produced it. Required for cleanup, debugging, and the run-scoped queries dedup needs. |
| **CC-4** | **Dev/test:** structured columns + `source_raw JSONB`<br>**Production:** structured columns only (drop `source_raw`) | Dev keeps `source_raw` as the safety net for backfill / debugging. Production migration drops it once parsing is stable. |
| **CC-5** | **No `search_filters` column** on per-source tables | Filters live on the run-log row (`extension_run_logs.search_filters`) and join through `scan_run_id`. |
| **CC-6** | **Flatten LinkedIn `data` + `included[]`** onto row columns | At ingest, `included[]` Company / Title / EmploymentStatus / WorkplaceType entities are resolved by URN and their kept fields land as top-level columns. Raw structure preserved in `source_raw` (dev). |
| **CC-7** | **`job_url UNIQUE` per table**, `ON CONFLICT DO NOTHING RETURNING id` semantics | Re-scrape of the same URL silently no-ops — backend returns the existing row's `id` and reports `already_exists: true` to the extension. UNIQUE is per-table only; the same job appearing on two sites creates two rows (resolved later by merge). |
| **CC-8** | **`scrape_time TIMESTAMPTZ DEFAULT NOW()`** | Server-side, never client-supplied. Single timestamp per row; no `updated_at` (append-only). |
| **CC-9** | **Site-stable IDs as `VARCHAR(32)`**, not BIGINT | LinkedIn's `jobPostingId` is numeric; Indeed's `jobkey` is hex; Glassdoor's `listingId` is numeric. VARCHAR is the unifying type and defensive against future ID format changes. |
| **CC-10** | **No salary normalization at ingest** | Per-source tables stay faithful to source vocabulary (`YEARLY` vs `YEAR` vs `ANNUAL`). Normalization happens in the merge step. |
| **CC-11** | **Nested objects stay JSONB on per-source tables** | `postal_address`, `pay_period_adjusted_pay`, `job_location`, `taxonomy_attributes`, `attributes`, etc. land as JSONB columns. Materialization to scalar columns is a merge-step concern. |
| **CC-12** | **Minimum index set** | PK (auto), `job_url UNIQUE` (auto), explicit FK index on `scan_run_id` (PostgreSQL does **not** auto-create FK indexes; see §8.4 for the explicit `CREATE INDEX` statements). No additional indexes added speculatively. |

Everything else uses my defaults from the prior conversation; nothing has
been negotiated otherwise.


## 3. Naming and column conventions

**Casing.** All columns are `snake_case`. Source-side camelCase fields are
mapped to snake_case at ingest (e.g. `jobPostingId` → `job_posting_id`).

**URN handling.** This task captures URNs as raw strings on the row;
parsing is **deferred** to a later step (per LI-3 and GD-2 decisions).
Where the master doc says "Keep as `country_urn`", the column stores the
full URN string `urn:li:fs_country:ca`. A future migration may add parsed
companion columns (`country_iso2`) when downstream needs them.

**CC-9 scope.** CC-9's `VARCHAR(32)` rule applies specifically to
**site-stable PKs** (`job_posting_id`, `jobkey`, `listing_id`) — the
defensive-against-format-change reasoning is scoped to these. Other
numeric taxonomy IDs (`goc_id`, `job_country_id`, etc.) use `INTEGER`.

**Sub-tree prefixes (Glassdoor).** Glassdoor surfaces the same concept on
multiple sources (Next.js sub-trees plus a separate JSON-LD block). Per
the master doc and Q3 decision, all duplicates are kept with source-
indicating prefixes:
- `*` (no prefix) — `jobDetailsData` top-level (canonical for most fields)
- `header_*` — `jobDetailsRawData.jobview.header`
- `map_*` — `jobDetailsRawData.jobview.map`
- `jobview_job_*` — `jobDetailsRawData.jobview.job`
- `jsonld_*` — JSON-LD `JobPosting` script block (separate `<script
  type="application/ld+json">` element, not a Next.js sub-tree, but
  surfaced as a prefix for naming consistency)

**Cross-surface prefixes (Indeed).** Indeed surfaces some concepts on
both `mosaic_job` and `GraphQL`. Per the master doc and Q3 decision, both
are kept; the `graphql_*` prefix marks the GraphQL alt:
- `*` (no prefix) — `mosaic_job` (canonical surface for most fields)
- `graphql_*` — GraphQL Extended Query alt (kept for cross-surface check)

**Salary column naming.** The same concept (currency, pay period) appears
on multiple surfaces with different source field names. Column names are
mechanically standardized to `salary_currency` + `salary_period` for the
canonical/primary salary on each table; alts use the appropriate source
prefix (`graphql_*`, `header_*`, `jsonld_*`). Source vocabulary is
preserved for **values** (`YEARLY` vs `ANNUAL` vs `YEAR`) per CC-10, but
column **names** are uniform across tables. See §5–§7 for the per-table
mapping.

**`source_raw` shape per site.** The full unprocessed source response.
Per-site contents are precisely:

- **LinkedIn:** `{data, included}` — the two top-level keys of the Voyager
  normalized response (`Accept: application/vnd.linkedin.normalized+json+2.1`).
  `data` holds the JobPosting itself; `included[]` holds the resolved
  Company / Title / EmploymentStatus / WorkplaceType entities. Other
  top-level keys (`paging`, `meta`, etc.) are stripped at the extension
  side before sending. **Both keys are required** — `included` is what
  resolves the `company_name`, `standardized_title`, `employment_status_label`
  and `workplace_type_entity_urn` row columns.

- **Indeed:** `{mosaic, graphql}` wrapper. **Sub-shapes inside the
  wrapper are pre-navigated to the per-card object** (mirroring how
  Glassdoor stores the navigated `jobListing` subtree, not the raw
  `__NEXT_DATA__`):
  - `mosaic` = the `mosaic_job` object directly. Not the SERP-wide
    container that holds it; just the per-card mosaic_job entry that
    the master doc's Indeed mosaic_job section enumerates fields from.
  - `graphql` = the `data.jobData.results[0].job` object directly.
    Not the full GraphQL response (`{data: {...}, errors: [...]}`);
    the content script unwraps the envelope and stores the per-card
    `job` object that the master doc's GraphQL Extended Query section
    enumerates fields from.

  Either side may be `null` if that surface failed at scrape time. The
  CHECK constraint on `indeed_jobs` (§6.3) rejects rows where both
  sides are null.

- **Glassdoor:** `{jobListing, json_ld}` two-key wrapper (mirroring
  Indeed's `{mosaic, graphql}` two-source pattern). Glassdoor has two
  independent scrape sources that must both be captured:
  - `jobListing` = `__NEXT_DATA__.props.pageProps.jobListing` subtree.
    Holds the `jobDetailsData.*`, `jobDetailsRawData.jobview.*`
    (header / map / job sub-trees) data.
  - `json_ld` = the parsed `<script type="application/ld+json">`
    `JobPosting` object. This is a **separate** HTML element, not
    inside `__NEXT_DATA__`. Holds the `JobPosting.title`,
    `JobPosting.datePosted`, `JobPosting.baseSalary.*`,
    `JobPosting.description` (HTML JD), etc. that the master doc's
    JSON-LD section enumerates fields from.

  When the RSC chunk parser is extended (deferred per GD-2) to walk
  sibling chunks for fields like `job_link`, `header_apply_url`, and
  `pay_period_adjusted_pay`, the parser **injects the dereferenced
  values back into the existing `jobListing` subtree** before
  serialization. The shape of `source_raw` therefore does not change
  when the parser is extended — only the values of previously-unresolved
  fields become populated.


## 4. Common columns (every per-source table)

Every per-source table includes these five columns:

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Project-wide UUID convention. |
| `scan_run_id` | UUID | FK → `extension_run_logs.id` `ON DELETE RESTRICT`, NOT NULL | The run that produced this scrape row. RESTRICT matches CC-1 append-only semantics. |
| `job_url` | VARCHAR(2048) | UNIQUE, NOT NULL | Site-canonical URL (per-site rule below). 2048-char ceiling is comfortably above all observed URL lengths and produces a friendlier error than a B-tree index-size violation. |
| `scrape_time` | TIMESTAMPTZ | NOT NULL, DEFAULT `NOW()` | Server-side row-insert timestamp. **Not** a per-card observation timestamp — see note below. |
| `source_raw` | JSONB | NULL allowed | **Dev/test only.** Full unprocessed source response. Dropped in production (§9). |

**`job_url` per-site rule:**
- **LinkedIn:** `data.jobPostingUrl`
  (e.g. `https://www.linkedin.com/jobs/view/4407958631`)
- **Indeed:** `https://ca.indeed.com/viewjob?jk={jobkey}`
  (constructed from `jobkey`, never read from the payload directly)
- **Glassdoor:** `https://www.glassdoor.ca/job-listing/listing-{listing_id}.htm?jl={listing_id}`
  (purely synthetic from `listing_id` — **not** derived from `seoJobLink`).
  This guarantees `job_url` is deterministic per job, never NULL, and
  identical across re-scrapes regardless of whether `seoJobLink` is
  populated. The SEO-friendly URL (when available) is stored separately
  in the `seo_job_link` column for display purposes. Glassdoor accepts
  the `?jl=` parameter without the descriptive slug, so the synthetic
  URL is also a working browser link.

The site-stable ID (`job_posting_id` / `jobkey` / `listing_id`) is **not**
the primary key. It is a payload column. The PK is the per-row UUID. The
"do not re-scrape the same job" invariant is enforced by `job_url UNIQUE`.

**`scrape_time` semantics.** `scrape_time` is the row-insert timestamp
(server-side `NOW()` at the moment ingest commits the row). It is *not*
a per-card observation timestamp. All rows from the same `scan_run_id`
share the same insertion window because cycles are sequential per the
auto-scrape `cycle_phase` guard. For run-level windowing, join through
`scan_run_id` to `extension_run_logs.started_at` / `completed_at`.


## 5. `linkedin_jobs` table

Source: Voyager API `WebFullJobPosting-65` decoration.
`data` → row columns, `included[]` → resolved entity fields → row columns.

### 5.1 Columns

#### Common (§4)
- `id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`

#### Identity
| Column | Type | Source | Notes |
|---|---|---|---|
| `job_posting_id` | VARCHAR(32) | `data.jobPostingId` | LinkedIn's stable numeric ID. Indexed via UNIQUE `job_url` redundancy; not separately UNIQUE. |
| `job_posting_url` | TEXT | `data.jobPostingUrl` | Same value as `job_url` for LinkedIn. Kept separately to preserve source structure. |

#### Timing & lifecycle
| Column | Type | Source | Notes |
|---|---|---|---|
| `listed_at` | BIGINT | `data.listedAt` | Epoch ms. Stored as int — parsing to TIMESTAMPTZ deferred. |
| `original_listed_at` | BIGINT | `data.originalListedAt` | Epoch ms. |
| `job_state` | VARCHAR(32) | `data.jobState` | `LISTED` / `CLOSED` / etc. |
| `job_application_limit_reached` | BOOLEAN | `data.jobApplicationLimitReached` | Master doc warns this is NOT a useful closure indicator alone. |
| `expire_at` | BIGINT | `data.expireAt` | Epoch ms. LinkedIn auto-set ~30 days. |
| `closed_at` | BIGINT | `data.closedAt` | Epoch ms. NULL while live. |

#### Location
| Column | Type | Source | Notes |
|---|---|---|---|
| `formatted_location` | TEXT | `data.formattedLocation` | Display string. |
| `country_urn` | VARCHAR(64) | `data.country` | Full URN `urn:li:fs_country:{iso2}`. |
| `location_urn` | VARCHAR(64) | `data.locationUrn` | Full URN `urn:li:fs_geo:{geoId}`. |
| `location_visibility` | VARCHAR(32) | `data.locationVisibility` | `ADDRESS` / `HIDDEN` / `REMOTE_ONLY`. |
| `postal_address` | JSONB | `data.postalAddress` | `{line1, city, postalCode, country}`. |
| `standardized_addresses` | JSONB | `data.standardizedAddresses` | Array of canonicalized address objects. |
| `job_region` | TEXT | `data.jobRegion` | E.g. `"Greater Toronto Area"`. |

#### Work mode
| Column | Type | Source | Notes |
|---|---|---|---|
| `work_remote_allowed` | BOOLEAN | `data.workRemoteAllowed` | Coarse remote flag. |
| `workplace_types_urns` | JSONB | `data.workplaceTypes` | Array of `urn:li:fs_workplaceType:{1\|2\|3}` strings. |
| `workplace_types_labels` | JSONB | `data.workplaceTypesResolutionResults` | Pre-resolved URN→label dict. |

#### Employment & taxonomy
| Column | Type | Source | Notes |
|---|---|---|---|
| `formatted_employment_status` | VARCHAR(32) | `data.formattedEmploymentStatus` | "Full-time" / "Part-time" / etc. |
| `employment_status_urn` | VARCHAR(64) | `data.employmentStatus` | Full URN. |
| `formatted_industries` | JSONB | `data.formattedIndustries` | Array of display strings. |
| `formatted_job_functions` | JSONB | `data.formattedJobFunctions` | Array of display strings. |
| `title` | TEXT | `data.title` | Raw employer-typed title. |
| `standardized_title` | TEXT | `included[].Title.localizedName` (resolved by `data.standardizedTitle` URN) | Resolved label. |
| `formatted_experience_level` | VARCHAR(32) | `data.formattedExperienceLevel` | Seniority display string. |
| `skills_description` | TEXT | `data.skillsDescription` | Free-text skills. |

#### Apply
| Column | Type | Source | Notes |
|---|---|---|---|
| `apply_method_type` | VARCHAR(64) | `data.applyMethod.$type` (parsed) | E.g. `"OffsiteApply"`, `"ComplexOnsiteApply"`, `"SimpleOnsiteApply"` (Java suffix dropped). |
| `company_apply_url` | TEXT | `data.applyMethod.companyApplyUrl` | Employer apply URL. |
| `applicant_tracking_system` | VARCHAR(64) | `data.applicantTrackingSystem` | E.g. `"Workday"`, `"Greenhouse"`. |
| `top_level_company_apply_url` | TEXT | `data.companyApplyUrl` | Alt apply URL. |

#### Salary
| Column | Type | Source | Notes |
|---|---|---|---|
| `salary_min` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].minSalary` | |
| `salary_max` | NUMERIC | `data.salaryInsights.compensationBreakdown[0].maxSalary` | |
| `salary_currency` | VARCHAR(3) | `data.salaryInsights.compensationBreakdown[0].currencyCode` | ISO 4217. |
| `salary_period` | VARCHAR(16) | `data.salaryInsights.compensationBreakdown[0].payPeriod` | LinkedIn vocab: `YEARLY` / `HOURLY` / `MONTHLY`. |
| `salary_provided_by_employer` | BOOLEAN | `data.salaryInsights.providedByEmployer` | Salary provenance flag. |

#### Description
| Column | Type | Source | Notes |
|---|---|---|---|
| `description_text` | TEXT | `data.description.text` | Plain-text JD body. Primary matching input. |

#### Benefits
| Column | Type | Source | Notes |
|---|---|---|---|
| `inferred_benefits` | JSONB | `data.inferredBenefits` | LinkedIn-parsed benefit tags. |
| `benefits` | JSONB | `data.benefits` | Employer-declared benefit tags. |

#### Company (resolved from `included[]`)
| Column | Type | Source | Notes |
|---|---|---|---|
| `company_name` | TEXT | `included[].Company.name` | Required for matching. |
| `company_universal_name` | VARCHAR(128) | `included[].Company.universalName` | URL-safe slug. |
| `company_url` | TEXT | `included[].Company.url` | LinkedIn employer profile URL. |
| `company_description` | TEXT | `included[].Company.description` | Free-text employer summary. |

#### Title / status / workplace URN companions (resolved from `included[]`)
| Column | Type | Source | Notes |
|---|---|---|---|
| `title_entity_urn` | VARCHAR(64) | `included[].Title.entityUrn` | Stable title-taxonomy ID. |
| `employment_status_label` | VARCHAR(32) | `included[].EmploymentStatus.localizedName` | Display string companion to `employment_status_urn`. |
| `employment_status_entity_urn` | VARCHAR(64) | `included[].EmploymentStatus.entityUrn` | Stable enum URN. |
| `workplace_type_entity_urn` | VARCHAR(64) | `included[].WorkplaceType.entityUrn` | Stable workplace-type URN. |

### 5.2 `linkedin_jobs` field count

5 common + 2 identity + 6 timing + 7 location + 3 work mode + 8 employment +
4 apply + 5 salary + 1 description + 2 benefits + 4 company + 4 misc URN
companions = **51 columns**.


## 6. `indeed_jobs` table

Source: `mosaic_job` (SERP-side) + `GraphQL Extended Query` (detail-side),
both fetched per scrape. Either side may be `null` if that surface failed.

### 6.1 Columns

#### Common (§4)
- `id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`

#### Surface presence (Indeed-specific)
| Column | Type | Source | Notes |
|---|---|---|---|
| `mosaic_present` | BOOLEAN | derived at ingest | `TRUE` if the `mosaic` block in the ingest payload was non-null. |
| `graphql_present` | BOOLEAN | derived at ingest | `TRUE` if the `graphql` block in the ingest payload was non-null. |

A row-level CHECK constraint enforces `mosaic_present OR graphql_present`
— Indeed rows with both surfaces failed are rejected at ingest. See §6.3
for rationale.

#### Identity & URLs (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `jobkey` | VARCHAR(32) | `mosaic.jobkey` | 16-char hex stable Indeed ID. |
| `link` | TEXT | `mosaic.link` | Indeed display URL (with tracking params). |
| `view_job_link` | TEXT | `mosaic.viewJobLink` | Alt display URL. |
| `more_loc_url` | TEXT | `mosaic.moreLocUrl` | Multi-location detail-page URL. |
| `third_party_apply_url` | TEXT | `mosaic.thirdPartyApplyUrl` | Indeed apply-redirect URL. |

#### Timing (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `pub_date` | BIGINT | `mosaic.pubDate` | Epoch ms publish time. |
| `create_date` | BIGINT | `mosaic.createDate` | Epoch ms Indeed-side ingest. |
| `expiration_date` | BIGINT | `mosaic.expirationDate` | Epoch ms employer-set expiry (rare). |
| `expired` | BOOLEAN | `mosaic.expired` | Captured per spec. |

#### Title & taxonomy (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `title` | TEXT | `mosaic.title` | Raw title. |
| `display_title` | TEXT | `mosaic.displayTitle` | HTML-decoded title. |
| `norm_title` | TEXT | `mosaic.normTitle` | Title-case canonical. |
| `job_types` | JSONB | `mosaic.jobTypes` | Array; treat as low-prevalence per master doc. |
| `taxonomy_attributes` | JSONB | `mosaic.taxonomyAttributes` | Indeed's primary structured taxonomy. |

#### Location (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `formatted_location` | TEXT | `mosaic.formattedLocation` | Display location. |
| `job_location_city` | VARCHAR(128) | `mosaic.jobLocationCity` | Structured city. |
| `job_location_state` | VARCHAR(8) | `mosaic.jobLocationState` | 2-letter province/state. |
| `job_location_postal` | VARCHAR(16) | `mosaic.jobLocationPostal` | Postal/ZIP. |
| `location_count` | INTEGER | `mosaic.locationCount` | Multi-location count. |
| `additional_location_link` | TEXT | `mosaic.additionalLocationLink` | Multi-location page URL. |
| `remote_location` | BOOLEAN | `mosaic.remoteLocation` | Coarse remote flag. |

#### Salary (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `salary_min` | NUMERIC | `mosaic.extractedSalary.min` | |
| `salary_max` | NUMERIC | `mosaic.extractedSalary.max` | |
| `salary_period` | VARCHAR(16) | `mosaic.extractedSalary.type` | Indeed mosaic vocab: `YEARLY` / `HOURLY`. |
| `salary_currency` | VARCHAR(3) | `mosaic.salarySnippet.currency` | ISO 4217. |
| `salary_text` | TEXT | `mosaic.salarySnippet.salaryTextFormatted` | Pre-formatted display string. |
| `salary_snippet_source` | VARCHAR(32) | `mosaic.salarySnippet.source` | `EXTRACTED` / `EMPLOYER_PROVIDED`. |

#### Employer (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `company` | TEXT | `mosaic.company` | Mosaic-side employer name. |

#### Apply (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `indeed_apply_enabled` | BOOLEAN | `mosaic.indeedApplyEnabled` | Hosted-form available. |
| `indeed_applyable` | BOOLEAN | `mosaic.indeedApplyable` | Eligible for hosted form. |
| `apply_count` | INTEGER | `mosaic.applyCount` | Application count. |
| `screener_questions_url` | TEXT | `mosaic.screenerQuestionsURL` | Screener page URL. |

#### Pre-extracted requirements (mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `match_negative_taxonomy` | JSONB | `mosaic.jobSeekerMatchSummaryModel.taxoEntityMatchesNegative` | Structured requirement entities. |
| `match_mismatching_entities` | JSONB | `mosaic.jobSeekerMatchSummaryModel.sortedMisMatchingEntityDisplayText` | Requirement labels. |
| `num_hires` | INTEGER | `mosaic.numHires` | Saturation signal. |

#### Identity & URLs (graphql)
| Column | Type | Source | Notes |
|---|---|---|---|
| `employer_canonical_url` | TEXT | `graphql.job.url` | Original employer-side URL. |

#### Timing (graphql, alts to mosaic)
| Column | Type | Source | Notes |
|---|---|---|---|
| `graphql_date_published` | DATE | `graphql.job.datePublished` | Date-precision publish. |
| `graphql_date_on_indeed` | DATE | `graphql.job.dateOnIndeed` | Date-precision crawl-discovery. |
| `graphql_expired` | BOOLEAN | `graphql.job.expired` | Alt expiration flag. |

#### Title & taxonomy (graphql, alts)
| Column | Type | Source | Notes |
|---|---|---|---|
| `graphql_title` | TEXT | `graphql.job.title` | Alt title. |
| `graphql_normalized_title` | TEXT | `graphql.job.normalizedTitle` | Lowercase normalized. |
| `attributes` | JSONB | `graphql.job.attributes` | Skill/education/tag taxonomy. |

#### Location (graphql, alts)
| Column | Type | Source | Notes |
|---|---|---|---|
| `location_formatted_long` | TEXT | `graphql.job.location.formatted.long` | Long display. |
| `graphql_location_city` | VARCHAR(128) | `graphql.job.location.city` | |
| `graphql_location_postal_code` | VARCHAR(16) | `graphql.job.location.postalCode` | |
| `graphql_location_street_address` | TEXT | `graphql.job.location.streetAddress` | |
| `graphql_location_admin1_code` | VARCHAR(8) | `graphql.job.location.admin1Code` | ISO 3166-2. |
| `graphql_location_country_code` | VARCHAR(2) | `graphql.job.location.countryCode` | ISO 2-letter. |

#### Description (graphql)
| Column | Type | Source | Notes |
|---|---|---|---|
| `description_text` | TEXT | `graphql.job.description.text` | Primary matching input. |
| `language` | VARCHAR(8) | `graphql.job.language` | ISO 2-letter. |

#### Employer (graphql)
| Column | Type | Source | Notes |
|---|---|---|---|
| `employer_name` | TEXT | `graphql.job.employer.name` | Normalized employer name. |
| `employer_company_page_url` | TEXT | `graphql.job.employer.relativeCompanyPageUrl` | Indeed company page (relative). |

#### Source / provenance (graphql)
| Column | Type | Source | Notes |
|---|---|---|---|
| `source_name` | VARCHAR(64) | `graphql.job.source.name` | Crawl source (e.g. `Greenhouse`). |

#### Salary (graphql, alt)
| Column | Type | Source | Notes |
|---|---|---|---|
| `graphql_salary_period` | VARCHAR(16) | `graphql.job.compensation.baseSalary.unitOfWork` | GraphQL vocab: `YEAR` / `HOUR` / `WEEK` / `MONTH`. |

### 6.2 `indeed_jobs` field count

5 common + 2 surface presence + 5 identity + 4 timing + 5 title/tax + 7
location + 6 salary + 1 employer + 4 apply + 3 reqs + 1 graphql identity
+ 3 graphql timing + 3 graphql title/tax + 6 graphql location + 2
description + 2 graphql employer + 1 source + 1 graphql salary = **61
columns**.

### 6.3 Why surface presence flags

LinkedIn and Glassdoor rows have a single underlying source response: if
that response was captured, every kept field has a deterministic
populated/NULL state derived from the source. Indeed is structurally
different — it has **two independent sources** (`mosaic_job` SERP-side
fetch and `GraphQL` detail-side fetch) and either can fail
independently. The four states are:

| `mosaic_present` | `graphql_present` | What's populated |
|---|---|---|
| `TRUE` | `TRUE` | All Indeed columns may be populated. |
| `TRUE` | `FALSE` | Mosaic-side columns populated; `graphql_*` columns and `description_text` are NULL. |
| `FALSE` | `TRUE` | `graphql_*` columns populated; mosaic-side columns (including unprefixed `title`, `salary_min`, `formatted_location`, `company`) are NULL. |
| `FALSE` | `FALSE` | Junk row — rejected at ingest by the CHECK constraint. |

Without these flags, downstream queries that touch unprefixed fields
(e.g. `title`, `salary_min`) need defensive `COALESCE(title,
graphql_title)` everywhere — and have no way to distinguish "field
genuinely NULL on a populated mosaic" from "mosaic surface failed
entirely." The flags make presence explicit and queryable, eliminate
the COALESCE boilerplate, and prevent the `(FALSE, FALSE)` junk-row
state from being representable.

The flags are derived at ingest time from the presence of the source
blocks in the payload, **not** from the contents of `source_raw`. See
§10 for the ingest contract.


## 7. `glassdoor_jobs` table

Source: JSON-LD `JobPosting` + `jobDetailsData` top-level + three
`jobDetailsRawData.jobview.*` sub-trees (header / map / job).

### 7.1 Columns

#### Common (§4)
- `id`, `scan_run_id`, `job_url`, `scrape_time`, `source_raw`

#### Identity & taxonomy IDs (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `listing_id` | VARCHAR(32) | `jobDetailsData.listingId` | Stable Glassdoor job ID. |
| `goc_id` | INTEGER | `jobDetailsData.gocId` | General Occupation Code ID. |
| `job_country_id` | INTEGER | `jobDetailsData.jobCountryId` | Glassdoor country ID. |

#### Title (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `job_title` | TEXT | `jobDetailsData.jobTitle` | |
| `normalized_job_title` | TEXT | `jobDetailsData.normalizedJobTitle` | Lowercase canonical. |

#### Lifecycle (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `expired` | BOOLEAN | `jobDetailsData.expired` | |
| `employer_active_status` | VARCHAR(16) | `jobDetailsData.employerActiveStatus` | `ACTIVE` / `INACTIVE`. |

#### Apply (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `is_easy_apply` | BOOLEAN | `jobDetailsData.isEasyApply` | |
| `job_link` | TEXT | `jobDetailsData.jobLink` | RSC reference pre-resolution. Captured as raw value (`"$3f"` etc) until parser is extended; per GD-2 this task does not resolve. |
| `seo_job_link` | TEXT | `jobDetailsData.seoJobLink` | Glassdoor canonical URL with `?jl=` param. |

#### Salary (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `salary_currency` | VARCHAR(3) | `jobDetailsData.payCurrency` | ISO 4217. |
| `salary_period` | VARCHAR(16) | `jobDetailsData.payPeriod` | Glassdoor vocab: `ANNUAL` / `HOURLY` / `MONTHLY`. |
| `salary_source` | VARCHAR(32) | `jobDetailsData.salarySource` | `EMPLOYER_PROVIDED` / `ESTIMATED`. |
| `pay_period_adjusted_pay` | JSONB | `jobDetailsData.payPeriodAdjustedPay` | `{p10, p50, p90}` percentiles. May be unresolved RSC ref currently. |

#### Location (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `location_name` | TEXT | `jobDetailsData.locationName` | Display city. |
| `location` | JSONB | `jobDetailsData.location` | `{id, name, type}` structured ref. |

#### Employer (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `employer_name` | TEXT | `jobDetailsData.employerName` | |
| `employer_overview` | TEXT | `jobDetailsData.employerOverview` | Long-form employer profile. |

#### Pre-extracted skills/education (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `indeed_job_attribute` | JSONB | `jobDetailsData.indeedJobAttribute` | Container with `skills`, `skillsLabel`, `education`, `educationLabel`. |
| `skills_labels` | JSONB | `jobDetailsData.indeedJobAttribute.skillsLabel` | Pre-extracted skill display strings. |
| `education_labels` | JSONB | `jobDetailsData.indeedJobAttribute.educationLabel` | Pre-extracted credentials. |

#### Description (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `job_description_plain` | TEXT | `jobDetailsData.jobDescription` | Pre-stripped plain text. |

#### Reviews & benefits (jobDetailsData)
| Column | Type | Source | Notes |
|---|---|---|---|
| `employer_benefits_overview` | TEXT | `jobDetailsData.employerBenefitsOverview` | Free-text benefits summary. |
| `employer_benefits_reviews` | JSONB | `jobDetailsData.employerBenefitsReviews` | Aggregated review snippets. |

#### JSON-LD `JobPosting`
| Column | Type | Source | Notes |
|---|---|---|---|
| `title` | TEXT | `JobPosting.title` | JSON-LD title (alt to `job_title`). |
| `date_posted` | DATE | `JobPosting.datePosted` | Posting date. |
| `valid_through` | DATE | `JobPosting.validThrough` | Master doc warns this is server-recomputed and **NOT** a real expiry signal. Forensic only. |
| `description` | TEXT | `JobPosting.description` | HTML JD body. Often the longest of the three description sources. |
| `experience_requirements_description` | TEXT | `JobPosting.experienceRequirements.description` | Free-text reqs summary. |
| `experience_requirements_months` | INTEGER | `JobPosting.experienceRequirements.monthsOfExperience` | Numeric experience requirement. |
| `education_requirements_credential` | VARCHAR(64) | `JobPosting.educationRequirements.credentialCategory` | E.g. `bachelor's degree`. |
| `employment_type` | JSONB | `JobPosting.employmentType` | Schema.org enum array. |
| `jsonld_salary_currency_top` | VARCHAR(3) | `JobPosting.salaryCurrency` | Top-level currency on JSON-LD object. |
| `jsonld_salary_currency` | VARCHAR(3) | `JobPosting.baseSalary.currency` | baseSalary block currency. |
| `jsonld_salary_min` | NUMERIC | `JobPosting.baseSalary.value.minValue` | |
| `jsonld_salary_max` | NUMERIC | `JobPosting.baseSalary.value.maxValue` | |
| `jsonld_salary_period` | VARCHAR(16) | `JobPosting.baseSalary.value.unitText` | Schema.org vocab: `YEAR` / `HOUR` / `MONTH` / `WEEK`. |
| `job_location` | JSONB | `JobPosting.jobLocation` | schema.org `Place` object. |
| `job_location_type` | VARCHAR(32) | `JobPosting.jobLocationType` | E.g. `TELECOMMUTE`. |
| `hiring_organization` | JSONB | `JobPosting.hiringOrganization` | schema.org `Organization`. |
| `industry` | VARCHAR(64) | `JobPosting.industry` | |
| `direct_apply` | BOOLEAN | `JobPosting.directApply` | |
| `job_benefits` | TEXT | `JobPosting.jobBenefits` | Free-text benefits. |

#### `jobDetailsRawData.jobview.header`
| Column | Type | Source | Notes |
|---|---|---|---|
| `header_goc` | VARCHAR(64) | `header.goc` | GOC display string. |
| `job_type` | JSONB | `header.jobType` | Display string array. |
| `job_type_keys` | JSONB | `header.jobTypeKeys` | Namespaced array. |
| `remote_work_types` | JSONB | `header.remoteWorkTypes` | E.g. `["WORK_FROM_HOME"]`. |
| `header_expired` | BOOLEAN | `header.expired` | Alt to top-level `expired`. |
| `header_easy_apply` | BOOLEAN | `header.easyApply` | Alt to `is_easy_apply`. |
| `header_apply_url` | TEXT | `header.applyUrl` | Alt apply URL. RSC ref pre-resolution. |
| `header_salary_source` | VARCHAR(32) | `header.salarySource` | Alt salary provenance. |
| `header_salary_currency` | VARCHAR(3) | `header.payCurrency` | Alt to top-level `salary_currency`. |
| `header_salary_period` | VARCHAR(16) | `header.payPeriod` | Alt to top-level `salary_period`. |
| `header_employer` | JSONB | `header.employer` | Alt employer ref `{name, id}`. |

#### `jobDetailsRawData.jobview.map`
| Column | Type | Source | Notes |
|---|---|---|---|
| `map_address` | TEXT | `map.address` | Street address. Sparse. |
| `map_city_name` | VARCHAR(128) | `map.cityName` | Structured city. |
| `map_country` | VARCHAR(64) | `map.country` | E.g. `"Canada"` or `"CA"`. |
| `map_state_name` | VARCHAR(64) | `map.stateName` | Full province/state name. |
| `map_location_name` | TEXT | `map.locationName` | Display city. |
| `map_postal_code` | VARCHAR(16) | `map.postalCode` | |
| `map_employer` | JSONB | `map.employer` | Alt employer ref. |

#### `jobDetailsRawData.jobview.job`
| Column | Type | Source | Notes |
|---|---|---|---|
| `discover_date` | TIMESTAMPTZ | `jobview.job.discoverDate` | Glassdoor crawl-ingest timestamp. Source value has no offset (e.g. `"2025-10-30T00:00:00"`); ingest parses as UTC. |
| `job_title_text` | TEXT | `jobview.job.jobTitleText` | Alt title. |
| `jobview_job_description` | TEXT | `jobview.job.description` | Alt JD body (HTML). |

### 7.2 `glassdoor_jobs` field count

5 common + 3 identity + 2 title + 2 lifecycle + 3 apply + 4 salary + 2
location + 2 employer + 3 skills/edu + 1 description + 2 reviews + 19
JSON-LD + 11 header + 7 map + 3 jobview.job = **69 columns**.


## 8. SQL — `CREATE TABLE` statements (dev/test)

These statements correspond to dev/test mode (CC-4 option (b)). The
production migration that drops `source_raw` is shown separately in §9.

### 8.1 `linkedin_jobs`

```sql
CREATE TABLE linkedin_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Identity
    job_posting_id                  VARCHAR(32),
    job_posting_url                 TEXT,

    -- Timing & lifecycle (epoch ms — parsing deferred)
    listed_at                       BIGINT,
    original_listed_at              BIGINT,
    job_state                       VARCHAR(32),
    job_application_limit_reached   BOOLEAN,
    expire_at                       BIGINT,
    closed_at                       BIGINT,

    -- Location
    formatted_location              TEXT,
    country_urn                     VARCHAR(64),
    location_urn                    VARCHAR(64),
    location_visibility             VARCHAR(32),
    postal_address                  JSONB,
    standardized_addresses          JSONB,
    job_region                      TEXT,

    -- Work mode
    work_remote_allowed             BOOLEAN,
    workplace_types_urns            JSONB,
    workplace_types_labels          JSONB,

    -- Employment & taxonomy
    formatted_employment_status     VARCHAR(32),
    employment_status_urn           VARCHAR(64),
    formatted_industries            JSONB,
    formatted_job_functions         JSONB,
    title                           TEXT,
    standardized_title              TEXT,
    formatted_experience_level      VARCHAR(32),
    skills_description              TEXT,

    -- Apply
    apply_method_type               VARCHAR(64),
    company_apply_url               TEXT,
    applicant_tracking_system       VARCHAR(64),
    top_level_company_apply_url     TEXT,

    -- Salary
    salary_min                      NUMERIC,
    salary_max                      NUMERIC,
    salary_currency                 VARCHAR(3),
    salary_period                   VARCHAR(16),
    salary_provided_by_employer     BOOLEAN,

    -- Description
    description_text                TEXT,

    -- Benefits
    inferred_benefits               JSONB,
    benefits                        JSONB,

    -- Company (resolved from included[])
    company_name                    TEXT,
    company_universal_name          VARCHAR(128),
    company_url                     TEXT,
    company_description             TEXT,

    -- Title / status / workplace URN companions (resolved from included[])
    title_entity_urn                VARCHAR(64),
    employment_status_label         VARCHAR(32),
    employment_status_entity_urn    VARCHAR(64),
    workplace_type_entity_urn       VARCHAR(64)
);
```

### 8.2 `indeed_jobs`

```sql
CREATE TABLE indeed_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Surface presence (derived at ingest)
    mosaic_present                  BOOLEAN NOT NULL DEFAULT FALSE,
    graphql_present                 BOOLEAN NOT NULL DEFAULT FALSE,

    -- Identity & URLs (mosaic)
    jobkey                          VARCHAR(32),
    link                            TEXT,
    view_job_link                   TEXT,
    more_loc_url                    TEXT,
    third_party_apply_url           TEXT,

    -- Timing (mosaic, epoch ms)
    pub_date                        BIGINT,
    create_date                     BIGINT,
    expiration_date                 BIGINT,
    expired                         BOOLEAN,

    -- Title & taxonomy (mosaic)
    title                           TEXT,
    display_title                   TEXT,
    norm_title                      TEXT,
    job_types                       JSONB,
    taxonomy_attributes             JSONB,

    -- Location (mosaic)
    formatted_location              TEXT,
    job_location_city               VARCHAR(128),
    job_location_state              VARCHAR(8),
    job_location_postal             VARCHAR(16),
    location_count                  INTEGER,
    additional_location_link        TEXT,
    remote_location                 BOOLEAN,

    -- Salary (mosaic)
    salary_min                      NUMERIC,
    salary_max                      NUMERIC,
    salary_period                   VARCHAR(16),
    salary_currency                 VARCHAR(3),
    salary_text                     TEXT,
    salary_snippet_source           VARCHAR(32),

    -- Employer (mosaic)
    company                         TEXT,

    -- Apply (mosaic)
    indeed_apply_enabled            BOOLEAN,
    indeed_applyable                BOOLEAN,
    apply_count                     INTEGER,
    screener_questions_url          TEXT,

    -- Pre-extracted requirements (mosaic)
    match_negative_taxonomy         JSONB,
    match_mismatching_entities      JSONB,
    num_hires                       INTEGER,

    -- Identity & URLs (graphql)
    employer_canonical_url          TEXT,

    -- Timing (graphql, alts)
    graphql_date_published          DATE,
    graphql_date_on_indeed          DATE,
    graphql_expired                 BOOLEAN,

    -- Title & taxonomy (graphql, alts)
    graphql_title                   TEXT,
    graphql_normalized_title        TEXT,
    attributes                      JSONB,

    -- Location (graphql, alts)
    location_formatted_long         TEXT,
    graphql_location_city           VARCHAR(128),
    graphql_location_postal_code    VARCHAR(16),
    graphql_location_street_address TEXT,
    graphql_location_admin1_code    VARCHAR(8),
    graphql_location_country_code   VARCHAR(2),

    -- Description (graphql)
    description_text                TEXT,
    language                        VARCHAR(8),

    -- Employer (graphql)
    employer_name                   TEXT,
    employer_company_page_url       TEXT,

    -- Source / provenance (graphql)
    source_name                     VARCHAR(64),

    -- Salary (graphql, alt)
    graphql_salary_period           VARCHAR(16),

    CONSTRAINT indeed_jobs_surface_present
        CHECK (mosaic_present OR graphql_present)
);
```

### 8.3 `glassdoor_jobs`

```sql
CREATE TABLE glassdoor_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Identity & taxonomy IDs (jobDetailsData)
    listing_id                      VARCHAR(32),
    goc_id                          INTEGER,
    job_country_id                  INTEGER,

    -- Title (jobDetailsData)
    job_title                       TEXT,
    normalized_job_title            TEXT,

    -- Lifecycle (jobDetailsData)
    expired                         BOOLEAN,
    employer_active_status          VARCHAR(16),

    -- Apply (jobDetailsData)
    is_easy_apply                   BOOLEAN,
    job_link                        TEXT,
    seo_job_link                    TEXT,

    -- Salary (jobDetailsData)
    salary_currency                 VARCHAR(3),
    salary_period                   VARCHAR(16),
    salary_source                   VARCHAR(32),
    pay_period_adjusted_pay         JSONB,

    -- Location (jobDetailsData)
    location_name                   TEXT,
    location                        JSONB,

    -- Employer (jobDetailsData)
    employer_name                   TEXT,
    employer_overview               TEXT,

    -- Pre-extracted skills/education (jobDetailsData)
    indeed_job_attribute            JSONB,
    skills_labels                   JSONB,
    education_labels                JSONB,

    -- Description (jobDetailsData)
    job_description_plain           TEXT,

    -- Reviews & benefits (jobDetailsData)
    employer_benefits_overview      TEXT,
    employer_benefits_reviews       JSONB,

    -- JSON-LD JobPosting
    title                           TEXT,
    date_posted                     DATE,
    valid_through                   DATE,
    description                     TEXT,
    experience_requirements_description TEXT,
    experience_requirements_months  INTEGER,
    education_requirements_credential VARCHAR(64),
    employment_type                 JSONB,
    jsonld_salary_currency_top      VARCHAR(3),
    jsonld_salary_currency          VARCHAR(3),
    jsonld_salary_min               NUMERIC,
    jsonld_salary_max               NUMERIC,
    jsonld_salary_period            VARCHAR(16),
    job_location                    JSONB,
    job_location_type               VARCHAR(32),
    hiring_organization             JSONB,
    industry                        VARCHAR(64),
    direct_apply                    BOOLEAN,
    job_benefits                    TEXT,

    -- jobDetailsRawData.jobview.header
    header_goc                      VARCHAR(64),
    job_type                        JSONB,
    job_type_keys                   JSONB,
    remote_work_types               JSONB,
    header_expired                  BOOLEAN,
    header_easy_apply               BOOLEAN,
    header_apply_url                TEXT,
    header_salary_source            VARCHAR(32),
    header_salary_currency          VARCHAR(3),
    header_salary_period            VARCHAR(16),
    header_employer                 JSONB,

    -- jobDetailsRawData.jobview.map
    map_address                     TEXT,
    map_city_name                   VARCHAR(128),
    map_country                     VARCHAR(64),
    map_state_name                  VARCHAR(64),
    map_location_name               TEXT,
    map_postal_code                 VARCHAR(16),
    map_employer                    JSONB,

    -- jobDetailsRawData.jobview.job
    discover_date                   TIMESTAMPTZ,
    job_title_text                  TEXT,
    jobview_job_description         TEXT
);
```

### 8.4 Indexes

Per CC-12, only the minimum:

- **PK index** — automatic on `id`.
- **UNIQUE index on `job_url`** — automatic from the constraint.
- **FK index on `scan_run_id`** — Postgres does NOT auto-create FK indexes;
  add explicitly:

```sql
CREATE INDEX ix_linkedin_jobs_scan_run_id  ON linkedin_jobs (scan_run_id);
CREATE INDEX ix_indeed_jobs_scan_run_id    ON indeed_jobs   (scan_run_id);
CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id);
```

That is the complete index set for dev/test. Reactive additions are
expected once dedup and matching land — those will be tracked separately.


## 9. Production migration (drop `source_raw`)

When the per-source extraction pipeline is validated and stable, a follow-up
migration drops `source_raw`. Single-statement per table:

```sql
ALTER TABLE linkedin_jobs  DROP COLUMN source_raw;
ALTER TABLE indeed_jobs    DROP COLUMN source_raw;
ALTER TABLE glassdoor_jobs DROP COLUMN source_raw;
```

Storage delta at 30K rows: ~450 MB (per the size analysis from the prior
discussion). The migration is not done in the initial cut — `source_raw`
stays through dev/test and the merged-table design phase.


## 10. Ingest contract changes

**Wire format unchanged; payload contents expanded.** The extension
continues to POST to `/jobs/ingest` (no new endpoint, no auth changes,
no extension-side routing logic). The payload **shape** must be expanded
by the content scripts to include the per-site raw response objects
(see §11) before the new tables can be populated correctly. The backend
ingest router gains per-site routing and per-table writers as described
below.

### 10.1 Ingest payload schema

Extend the existing `ScrapedJobIngest` Pydantic class with one new field:

```python
class ScrapedJobIngest(BaseModel):
    website: str
    job_url: str | None = None
    skip_reason: str | None = None
    scan_run_id: UUID | None = None
    source_raw: dict | None = None   # NEW — site-specific raw response
    # Legacy unified fields (still sent by current content scripts;
    # no longer required, retained for backward compatibility through the
    # transition):
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    job_description: str | None = None
    apply_url: str | None = None
    easy_apply: bool = False
    post_datetime: datetime | None = None
    search_filters: dict | None = None
    voyager_raw: dict | None = None  # legacy; superseded by source_raw
    original_job_id: UUID | None = None
```

**Why a single permissive class instead of a discriminated union.** A
strict Pydantic discriminated union (one subclass per site) would give
better OpenAPI docs and per-site validation, but breaks two things:
- Skip-row ingest (`body.skip_reason` is set, `body.website` may be any
  of the three) doesn't fit any per-site variant cleanly.
- The source-side response shapes (Voyager, mosaic, GraphQL, jobview)
  are not under our control and drift across LinkedIn/Indeed/Glassdoor
  releases. Static Pydantic schemas would need updates every time those
  sites add a field. Treating `source_raw` as `dict | None` keeps us
  flexible.

The route handler discriminates on `body.website` and reads per-site
sub-blocks from `source_raw` (e.g. `body.source_raw["mosaic"]` for
Indeed). The field name `source_raw` matches the DB column name on all
three per-source tables, so the request value is stored verbatim in
the column with no rename.

**`voyager_raw` coexistence.** This PR does not modify the existing
`voyager_raw` field on `ScrapedJobIngest` or the `voyager_raw` column on
`scraped_jobs`. Both remain in place, populated by the legacy ingest
path. The new ingest path uses the new `source_raw` field and writes to
the per-source tables' `source_raw` column. Both fields coexist on the
schema during the transition. The eventual rename/cleanup of
`voyager_raw` (in `scraped_jobs` and on the schema) is out of scope for
this PR and deferred to the larger `scraped_jobs` deprecation work that
lands with the merged-table design.

### 10.2 Routing and per-source extraction

The route handler does the following in order:

1. **Skip-row precedence.** If `body.skip_reason` is set, the row is
   written to the legacy `scraped_jobs` table by the existing code
   path and the per-source routing below is skipped entirely. This
   preserves the current skip-row semantics during the transition.

2. **Transition fallback for non-skip rows missing `source_raw`.** If
   `body.skip_reason` is not set but `body.source_raw is None`
   (extension hasn't been updated yet to send raw responses), the row
   is written to the legacy `scraped_jobs` table by the existing
   non-skip code path. **No per-source table receives a row in this
   case.** This eliminates CHECK constraint violations on `indeed_jobs`
   (where `mosaic_present OR graphql_present` would be false with no
   `source_raw`) and keeps the per-source archive clean during the
   rollout window.

   The route handler logs each occurrence so the cleanup criterion is
   observable:
   ```python
   if body.source_raw is None and not body.skip_reason:
       logger.info("ingest_transition_fallback %s", {"website": body.website})
       # ... fall through to legacy scraped_jobs write path
   ```
   This follows the existing `logger.info("ingest_ok %s", ...)`
   precedent in `routers/jobs.py` — log entries are structured JSON
   queryable via the project's existing log aggregation.

   **Cleanup criterion.** After 30 consecutive days of zero
   `ingest_transition_fallback` log entries, the legacy non-skip
   branch is unreachable code and can be deleted in a follow-up
   cleanup. Skip-row branch (step 1) stays — that is a permanent
   ingest path, not a transition path.

   **Strict `{}` vs `None` boundary.** `body.source_raw is None`
   triggers this fallback (extension hasn't updated yet — expected
   state during rollout). An empty dict `body.source_raw == {}` does
   NOT trigger fallback — it indicates the extension *thought* it
   sent data but didn't (likely a content-script bug). Empty-dict
   payloads proceed to step 3 routing where Indeed's per-site checks
   return 400 with structured detail. This boundary preserves the
   signal: the telemetry log only fires for genuine "not yet updated"
   cases, not for malformed payloads.

3. **Per-site routing for non-skip rows with `source_raw`.** Branch on
   `body.website`:
   - `linkedin` → write to `linkedin_jobs`
   - `indeed` → write to `indeed_jobs`
   - `glassdoor` → write to `glassdoor_jobs`

   **`scan_run_id` required.** The per-source tables have
   `scan_run_id UUID NOT NULL REFERENCES extension_run_logs(id)`; an
   ingest with `body.scan_run_id is None` would fail at the FK with a
   500. Guard explicitly:
   ```python
   if body.scan_run_id is None:
       raise HTTPException(
           status_code=400,
           detail="scan_run_id required for per-source ingest",
       )
   ```
   This guard runs after step 2's transition fallback and skip-row
   precedence, so it only affects the new per-source path. The legacy
   skip-row path still accepts `scan_run_id=None` (current behavior).

4. **Per-source field extraction.** The route handler maps the incoming
   payload to the per-source columns described in §5–§7, with these
   per-site rules.

   **Source-path → Python-access translation.** §5–§7 column tables
   show source paths in master-doc notation (e.g. `jobview.job.discoverDate`
   or `JobPosting.title`). Translating these to access from `body.source_raw`:

   - **LinkedIn:** `data.X` → `source_raw["data"]["X"]`;
     `included[].Company.X` requires URN-resolution code (per §11
     LinkedIn follow-up). See the `_resolve_linkedin_included()`
     helper below.
   - **Indeed:** `mosaic.X` → `source_raw["mosaic"]["X"]`;
     `graphql.job.X` → `source_raw["graphql"]["X"]` (since per §3 the
     `graphql` value is pre-navigated to the per-card `job` object,
     not the wrapped GraphQL response). The `.job.` prefix in §6.1's
     source-path notation is a master-doc artifact and is **dropped**
     in `source_raw` access. Example: `graphql.job.title` is read as
     `source_raw["graphql"]["title"]`, not
     `source_raw["graphql"]["job"]["title"]`.
   - **Glassdoor:**
     - `jobDetailsData.X` → `source_raw["jobListing"]["jobDetailsData"]["X"]`
     - `jobview.X.Y` → `source_raw["jobListing"]["jobDetailsRawData"]["jobview"]["X"]["Y"]`
       (header / map / job sub-trees)
     - `JobPosting.X` → `source_raw["json_ld"]["X"]` (JSON-LD lives in
       the separate top-level `json_ld` key, not under `jobListing`)

   Throughout extraction, use defensive `.get(key, {})` chains; never
   bare `[key]` indexing. Missing keys produce NULL columns, never
   AttributeError. A worked example is shown below for `discover_date`.

   **Robustness wrapper.** Wrap the entire per-site extraction block
   in `try/except (AttributeError, TypeError)`. Pydantic validates
   that `body.source_raw` is `dict | None` but does not validate the
   *contents* of the dict — a malformed payload like
   `{"jobListing": "string"}` would raise `AttributeError: 'str' object
   has no attribute 'get'` mid-extraction. The wrapper converts these
   into clean HTTP 400 responses with sanitized messages (the original
   exception goes to server logs only):
   ```python
   try:
       # All per-site extraction code: job_url construction, presence
       # flags, column population, helper calls (e.g.
       # _parse_glassdoor_discover_date).
       ...
   except (AttributeError, TypeError) as e:
       logger.warning(
           "ingest_malformed_source_raw %s",
           {"website": body.website, "error": str(e)},
       )
       raise HTTPException(
           status_code=400,
           detail=f"Malformed source_raw for website={body.website}",
       )
   ```

   The per-site rules below assume this wrapper is in place.

   - **Glassdoor `job_url` construction.** The route handler **always**
     constructs `job_url` synthetically from `listing_id`. Because
     `source_raw` is a permissive dict (per CC-4 / B4), every nested
     access uses `.get()` chains and the missing-data case raises
     HTTP 400 instead of crashing the handler. Note `listingId` lives
     under the `jobListing` sub-key of Glassdoor's two-key
     `source_raw` wrapper (per §3):
     ```python
     job_listing = (body.source_raw or {}).get("jobListing") or {}
     listing_id = job_listing.get("jobDetailsData", {}).get("listingId")
     if not listing_id:
         raise HTTPException(
             status_code=400,
             detail="Glassdoor ingest missing listing_id",
         )
     job_url = (
         f"https://www.glassdoor.ca/job-listing/listing-{listing_id}.htm"
         f"?jl={listing_id}"
     )
     ```
     The route handler **never** reads `seoJobLink` to populate
     `job_url`, even when present. This guarantees deterministic
     URL-per-listing (no duplicate rows from URL variation across
     re-scrapes) and never-NULL behavior when `listing_id` is captured.
     The `seoJobLink` value (when present) is stored in the separate
     `seo_job_link` column for display purposes.

   - **Indeed presence flags.** The route handler sets `mosaic_present`
     and `graphql_present` based on which top-level blocks are present
     in `body.source_raw`:
     ```python
     mosaic_present = bool(body.source_raw and body.source_raw.get("mosaic"))
     graphql_present = bool(body.source_raw and body.source_raw.get("graphql"))
     if not (mosaic_present or graphql_present):
         raise HTTPException(
             status_code=400,
             detail="Indeed ingest has source_raw but both mosaic and graphql blocks are null/missing",
         )
     ```
     Note: this code path is reached only when `body.source_raw` is
     present-but-empty or has both blocks null (per the v5-2B boundary
     in step 2). The `body.source_raw is None` case never arrives here —
     it was caught by the transition fallback in step 2. The CHECK
     constraint (`mosaic_present OR graphql_present`) is a
     belt-and-suspenders defense; the route handler's 400 should
     normally be the user-facing error.

   - **Glassdoor `discover_date` parsing.** Source value
     (e.g. `"2025-10-30T00:00:00"`, no offset) is parsed strictly as
     UTC at ingest, with a try/except wrapper that falls to NULL on
     failure and logs a warning so any future format drift becomes
     observable. **Implementer note:** place this helper as a private
     module-level function in `routers/jobs.py`, alongside the
     existing `_hash_description` helper. Note the existing file
     imports `timezone as dt_timezone` (to avoid name collisions);
     the helper uses that alias:
     ```python
     def _parse_glassdoor_discover_date(raw: str | None) -> datetime | None:
         if not raw:
             return None
         try:
             d = datetime.fromisoformat(raw)
             return (
                 d.replace(tzinfo=dt_timezone.utc)
                 if d.tzinfo is None
                 else d.astimezone(dt_timezone.utc)
             )
         except (ValueError, TypeError) as e:
             logger.warning(
                 "ingest_discover_date_parse_failed %s",
                 {"raw": raw, "error": str(e)},
             )
             return None
     ```

     **Call site (worked example of the access-rule above).** Per the
     `jobview.X.Y → source_raw["jobListing"]["jobDetailsRawData"]["jobview"]["X"]["Y"]`
     translation, `discover_date`'s source path
     `jobview.job.discoverDate` resolves to:
     ```python
     job_listing = (body.source_raw or {}).get("jobListing") or {}
     discover_date_raw = (
         job_listing.get("jobDetailsRawData", {})
                    .get("jobview", {})
                    .get("job", {})
                    .get("discoverDate")
     )
     discover_date = _parse_glassdoor_discover_date(discover_date_raw)
     ```
     Apply the same `.get(key, {})` chain pattern to every Glassdoor
     column extraction. The same pattern (with shorter chains) applies
     to LinkedIn (`source_raw["data"]`) and Indeed
     (`source_raw["mosaic"]` / `source_raw["graphql"]`).

   - **LinkedIn `included[]` URN resolution.** Voyager's normalized
     response has `data` (the JobPosting) plus `included[]` (related
     entities: Company, Title, EmploymentStatus, WorkplaceType). Each
     entity has a `$type` and `entityUrn`. Some `data` fields hold URN
     references that must be looked up in `included[]`. **Implementer
     note:** place this helper alongside `_parse_glassdoor_discover_date`
     in `routers/jobs.py`:
     ```python
     def _resolve_linkedin_included(
         included: list | None,
         entity_urn: str | None,
     ) -> dict | None:
         """Find the entity in included[] whose entityUrn matches.
         Returns None if not found or if either input is missing.
         """
         if not included or not entity_urn:
             return None
         if not isinstance(included, list):
             return None
         for entity in included:
             if not isinstance(entity, dict):
                 continue
             if entity.get("entityUrn") == entity_urn:
                 return entity
         return None
     ```
     **Call site examples for all four entity types.** Each entity
     type has a different way to find its URN in `data`:

     ```python
     data = (body.source_raw or {}).get("data") or {}
     included = (body.source_raw or {}).get("included")

     # 1. Title — URN is a direct string in data.standardizedTitle
     title_entity = _resolve_linkedin_included(included, data.get("standardizedTitle"))
     standardized_title = (title_entity or {}).get("localizedName")
     title_entity_urn = (title_entity or {}).get("entityUrn")

     # 2. Company — URN is NESTED inside data.companyDetails under
     # a Java-class wrapper key. Shape:
     #   data.companyDetails = {
     #     "com.linkedin.voyager.deco.jobs.web.shared.WebJobPostingCompany": {
     #       "company": "urn:li:fs_normalized_company:12345",
     #       ... other fields
     #     }
     #   }
     # The wrapper key varies; iterate values to find the dict with
     # a "company" URN string.
     company_urn = None
     for v in (data.get("companyDetails") or {}).values():
         if isinstance(v, dict) and isinstance(v.get("company"), str):
             company_urn = v["company"]
             break
     company_entity = _resolve_linkedin_included(included, company_urn)
     company_name = (company_entity or {}).get("name")
     company_universal_name = (company_entity or {}).get("universalName")
     company_url = (company_entity or {}).get("url")
     company_description = (company_entity or {}).get("description")

     # 3. EmploymentStatus — URN is a direct string in data.employmentStatus
     emp_entity = _resolve_linkedin_included(included, data.get("employmentStatus"))
     employment_status_label = (emp_entity or {}).get("localizedName")
     employment_status_entity_urn = (emp_entity or {}).get("entityUrn")
     # The URN string itself is also kept directly:
     employment_status_urn = data.get("employmentStatus")

     # 4. WorkplaceType — URNs are an ARRAY in data.workplaceTypes;
     # the corresponding row column captures the first.
     workplace_urns = data.get("workplaceTypes") or []
     first_workplace_urn = workplace_urns[0] if workplace_urns else None
     workplace_entity = _resolve_linkedin_included(included, first_workplace_urn)
     workplace_type_entity_urn = (workplace_entity or {}).get("entityUrn")
     # The full array (URN strings) is kept as-is in workplace_types_urns JSONB.
     ```

     For columns that just need the URN string (e.g. `country_urn` from
     `data.country`, `location_urn` from `data.locationUrn`), no
     resolution required — read the value directly.

### 10.3 Conflict handling — single-statement CTE

The naive `INSERT ... ON CONFLICT DO NOTHING RETURNING id` pattern
returns **zero rows on conflict**, which forces either a separate
SELECT round-trip or a silent `id: null` bug. The required pattern is
a data-modifying CTE with a fallback SELECT, expressed in SQLAlchemy
`text()` form using `:name` placeholders. Note that `:job_url` appears
twice in the same statement — once in the INSERT VALUES and once in
the fallback SELECT WHERE clause — which SQLAlchemy substitutes
correctly with a single bound value.

**JSONB binding requirement.** Each per-source table has many JSONB
columns (LinkedIn: `source_raw`, `postal_address`,
`standardized_addresses`, `workplace_types_urns`,
`workplace_types_labels`, `formatted_industries`,
`formatted_job_functions`, `inferred_benefits`, `benefits` —
9 columns; Indeed: `source_raw`, `job_types`, `taxonomy_attributes`,
`match_negative_taxonomy`, `match_mismatching_entities`, `attributes`
— 6 columns; Glassdoor: 15 JSONB columns including `source_raw`,
`pay_period_adjusted_pay`, `location`, `indeed_job_attribute`,
`skills_labels`, `education_labels`, `employer_benefits_reviews`,
`employment_type`, `job_location`, `hiring_organization`, `job_type`,
`job_type_keys`, `remote_work_types`, `header_employer`,
`map_employer`).

When binding Python `dict` values to these via SQLAlchemy `text()`,
**every JSONB column needs an explicit `bindparam(..., type_=JSONB)`
declaration** attached to the prepared `text()`. Without this,
SQLAlchemy stringifies the dict via `str(dict)` (Python repr — single
quotes, etc.) and PostgreSQL rejects the INSERT with
`invalid input syntax for type json`.

```python
from sqlalchemy import text, bindparam
from sqlalchemy.dialects.postgresql import JSONB

# Define column list once per table — single source of truth for
# the INSERT column order. Order must match the params dict keys.
LINKEDIN_COLS = [
    "job_url", "scan_run_id", "source_raw",  # JSONB
    "job_posting_id", "job_posting_url",
    "listed_at", "original_listed_at", "job_state",
    "job_application_limit_reached", "expire_at", "closed_at",
    "formatted_location", "country_urn", "location_urn",
    "location_visibility",
    "postal_address",          # JSONB
    "standardized_addresses",  # JSONB
    "job_region",
    "work_remote_allowed",
    "workplace_types_urns",    # JSONB
    "workplace_types_labels",  # JSONB
    "formatted_employment_status", "employment_status_urn",
    "formatted_industries",    # JSONB
    "formatted_job_functions", # JSONB
    "title", "standardized_title", "formatted_experience_level",
    "skills_description",
    "apply_method_type", "company_apply_url",
    "applicant_tracking_system", "top_level_company_apply_url",
    "salary_min", "salary_max", "salary_currency", "salary_period",
    "salary_provided_by_employer",
    "description_text",
    "inferred_benefits",       # JSONB
    "benefits",                # JSONB
    "company_name", "company_universal_name", "company_url",
    "company_description",
    "title_entity_urn", "employment_status_label",
    "employment_status_entity_urn", "workplace_type_entity_urn",
]

# JSONB columns need explicit bindparam declarations so SQLAlchemy
# serializes Python dicts as JSON instead of str(dict) Python repr.
LINKEDIN_JSONB_COLS = [
    "source_raw", "postal_address", "standardized_addresses",
    "workplace_types_urns", "workplace_types_labels",
    "formatted_industries", "formatted_job_functions",
    "inferred_benefits", "benefits",
]

# Build SQL fragments programmatically — eliminates 51 hand-typed
# column names AND 51 hand-typed `:name` placeholders, eliminates
# typos, and makes future schema changes trivial (update one list).
_cols_sql = ", ".join(LINKEDIN_COLS)
_vals_sql = ", ".join(f":{c}" for c in LINKEDIN_COLS)

INSERT_LINKEDIN_JOB = text(f"""
    WITH inserted AS (
        INSERT INTO linkedin_jobs ({_cols_sql})
        VALUES ({_vals_sql})
        ON CONFLICT (job_url) DO NOTHING
        RETURNING id
    )
    SELECT id, false AS already_exists FROM inserted
    UNION ALL
    SELECT id, true AS already_exists FROM linkedin_jobs
     WHERE job_url = :job_url AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
""").bindparams(
    *(bindparam(c, type_=JSONB) for c in LINKEDIN_JSONB_COLS),
)
```

The same pattern applies to `INSERT_INDEED_JOB` (61-column list,
6 JSONB bindparams) and `INSERT_GLASSDOOR_JOB` (69-column list,
15 JSONB bindparams). The full INDEED_COLS / GLASSDOOR_COLS lists
are mechanical transcriptions of §8.2 and §8.3 column declarations
in declared order. The JSONB subsets — which carry the real
correctness risk if a column is missed — are spelled out below.

```python
# 6 JSONB columns on indeed_jobs (verify against §8.2 by grep'ing JSONB)
INDEED_JSONB_COLS = [
    "source_raw",
    "job_types",
    "taxonomy_attributes",
    "match_negative_taxonomy",
    "match_mismatching_entities",
    "attributes",
]

# 15 JSONB columns on glassdoor_jobs (verify against §8.3 by grep'ing JSONB)
GLASSDOOR_JSONB_COLS = [
    "source_raw",
    "pay_period_adjusted_pay",
    "location",
    "indeed_job_attribute",
    "skills_labels",
    "education_labels",
    "employer_benefits_reviews",
    "employment_type",
    "job_location",
    "hiring_organization",
    "job_type",
    "job_type_keys",
    "remote_work_types",
    "header_employer",
    "map_employer",
]
```

When constructing `INDEED_COLS` and `GLASSDOOR_COLS`, mark the JSONB
columns inline with `# JSONB` comments (mirroring `LINKEDIN_COLS`'s
treatment) so the visual cross-check against the JSONB lists is
immediate.

**Three prepared statements, three params builders.** The route
handler dispatches on `body.website` to one of three module-level
prepared statements (`INSERT_LINKEDIN_JOB`, `INSERT_INDEED_JOB`,
`INSERT_GLASSDOOR_JOB`) with three corresponding parameter builders
(`build_linkedin_params(body)`, `build_indeed_params(body)`,
`build_glassdoor_params(body)`). Each builder returns a dict mapping
`{":name": value, ...}`. Pass a single params dict to
`db.execute(stmt, params)`; SQLAlchemy binds the same value to all
occurrences of `:job_url` (which appears twice in SQL — VALUES and
the fallback WHERE — but only once in the params dict).

**Builder fragment example.** A skeleton of `build_linkedin_params`
covering the diverse cases — scalar reads, JSONB pass-through, and
URN-resolved fields. The bulk of the builder is repetitive scalar
reads that follow §5 column source paths; the interesting cases are
shown here:
```python
def build_linkedin_params(body: ScrapedJobIngest) -> dict:
    data = (body.source_raw or {}).get("data") or {}
    included = (body.source_raw or {}).get("included")

    # URN-resolved fields (see §10.2 for the full helper call sites
    # for all four entity types):
    title_entity = _resolve_linkedin_included(included, data.get("standardizedTitle"))
    emp_entity = _resolve_linkedin_included(included, data.get("employmentStatus"))
    company_urn = None
    for v in (data.get("companyDetails") or {}).values():
        if isinstance(v, dict) and isinstance(v.get("company"), str):
            company_urn = v["company"]; break
    company_entity = _resolve_linkedin_included(included, company_urn)

    return {
        # Common
        "job_url": data.get("jobPostingUrl"),
        "scan_run_id": body.scan_run_id,
        "source_raw": body.source_raw,                 # JSONB pass-through
        # Scalar reads (representative; full set follows §5 paths)
        "job_posting_id": data.get("jobPostingId"),
        "job_posting_url": data.get("jobPostingUrl"),
        "listed_at": data.get("listedAt"),
        "title": data.get("title"),
        "description_text": (data.get("description") or {}).get("text"),
        # JSONB pass-through (the bindparam declares JSONB type;
        # SQLAlchemy serializes the dict/list correctly)
        "postal_address": data.get("postalAddress"),
        "workplace_types_urns": data.get("workplaceTypes"),
        "inferred_benefits": data.get("inferredBenefits"),
        # URN-resolved
        "standardized_title": (title_entity or {}).get("localizedName"),
        "title_entity_urn": (title_entity or {}).get("entityUrn"),
        "employment_status_label": (emp_entity or {}).get("localizedName"),
        "employment_status_urn": data.get("employmentStatus"),
        "company_name": (company_entity or {}).get("name"),
        "company_universal_name": (company_entity or {}).get("universalName"),
        # ... rest of LINKEDIN_COLS (see §5 for paths)
    }
```
The Indeed and Glassdoor builders follow the same pattern with
appropriate `.get()` chains per §10.2's translation rule.


Properties:
- **Single statement, single round-trip.** Insert and conflict-lookup
  in one query.
- **Always returns exactly one row.** Insert succeeded → `inserted`
  branch with `already_exists = false`. Conflict → fallback branch
  with `already_exists = true`. Consume with `result.one()` — this
  raises if zero or 2+ rows come back, which is the right behavior
  given the CTE's guarantee. Do not use `.first()` (silently accepts
  zero rows on a bug) or `.scalar()` (returns only `id`, drops
  `already_exists`).
- **No write on conflict.** The append-only invariant (CC-1) is
  preserved. The tempting wrong fix `ON CONFLICT DO UPDATE SET id =
  id` would issue a write on every re-scrape — do not use it.
- **Same pattern for all three tables.** Substitute the table name
  and column list per site. The two `:job_url` references must remain
  in both clauses; SQLAlchemy binds the same value to both.

Data-modifying CTEs in PostgreSQL execute exactly once and their side
effects are visible to the outer query, so the `NOT EXISTS (SELECT 1
FROM inserted)` predicate correctly distinguishes "insert succeeded"
from "conflict occurred."

**Concurrency assumption.** This pattern assumes sequential ingest of
any given `job_url`. The auto-scrape `cycle_phase` guard makes
parallel ingest within auto-scrape impossible, and manual scans
triggered while auto-scrape is running are blocked by the same guard
in `trigger_scan`. The legacy `scraped_jobs` ingest path writes to a
different table and cannot race against these per-source tables.
Under this architecture the race window does not occur. If parallelism
is ever introduced, the right fix is application-level retry on
unique-violation rather than a no-op `ON CONFLICT DO UPDATE` (which
would silently retire CC-1's append-only invariant).

### 10.4 Backend response shape

The route handler maps the CTE result to the existing extension-facing
response. Concretely:
```python
result = await db.execute(stmt, params)
row = result.one()
return ScrapedJobIngestResponse(
    id=row.id,
    already_exists=row.already_exists,
    content_duplicate=False,    # always False on per-source path
    skip_reason=None,           # always None on per-source path
)
```
`content_duplicate` is always `false` for the per-source tables
(content-hash dedup is a Stage 2 / merged-table concern, not an
ingest-time check). The field is preserved for backward compatibility
with the extension's response classifier in `process.js`; the
"existing" branch in that classifier catches all duplicate cases via
the `already_exists` flag. `skip_reason` is always None on this path
because skip rows are filtered out in step 1 of §10.2.

### 10.5 Run-log ordering invariant

`scan_run_id UUID NOT NULL REFERENCES extension_run_logs(id)
ON DELETE RESTRICT` means an ingest before the run-log row commits
will fail with FK violation. The current backend pattern is:

- Extension calls `POST /extension/run-log/start` → backend INSERTs
  run-log → returns `{id}` to extension.
- Extension content scripts then call `POST /jobs/ingest` with that
  `runId`.

FastAPI's session-per-request pattern commits when the response is
sent, so as long as the HTTP response from `/run-log/start` reaches
the extension before the next `/jobs/ingest` POST, the FK is satisfied.
In practice this is always the case — the extension cannot send
`INGEST_JOB` until it has a `runId` from the response body.

This invariant should be documented in code: a careless future change
to the run-log handler (returning `runId` before COMMIT for "perf")
would silently break ingest. Implementations should ensure
`/run-log/start` returns only after the run-log row is durable.

### 10.6 Skip rows

For `body.skip_reason` (no_id / jd_failed cases) — out of scope for
this design. Skip rows do not belong on the per-source archive tables.
A separate `scrape_skips` table will be designed when the extension's
skip semantics are revisited; for now, skip rows continue to land in
the legacy `scraped_jobs` table via the existing code path (see §10.2
item 1 — skip-row precedence).

### 10.7 ON DELETE RESTRICT pre-implementation check

Before applying the migration, verify that no existing code path
issues `DELETE` on `extension_run_logs` rows. Run on the backend:

```bash
docker compose exec backend grep -rn \
    "DELETE FROM extension_run_logs\|extension_run_logs.*\.delete\|delete(ExtensionRunLog" \
    /app/
```

- **Empty result:** the `ON DELETE RESTRICT` choice ships as-is. The
  invariant ("run-logs are permanent because their scrape children
  are permanent") matches CC-1 append-only.
- **Non-empty result:** revisit the FK choice before applying the
  migration. The likely culprit is the auto-scrape orchestrator's
  `cleanup-orphan-cycles` endpoint; if it deletes `extension_run_logs`,
  it will start failing on any run-log with scrape children.
  Mitigations would be (a) change the cleanup to only delete child-less
  run-logs, (b) use `ON DELETE CASCADE` (different semantics — accept
  that scrape rows die with their parent), or (c) add a separate
  scrape-row cleanup step before run-log deletion. None of these is
  free; pick deliberately.

**`scraped_jobs` table.** Not modified by this design. Continues to
receive ingest writes from the legacy `/jobs/ingest` path (skip-row
branch + transition period) and is the destination for skip rows
during the transition. When the merged-table design lands,
`scraped_jobs` will be deprecated by a separate migration.


## 11. Open scraper-side follow-ups

These are out of scope for the schema design but are required before the
new tables can be populated correctly. Tracked here for reference, not
gated by this design.

- **LinkedIn.** Content script currently sends only ~6 Voyager fields.
  Must send the full `{data, included}` response (see §10.2) plus extract
  `included[]` Company / Title / EmploymentStatus / WorkplaceType entities
  by URN before ingest.
- **Indeed.** GraphQL query currently fetches only `title` and
  `description`. Must expand to all kept GraphQL fields. Mosaic provider
  data on the SERP is currently not parsed — must be captured.
- **Glassdoor.** Content script must produce the two-key
  `source_raw = {jobListing, json_ld}` wrapper described in §3:
  `jobListing` from `__NEXT_DATA__.props.pageProps.jobListing` and
  `json_ld` from the page's `<script type="application/ld+json">`
  block (parsed as JSON). Without both keys, the JSON-LD-sourced
  columns (`jsonld_*` plus `title`, `date_posted`, `description`, etc.
  in §7) all land NULL. The RSC chunk parser must additionally be
  extended to dereference `$XX` pointers for `job_link`,
  `header_apply_url`, and `pay_period_adjusted_pay` (per GD-2 these
  are captured raw for now — `null` or `"$3f"` strings —
  dereferenced values get injected back into `jobListing`).
  `parseGlassdoorCard` extracts `ageText` but `process.js` discards
  it; fix would populate `date_posted` from card data when JSON-LD is
  missing.
- **Indeed `parseIndeedPostDate`.** Regex matches English snippets only;
  French postings (e.g. `"Cinesite-Montreal"` row in current DB) yield
  `post_datetime: null`. The new schema captures `pub_date` (epoch ms)
  directly from `mosaic.pubDate`, bypassing the snippet-parsing approach
  entirely — this is a scraper-side cleanup, not a schema gap.

These items belong on the scraper task list, not the schema task list.
The schema accepts NULL values everywhere they apply.


## 12. Decisions explicitly deferred

- **Update / delete rules.** Append-only is convention-only during dev
  (CC-1). Lifecycle rules (re-scrape policy, delete-after-N-days,
  cleanup-on-cycle-end) are designed in a later step.
- **Index expansion.** Reactive additions when slow queries surface (CC-12).
- **URN parsing into companion columns.** URNs stored as raw strings;
  parsed companions added when downstream needs them (LI-3, GD-2).
- **Cross-table merge step.** The merged table that consumes these three
  is the next design task.
- **Skip-row table.** Skip rows continue to land in `scraped_jobs` until
  a dedicated `scrape_skips` table is designed.
- **`source_raw` removal.** Production migration drops it (§9); no firm
  date. Trigger is "extraction is stable enough that we no longer need
  the safety net for backfill."
- **Glassdoor cross-surface duplicate consolidation.** Glassdoor keeps
  duplicated fields across `jobDetailsData` (unprefixed) / `header_*` /
  `map_*` / `jobview_job_*` / `jsonld_*` per Q3 for surface-reliability
  measurement. Before the production migration that drops `source_raw`,
  evaluate per-field-group which surface populates most reliably across
  real scrape data and consolidate to a single canonical column where
  one source dominates. Storage savings concentrated in description
  columns (3 columns × ~3–8 KB/row × 30K rows ≈ 270–720 MB) but the same
  reasoning applies to currency / period / expiration / employer alts.
  Ingest pipeline already populates all duplicates so no extension
  change is required for either outcome.
- **FK ON DELETE reconsideration.** `scan_run_id` is `ON DELETE
  RESTRICT` on all three tables (§8 SQL). This matches CC-1 append-only
  intent and is correct under current architecture (no code path deletes
  `extension_run_logs`). If a future feature adds run-log deletion, the
  FK choice must be revisited — see §10.7 for the verification gate and
  the decision space.
- **Skip-row migration off `scraped_jobs`.** Skip rows continue to land
  in the legacy `scraped_jobs` table during the transition (§10.6). A
  dedicated `scrape_skips` table is part of the merged-table design
  phase. Until then, the skip-row code path in the ingest router is
  unchanged.


## 13. Summary

| Table | Columns | PK | Unique | FK |
|---|---|---|---|---|
| `linkedin_jobs`  | 51 | `id` UUID | `job_url` | `scan_run_id` (`ON DELETE RESTRICT`) |
| `indeed_jobs`    | 61 | `id` UUID | `job_url` | `scan_run_id` (`ON DELETE RESTRICT`) |
| `glassdoor_jobs` | 69 | `id` UUID | `job_url` | `scan_run_id` (`ON DELETE RESTRICT`) |

All three tables follow the same five-column common section (CC-3, CC-7,
CC-8, plus the dev `source_raw`). All three are append-only by convention
(CC-1) with `gen_random_uuid()` PKs (CC-2). All three use VARCHAR(2048)
for `job_url`, `ON DELETE RESTRICT` on the run-log FK, VARCHAR for site-
stable IDs (CC-9), preserve source vocabulary (CC-10), and route nested
objects to JSONB (CC-11). Indexes are minimal (CC-12) — PK, URL UNIQUE,
and an explicit FK index on `scan_run_id`.

`indeed_jobs` carries two extra surface-presence boolean columns
(`mosaic_present`, `graphql_present`) with a CHECK constraint enforcing
at least one is `TRUE`. Glassdoor's `job_url` is purely synthetic from
`listing_id` regardless of `seoJobLink` presence — see §4 and §10 for
rationale.


## 14. Migration

**Filename:** `backend/alembic/versions/025_per_source_scrape_tables.py`

Naming follows the project convention from `023_auto_scrape_foundations.py`
(describes feature scope, not table list). Single migration covering
all three `CREATE TABLE` statements plus the three explicit FK indexes
on `scan_run_id` (PostgreSQL does not auto-create FK indexes — see
CC-12 and §8.4).

**No data migration.** Per-source tables start empty. Existing
`scraped_jobs` rows are not migrated.

**Upgrade pattern.** Translating §8's full SQL into Alembic
`op.create_table()` calls would be ~180+ column declarations of
mechanical transcription, error-prone and doubling the source of
truth. The pragmatic alternative is to run §8's SQL verbatim via
`op.execute(text(...))`:
```python
from sqlalchemy import text

def upgrade():
    op.execute(text("""<paste §8.1 linkedin_jobs CREATE TABLE>"""))
    op.execute(text("""<paste §8.2 indeed_jobs CREATE TABLE>"""))
    op.execute(text("""<paste §8.3 glassdoor_jobs CREATE TABLE>"""))
    op.execute(text("CREATE INDEX ix_linkedin_jobs_scan_run_id  ON linkedin_jobs (scan_run_id)"))
    op.execute(text("CREATE INDEX ix_indeed_jobs_scan_run_id    ON indeed_jobs   (scan_run_id)"))
    op.execute(text("CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id)"))
```
Both `op.execute(text(...))` and `op.create_table()` are supported
patterns; `op.execute` is significantly simpler here.

**Pre-implementation gate.** Before applying the migration, run the
verification grep from §10.7 to confirm no existing code path issues
`DELETE` on `extension_run_logs`. If empty, ship as designed; if
non-empty, revisit the FK ON DELETE choice before applying.

**Downgrade.** The migration's `downgrade()` drops the three tables
in reverse-creation order:
```python
op.drop_table('glassdoor_jobs')
op.drop_table('indeed_jobs')
op.drop_table('linkedin_jobs')
```
Indexes and constraints attached to the tables are dropped implicitly
by `drop_table`. Since per-source tables are not yet referenced by any
other table at this point in the project's evolution, downgrade is
straightforward — no FK from external tables points into them.

**Sequence.** This is migration 025. Current applied version (per the
`alembic_version` row checked during the design phase) is 024.
