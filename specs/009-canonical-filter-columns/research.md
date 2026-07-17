# Phase 0 Research: Canonical Filter Columns on `scraped_jobs`

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-16

Six decisions. R1 and R4 close gaps the spec left to the plan. R2, R3, R5, R6 resolve findings from
[checklists/data-model.md](./checklists/data-model.md) — the two verified defects (R2, R6) and the
two highest-signal gaps (R3, R4).

---

## R1: Column types and bounds

**Decision**:

| Column | Type | Rationale |
|---|---|---|
| `employment_type` | `varchar(16)` | Longest token is `INTERNSHIP` (10). Mirrors `salary_period varchar(16)` — the shipped controlled-vocabulary column, same shape, same feature. |
| `workplace_type` | `varchar(16)` | Longest token is `REMOTE`/`HYBRID`/`ONSITE` (6). Sized with `employment_type` for consistency rather than shrink-wrapped. |
| `language` | `varchar(8)` | Mirrors `indeed_jobs.language varchar(8)`, its only source. Post-normalization values are 2–3 chars (FR-011a); the width is inherited, not computed. |
| `education_requirements` | `text` | Unbounded by necessity — it is a `"; "`-join of N labels (FR-012b) **or** a long free-prose experience description (FR-012). Matches `experience_level text`, which carries that same prose today. |
| `salary_disclosed` | `boolean` | Nullable — tri-state (FR-003). |

**Rationale**: No column invents a width. Each either mirrors the shipped canonical column with the
same role (`salary_period`) or its per-source origin (`indeed_jobs.language`). All five are
`NULL`-permitting with **no server default** — a default would manufacture the "third state" FR-002
forbids.

**Alternatives considered**:
- *Postgres `ENUM` types for the two vocabularies* — rejected. An enum makes every future vocabulary
  addition a migration with a table lock, and it turns an unrecognized token into an ingest failure,
  which directly contradicts FR-013 (never fail the ingest over one field). The shipped
  `salary_period` uses `varchar` for exactly this reason.
- *`CHECK` constraints on the vocabularies* — rejected, same reason: FR-005b says the mapping is
  reasoned-not-observed and expects correction from live data. A CHECK would convert "our table is
  incomplete" into "ingest is down".
- *Capping `education_requirements`* — rejected. Truncation would silently corrupt a requirement,
  and the canonical row already carries unbounded `description`/`experience_level`.

---

## R2: Glassdoor `salary_disclosed` describes a different payload than the row's salary amounts

*(checklists/data-model.md CHK025/CHK025a — **verified against code**)*

**Decision**: Implement exactly as specified (FR-010, FR-005a) — `salary_disclosed` derives from
`salary_source`, full stop. Document the limitation in `docs/live-per-source-schemas.md` beside the
new column, and flag it for the FR-005d first-scan review. **Do not** attempt to reconcile the two
payloads in this feature.

**The finding**: For Glassdoor, the canonical salary amounts and the canonical salary provenance
come from two different parts of the payload:

| Canonical column | Source | Payload |
|---|---|---|
| `salary_min` / `salary_max` | `jp.baseSalary.value.minValue/maxValue` (`jobs.py:628`) | JSON-LD — **employer-authored** structured markup |
| `salary_currency` | `jp.salaryCurrency` (`jobs.py:627`) | JSON-LD |
| `salary_period` *(shipped, 008)* | `jdd.payPeriod` (`jobs.py:610`) | `jobDetailsData` — **Glassdoor's own** salary block |
| `salary_disclosed` *(this feature)* | `jdd.salarySource` (`jobs.py:611`) | `jobDetailsData` |

So a Glassdoor row can carry employer-authored amounts labelled `salary_disclosed = false` because
Glassdoor's own salary block — describing a *different* number — says it estimated one.

**Rationale**:
- **It is inherited, not introduced.** Shipped 008 already reads `salary_period` from
  `jobDetailsData` while reading amounts from JSON-LD. This feature adds a fourth column to an
  existing split; it does not create it.
