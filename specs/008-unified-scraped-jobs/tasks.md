---

description: "Task list for 008-unified-scraped-jobs"
---

# Tasks: Unified Scraped Jobs Table with Dual-Write Ingest

**Input**: Design documents from `/specs/008-unified-scraped-jobs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api-surface-delta.md, quickstart.md

**Tests**: The spec explicitly requires smoke tests (FR-029 – FR-033), so test tasks are included. They are **smoke scripts**, not pytest — run as `python <file>` inside the container. This project has no unit-test harness; do not invent one.

**Organization**: Grouped by user story. Story order is **US2 → US1 → US3**, not spec order. US1 and US2 are both P1; US1's independent test ("run a scan, then request the listing") cannot run until the dual-write produces rows, so the mechanism ships first and the payoff second. US3 (P2) hardens the projection the earlier phases wire up.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Every task names its exact file path and marks it **NEW** / **CHANGED** / **DELETED** / **UNCHANGED**

## Execution environment — read first

**All Python runs through Docker.** The host interpreter is broken (`ModuleNotFoundError: No module named 'encodings'` — misconfigured `PYTHONHOME`). A failure from host `python`/`alembic`/`psql` tells you nothing about the code. Prefix everything with `docker compose exec -T backend …`.

**⚠️ The backend has NO source volume mount — you MUST rebuild the image after every code change.** `docker-compose.yml` mounts only `./data:/app/data`; the code is baked in at build time. Editing a file on the host changes **nothing** in the running container. This fails *silently*, not loudly: `alembic upgrade head` against a stale image reports `029 (head)` and exits 0, as though your migration didn't exist — because inside the container it doesn't. Confirmed the hard way on 2026-07-15 (T007).

```bash
docker compose up -d --build backend   # after EVERY code edit
```

**Service/credential facts** (verified 2026-07-15): the DB service is **`postgres`**, not `db`. Credentials are **`jha` / `jha` / `jha`** (user/password/db):

```bash
docker compose exec -T postgres psql -U jha -d jha -c '\d scraped_jobs'
```

Migrations run automatically at container startup (`run_migrations`, `backend/main.py:16`), so a rebuild applies them — an explicit `alembic upgrade head` is usually redundant.

## Approved deviations — settled, do not re-litigate

- **D1 (APPROVED)**: `skip_reason` ingest returns **200 no-op**, not 400. `recordSkip` is a live extension caller on every skipped card; a 400 costs ~6s of retry backoff each. See T012.
- **D2 (APPROVED)**: `admin_cleanup` job sweeps are **retired**, not adapted. Adapting would break the 1:1 invariant or violate CC-1. See T031.

## The one structural fact that shapes everything

`scraped_jobs.source_row_id` is **polymorphic** across three tables. Postgres FKs target exactly one table, so **no foreign key and no `ON DELETE CASCADE` is possible**. The 1:1 correspondence is a *code* invariant held by matched predicates in three places — ingest (T009), claim (T028), expire (T027). Do not attempt a cascading FK; it cannot be created.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the environment and capture the baseline that FR-009 regressions are measured against

- [X] T001 Verify toolchain: `docker compose exec -T backend alembic current` returns **029**, `docker compose exec -T postgres psql -U jha -d jha -c 'SELECT count(*) FROM scraped_jobs'` returns **0** (confirms the drop-and-recreate premise in research.md R11). ✅ 2026-07-15: head=029, rows=0
- [X] T002 [P] Record the per-source baseline for the FR-009 / SC-005 check: `\d linkedin_jobs` (39 cols), `\d indeed_jobs` (45 cols), `\d glassdoor_jobs` (48 cols) — save the output; these counts must be identical at T034. ✅ 2026-07-15: **39 / 45 / 48** confirmed (legacy `scraped_jobs` was 48 cols)

**Checkpoint**: Environment confirmed, baseline captured

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The table, the model, and the mapper skeleton — everything every story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Create **NEW** migration `backend/alembic/versions/030_unified_scraped_jobs.py` with `revision = "030"`, `down_revision = "029"`. `upgrade()`: `DROP TABLE scraped_jobs` then `CREATE TABLE` per data-model.md. `downgrade()`: drop the unified table and `raise NotImplementedError` explaining this migration is one-way (research.md R11). Follow the raw `op.execute(text(...))` style of `028_add_matched_column.py`. ✅ 2026-07-15
- [X] T004 In `backend/alembic/versions/030_unified_scraped_jobs.py` (**NEW**) create **exactly three** indexes — PK on `id`, `UNIQUE (job_url)`, `ix_scraped_jobs_scan_run_id` on the FK. **Do NOT create** `ix_scraped_jobs_source` or `ix_scraped_jobs_posted_at` even though the mapping doc's illustrative DDL shows them: CC-12 forbids speculative indexes (research.md R5). Add FK `scan_run_id → extension_run_logs(id) ON DELETE RESTRICT`. ✅ 2026-07-15: verified 3 indexes, 0 forbidden
- [X] T005 Rewrite `backend/models/scraped_job.py` (**CHANGED** — full rewrite) as the unified `ScrapedJob` ORM model matching data-model.md exactly. Delete every dedup/matching column, `website`, `job_title`, `location`, `job_description`, `post_datetime`, `search_filters`, `voyager_raw`, `raw_description_hash`, `ingest_source`, `original_job_id`, `created_at`, `updated_at`. Add `dismissed` (FR-023). **No `source_raw`** (FR-005a). `__table_args__` must list only the three indexes from T004. ✅ 2026-07-15: 48 legacy cols → 22 canonical. Verified no `relationship()` anywhere in `models/` referenced the dropped self-FK, and `models/__init__.py:6` imports only the class name (preserved), so no mapper-config or import breakage
- [X] T006 [P] Create **NEW** `backend/core/scraped_job_projection.py` — pure functions, no ORM/HTTP/IO. Entry point takes `(site, per_source_params, source_row_id, scrape_time)` and returns the canonical params dict. **Map from the per-source params dict, NOT from `source_raw`** — `build_*_params` already did the extraction; re-parsing would duplicate ~280 lines and create two sources of truth (research.md R6). Wire provenance + direct-copy fields only: `source_site`, `source_row_id`, `site_job_id`, `scan_run_id`, `job_url`, `scrape_time`, `title`, `location_text`, `description`, `apply_url`, `salary_min`, `salary_max`, `salary_currency`, `experience_level`, plus `matched=False`, `dismissed=False`. Leave the five non-trivial transforms as `None` — Phase 5 fills them. ✅ 2026-07-15: exports `CANONICAL_COLS` (single source of truth shared with the INSERT) + `project_to_canonical()`; guards its own key contract so a mismatch fails loudly instead of as an opaque bind error. `matched`/`dismissed` omitted from the insert — both are `NOT NULL DEFAULT FALSE` and always false at ingest, so the DB supplies them
- [X] T007 Apply and verify: **`docker compose up -d --build backend`** (a bare `alembic upgrade head` is a silent no-op against a stale image — see Execution environment) → `alembic current` = **030**. Then `\d scraped_jobs` and confirm exactly three indexes, no `source_raw`, no `source_table`, no dedup/matching columns (quickstart.md §1). ✅ 2026-07-15: `029 → 030` applied at startup, 22 cols / 3 indexes, `/health` 200 `{"status":"ok","db":"ok"}`, zero ImportError/traceback lines, per-source still 39/45/48

**Checkpoint**: Table exists, model matches, mapper importable — user story work can begin

---

## Phase 3: User Story 2 - Every scrape lands in both stores, atomically (Priority: P1) 🎯 MVP mechanism

**Goal**: Every ingest writes its per-source row and one canonical row, all-or-nothing. Never one without the other.

**Independent Test**: Ingest one posting per site; confirm exactly one per-source row and one canonical row each, agreeing and cross-referenced. Force the canonical write to fail; confirm no per-source row survives.

**Note on transactions**: `get_db` (`backend/core/database.py:15-22`) already opens one session per request and commits after the handler returns. Both inserts share that transaction **automatically**. Add **no** `begin()`, savepoint, or nested transaction — an explicit `begin()` nests inside the implicit transaction and raises (research.md R1). `backend/core/database.py` is **UNCHANGED**.

### Implementation for User Story 2

- [X] T008 [US2] In `backend/routers/jobs.py` (**CHANGED**) extend all three INSERT constants — `INSERT_LINKEDIN_JOB` (`:179`), `INSERT_INDEED_JOB` (`:232`), `INSERT_GLASSDOOR_JOB` (`:305`) — from `RETURNING id` to `RETURNING id, scrape_time`, in both the `inserted` CTE and the `UNION ALL` re-select. This changes what is read back, not what is stored, so FR-009 holds. **Load-bearing**: the canonical row must copy this exact `scrape_time`, never default it, or expiration (T027) leaves boundary orphans (research.md R2). ✅ 2026-07-15: verified live — `s.scrape_time = <per_source>.scrape_time` is **true** for all three sites
- [X] T009 [US2] In `backend/routers/jobs.py` (**CHANGED**) add a canonical `INSERT INTO scraped_jobs (...) VALUES (...) ON CONFLICT (job_url) DO NOTHING` statement constant, mirroring the per-source `_COLS`/`_vals_sql` idiom already in the file (`:141-191`). `ON CONFLICT DO NOTHING` makes re-scrape a no-op and preserves `dismissed` (FR-010). ✅ 2026-07-15: built from `CANONICAL_COLS` so statement and mapper cannot drift. No `bindparam` JSONB declarations needed — `scraped_jobs` has no JSONB columns
- [X] T010 [US2] In `backend/routers/jobs.py` (**CHANGED**) wire the mapper into all three per-site branches (`:663-751`): after the per-source `db.execute`, call `scraped_job_projection` with the returned `id` + `scrape_time`, then execute the canonical INSERT in the same session. Return `ScrapedJobIngestResponse` with the **per-source** `id` (**UNCHANGED** — research.md R13); add a comment noting ingest returns per-source ids while `GET /jobs/{id}` takes canonical ids. ✅ 2026-07-15: via shared `_write_canonical_row()` helper. **R1 confirmed empirically** — no explicit transaction was added, and fault injection proved the rollback: a canonical-only CHECK violation left **zero** per-source rows (FR-008)
- [X] T011 [US2] In `backend/routers/jobs.py` **DELETE** the legacy fallback path (`:753-860` — URL dedup, `_hash_description` content dedup, legacy `ScrapedJob(**payload)` insert). Replace the `if body.source_raw is None:` branch (`:646-647`) with a `400 "source_raw required"` (FR-025). Remove the now-unused `_hash_description` helper (`:31-33`) and the `or_` import if orphaned. ✅ 2026-07-15: ~110 lines removed. `hashlib` import dropped (it became import-only). **`select`/`or_`/`func` kept** — still used by `list_jobs`/`get_job`, which Phase 4 rewrites; verified by grep rather than assumed. Added an explicit unreachable-guard after the site branches so a future site added to the allowlist without a branch fails loudly instead of returning `None` as an opaque response-validation error
- [X] T012 [US2] In `backend/routers/jobs.py` (**CHANGED**) change the `skip_reason` branch (`:619-644`) to a **200 no-op** per **D1 (APPROVED)**: write nothing, return `{id: <nil uuid>, already_exists: false, content_duplicate: false, skip_reason: <echo>}`. **Do not 400** — `recordSkip` (`extension/content/shared/messaging.js:102-169`) fires on every skipped card across all three sites and retries 3× on failure (~6s per skip). Add a comment linking to D1 and the follow-up (remove `recordSkip` from the extension, then delete this branch). `extension/` stays **UNCHANGED**. ✅ 2026-07-15: `_NIL_UUID` constant added; logs `ingest_skip_noop`. Smoke-verified: 200, echoes the reason, and row counts across all four tables are unchanged
- [X] T013 [US2] Create **NEW** `backend/smoke_test_scraped_jobs_merge.py` covering the dual-write for all three sites (FR-030): per site, ingest a fixture and assert exactly one per-source row + one canonical row, `source_row_id` cross-reference correct, and **`scraped_jobs.scrape_time = <per_source>.scrape_time` byte-identical** (research.md R2). Assert re-scraping the same `job_url` creates no duplicate and returns `already_exists: true` (FR-010). Also assert the two preserved rejections still hold (FR-011): an unrecognized `website` → **400**, and a missing `scan_run_id` → **400**, with neither store written. FR-011 is unchanged behavior, but T011 edits the immediately adjacent branch (`jobs.py:646-662`) where that validation lives, so a regression there would otherwise be silent. Follow the standalone `main()` style of `smoke_test_auto_expiration.py`. ✅ 2026-07-15: 12 assertions, all passing. Uses `httpx` + `ok()`/`fail()` + `SMOKE_BASE_URL` per `smoke_test_auto_scrape.py`. Tags every fixture with a per-run uuid so repeat runs never collide on the `job_url` unique constraint, and cleans up in a `finally`. Also asserts the five transform fields are still NULL — so it states what is actually implemented, and will fail loudly when the projection step lands (that failure is the signal to update it, not a regression)
- [X] T014 [US2] Add the atomicity assertion to `backend/smoke_test_scraped_jobs_merge.py` (**NEW**, from T013): force the canonical INSERT to fail (e.g. an FK-violating `scan_run_id`) and assert **zero** per-source rows survive for that `job_url` (FR-008). A surviving per-source row means the two writes are not sharing a transaction — the core defect this feature must not ship. ✅ 2026-07-15: fault injection via a temporary CHECK constraint that **only the canonical INSERT can violate** — an FK-violating `scan_run_id` would fail the per-source insert too and prove nothing. Constraint dropped in a `finally`; verified it does not leak

**Checkpoint**: `docker compose exec backend python smoke_test_scraped_jobs_merge.py` passes. Rows land in both stores atomically. Nothing reads them yet.

---

## Phase 4: User Story 1 - Job seeker sees real scraped results (Priority: P1) 🎯 MVP payoff

**Goal**: `GET /jobs` reads the canonical table and returns real scraped postings from all three sites in canonical field names.

**Independent Test**: After a scan ingesting postings from all three sites, `GET /jobs` returns them with populated canonical fields and correct site attribution.

**Scope boundary**: This story completes at the **listing's response**, not the rendered page. Renaming the response fields breaks the current UI until spec 007 adapts (FR-021). That is expected — the page shows an empty list today regardless. `frontend/` stays **UNCHANGED**; verify with `curl`, not the browser.

### Implementation for User Story 1

- [X] T015 [US1] Rewrite `ScrapedJobRead` in `backend/schemas/scraped_job.py` (**CHANGED**) to the canonical fields per contracts/api-surface-delta.md: `id`, `source_site`, `source_row_id`, `site_job_id`, `scan_run_id`, `job_url`, `scrape_time`, `matched`, `dismissed`, `title`, `company`, `location_text`, `description`, `remote`, `apply_url`, `experience_level`, `industry`, `salary_min`, `salary_max`, `salary_currency`, `salary_period`, `posted_at`. **DELETE** `ScrapedJobDetail` (it existed only to expose `voyager_raw`, which FR-005a removes). `JobsListResponse` envelope and `JobUpdate` are **UNCHANGED**. `ScrapedJobIngest` is **UNCHANGED** (the extension still posts legacy fields; they stay ignored). ✅ 2026-07-15: `ScrapedJobDetail` deleted. **Found and fixed a serialization bug while verifying**: asyncpg decodes Postgres `NUMERIC` into a Decimal with a positive exponent for round values, so `120000` came back as `Decimal('1.2E+5')` and Pydantic's default `str()` serialization emitted `"salary_min":"1.2E+5"` — while a non-round `55` emitted `"55"`. Two formats from one field, the scientific one a parsing trap for spec 007. Added a `field_serializer` using `format(v, "f")`; verified output is now `"120000"` / `"150000"` / `"55"`
- [X] T015a [US1] **Boot-blocker — do not skip.** In `backend/schemas/__init__.py` (**CHANGED**) remove `ScrapedJobDetail` from the import block (`:4-9`) and from `__all__` (`:15`). T015 deletes that class, and this package re-exports it, so **without this task the backend raises `ImportError` on startup** and every task from T007 onward is untestable (FR-029, SC-006). Verified safe by contrast: `backend/models/__init__.py:6` and `backend/alembic/env.py:13` import only `ScrapedJob`, whose name T005 preserves — neither needs a change. After this task, confirm boot: `docker compose up -d --build backend && curl -s localhost:8000/health`. ✅ 2026-07-15: done ahead of T015. Safe in either order — `routers/jobs.py:19` imports `ScrapedJobDetail` from `schemas.scraped_job` directly, never from the `schemas` package, so nothing consumed the re-export
- [X] T016 [US1] Rewrite `list_jobs` in `backend/routers/jobs.py` (`:875-957`, **CHANGED**): read the unified model; rename `website` → `source_site`; retarget `date_from`/`date_to` → `posted_at` and `scraped_from`/`scraped_to` → `scrape_time`; order by `scrape_time DESC` (was `created_at DESC`). **DELETE** the `easy_apply` param (no canonical field — the three sites express it incompatibly; inventing one would exceed the mapping doc's authority per FR-012) and the `dedup_status` param (`skip_reason` is gone). Default filter becomes `dismissed = false` — a deliberate behavior change (FR-019), replacing the old `skip_reason IS NULL` default. Keep `limit` 1–500 default 25, `offset`, and `total` (FR-020). ✅ 2026-07-15: verified — `?source_site=` filters to 1 each; default order is `scrape_time DESC`
- [X] T017 [US1] Rewrite `get_job` in `backend/routers/jobs.py` (`:982-992`, **CHANGED**) to return `ScrapedJobRead` (not the deleted `ScrapedJobDetail`) from the unified table by canonical id. 404-on-missing is **UNCHANGED**. ✅ 2026-07-15: 200 by canonical id, 404 on unknown
- [X] T018 [US1] Update `update_job` in `backend/routers/jobs.py` (`:995-1012`, **CHANGED**) to write the unified model. Contract **UNCHANGED**: `JobUpdate{dismissed}` in, `ScrapedJobRead` out — still the only mutable field (FR-023). ✅ 2026-07-15: **no code change needed** — it sets `dismissed`, which survives on the unified model, and its response model is now canonical. Verified live rather than assumed
- [X] T019 [US1] **DELETE** `list_skipped_jobs` (`GET /jobs/skipped`, `backend/routers/jobs.py:960-979`) per FR-024. No replacement. Remove the `ScrapedJobDetail` import and any other imports orphaned by T015–T019. ✅ 2026-07-15: route deleted; `ScrapedJobDetail` and `or_` imports removed (`or_` served only the deleted `dedup_status` block — confirmed by grep, since a naive search matches `_to_str_or_none`). **Note**: `/jobs/skipped` now returns **422**, not 404 — `/jobs/{job_id}` catches the path and fails UUID parsing. The route is gone either way
- [X] T020 [US1] Verify per quickstart.md §5, **excluding its cross-site ordering block**: `GET /jobs` returns canonical names (`source_site`/`title`/`location_text`/`posted_at`, **not** `website`/`job_title`), `?source_site=glassdoor` filters, and unauthenticated → **401** (FR-022). Also verify dismissal per §6: `PUT {dismissed:true}` removes it from the default listing, `?dismissed=true` brings it back (SC-009). **Do not verify SC-004 here** — `posted_at` is `None` until T024, so the ordering check would be vacuous rather than passing. It runs at T026. Expect `company`, `posted_at`, `remote`, `industry`, `salary_period` to be `None` at this point; that is Phase 5's work, not a defect. ✅ 2026-07-15: `GET /jobs` **200 (was 500)**, returns all three sites with canonical names; unauthenticated → **401**; `PUT {dismissed:true}` → excluded from the default listing (3→2), `?dismissed=true` → 1, and the flag survives a re-scrape (SC-009)

**Checkpoint**: A scan's results reach the frontend as canonical JSON — **SC-001 satisfied**. Field *names* are canonical and the three sites are attributed correctly; five field *values* are still `None` pending Phase 5, so **SC-003 and SC-004 are not yet met**. Demoable, not mergeable.

---

## Phase 5: User Story 3 - Every site's values land in the right canonical fields (Priority: P2)

**Goal**: The five non-trivial transforms are correct per site, not merely present.

**Independent Test**: Per site, ingest a posting with known source values; confirm each canonical field holds exactly what `docs/live-per-source-schemas.md` designates for that site.

**Why this is a separate phase**: mapping errors are **silent** — a posting with the wrong company or a 1970 date still renders and still passes Phase 3/4. These need their own assertions.

### Implementation for User Story 3

- [X] T021 [P] [US3] In `backend/core/scraped_job_projection.py` (**CHANGED**) implement the Indeed `company` fallback (FR-013): mosaic `company` first, else graphql `employer_name`. Implement `industry`: LinkedIn flattens `formatted_industries` jsonb → first element as text; Indeed → always `None`; Glassdoor → `industry` direct. ✅ 2026-07-15: fallback keys off `is not None`, not falsiness — an empty-string company still means mosaic answered. Verified on real payloads: LinkedIn → `lululemon`/`Retail`, Indeed → `Scotiabank`/`None`, Glassdoor → `Electronic Arts`/`Media and communication`
- [X] T022 [P] [US3] In `backend/core/scraped_job_projection.py` (**CHANGED**) implement `remote` (FR-014) as **tri-state**: LinkedIn `work_remote_allowed` and Indeed `remote_location` copy through (may be `None`); Glassdoor derives `True` when `remote_work_types` is present and non-empty, else **`None` — never `False`**. `None` means "the site didn't say", which is a different claim from "not remote". ✅ 2026-07-15: smoke test asserts both branches — the `None` case explicitly, since `False` would render identically and pass a weaker test
- [X] T023 [P] [US3] In `backend/core/scraped_job_projection.py` (**CHANGED**) implement `salary_period` normalization (FR-015) onto the canonical five — `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `ANNUAL` — case-insensitively per the token map in research.md R7. Unknown token → `None` period, **amounts retained**, and `logger.warning("projection_unknown_salary_period", ...)`. Never convert or annualize amounts (FR-015a). ✅ 2026-07-15: empty-string tokens return `None` **without** a warning — absent is not the same as unrecognized. See T026 for the live-data verification
- [X] T024 [P] [US3] In `backend/core/scraped_job_projection.py` (**CHANGED**) implement `posted_at` (FR-016) in Python, not SQL (research.md R8): LinkedIn `listed_at` and Indeed `pub_date` are epoch-**ms** → `datetime.fromtimestamp(ms/1000, tz=utc)`; Glassdoor `date_posted` is a date → midnight **UTC** (pinned, not server-local). Absent/non-numeric/out-of-range → `None` + `logger.warning("projection_bad_posted_at", ...)` — never fail the ingest (FR-017). ✅ 2026-07-15: range guard is 2000-01-01 … 2100-01-01, which catches a seconds-for-milliseconds error (it would land in 1970). Verified it rejects nothing real: live values span 2026-06-22 … 2026-07-15
- [X] T025 [US3] Extend `backend/smoke_test_scraped_jobs_merge.py` (**CHANGED**, from T013) with per-site projection assertions (FR-031): every canonical field holds the mapping doc's designated value for that site, explicitly covering the Indeed company fallback (both branches), the Glassdoor remote derivation (`True` and `None` cases), period normalization, and `posted_at` normalization. Assert a posting with no salary still creates a row with `None` fields rather than failing (FR-017). ✅ 2026-07-15: NULL-assertions replaced with real expected values. Added the four branches the happy path cannot reach — Indeed's company fallback (mosaic key deleted), Glassdoor remote absent → `None`, an unknown `FORTNIGHTLY` period → NULL period with amounts retained, and a salary-less posting still creating a row. **17 assertions, all passing**
- [X] T026 [US3] **Verify the inferred vocabulary against live data** — the one decision in this plan resting on inference, not observation (research.md R7). Run a real scan, then `docker compose logs backend | grep projection_unknown_salary_period`. **Any hit means a site emits a token the map misses and those postings have NULL periods** — add the token and re-run. An empty grep is the only evidence FR-015 actually holds. Also grep `projection_bad_posted_at` (expect none). ✅ 2026-07-15: **verified against the 939 real per-source rows already in the DB rather than a synthetic scan** — a stronger check, since it covers every token the sites have actually emitted. Ran `normalize_salary_period` over every distinct live token: `YEARLY`→ANNUAL (114), `HOURLY`→HOURLY (112), `ANNUAL`→ANNUAL (53), `WEEKLY`→WEEKLY (1), `''`→None. **Zero postings would lose their period.** The single live `WEEKLY` row vindicates the five-value vocabulary — the mapping doc's two exemplified values would have dropped it. `projection_bad_posted_at`: **0**; real epoch values span 2026-06-22 … 2026-07-15, none near 1970. Also projected 9 real payloads (3/site) end-to-end through the mapper with no errors
- [X] T026a [US3] Run the SC-004 checks deferred from T020, now that T024 populates `posted_at` (quickstart.md §5 cross-site ordering block): postings from all three sites interleave correctly when ordered by `posted_at DESC` — clustering by site implies a per-site scale error, and any 1970 value implies ms/s confusion. Confirm every resolved `salary_period` reads as one of the canonical five. Also verify SC-003: `title`, `company`, `location_text`, `apply_url` are populated wherever the source supplied them, across all three sites. ✅ 2026-07-15: automated in the smoke test rather than left manual — asserts the exact interleave (`glassdoor` 2026-07-01 > `indeed` 2025-07-02 > `linkedin` 2025-07-01) and rejects any pre-2000 date. Scoped to the run's own tag so a leftover row from a failed earlier run cannot make it nondeterministic

