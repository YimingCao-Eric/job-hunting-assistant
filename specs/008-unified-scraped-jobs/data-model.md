# Phase 1 Data Model: Unified `scraped_jobs`

**Feature**: 008-unified-scraped-jobs | **Date**: 2026-07-15

Authoritative mapping: `docs/live-per-source-schemas.md`. Where this file and that one differ,
that one wins — **except** the three departures FR-012 names explicitly (raw payload omitted,
five-value period vocabulary, `dismissed` added), which are settled in the spec and must be
written back into that doc.

---

## Table: `scraped_jobs` (NEW — replaces the legacy table of the same name)

The legacy table is dropped in full (R11). It is not a migration target; nothing is preserved.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | PK. Distinct from `source_row_id`. |
| `source_site` | varchar(16) | NOT NULL | | `linkedin` \| `indeed` \| `glassdoor`. Also identifies the per-source table — **there is no `source_table` column** (FR-004). |
| `source_row_id` | uuid | NOT NULL | | The per-source row's `id`. **Polymorphic — no FK possible** (see below). |
| `site_job_id` | varchar(32) | NULL | | Site-native id: `job_posting_id` / `jobkey` / `listing_id`. |
| `scan_run_id` | uuid | NOT NULL | | FK → `extension_run_logs(id)` ON DELETE RESTRICT. |
| `job_url` | varchar(2048) | NOT NULL | | **UNIQUE**. Identity of a posting (FR-006). |
| `scrape_time` | timestamptz | NOT NULL | `now()` | Always written explicitly from the per-source row — never allowed to default (R2). |
| `matched` | boolean | NOT NULL | `false` | Claim flag. Kept in step with the per-source row (FR-028). |
| `dismissed` | boolean | NOT NULL | `false` | User decision. **Extends the mapping doc** (FR-023). |
| `title` | text | NULL | | |
| `company` | text | NULL | | Indeed: mosaic `company`, else graphql `employer_name` (FR-013). |
| `location_text` | text | NULL | | |
| `description` | text | NULL | | |
| `remote` | boolean | NULL | | Tri-state: true / false / **unknown (NULL)**. Glassdoor: derived (FR-014). |
| `apply_url` | text | NULL | | |
| `experience_level` | text | NULL | | Not aligned across sites; best-available. Indeed → always NULL. |
| `industry` | text | NULL | | LinkedIn: flatten jsonb → first. Indeed → always NULL. |
| `salary_min` | numeric | NULL | | As quoted; never converted (FR-015a). |
| `salary_max` | numeric | NULL | | As quoted; never converted (FR-015a). |
| `salary_currency` | varchar(3) | NULL | | |
| `salary_period` | varchar(16) | NULL | | Canonical five only, or NULL (FR-015). |
| `posted_at` | timestamptz | NULL | | Normalized from epoch-ms / date (FR-016, R8). |

**No `source_raw`** (FR-005a) — raw payloads stay on per-source rows, reachable via
`source_row_id`. **No dedup or matching columns** (FR-005).

### Indexes — exactly three (CC-12, R5)

| Index | Kind | Permitted because |
|---|---|---|
| `scraped_jobs_pkey` on `id` | PK | primary key |
| `scraped_jobs_job_url_key` on `job_url` | UNIQUE | unique constraint |
| `ix_scraped_jobs_scan_run_id` on `scan_run_id` | plain | foreign-key index |

**Deliberately NOT created**, against the mapping doc's illustrative DDL: `ix_scraped_jobs_source`
(`source_site` has cardinality 3 — an index would rarely beat a seq scan) and
`ix_scraped_jobs_posted_at`. Both are speculative under CC-12. Add later, with a measured
query, if the listing's sort proves slow.

### Constraints

- `PRIMARY KEY (id)`
- `UNIQUE (job_url)` — FR-006; makes same-site re-scrape a no-op (FR-010)
- `FOREIGN KEY (scan_run_id) REFERENCES extension_run_logs(id) ON DELETE RESTRICT` — matches
  the per-source tables' behavior
- `NOT NULL` on `source_site`, `source_row_id`, `scan_run_id`, `job_url`, `scrape_time`,
  `matched`, `dismissed`

### Why `source_row_id` has no foreign key

It is **polymorphic**: it references `linkedin_jobs`, `indeed_jobs`, or `glassdoor_jobs`
depending on `source_site`. A Postgres FK targets exactly one table, so no constraint — and
therefore no `ON DELETE CASCADE` — can express this. Referential integrity is upheld by the
write path (dual-write, R1) and the delete path (matched predicates, R3) instead of by the
database.

This is the single most consequential structural fact in the design: **every "the database will
keep these in sync for us" instinct is unavailable here.** The 1:1 correspondence is a code
invariant, which is exactly why FR-030/FR-032/FR-033 demand smoke coverage of it.

---

## Per-site projection

Source columns are per `docs/live-per-source-schemas.md`. "→" means direct copy.

