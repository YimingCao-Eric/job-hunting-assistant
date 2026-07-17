---

description: "Task list for feature implementation"
---

# Tasks: Canonical Filter Columns on `scraped_jobs`

**Input**: Design documents from `/specs/009-canonical-filter-columns/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/canonical-columns.md](./contracts/canonical-columns.md), [quickstart.md](./quickstart.md)

**Tests**: Smoke-test tasks are **REQUIRED**, not optional. Constitution Principle II makes the
`smoke_test_*.py` suite the behavioral contract and requires permanent new behavior to be captured
by one. Every smoke-test edit here is **additive** — no existing assertion is modified or weakened
(declared in plan.md → Constitution Check).

**Organization**: Grouped by user story. Story → columns:

| Story | Priority | Columns |
|---|---|---|
| US1 | P1 | `employment_type`, `workplace_type` |
| US2 | P2 | `salary_disclosed` |
| US3 | P3 | `language`, `education_requirements` |

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths included in every task

## Path Conventions

Backend web service. Real paths from plan.md: `backend/alembic/versions/`, `backend/core/`,
`backend/models/`, `backend/smoke_test_*.py`, `docs/`.

---

## ⚠️ Two constraints that govern this whole list

**1. `CANONICAL_COLS` and the projection dict must move together — always.**
`project_to_canonical` guards them against each other (`backend/core/scraped_job_projection.py:301-307`):

```python
missing = set(CANONICAL_COLS) - set(canonical)
extra   = set(canonical) - set(CANONICAL_COLS)
if missing or extra:
    raise ValueError(...)