- **Fixing it violates the feature's own contract.** FR-020 promises the 22 existing columns keep
  their current values and semantics; Principle III forbids the drive-by. Any reconciliation
  changes `salary_period` for Glassdoor rows — a shipped column with existing readers.
- **The spec is the contract.** FR-010 and FR-005a say `salary_disclosed` ← `salary_source`. A plan
  that quietly substitutes different semantics is exactly what Principle I forbids.

**Consequence to be honest about**: User Story 2 ("distinguish employer-stated salaries from site
estimates") is fully delivered for LinkedIn and Indeed, and delivered *with a caveat* for Glassdoor —
the flag is trustworthy about `jobDetailsData`'s figure, which may not be the figure on the row.

**Alternatives considered**:
- *Derive Glassdoor `salary_disclosed` from JSON-LD presence instead* — rejected: JSON-LD presence
  proves the employer published markup, not that the pay came from the employer, and it contradicts
  FR-005a's explicit mapping.
- *Set `salary_disclosed = NULL` for Glassdoor when the two payloads disagree* — rejected: "disagree"
  is undefined (they describe different numbers, so they always potentially disagree), and it would
  null the column for most Glassdoor rows, gutting the story it exists to serve.
- *Fix the 008 split first* — the honest option, but it is a separate spec against shipped
  behavior. **Recommended as follow-up** if Glassdoor precision matters.

---

## R3: NULL is overloaded — "site didn't say" vs "row predates the feature"

*(checklists/data-model.md CHK021)*

**Decision**: Accept the overload; add no marker column and no backfill. Document that pre-feature
rows are identifiable by `scrape_time` predating the `031` deployment, and record that as the
consumer's disambiguation route.

**Rationale**: FR-002 assigns NULL one meaning ("the site did not say") while FR-023 gives
pre-existing rows NULL for the same columns — so `WHERE employment_type IS NULL` returns both
populations. The overload is real, but:
- **It self-heals.** Canonical rows are deleted by shelf-life auto-expiration (CC-1), so within one
  shelf-life every surviving row is post-`031`. This is a bounded, temporary ambiguity, not a
  permanent modelling defect.
- **`scrape_time` already separates them.** Every canonical row copies the per-source `scrape_time`
  exactly (never defaulted — 008 depends on this for expiration symmetry). A consumer needing the
  distinction filters `scrape_time >= <031 deploy time>`. No schema change buys anything
  `scrape_time` does not already provide.
- **The consumer does not exist yet.** Adding a `projection_version` column now would be
  speculative structure for a reader nobody has written, against Principle III.

**Alternatives considered**:
- *Backfill the five columns for existing rows* — rejected: explicitly out of scope (spec
  Assumptions), and it would require re-reading per-source rows for every canonical row.
- *A `projection_version` / `columns_populated_at` marker column* — rejected as speculative (CC-12's
  spirit); `scrape_time` already answers the question.
- *Delete pre-feature rows so only populated rows exist* — rejected: destroys live data the Jobs
  page is serving, to solve a question no reader is asking yet.

---

## R4: Warning identifiers and payloads

*(checklists/data-model.md CHK035/CHK036/CHK038 — FR-005d's required review needs something to grep)*

**Decision**: Five new warning event names, following the shipped
`projection_unknown_salary_period` / `projection_bad_posted_at` convention exactly — a bare event
name followed by a single dict, logged at `WARNING`, raw values truncated to 64 chars.

| Event name | Fires when | Payload |
|---|---|---|
| `projection_unknown_employment_type` | A stated employment value is neither mappable nor `OTHER` (FR-008d) | `{site, raw}` |
| `projection_unknown_workplace_type` | A stated workplace value maps to no token | `{site, raw}` |
| `projection_unknown_salary_source` | Salary-source field present but matches neither indicator (FR-010b) | `{site, raw}` |
| `projection_bad_language` | Language present but not a plausible base code (FR-011b) | `{site, raw}` |
| `projection_workplace_remote_conflict` | LinkedIn labels contradict `work_remote_allowed` (FR-009b) | `{site, remote_allowed, labels}` |

**Rationale**:
- FR-005d makes reviewing the first scan's warnings a **required step**, and SC-008 makes the
  mapping's confirmation a success criterion. Neither is executable without a stable, greppable
  token. Matching the existing convention means one `grep projection_` finds all of them.
- **`projection_workplace_remote_conflict` is deliberately named apart from the `unknown_*` family**
  (CHK038). It reports an upstream data contradiction, not a gap in our vocabulary — folding it in
  would pollute the FR-005d review with warnings that require no mapping change.
- **`Other` must not warn** (FR-008d): it is classified before the unknown check, so it reaches no
  logger. This is what makes SC-009 ("zero warnings for normal postings") achievable.

**Alternatives considered**:
- *One generic `projection_unknown_token` with a `field` key* — rejected: the existing convention is
  one event per concern (`projection_unknown_salary_period`, `projection_bad_posted_at`), and a
  shared name makes per-column triage a payload-parsing exercise.
- *Structured/JSON logging* — rejected: not the codebase's convention; Principle III.

---

## R5: Which smoke tests must pass, and how this one is extended

*(checklists/data-model.md CHK043/CHK044a — **verified**)*

**Decision**: The authoritative suite is the **four** `smoke_test_*.py` files on disk. Extend
`smoke_test_scraped_jobs_merge.py` **additively**; leave the other three untouched. Do not create a
new smoke-test file.

**The finding**: Constitution §II enumerates three smoke tests; four exist —
`smoke_test_scraped_jobs_merge.py` was added by 008 and never added to the list. FR-022 says "all
existing smoke tests" and inherits the stale enumeration.

**Rationale**:
- The merge test already **owns the projection contract**: its `CASES` table
  (`smoke_test_scraped_jobs_merge.py:167`) maps site → expected canonical values, with direct copies
  and transforms separated. Five new expectations per site drop straight in.
- Principle II requires new permanent behavior to be captured by a smoke test; FR-022 requires no
  existing assertion to change. Both hold: every edit adds, none rewrites. Declared in plan.md's
  Constitution Check and Complexity Tracking.
- A separate `smoke_test_filter_columns.py` was rejected — it would split one projection contract
  across two files, and the fixtures (payload builders, cleanup, run-id plumbing) already exist here.

**Coverage to add** (assertion intent; specifics in [quickstart.md](./quickstart.md)):
per-site population and NULL-where-not-supplied; `Other` → NULL **with no warning**; precedence on a
multi-tagged posting; determinism under reversed payload order; unrecognized salary source → NULL not
false; multi-label education join.

---

## R6: Migration `031` shape

**Decision**: `031_scraped_jobs_filter_columns.py`, `down_revision = "030"` (verified head). Five
`ADD COLUMN` statements, all nullable, no defaults, no indexes, no constraints. `downgrade()` drops
the five columns.

**Rationale**:
- **No indexes** (CC-12): the consuming service does not exist, so no query has demonstrated a need.
  Each is one migration away if measurement justifies it — the same call 008 made and documented for
  `source_site` and `posted_at`.
- **Nullable with no default**: `ADD COLUMN ... NULL` without a default is a metadata-only operation
  in modern Postgres — no table rewrite, no long lock, regardless of row count. A default would both
  rewrite the table and manufacture a non-NULL value for rows whose sites never said anything,
  breaking FR-002.
- **`downgrade()` is real here**, unlike 030's (which raises rather than reconstruct a ~48-column
  legacy schema). Dropping five additive columns is exact and lossless with respect to the pre-031
  schema, so there is no reason to make this one one-way.

**Alternatives considered**:
- *Fold the five columns into a single JSONB `attributes` column* — rejected: defeats the feature's
  purpose (cheap, plain-SQL filtering for the future service), and CC-10/CC-11 put normalized values
  on the canonical row as columns, not as a nested blob.
- *Add the indexes now* — rejected: CC-12 forbids speculative indexes without demonstrated need, and
  the plan's Constitution Check would fail the Principle IV gate.