| Canonical | ← `linkedin_jobs` | ← `indeed_jobs` | ← `glassdoor_jobs` | Transform |
|---|---|---|---|---|
| `source_site` | `'linkedin'` | `'indeed'` | `'glassdoor'` | constant per ingest path |
| `source_row_id` | `id` | `id` | `id` | from `INSERT … RETURNING` |
| `site_job_id` | `job_posting_id` | `jobkey` | `listing_id` | → |
| `scan_run_id` | `scan_run_id` | `scan_run_id` | `scan_run_id` | → |
| `job_url` | `job_url` | `job_url` | `job_url` | → |
| `scrape_time` | `scrape_time` | `scrape_time` | `scrape_time` | from `RETURNING` (R2) |
| `title` | `title` | `title` | `title` | → |
| `company` | `company_name` | `company` **else** `employer_name` | `employer_name` | Indeed: coalesce (FR-013) |
| `location_text` | `formatted_location` | `formatted_location` | `location_name` | → |
| `description` | `description_text` | `description_text` | `description` | → |
| `remote` | `work_remote_allowed` | `remote_location` | *(derived)* | Glassdoor: `remote_work_types` non-empty → true, else NULL (FR-014) |
| `apply_url` | `company_apply_url` | `third_party_apply_url` | `header_apply_url` | → |
| `experience_level` | `formatted_experience_level` | *(none → NULL)* | `experience_requirements_description` | best-available |
| `industry` | `formatted_industries` (jsonb) | *(none → NULL)* | `industry` | LinkedIn: flatten → first |
| `salary_min` | `salary_min` | `salary_min` | `jsonld_salary_min` | → |
| `salary_max` | `salary_max` | `salary_max` | `jsonld_salary_max` | → |
| `salary_currency` | `salary_currency` | `salary_currency` | `jsonld_salary_currency_top` | → |
| `salary_period` | `salary_period` | `salary_period` | `salary_period` | normalize (R7) |
| `posted_at` | `listed_at` (ms) | `pub_date` (ms) | `date_posted` (date) | normalize to UTC (R8) |
| `matched` | `false` | `false` | `false` | always false at ingest |
| `dismissed` | `false` | `false` | `false` | always false at ingest |

### Transform rules

**`salary_period`** (FR-015, R7) — case-insensitive token → canonical five, else NULL + warn:

```
HOURLY  ← HOURLY, HOUR, PER_HOUR
DAILY   ← DAILY, DAY, PER_DAY
WEEKLY  ← WEEKLY, WEEK, PER_WEEK
MONTHLY ← MONTHLY, MONTH, PER_MONTH
ANNUAL  ← YEARLY, YEAR, ANNUAL, ANNUALLY, PER_YEAR
```
Unknown → `NULL` period, amounts retained, log `projection_unknown_salary_period`.
⚠ The token lists are inferred, not observed (R7) — verify on first live scan.

**`posted_at`** (FR-016, R8):
- LinkedIn `listed_at`, Indeed `pub_date`: epoch-ms → `datetime.fromtimestamp(ms/1000, tz=utc)`
- Glassdoor `date_posted`: date → midnight **UTC** (not server-local — R8)
- Absent / non-numeric / out-of-range → `NULL` + log `projection_bad_posted_at` (FR-017)

**`remote`** (FR-014) — tri-state, and the distinction matters:
- LinkedIn `work_remote_allowed`, Indeed `remote_location`: copy (may be NULL)
- Glassdoor: `remote_work_types` present and non-empty → `true`; absent/empty → **`NULL`**, not
  `false`. NULL means "the site didn't say", which is not the same claim as "not remote".

**`company`** (FR-013) — Indeed only: mosaic `company` first; fall back to graphql
`employer_name` only when the first is absent.

**`industry`** — LinkedIn `formatted_industries` is jsonb; take the first element as text.
NULL when absent or empty.

---

## Lifecycle

| Event | Per-source row | Canonical row | Enforced by |
|---|---|---|---|
| Ingest (new) | INSERT | INSERT | one transaction (R1) |
| Ingest (re-scrape, same url) | `ON CONFLICT DO NOTHING` | `ON CONFLICT DO NOTHING` | UNIQUE `job_url` (FR-010) |
| Claim for matching | `matched` false→true | `matched` false→true | same transaction (R4) |
| User dismisses | *(untouched)* | `dismissed` → true | `PUT /jobs/{id}` |
| Auto-expiration | DELETE by `scrape_time` | DELETE by identical predicate | same transaction (R3) |

**Permitted mutations on the canonical row — exactly three** (Constitution V): the `matched`
claim-flip, the `dismissed` flag, and auto-expiration DELETE. No other in-place update.

**Invariants**:
1. A canonical row exists **iff** its per-source row exists (dual-write + matched deletes).
2. A canonical row never outlives its per-source row (Constitution V).
3. `matched` agrees across the pair at all times (FR-028).
4. `scrape_time` is byte-identical across the pair — invariant 2's expiration symmetry depends
   on it (R2).

---

## Entities unchanged

- **`linkedin_jobs` / `indeed_jobs` / `glassdoor_jobs`** — UNCHANGED in structure and written
  values (FR-009). The only edit is `RETURNING id` → `RETURNING id, scrape_time`, which changes
  what is *read back*, not what is stored.
- **`extension_run_logs`** — UNCHANGED. Still the FK target for `scan_run_id`.