```

Adding a column name to `CANONICAL_COLS` **before** all three site projections return that key
raises `ValueError` on **every ingest**, for every site. Not a test failure — a 500 on live ingest.

**Therefore**: no task adds a name to `CANONICAL_COLS` except the task that simultaneously adds that
key to `_linkedin_projection`, `_indeed_projection`, **and** `_glassdoor_projection`. This is why
the foundational phase adds the *migration* and *ORM* but deliberately does **not** touch
`CANONICAL_COLS`. Each story owns its own columns end to end.

**2. Rebuild after every backend edit, or you are testing the old code.**
`backend` has no source mount — code is baked in at image build. Host edits change nothing until:

```bash
docker compose up -d --build backend
```

This fails **silently**: migration `030` once reported `029 (head)` and exited 0, exactly as if the
file didn't exist. Migrations run at container startup, so the rebuild also applies them.
**If a change seems to have no effect, suspect a stale image before suspecting your code.**

---

## Phase 1: Setup (Baseline Capture)

**Purpose**: Record the "before" state that the regression gates compare against. Nothing here
changes code.

- [X] T001 Confirm the migration chain head is `030` and unedited: `docker compose exec -T backend alembic current` and `docker compose exec -T backend alembic history | head -3`
- [X] T002 [P] ~~Capture the `GET /jobs` baseline for the FR-018 byte-identical diff~~ — **NEVER PERFORMED.** `031` shipped before a baseline was taken, making the planned diff permanently impossible. Objective met instead via FR-018a: `git diff` proves `ScrapedJobRead`/`routers/jobs.py` untouched, and 518 rows with populated columns are served at 22 fields with zero leakage. Recorded as superseded, not as done-as-written
- [X] T003 [P] ~~Record the pre-change green baseline by running all four smoke tests~~ — **NEVER PERFORMED** (no pre-change capture). All four pass now and every pre-existing assertion held throughout, so no regression is masked; but the "provably ours" argument this task existed to buy was never available

**Checkpoint**: Baseline captured — a later regression is provably ours.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Put the five columns in the database and the ORM. Populating them is story work.

**⚠️ CRITICAL**: No user story can begin until this phase is complete.

**⚠️ Do NOT touch `CANONICAL_COLS` in this phase** — see constraint 1 above. The columns exist and
stay NULL; nothing writes them yet, and nothing breaks.

- [X] T004 Create migration `backend/alembic/versions/031_scraped_jobs_filter_columns.py` with `revision = "031"`, `down_revision = "030"`, adding five nullable columns to `scraped_jobs` — `employment_type varchar(16)`, `workplace_type varchar(16)`, `language varchar(8)`, `education_requirements text`, `salary_disclosed boolean` — with **no defaults**, **no indexes**, **no constraints** (per data-model.md → Added DDL; CC-12; FR-002)
- [X] T005 Implement a real `downgrade()` in `backend/alembic/versions/031_scraped_jobs_filter_columns.py` dropping the five columns (unlike `030`'s, which raises — dropping five additive columns is exact and lossless; research.md R6)
- [X] T006 [P] Add the five `mapped_column` definitions to `ScrapedJob` in `backend/models/scraped_job.py`, matching T004's types/nullability, so the ORM mirrors the table. Do **not** alter `__table_args__` — the index count stays at three
- [X] T007 Add the shared normalized-token helper to `backend/core/scraped_job_projection.py` — `strip()`, `upper()`, spaces and hyphens → `_` (FR-005a) — beside the existing `normalize_salary_period`. Used by US1 and US2; foundational to avoid three stories editing one helper
- [X] T008 Rebuild and verify: `docker compose up -d --build backend`, then `docker compose exec -T postgres psql -U jha -d jha -c '\d scraped_jobs'` shows **27 columns**, all five nullable with no defaults, and **exactly three indexes** (`scraped_jobs_pkey`, `scraped_jobs_job_url_key`, `ix_scraped_jobs_scan_run_id`)
- [X] T009 Confirm the foundation is inert: re-run `backend/smoke_test_scraped_jobs_merge.py` and ~~diff `GET /jobs` against the baseline~~ — baseline never existed (T002); FR-018 closed by the stronger route in FR-018a instead — both must be unchanged, because nothing populates the new columns yet

**Checkpoint**: 27 columns exist and are NULL. Ingest, `GET /jobs`, and all four smoke tests are
exactly as before. User stories can now begin — but **only one at a time** (see Dependencies).

---

## Phase 3: User Story 1 - Filter by employment type and workplace type (Priority: P1) 🎯 MVP

**Goal**: `employment_type` and `workplace_type` populate across all three sites with one canonical
vocabulary, readable from `scraped_jobs` alone.

**Independent Test**: Ingest a full-time remote posting from each of the three sites; all three
canonical rows carry `employment_type = FULL_TIME` and `workplace_type = REMOTE`. Sites that say
nothing yield NULL.

### Implementation for User Story 1

- [X] T010 [US1] Add `normalize_employment_type(raw, *, site)` to `backend/core/scraped_job_projection.py` implementing the FR-005a token table (`FULL_TIME`/`FULLTIME`, `PART_TIME`/`PARTTIME`, `CONTRACT`/`CONTRACTOR`, `TEMPORARY`/`TEMP`, `INTERNSHIP`/`INTERN`, `VOLUNTEER`) and the FR-008a precedence `FULL_TIME › PART_TIME › CONTRACT › TEMPORARY › INTERNSHIP › VOLUNTEER`, accepting a single value or a list
- [X] T011 [US1] Implement the three-way value classification from FR-008d in the same helper: **mappable** → competes by precedence; **recognized-but-unmappable** (`OTHER` only) → skipped, **no warning**; **unrecognized** → skipped, warns `projection_unknown_employment_type` with `{site, raw}`. Classify **before** ranking (FR-008b) — an unrecognized token must never outrank a recognized one, and `OTHER` must never reach the logger (SC-009)
- [X] T012 [US1] Add `normalize_workplace_type(raw, *, site)` to `backend/core/scraped_job_projection.py`: tokens `REMOTE`/`FULLY_REMOTE`/`WORK_FROM_HOME`, `HYBRID`, `ONSITE`/`IN_PERSON`/`IN_OFFICE`; precedence `REMOTE › HYBRID › ONSITE`; unrecognized warns `projection_unknown_workplace_type`. Selection must be order-independent (FR-008, SC-003a)
- [X] T013 [US1] Add the LinkedIn remote-contradiction warning to `backend/core/scraped_job_projection.py`: when `workplace_types_labels` and `work_remote_allowed` disagree, log `projection_workplace_remote_conflict` with `{site, remote_allowed, labels}`. Labels win for `workplace_type`; **`remote` is not touched** (FR-009b). Name it apart from the `unknown_*` family — it is an upstream data conflict, not a vocabulary gap, and must not pollute the FR-005d review (research.md R4)
- [X] T014 [US1] Add both keys to `_linkedin_projection` in `backend/core/scraped_job_projection.py`: `employment_type` from `formatted_employment_status`, `workplace_type` from `workplace_types_labels` (labels win over `work_remote_allowed`)
- [X] T015 [US1] Add both keys to `_indeed_projection` in `backend/core/scraped_job_projection.py`: `employment_type` from the `job_types` list; `workplace_type` from `remote_location` — `true` → `REMOTE`, `false` → `ONSITE`, `None` → `None`. Comment that `ONSITE` here means only "not remote" (FR-009, accepted mislabel of hybrid)
- [X] T016 [US1] Add both keys to `_glassdoor_projection` in `backend/core/scraped_job_projection.py`: `employment_type` from the per-source `employment_type` list, falling back to `job_type` **only when the structured field is NULL or an empty list** (an empty list is absence; a list holding only `OTHER` is present and yields NULL without falling back — data-model.md). `workplace_type` from `remote_work_types`. **Comment the name collision**: `p.get("employment_type")` is Glassdoor's per-source jsonb list, while the returned `"employment_type"` key is the canonical token
- [X] T017 [US1] Append `"employment_type"` and `"workplace_type"` to `CANONICAL_COLS` in `backend/core/scraped_job_projection.py`. **Only now** — T014–T016 must all be complete or every ingest raises `ValueError`. `INSERT_SCRAPED_JOB` in `backend/routers/jobs.py` needs **no edit**; it derives from this list (`jobs.py:334`)
- [X] T018 [US1] Extend the `CASES` table in `backend/smoke_test_scraped_jobs_merge.py` (line ~167) with expected `employment_type` / `workplace_type` per site, under the existing "Transforms" comment grouping. **Additive only** — do not modify an existing expectation
- [X] T019 [US1] Add smoke assertions to `backend/smoke_test_scraped_jobs_merge.py`: a multi-tagged posting resolves by precedence (spec US1 scenario 4); the same posting with values in **reversed order** yields the identical token (SC-003a); an unrecognized value alongside a recognized one yields the recognized one (scenario 7); an `Other` status yields NULL and emits **no warning** (scenario 9)
- [X] T020 [US1] Rebuild (`docker compose up -d --build backend`), run `backend/smoke_test_scraped_jobs_merge.py`, and ~~diff `GET /jobs` against the baseline~~ — baseline never existed (T002); FR-018 closed by the stronger route in FR-018a instead — must be byte-identical (FR-018)

**Checkpoint**: US1 is independently shippable. `employment_type`/`workplace_type` populate;
`language`, `education_requirements`, `salary_disclosed` remain NULL and unwritten.

---

## Phase 4: User Story 2 - Distinguish employer-stated salaries from site estimates (Priority: P2)

**Goal**: `salary_disclosed` separates employer-published pay from site-generated estimates.

**Independent Test**: Ingest one employer-salary and one site-estimate posting per site; the two
groups are separable by `salary_disclosed` reading `scraped_jobs` alone.

### Implementation for User Story 2

- [X] T021 [US2] Add `derive_salary_disclosed(raw, *, site)` to `backend/core/scraped_job_projection.py` implementing FR-010a **positive evidence only**: employer tokens (`EMPLOYER`, `EMPLOYER_PROVIDED`, `EMPLOYER_PROVIDED_SALARY`) → `True`; estimate tokens (`ESTIMATE`, `ESTIMATED`, `INDEED_ESTIMATE`, `GLASSDOOR_ESTIMATE`) → `False`; absent/empty → `None`
- [X] T022 [US2] In the same helper, an **unrecognized** token must yield `None` **and** warn `projection_unknown_salary_source` with `{site, raw}` — **never `False`** (FR-010b). `False` is a positive claim that the site estimated the pay; inferring it from an unreadable token asserts something unknown
- [X] T023 [US2] Add `salary_disclosed` to `_linkedin_projection` in `backend/core/scraped_job_projection.py` from the `salary_provided_by_employer` boolean: `True` → `True`, `False` → `False`, absent → `None`. It admits no unrecognized state, so it bypasses the token helper (FR-010c)
- [X] T024 [US2] Add `salary_disclosed` to `_indeed_projection` in `backend/core/scraped_job_projection.py` from `salary_snippet_source` via T021's helper
- [X] T025 [US2] Add `salary_disclosed` to `_glassdoor_projection` in `backend/core/scraped_job_projection.py` from `salary_source` via T021's helper. **Add a comment recording the known limitation** (research.md R2, verified): `salary_source` comes from `jobDetailsData` while this row's `salary_min`/`max` come from the employer's JSON-LD `baseSalary` — two payloads, so the flag may describe a different figure than the amounts beside it. Inherited from 008 (`salary_period` splits the same way); **do not "fix" it here** (FR-020, Principle III)
- [X] T026 [US2] Append `"salary_disclosed"` to `CANONICAL_COLS` in `backend/core/scraped_job_projection.py` — **only after** T023–T025 are all complete
- [X] T027 [US2] Extend the `CASES` table in `backend/smoke_test_scraped_jobs_merge.py` with expected `salary_disclosed` per site (employer → `True`, estimate → `False`). **Additive only**
- [X] T028 [US2] Add smoke assertions to `backend/smoke_test_scraped_jobs_merge.py`: a posting quoting no salary yields `salary_disclosed = None`, not `False` (US2 scenario 4); an unrecognized salary-source token yields `None` **and** warns, never `False` (US2 scenario 5)
- [X] T029 [US2] Rebuild, run `backend/smoke_test_scraped_jobs_merge.py`, and re-~~diff `GET /jobs` against the baseline~~ — baseline never existed (T002); FR-018 closed by the stronger route in FR-018a instead

**Checkpoint**: US1 + US2 both work. `language` and `education_requirements` remain NULL.

---

## Phase 5: User Story 3 - Language and education requirements (Priority: P3)

**Goal**: `language` (Indeed-only) and `education_requirements` (Glassdoor-only) populate where
supplied, NULL everywhere else.

**Independent Test**: Ingest from all three sites; `language` is populated only on Indeed rows,
`education_requirements` only on Glassdoor rows, both NULL elsewhere, and no ingest fails.

### Implementation for User Story 3

- [X] T030 [P] [US3] Add `normalize_language(raw, *, site)` to `backend/core/scraped_job_projection.py`: lowercase, trim, **drop any region subtag** so `en-US`/`en_US`/`EN`/`en` all yield `en` (FR-011a). Present-but-implausible → `None` + `projection_bad_language`; absent/empty → `None`, no warning (FR-011b). **No allow-list** — shape is validated, membership is not (FR-012c's sibling rule)
- [X] T031 [P] [US3] Add `join_education_labels(raw)` to `backend/core/scraped_job_projection.py`: join all non-blank labels with `"; "` in source order, dropping blanks; a single label yields itself with no separator; an all-blank or empty list is **absence** → `None`. It **never warns and never validates** — any text the site supplies is valid (FR-012b, FR-012c)
- [X] T032 [US3] Add `language: None` and `education_requirements: None` to `_linkedin_projection` in `backend/core/scraped_job_projection.py`, with a comment that LinkedIn supplies neither — mirroring how `experience_level`/`industry` already designate NULL for Indeed (FR-011, FR-012)
- [X] T033 [US3] Add `language` (from `language`, via T030) and `education_requirements: None` to `_indeed_projection` in `backend/core/scraped_job_projection.py`
- [X] T034 [US3] Add `language: None` and `education_requirements` to `_glassdoor_projection` in `backend/core/scraped_job_projection.py` — `education_labels` via T031, falling back to `experience_requirements_description` when the labels are absent. **Comment the accepted duplication** (FR-012a): on fallback this holds the same text as `experience_level`, which projects that same field; `experience_level` must not change (FR-020)
- [X] T035 [US3] Append `"language"` and `"education_requirements"` to `CANONICAL_COLS` in `backend/core/scraped_job_projection.py` — **only after** T032–T034 are all complete. This completes the five; `CANONICAL_COLS` now has 24 entries and the INSERT writes all 27 columns minus the three the DB supplies
- [X] T036 [US3] Extend the `CASES` table in `backend/smoke_test_scraped_jobs_merge.py` with expected `language` / `education_requirements` per site — explicitly asserting `None` for the sites that do not supply each (US3 scenarios 2 and 5). **Additive only**
- [X] T037 [US3] Add a smoke assertion to `backend/smoke_test_scraped_jobs_merge.py` that a Glassdoor posting with several education labels yields all of them joined in source order by `"; "`, none dropped (US3 scenario 4)
- [X] T038 [US3] Rebuild, run `backend/smoke_test_scraped_jobs_merge.py`, and re-~~diff `GET /jobs` against the baseline~~ — baseline never existed (T002); FR-018 closed by the stronger route in FR-018a instead

**Checkpoint**: All five columns populate. All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the required evidence step, and the fidelity defects found while planning.

- [X] T039 [P] Update the merged-table section of `docs/live-per-source-schemas.md`: 22 → **27 columns**, the as-built DDL block, and a per-site column→source→transform row for each of the five, matching the tables in [data-model.md](./data-model.md)
- [X] T040 Add the FR-009a note to `docs/live-per-source-schemas.md` — **required by the spec, not optional**: `workplace_type` and `remote` can disagree (Glassdoor hybrid-only rows read `remote = true` + `workplace_type = HYBRID`; LinkedIn reads two different source fields entirely), so the future service's authors find it before depending on `remote`. Also record the R2 Glassdoor `salary_disclosed` cross-payload limitation
- [X] T040a Carry the **consumer rules** into `docs/live-per-source-schemas.md` beside the new columns — not just the discrepancy note. Today FR-008c and FR-009c exist only in `specs/009-canonical-filter-columns/contracts/canonical-columns.md`, a spec-directory artifact the future service's authors have no reason to open; the constitution names `docs/live-per-source-schemas.md` as authoritative runtime guidance, so the contract must live there. Record, sourced from [contracts/canonical-columns.md](./contracts/canonical-columns.md): (a) **FR-009c** — `workplace_type` is not a refinement of `remote`; pick one column per filter and never mix them; (b) **FR-008c** — multi-valued postings are lossy, the winning token is chosen by precedence and the discarded values survive only on the per-source row via `source_row_id`; (c) NULL means "we don't know", never "no" — an exclusion filter silently drops NULL rows; (d) Indeed `ONSITE` means only "not remote" (FR-009)
- [X] T041 Record in `docs/live-per-source-schemas.md` that the two vocabularies are **reasoned, not observed** (FR-005b) and that the six tokens `PERMANENT`, `FREELANCE`, `PER_DIEM`, `APPRENTICESHIP`, `COMMISSION`, `NEW_GRAD` are deliberately unmapped pending live evidence (FR-005c)
- [X] T042 Run all four smoke tests in `backend/` — the three untouched ones must pass **unedited** (FR-022). A failure in a *pre-existing* assertion of `smoke_test_scraped_jobs_merge.py` is a real regression, not a test to update (Principle II)
- [X] T043 Run a real scan covering **all three sites**, then verify per-site population with the query in [quickstart.md](./quickstart.md) Step 4: `language` non-zero for Indeed only, `education_requirements` non-zero for Glassdoor only, zero for the other sites (SC-004)
- [X] T044 **⚠️ REQUIRED — the FR-005d warning review.** `docker compose logs backend | grep -E "projection_(unknown_employment_type|unknown_workplace_type|unknown_salary_source|bad_language|workplace_remote_conflict)"`. This is a step of the feature, not follow-up — until it runs, no claim about population rates is evidence-based (FR-005b, SC-008).
  - **Owner**: whoever implements this feature. It is not delegable to a later reader, because only this author knows which tokens were guessed (FR-005c) versus attested.
  - **Exit condition** (all three, or the feature is not done): every **distinct** raw value in the output is either mapped in FR-005a or listed as consciously-unmapped with a reason; a re-scan after any mapping change emits **zero** warnings for normally-behaving postings (SC-009); and every site absent from the scan is named as still-unverified.
  - **Output location**: the decision is written to the FR-005a mapping tables in [spec.md](./spec.md) **and** the merged-table section of `docs/live-per-source-schemas.md` (T045). A review whose outcome is recorded nowhere has not happened.
  - **Do not silently pass on zero output**: zero warnings from a scan that returned no Glassdoor postings is not evidence about Glassdoor. Record which sites the scan actually covered.
- [X] T045 Update the FR-005a mapping tables in [spec.md](./spec.md) and `docs/live-per-source-schemas.md` with whatever T044 revealed, then re-check SC-009: a scan of normally-behaving postings — **including `Other` statuses** — must emit **zero** warnings for these five attributes
- [X] T046 [P] Fix the fidelity defect in `README.md:136`: it says smoke tests "expect migrations through **029**" — the head is now `031`. Stale since 008
- [X] T047 Walk [quickstart.md](./quickstart.md) end to end and tick its "Done when" list, including the "Known-good deviations — do not fix these" table so the six deliberate behaviors are not mistaken for bugs by the next reader

> **Deliberately NOT a task: amending `.specify/memory/constitution.md`.** Principle II enumerates
> three smoke tests but **four** exist (`smoke_test_scraped_jobs_merge.py`, added by 008), and
> FR-022 inherits the stale list by reference. A draft T046 fixed it inline and was **dropped**:
> Governance requires every amendment to carry "a documented change to this file, a version bump per
> the policy below, and propagation to dependent Spec Kit templates" — none of which belongs in an
> unrelated feature's diff. Correcting the list is a **PATCH-level** constitution change
> (factual correction, no principle redefined) and belongs in its own `/speckit-constitution` run.
>
> **This feature is unaffected**: the authoritative suite is the four files on disk (research.md
> R5), and FR-022/FR-022a bind assertions rather than the constitution's enumeration. Recorded in
> plan.md → "Fidelity defects found while planning" so it is not lost.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. Must precede any code change, since T002/T003 capture the baseline the regression gates compare against.
- **Foundational (Phase 2)**: Depends on Setup. **BLOCKS all user stories.**
- **User Stories (Phase 3–5)**: All depend on Foundational. **Run sequentially — see below.**
- **Polish (Phase 6)**: Depends on all three stories. T044/T045 additionally depend on a real scan (T043).

### ⚠️ User stories are NOT parallelizable here

The template's default assumption — stories touch different modules, so staff them concurrently —
**does not hold for this feature**. All three stories edit the same two files:
`backend/core/scraped_job_projection.py` and `backend/smoke_test_scraped_jobs_merge.py`.

Worse than merge conflicts: each story ends by appending to `CANONICAL_COLS`, and two stories
appending concurrently would leave a name in that list whose keys aren't in every projection —
`ValueError` on **every ingest** (see constraint 1).

**Run US1 → US2 → US3 sequentially.** Each is independently *shippable* and *testable* — which is
what the story split buys here — but not independently *developable in parallel*. One developer, in
priority order.

### Within Each User Story

Strict order, and the reason matters:

1. Helpers first (pure functions, no callers yet — safe)
2. Then all three site projections (`_linkedin` → `_indeed` → `_glassdoor`)
3. **Then, and only then, `CANONICAL_COLS`** — the guard is unforgiving
4. Then smoke expectations
5. Then rebuild + verify

### Parallel Opportunities

Genuinely few. Real ones only:

- **T002 + T003** — different outputs, no code touched
- **T004/T005 (migration) ∥ T006 (ORM model)** — different files. T007 also touches `scraped_job_projection.py`, so it is **not** parallel with story work
- **T030 ∥ T031** — the only intra-story pair: both add new pure functions to the same file with no shared lines. Sequence them if your tooling can't merge cleanly
- **T039/T040/T040a/T041 (docs) ∥ T046 (README fidelity fix)** — different files
- Everything else is sequential on `backend/core/scraped_job_projection.py`

---

## Parallel Example: Phase 2 Foundational

```bash
# Different files — safe together:
Task: "Create migration backend/alembic/versions/031_scraped_jobs_filter_columns.py"
Task: "Add five mapped_column definitions to ScrapedJob in backend/models/scraped_job.py"

