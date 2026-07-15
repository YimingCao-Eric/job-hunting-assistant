# Phase 0 Research: Unified Scraped Jobs Table with Dual-Write Ingest

**Feature**: 008-unified-scraped-jobs | **Date**: 2026-07-15

Each decision below was verified against the live code, not inferred. File references are
`path:line` at the time of writing.

---

## R1: Transaction boundary — the dual-write needs no new machinery

**Decision**: Write the per-source row and the canonical row as two `db.execute()` calls in
the existing request session. Add no explicit `begin()`, no nested transaction, no savepoint.

**Rationale**: `get_db` (`backend/core/database.py:15-22`) already wraps the whole request in
one session, commits after the handler returns, and rolls back on any exception. Both inserts
therefore land in one transaction automatically — if the canonical insert raises, the
per-source insert rolls back with it. FR-008 ("one transaction, committing together or not at
all") is satisfied by the ambient behavior. Constitution IV ("multi-table writes MUST be
atomic") is likewise already honored.

**Alternatives considered**:
- *Explicit `async with db.begin()` in the handler* — would nest inside the session's implicit
  transaction and raise. Rejected.
- *Two-phase / outbox* — enormous complexity for a single-database write. Rejected.

**Consequence**: the dual-write is a genuinely small change. Any plan step claiming it needs
transaction plumbing is wrong.

---

## R2: `scrape_time` MUST be copied from the per-source row, never defaulted

**Decision**: Extend each per-source `INSERT ... RETURNING id` to `RETURNING id, scrape_time`,
and pass that exact value into the canonical insert. The canonical `scrape_time` column keeps
a `DEFAULT now()` for safety but the write always supplies the value explicitly.

**Rationale**: This is load-bearing and non-obvious. Both tables default `scrape_time` to
`now()`. Postgres `now()` is transaction-stable, so within one transaction the two defaults
*would* agree — but that is an accident of implementation, not a guarantee anyone stated, and
R3 makes expiration depend on the two values being identical. Copying makes the invariant
explicit and survives someone later changing the default to `clock_timestamp()`.

Adding columns to `RETURNING` does not change what is written, so FR-009 ("per-source rows
identical … no observable change") holds.

**Alternatives considered**:
- *Let both default to `now()`* — relies on transaction-stable `now()` as an unstated
  invariant. Rejected as fragile.
- *Canonical `scrape_time` as a generated/derived column* — no cross-table generated columns in
  Postgres. Not possible.

---

## R3: Expire-both (FR-027) — a fourth DELETE with the same predicate, not an FK cascade

**Decision**: In `run_auto_expiration` (`backend/auto_scrape/auto_expiration.py:33-41`), add a
fourth `DELETE FROM scraped_jobs WHERE scrape_time < NOW() - make_interval(days => :d)`, using
the identical predicate and the same transaction.

**Rationale**: An FK cascade is **impossible here** and this needs stating plainly, because the
mapping doc's `source_row_id` column invites the assumption. `source_row_id` is polymorphic —
it points at one of *three* tables depending on `source_site`. Postgres foreign keys reference
exactly one table, so no `ON DELETE CASCADE` can exist. Anyone planning "just add a cascading
FK" will discover this at migration time.

Because `scraped_jobs.scrape_time` is copied exactly from the per-source row (R2), the same
predicate selects exactly the same postings. The delete sets match by construction. This keeps
`auto_expiration` symmetric with its existing style (a loop of raw `DELETE`s in the caller's
transaction) and preserves Constitution V's "a canonical row MUST NOT outlive its per-source
row".

**Alternatives considered**:
- *`DELETE FROM scraped_jobs WHERE source_row_id NOT IN (SELECT id FROM …)` (orphan sweep)* —
  correct but three anti-joins over the whole table on every cycle. Rejected on cost.
- *Three FKs (one nullable column per site)* — would satisfy cascade at the price of a
  wide, mostly-null schema contradicting the doc's single `source_row_id`. Rejected.
- *Postgres trigger on the per-source tables* — hides a delete path from the code. Rejected.

**Test consequence**: FR-032's smoke assertion must confirm the canonical row is gone, not just
that the per-source row is.

---

## R4: Claim-both (FR-028) — a fourth UPDATE

**Decision**: In `claim_unmatched_rows` (`backend/auto_scrape/matching_claim.py:44-52`), after
the three per-source `UPDATE … RETURNING`, add
`UPDATE scraped_jobs SET matched = TRUE WHERE matched = FALSE`, in the same transaction.

**Rationale**: The dual-write guarantees a 1:1 correspondence and both rows start `matched =
false`, so "all unmatched canonical rows" is exactly "all canonical twins of the rows just
claimed". The blanket UPDATE matches the function's existing idiom and needs no join.

The caller manages the transaction (`matching_claim.py:26-31`), so the fourth UPDATE commits
with the other three — satisfying FR-028's "same operation".

**Alternatives considered**:
- *`UPDATE … WHERE job_url IN (:urls)` from the RETURNING rows* — more explicitly correct, but
  needs a large IN-list and an extra round trip. Equivalent in effect. Rejected for complexity;
  revisit if the 1:1 invariant ever weakens.
- *Trigger* — hides the write path. Rejected.

---

## R5: Indexes — CC-12 forbids two of the three the mapping doc suggests

**Decision**: Create exactly three indexes: the `id` PK, `UNIQUE (job_url)`, and
`ix_scraped_jobs_scan_run_id` on the `scan_run_id` FK. **Drop** the mapping doc's
`ix_scraped_jobs_source` (on `source_site`) and `ix_scraped_jobs_posted_at`.

**Rationale**: Constitution IV / CC-12 permits primary-key, unique, and foreign-key indexes
only; anything more "requires a demonstrated need, justified in the plan". No such need exists
today: `scraped_jobs` starts at zero rows, and `source_site` has cardinality 3 — an index on
it would rarely beat a sequential scan. The FK index on `scan_run_id` is permitted and matches
the precedent on all three per-source tables (`ix_linkedin_jobs_scan_run_id` et al).

`posted_at DESC` is the plausible future need, since the listing may sort by it — but "may
sort by it" is speculation until a slow query exists. Adding it later is one migration.

**Alternatives considered**:
- *Follow the doc's DDL literally* — a direct CC-12 violation requiring Complexity Tracking
  justification we cannot honestly supply. Rejected.

**Consequence**: this closes the one Constitution Check item the spec carried into planning.

---

## R6: The projection mapper lives in `core/`

**Decision**: New module `backend/core/scraped_job_projection.py`, exposing one entry point
that takes a site plus the already-built per-source params and returns the canonical params
dict. Pure functions; no ORM, no HTTP, no I/O.

**Rationale**: Constitution's module layout enumerates `models/` (tables), `schemas/`
(Pydantic), `routers/` (routes), `core/` (cross-cutting infrastructure), `auto_scrape/`
(pipeline) and says "do not introduce parallel or catch-all modules". The mapper is not a
table, not a Pydantic model, not a route, and not part of the post-scrape pipeline. `core/` is
the only listed home that fits, and the mapper is genuinely cross-cutting: the router uses it
now, matching will read its output later.

**Key design point**: the mapper consumes the **per-source params dict** that
`build_linkedin_params` / `build_indeed_params` / `build_glassdoor_params` already produce —
not the raw `source_raw` payload. Those builders have already done the messy extraction
(`_resolve_linkedin_included`, coercion helpers, mosaic-vs-graphql precedence). Re-parsing
`source_raw` in the mapper would duplicate ~280 lines of extraction logic and create two
sources of truth that could drift. The canonical row is a projection *of the per-source row*,
which is exactly what the mapping doc describes.

**Alternatives considered**:
- *New top-level `projection/` package* — contradicts the constitution's layout rule without a
  spec saying why. Rejected.
- *Map from `source_raw` directly* — duplicates extraction, invites drift. Rejected.
- *Map in SQL (`INSERT … SELECT` from the per-source row)* — would put transform logic in three
  hand-written SQL strings, untestable without a database. Rejected.

---

## R7: Pay-period vocabulary — token normalization with a logged fallback

**Decision**: Normalize case-insensitively on the source token, mapping known spellings onto
the canonical five (FR-015: `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `ANNUAL`). An unrecognized
token yields `NULL` period, keeps the amounts, and logs a warning
(`projection_unknown_salary_period`).

Starting map (all three sites share the `salary_period` column name):

| Source token(s) | Canonical |
|---|---|
| `HOURLY`, `HOUR`, `PER_HOUR` | `HOURLY` |
| `DAILY`, `DAY`, `PER_DAY` | `DAILY` |
| `WEEKLY`, `WEEK`, `PER_WEEK` | `WEEKLY` |
| `MONTHLY`, `MONTH`, `PER_MONTH` | `MONTHLY` |
| `YEARLY`, `YEAR`, `ANNUAL`, `ANNUALLY`, `PER_YEAR` | `ANNUAL` |

**Rationale**: The mapping doc states the vocabularies differ and gives only two worked
examples (`YEARLY`/`YEAR`/`ANNUAL` → `ANNUAL`; `HOURLY`/`HOUR` → `HOURLY`). The table above
extrapolates that pattern across the canonical five. The log-and-null fallback is exactly what
the spec's edge case requires ("indicates a site changed its vocabulary and is worth surfacing
rather than absorbing silently").

**⚠ Open — requires verification against live data**: the exact tokens each site emits are
**not** established by any doc I could verify, and the live tables could not be queried during
planning (host Python/psql unavailable; see the environment note in `plan.md`). The map above
is a reasoned superset, not an observed one. The warning log is the safety net: it makes any
gap visible on first real scan rather than silently nulling periods. **Task**: run one scan and
grep for `projection_unknown_salary_period` before declaring FR-015 done.

**Alternatives considered**:
- *Fail ingest on unknown period* — violates FR-017 (absent/unmappable values must not fail
  ingest). Rejected.
- *Pass the raw token through* — defeats FR-015's whole purpose. Rejected.

---

## R8: `posted_at` conversion happens in Python, not SQL

**Decision**: Convert in the mapper and bind an aware `datetime`:
- LinkedIn `listed_at` (bigint epoch-ms) → `datetime.fromtimestamp(ms / 1000, tz=utc)`
- Indeed `pub_date` (bigint epoch-ms) → same
- Glassdoor `date_posted` (date) → `datetime.combine(d, time.min, tzinfo=utc)`

Guard: non-positive, non-numeric, or out-of-range values yield `None` and log
`projection_bad_posted_at`. `None` in → `None` out.

**Rationale**: The doc expresses these as SQL (`to_timestamp(x/1000)`,
`date_posted::timestamptz`), but the mapper builds a params dict, so doing it in Python keeps
one transform site and makes it unit-testable without a database. The results are identical.

The Glassdoor cast deserves care: `date_posted::timestamptz` in Postgres resolves midnight in
the **server's** TimeZone setting, which is environment-dependent. Pinning it to UTC in Python
is deterministic and matches how the epoch-ms values (inherently UTC) land. This is a
deliberate, documented reading of the doc rather than a literal translation.

**Alternatives considered**:
- *Literal SQL expressions in the INSERT* — reintroduces server-timezone dependence for
  Glassdoor and can't be unit-tested. Rejected.

---

## R9: The two legacy ingest paths

### R9a: `source_raw is None` fallback (FR-025) → **400**

**Decision**: Remove the legacy fallback block (`jobs.py:753-860`). A POST without `source_raw`
for a supported site returns `400 "source_raw required"`.

**Rationale**: FR-025 requires this path cannot write rows in a shape the unified store no
longer supports. The block writes a legacy `ScrapedJob` with `raw_description_hash`,
`original_job_id`, and content-dedup — all columns the redesign deletes. It is already flagged
transitional in the code (`ingest_transition_fallback`, `jobs.py:647`). Deleting it is the
honest resolution.

### R9b: `skip_reason` branch (FR-024) → **200 no-op**, deviating from the spec's literal text

**Decision**: Accept the request, write nothing, return `200` with
`{id: <nil uuid>, already_exists: false, content_duplicate: false, skip_reason: <echo>}`.
Do **not** return 400.

**Rationale — this is a deliberate deviation and needs sign-off.** FR-024 says "Ingest MUST NOT
accept or record a skip reason", and the spec assumed no live caller. There is one:
`recordSkip` (`extension/content/shared/messaging.js:102-169`) fires on **every skipped card**
on all three sites (`linkedin/process.js:14,56,80`, `indeed/process.js:44,85`,
`glassdoor/process.js`). It posts `job_url: null` and no `source_raw`.

If ingest 400s, `recordSkip` retries 3× with 1s/2s/3s backoff (`messaging.js:118-167`) — about
**6 seconds of dead wait per skipped card**, plus error-log noise, on a scan that may skip many
cards. It does not set `_backendDownDuringScan` (that flag is `ingestJob`-only,
`messaging.js:97-98`), so a scan would not be marked failed — it would just get slow and noisy.

The 200 no-op honors FR-024's *intent* (no skip row is recorded anywhere; the skipped-postings
listing is gone) while not degrading a scrape path the user asked to leave unchanged. The
counters that matter are already tracked client-side (`counters.id_skipped` etc.).

**Alternatives considered**:
- *400, per FR-024's literal wording* — the 6s-per-skip regression above. Rejected.
- *Update the extension to stop calling `recordSkip`* — the complete fix, and the right
  follow-up, but it widens this feature into the extension, which the user scoped out
  ("keep the scrape/auto-scrape paths otherwise unchanged"). **Recommended as a follow-up.**

**Follow-up**: once the extension drops `recordSkip`, the no-op branch and `skip_reason` /
`original_job_id` / `voyager_raw` / `search_filters` on `ScrapedJobIngest` can all go.

---

## R10: `admin_cleanup` job deletions must be retired, not adapted (FR-026)

**Decision**: Delete the three job-deletion sweeps from `cleanup_invalid_entries`
(`backend/routers/admin_cleanup.py:41-69`) and `_delete_scraped_jobs_where` (`:17-33`). Keep
the stale-run-log sweep (`:71-87`). Keep all response keys, returning `0` for the retired
counters.

**Rationale — derived from the constitution, and it forecloses the obvious alternative.**
FR-026 offered "operate on the unified store's canonical fields, **or** be retired". Adapting
looks easy (`website` → `source_site`, `job_title` → `title`, `created_at` → `scrape_time`) but
is not viable:

1. **Deleting only the canonical row breaks the 1:1 invariant.** It would leave a per-source
   row with no canonical twin — the exact inverse orphan, violating SC-002 ("no posting present
   in a per-source store but missing from the unified store") and Constitution V's derived-table
   correspondence.
2. **Deleting both rows violates CC-1.** Constitution V permits *exactly two* mutations on
   per-source rows: the one-way `matched` flip and auto-expiration `DELETE`. An admin cleanup
   `DELETE` is neither. Adapting the sweep to delete per-source rows would be a direct
   constitutional violation.

With both branches closed, retirement is the only compliant option. The mismatched-website
sweep is independently dead anyway: ingest validates the site against the three-site allowlist
and 400s otherwise (`jobs.py:650-657`), so `source_site` can no longer hold a bad value —
FR-026's "retired where the condition it screened for can no longer arise" applies literally.

The empty-core and short-JD conditions *can* still arise (FR-017 permits empty canonical
fields). They are simply no longer this endpoint's business: auto-expiration reclaims aged rows
by TTL, and a junk row is a faithful record of a junk posting. Under Principle I, a scrape that
returned no title is data, not corruption.

Keeping the response keys at `0` follows Principle VII (forward-compatible outputs: add rather
than remove keys) and the precedent already set in this very file for
`marked_failed_dedup_tasks` (`admin_cleanup.py:89-91`).

**Alternatives considered**:
- *Adapt to canonical columns, delete canonical only* — breaks the 1:1 invariant (1). Rejected.
- *Adapt and delete both rows* — violates CC-1 (2). Rejected.
- *Delete the endpoint entirely* — it still does useful run-log work. Rejected.

---

## R11: Migration `030` — drop-and-recreate, non-reversible to the legacy shape

**Decision**: `030_unified_scraped_jobs.py`, `down_revision = "029"`. `upgrade()` drops
`scraped_jobs` and creates the unified table. `downgrade()` drops the unified table and does
**not** recreate the legacy one; it raises `NotImplementedError` with an explanatory message.

**Rationale**: The user confirmed drop-and-recreate is acceptable (0 rows, nothing to
preserve). A faithful `downgrade()` would have to reconstruct ~60 legacy columns spanning
dedup and matching features whose code has been deleted — a table no code could use, built
from a schema no doc still describes accurately. Writing it would be dishonest ceremony;
writing it *wrong* would be worse than refusing.

Raising is the truthful option: it states plainly that this migration is one-way. Recovery is
`git revert` plus a restore, not `alembic downgrade`. Existing migrations follow simple raw
`op.execute(text(...))` with string revision ids (`028_add_matched_column.py:13-14`); `030`
matches that style.

**Alternatives considered**:
- *Faithful legacy recreate* — ~60 columns of boilerplate for a dead schema. Rejected.
- *Silent no-op `downgrade()`* — leaves the DB in a state 029's world does not expect, with no
  warning. Rejected as dishonest.

**Accepted limitation**: `alembic downgrade 029` fails loudly. Documented in the migration
docstring and `quickstart.md`.

---

## R12: `GET /jobs` filters — three of nine cannot survive

**Decision**:

| Current filter | Fate | Canonical target |
|---|---|---|
| `website` | **RENAMED** | `source_site` |
| `dismissed` | UNCHANGED | `dismissed` (now excluded by default — FR-019) |
| `scan_run_id` | UNCHANGED | `scan_run_id` |
| `date_from` / `date_to` | **RETARGETED** | `posted_at` (was `post_datetime`) |
| `scraped_from` / `scraped_to` | **RETARGETED** | `scrape_time` (was `created_at`) |
| `easy_apply` | **DELETED** | — no canonical field exists |
| `dedup_status` | **DELETED** | — `skip_reason` is gone |

Ordering changes from `created_at DESC` to `scrape_time DESC` (the canonical equivalent).

**Rationale**: `easy_apply` has no canonical column — the mapping doc omits it, and the three
sites express it incompatibly (LinkedIn `apply_method_type`, Indeed `indeed_apply_enabled`,
Glassdoor `is_easy_apply`/`direct_apply`). Inventing one would exceed the doc's authority
(FR-012). `dedup_status` filters on `skip_reason`, which FR-024 removes.

Default filtering flips from `skip_reason IS NULL` to `dismissed = false` (FR-019).

**Frontend impact**: `frontend/src/api.js` and the Jobs page pass these filters. Per FR-021,
adapting the frontend is spec 007's work, not this feature's.

---

## R13: The ingest response `id` stays the per-source row id

**Decision**: `ScrapedJobIngestResponse.id` continues to return the per-source row's id on the
per-source path. Unchanged.

**Rationale**: FR-009 requires no observable change to the per-source path. The extension only
null-checks this id (`messaging.js:155`); it never dereferences it. Switching it to the
canonical id would be a gratuitous contract change (Principle III).

**Consequence worth stating**: `POST /jobs/ingest` returns per-source ids while
`GET /jobs/{id}` takes canonical ids — two distinct id spaces on one router. Nothing consumes
them together today, but it is a sharp edge, and worth a comment at the response site.

---

## Environment note

The host Python interpreter is broken (`ModuleNotFoundError: No module named 'encodings'` —
misconfigured `PYTHONHOME`), so no code, migration, or live query could be executed during
planning. All findings above are from static reading of the source. Per the user's standing
instruction, execution goes through Docker; `quickstart.md` gives the container commands.

**Direct consequence**: R7's period vocabulary is unverified against live data. It is the one
decision here resting on inference rather than observation, which is why it ships with a
warning log.