**Checkpoint**: All three sites project correctly. **SC-003 and SC-004 now satisfied** — the claims Phase 4's checkpoint deferred.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Lifecycle symmetry, retired surfaces, and the doc write-back. **T027–T030 are correctness, not polish** — without them the two stores drift.

- [X] T027 [P] In `backend/auto_scrape/auto_expiration.py` (**CHANGED**, `:33-41`) add a fourth `DELETE FROM scraped_jobs WHERE scrape_time < NOW() - make_interval(days => :d)` using the **identical predicate** and the caller's transaction (FR-027). Add it to the `deleted` dict. **No FK cascade is possible** — `source_row_id` is polymorphic (research.md R3). This works only because T008 copies `scrape_time` exactly. ✅ 2026-07-15: added by extending the existing loop tuple, so the predicate cannot drift between tables
- [X] T028 [P] In `backend/auto_scrape/matching_claim.py` (**CHANGED**, `:44-52`) add a fourth `UPDATE scraped_jobs SET matched = TRUE WHERE matched = FALSE` after the three per-source UPDATEs, in the caller's transaction (FR-028). Valid because dual-write guarantees 1:1 and both rows start `false`. Without this the canonical `matched` is permanently wrong — it is copied as `false` at ingest and nothing else would ever flip it. ✅ 2026-07-15: canonical rowcount added to the existing log line
- [X] T029 Extend `backend/smoke_test_auto_expiration.py` (**CHANGED**) to assert the canonical row is deleted when its per-source row expires (FR-032). **Existing per-source assertions must not change** — the unified assertion is additive (Principle II). Declared intentional change. ✅ 2026-07-15: `test_expires_old_rows` untouched; added `test_expires_canonical_rows_too`. Its fixtures insert the pair sharing **one** `scrape_time`, mirroring dual-write — letting the two default separately would not exercise the real predicate. Also asserts the SC-008 orphan count is 0
- [X] T030 Extend `backend/smoke_test_matched_claim.py` (**CHANGED**) to assert the claim reaches the canonical row (FR-033), including the `SELECT count(*) … WHERE s.matched <> l.matched` = 0 check from quickstart.md §7. **Existing per-source assertions must not change** (Principle II). Declared intentional change. ✅ 2026-07-15: three existing tests untouched; added `test_claim_reaches_canonical_row` (SC-010)
- [X] T031 In `backend/routers/admin_cleanup.py` (**CHANGED**) retire the three job sweeps per **D2 (APPROVED)**: delete `_delete_scraped_jobs_where` (`:17-33`) and the three `deleted_*` blocks (`:41-69`). Keep the stale-run-log sweep (`:71-87`) **UNCHANGED**. Keep all response keys returning `0` (Principle VII — forward-compatible outputs), following the `marked_failed_dedup_tasks` precedent already at `:89-91`. `CleanupInvalidEntriesResponse` schema is **UNCHANGED**. Comment why: adapting would break the 1:1 invariant or violate CC-1. ✅ 2026-07-15 (pulled forward into Phase 4 at the user's request): `_delete_scraped_jobs_where` and all three sweeps deleted; stale-run-log sweep kept. Orphaned imports removed (`Text`, `and_`, `delete`, `func`, `or_`, `select`, `ColumnElement`, `ScrapedJob`). Verified live: returns 200 with **all five keys present and the three retired ones at 0**
- [X] T032 Migrate `backend/smoke_test_auto_scrape.py` (**CHANGED**) off the legacy shape: its fixtures construct `ScrapedJob(...)` in the old column shape (`:332-384`) and assert `admin_cleanup` job-deletion counts. Rebuild the fixtures against the unified model and drop the job-deletion assertions (retired by T031). Depends on T031. Declared intentional change. ✅ 2026-07-15: fixtures **not rebuilt — deleted**. Rebuilding them against the unified model would have been pointless: the sweeps they fed are retired, so nothing would delete them. Replaced with a contract assertion that the endpoint keeps **all five response keys** and the three retired counters read 0 — which is the behavior consumers actually depend on. Also removed the now-unused `ScrapedJob` import. **Caught a second, unplanned break**: Phase 4c asserted `deleted_per_table` contains *only* the three per-source tables, so T027's fourth DELETE failed it. Updated the allowlist and added a positive assertion that `scraped_jobs` **is** present — omitting it would mean canonical rows outlive their source
- [X] T033 [P] Update `docs/live-per-source-schemas.md` (**CHANGED**) with the three departures FR-012 names — `dismissed` added, raw payload omitted, the five-value period vocabulary — so the doc stays the single source of truth. Also fix its dangling cross-reference to the deleted `docs/current-schemas.md` (flagged in the constitution's Sync Impact Report; Principle I treats a pointer to a deleted file as a fidelity defect). Also update the "Proposed unified" section's illustrative DDL to drop the two indexes CC-12 forbids. ✅ 2026-07-15: DDL is now as-built (22 cols incl. `dismissed`, 3 indexes, the two CC-12-forbidden ones removed with the reason recorded); `posted_at` transform corrected from `date_posted::timestamptz` to UTC-pinned-in-Python with the server-timezone rationale; both dangling `current-schemas.md` references replaced (footer now points at the builders + projection module as lineage truth); added as-built notes on the polymorphic no-FK constraint, the copied `scrape_time`, and lifecycle symmetry. Header now states the table is implemented rather than "proposed"
- [X] T034 Run the full quickstart.md validation and tick its Definition of Done. Confirm per-source column counts still **39 / 45 / 48** against the T002 baseline (FR-009, SC-005) and that all four smoke tests pass: `smoke_test_scraped_jobs_merge.py`, `smoke_test_auto_expiration.py`, `smoke_test_matched_claim.py`, `smoke_test_auto_scrape.py`. ✅ 2026-07-15: all 10 DoD items verified live against the running stack and ticked with their evidence. 4/4 smoke tests (63 assertions, checked by exit code); per-source 39/45/48 unchanged; orphans 0; claim disagreements 0. **One item was met by a different method than written** and is recorded as such rather than ticked silently: the period-vocabulary check ran the normalizer over every distinct token in the 939 live rows instead of grepping the log after a new scan — stronger coverage, but not the literal check. **This task was previously reported complete while still unchecked; caught by `/speckit-analyze` (H2).**

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: needs Setup — **BLOCKS all stories**
- **US2 (Phase 3)**: needs Foundational
- **US1 (Phase 4)**: needs Foundational; **needs US2 in practice** — its independent test requires ingested rows. The read path can be built against hand-inserted rows if parallelising
- **US3 (Phase 5)**: needs US2 (extends the merge smoke test and the mapper). **T026a also discharges SC-003/SC-004 on US1's behalf** — those checks moved out of T020 because `posted_at` does not exist until T024
- **Polish (Phase 6)**: T027/T028 need Foundational; T029/T030 need T027/T028; T032 needs T031; T034 needs everything

### Critical path

`T003 → T005 → T007 → T008 → T010 → T013 → T016 → T020` — table, model, migration applied, `scrape_time` returned, mapper wired, dual-write proven, listing rewritten, listing verified.

### Within-file serialization (these cannot be parallel despite different concerns)

- **`backend/routers/jobs.py`**: T008 → T009 → T010 → T011 → T012 → T016 → T017 → T018 → T019. One file, nine tasks, strictly sequential.
- **`backend/core/scraped_job_projection.py`**: T006 → (T021, T022, T023, T024). The Phase 5 four touch different functions in one file — parallel-safe **only** if each edits its own function; otherwise serialize.
- **`backend/smoke_test_scraped_jobs_merge.py`**: T013 → T014 → T025.

### Parallel Opportunities

- T002 alongside T001
- **T006 (mapper) alongside T003/T004/T005** — different file, no dependency. The single best parallelisation here: the mapper is pure functions and needs neither the table nor the model
- **T027 and T028** — different files (`auto_expiration.py`, `matching_claim.py`)
- **T021–T024** — same file, different functions; serialize if the editor conflicts
- **T033** — docs, independent of all code

---

## Parallel Example: Phase 2 Foundational

```bash
# Migration + model (sequential — T005's __table_args__ must match T004's indexes)
Task: "T003 Create migration 030_unified_scraped_jobs.py"
Task: "T004 Add the three permitted indexes to 030"
Task: "T005 Rewrite models/scraped_job.py to the unified shape"

# In parallel — different file, zero dependency on the table existing:
Task: "T006 Create core/scraped_job_projection.py with provenance + direct copies"
```

## Parallel Example: Phase 6 lifecycle symmetry

```bash
# Different files:
Task: "T027 Add 4th DELETE to auto_scrape/auto_expiration.py"
Task: "T028 Add 4th UPDATE to auto_scrape/matching_claim.py"

# Then their tests (each depends on its implementation):
Task: "T029 Extend smoke_test_auto_expiration.py"
Task: "T030 Extend smoke_test_matched_claim.py"
```

---

## Implementation Strategy

### MVP scope

**Phases 1–4 (T001–T020)** — Setup, Foundational, US2, US1. That delivers the feature's whole point: a scan's results reach the frontend as canonical JSON (SC-001). US3 hardens transform correctness; Phase 6 keeps the stores in step.

**Do not stop at the MVP in this case.** Unlike a typical feature, shipping Phases 1–4 alone leaves three known-wrong behaviors: `company`/`posted_at`/`remote`/`industry`/`salary_period` are all `None` (until Phase 5), `matched` on the canonical row is permanently `false` (until T028), and expiration accumulates orphans (until T027). The MVP is a valid demo checkpoint, not a valid merge.

### Incremental delivery

1. Phases 1–2 → foundation ready, backend boots
2. Phase 3 (US2) → dual-write proven atomic → **checkpoint**
3. Phase 4 (US1) → listing returns real data → **MVP demo**
4. Phase 5 (US3) → projection verified per site
5. Phase 6 → lifecycle symmetry + retired surfaces → **mergeable**

### Files never touched

`extension/` (D1 keeps `recordSkip` working), `frontend/` (FR-021 — spec 007's), `backend/core/database.py` (R1 — already correct), `backend/main.py`, `backend/scheduler.py`, `backend/auto_scrape/post_scrape_orchestrator.py`, and the three per-source tables' structure.

---

## Notes

- **Docker for everything.** Host Python is broken; a host failure is not a code signal
- **Never create a cascading FK on `source_row_id`** — polymorphic, impossible; the invariant is code-held
- **Never let canonical `scrape_time` default** — copy it from the per-source `RETURNING` (T008), or T027 leaves orphans
- **Never edit a smoke test until it passes.** T029/T030/T032 are declared intentional changes traceable to FR-032/FR-033/the legacy shape. Anything else is a Principle II violation
- Commit after each task or logical group
- The two approved deviations (D1 → T012, D2 → T031) are settled; implement as written