# Then, alone (touches scraped_job_projection.py, which every story also touches):
Task: "Add the shared normalized-token helper to backend/core/scraped_job_projection.py"

# Then, always, before testing anything:
docker compose up -d --build backend
```

## Parallel Example: Phase 6 Polish

```bash
# Different files — safe together:
Task: "Update merged-table section of docs/live-per-source-schemas.md"   # T039/T040/T040a/T041
Task: "Fix 'migrations through 029' in README.md:136"                    # T046

# NOT here: amending .specify/memory/constitution.md. Dropped deliberately —
# it needs a version bump and template propagation, so it gets its own
# /speckit-constitution run, not a ride in this feature's diff.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup — capture the baseline
2. Phase 2: Foundational — migration + ORM (**blocks everything**)
3. Phase 3: US1 — `employment_type` + `workplace_type`
4. **STOP and VALIDATE**: merge smoke test green; `GET /jobs` byte-identical; the three untouched smoke tests still pass unedited
5. Shippable. The canonical table is filterable on the two highest-value axes; the other three columns are NULL and unwritten

### Incremental Delivery

1. Setup + Foundational → 27 columns exist, all NULL, nothing else changed
2. + US1 → **MVP**: employment/workplace filtering across all three sites
3. + US2 → employer-vs-estimate salary provenance
4. + US3 → language and education attributes
5. + Polish → docs current, **warning review done** (T044 — the feature is not finished without it)

Each increment leaves ingest, `GET /jobs`, and the full smoke suite green.

### Team Strategy

**One developer, sequential.** Splitting US1/US2/US3 across people means concurrent edits to
`scraped_job_projection.py` and races on `CANONICAL_COLS`. The only safe split is docs (Phase 6
`[P]` tasks) alongside late story work.

---

## Notes

- **[P] = different files.** Applied sparingly here on purpose — most of this feature lives in one module
- Every smoke-test edit is **additive**; a failing *pre-existing* assertion is a regression, not a test to update (Principle II)
- Commit after each task or logical group; `031` is a **new** migration and `030` is never edited (Principle IV)
- **Rebuild after every backend edit** — the silent failure mode is the expensive one
- Six behaviors in this feature look like bugs and are deliberate decisions. Before "fixing" one, read quickstart.md → "Known-good deviations"
- Stop at any checkpoint: each leaves the system green and shippable
