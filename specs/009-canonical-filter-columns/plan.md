# Implementation Plan: Canonical Filter Columns on `scraped_jobs`

**Branch**: `031-scraped-jobs-matching-columns` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-canonical-filter-columns/spec.md`

## Summary

Add five nullable canonical columns to the derived `scraped_jobs` table — `employment_type`,
`workplace_type`, `language`, `education_requirements`, `salary_disclosed` — populated inside the
existing atomic dual-write at ingest, so a future filtering/matching service can read
`scraped_jobs` alone.

The approach is deliberately narrow because feature 008 already built every mechanism this needs.
The projection module (`core/scraped_job_projection.py`) is a set of pure functions over the
per-source params dict; `CANONICAL_COLS` is the single source of truth for the INSERT column list;
and the dual-write already runs in the request transaction. This feature adds **five values to an
existing dict** and **one migration**. It writes no new module, no new query path, and no new HTTP
surface.

Three facts verified against the code shape the plan:

1. **`INSERT_SCRAPED_JOB` needs no edit.** It is generated from `CANONICAL_COLS`
   (`routers/jobs.py:334-341`). Appending to that list updates the statement automatically — the
   two "cannot drift apart" by construction.
2. **`GET /jobs` is unchanged for free.** It selects the ORM entity but serializes through
   `ScrapedJobRead`, an explicit Pydantic field list (`schemas/scraped_job.py:43`). Not extending
   that schema keeps the response byte-identical (FR-018).
3. **Re-scrape needs no new rule.** The canonical INSERT is `ON CONFLICT (job_url) DO NOTHING`
   (`routers/jobs.py:340`), so an existing row's five attributes are never recomputed.

## Technical Context

**Language/Version**: Python 3.11 (backend container; the host interpreter is broken — all Python
runs via Docker)

**Primary Dependencies**: FastAPI, SQLAlchemy 2.x (async), Alembic, asyncpg

**Storage**: PostgreSQL (system of record). Migration head is `030`; this feature adds `031`.

**Testing**: `backend/smoke_test_*.py` — HTTP + DB scripts run against a live API, not pytest.
`smoke_test_scraped_jobs_merge.py` is the 008 projection test and this feature's primary target.

**Target Platform**: Linux server (Docker Compose)

**Project Type**: Web service (FastAPI backend) + Chrome MV3 extension scraper + React UI. This
feature touches the backend only.

**Performance Goals**: Ingest performs the same number of database statements per posting as before —
one per-source INSERT, one canonical INSERT (SC-007). The added work is five in-memory value mappings
on data already in hand: zero added queries, round trips, or reads. A structural claim, checkable by
inspecting the ingest path, not a timing target needing a benchmark harness.

**Constraints**: Strictly additive (FR-020). Per-source tables untouched (FR-016). `GET /jobs`
byte-identical (FR-018). No indexes beyond PK/unique/FK (CC-12).

**Scale/Scope**: 1 migration, 1 projection module, 1 ORM model, 1 doc, 1 smoke test. ~5 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. As-Built Fidelity** | Spec/plan describe existing behavior truthfully; discovered doc rot corrected | ✅ PASS — Context section verified against `scraped_job_projection.py` and `jobs.py`. Three fidelity defects found and routed (see Complexity Tracking): Constitution §II's stale smoke-test list, `README.md` "migrations through 029", and the Glassdoor cross-payload salary split. |
| **II. Smoke Tests Are the Behavioral Contract** | New permanent behavior captured by a smoke test; intentional test changes declared | ⚠️ PASS WITH DECLARATION — `smoke_test_scraped_jobs_merge.py` is extended **additively**. No existing assertion is modified or weakened. Declared below; see Complexity Tracking row 1 for the FR-022 tension. |
| **III. Surgical, Behavior-Preserving Change** | Smallest edit; no drive-by refactors | ✅ PASS — five entries added to an existing dict/list; no restructuring. `remote`, `experience_level`, and `salary_period` are left alone despite known imperfections (FR-009a, FR-012a). |
| **IV. Migration & Schema Discipline** | New migration off head; never edit existing; snake_case; atomic; no speculative indexes (CC-12) | ✅ PASS — `031` chains off `030` (verified head). Five snake_case columns, **zero indexes**. |
| **V. Data-Model Invariants** | Raw stays source-shaped; normalization on the derived row; atomic dual-write; lifecycle symmetry | ✅ PASS — per-source tables untouched (FR-016); all five transforms land on the canonical row (CC-10/CC-11); values are projected from the same params dict the per-source row is written from, inside the same transaction (FR-015/FR-017). No lifecycle change: `matched`/`dismissed`/expiration untouched. |
| **VI. Async Background Execution** | Background work uses `asyncio.create_task` + own session | ✅ N/A — ingest is request-scoped; this feature adds no background work. |
| **VII. Auth Boundary & Forward-Compatible Outputs** | All routes but `/health` require bearer auth; JSONB outputs additive | ✅ PASS — no route added or altered. `ScrapedJobRead` deliberately **not** extended, so no output changes at all. |

**Post-Phase-1 re-check**: ✅ PASS — no gate regressed. Design added no module, no index, no route,
and no per-source write. The one deviation (FR-022's literal wording vs Principle II) is recorded
in Complexity Tracking with its justification.

## Project Structure

### Documentation (this feature)

```text
specs/009-canonical-filter-columns/
├── spec.md              # Feature specification (/speckit-specify, /speckit-clarify)
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0 output — 6 decisions resolved
├── data-model.md        # Phase 1 output — column contract + projection rules
├── quickstart.md        # Phase 1 output — how to validate this end to end
├── contracts/
│   └── canonical-columns.md   # Phase 1 output — the contract offered to the future consumer
├── checklists/
│   ├── requirements.md  # Spec quality checklist (21/21)
│   └── data-model.md    # Requirements-quality checklist (49 items) — findings routed into research.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/
├── alembic/versions/
│   ├── 030_unified_scraped_jobs.py          # UNCHANGED — never edited (Principle IV)
│   └── 031_scraped_jobs_filter_columns.py   # NEW — five nullable columns, no indexes
├── core/
│   └── scraped_job_projection.py            # MODIFIED — new pure transforms + 5 keys per site
├── models/
│   └── scraped_job.py                       # MODIFIED — five mapped columns (ORM mirrors table)
├── routers/
│   └── jobs.py                              # UNCHANGED — INSERT derives from CANONICAL_COLS
├── schemas/
│   └── scraped_job.py                       # UNCHANGED — deliberately; this is what preserves GET /jobs
└── smoke_test_scraped_jobs_merge.py         # MODIFIED — additive assertions only

docs/
└── live-per-source-schemas.md               # MODIFIED — merged-table section: 22 → 27 columns
```

**Structure Decision**: Existing backend layout, unchanged. Every file above already exists except
migration `031`. No new package or module — the constitution forbids parallel/catch-all modules,
and the projection module is exactly where per-site normalization belongs.

### UNCHANGED vs NEW (explicit, per request)

| File / symbol | Verdict | Why |
|---|---|---|
| `alembic/versions/031_scraped_jobs_filter_columns.py` | **NEW** | Five nullable columns; `down_revision = "030"`; no indexes (CC-12) |
| `core/scraped_job_projection.py` → `CANONICAL_COLS` | **MODIFIED** | Append 5 names. This is the *only* change needed to reach the INSERT |
| `core/scraped_job_projection.py` → transforms | **NEW (in existing file)** | `normalize_employment_type`, `normalize_workplace_type`, `normalize_language`, `derive_salary_disclosed`, `join_education_labels` — pure functions beside the existing ones |
| `core/scraped_job_projection.py` → `_linkedin/_indeed/_glassdoor_projection` | **MODIFIED** | +5 keys each |
| `models/scraped_job.py` → `ScrapedJob` | **MODIFIED** | +5 `mapped_column`s so the ORM mirrors the table |
| `routers/jobs.py` → `INSERT_SCRAPED_JOB` | **UNCHANGED** | Generated from `CANONICAL_COLS` (`jobs.py:334`) — updates itself |
| `routers/jobs.py` → `_write_canonical_row`, `build_*_params` | **UNCHANGED** | All 13 source fields are already in the params dicts (verified) |
| `routers/jobs.py` → `GET /jobs`, `PATCH`, ingest routes | **UNCHANGED** | FR-018/FR-019 |
| `schemas/scraped_job.py` → `ScrapedJobRead` | **UNCHANGED — deliberate** | Not extending it is *what makes* the response identical. The columns exist in the DB and ORM but are not exposed; the future service reads the table, not this API |
| `models/linkedin_job.py`, `indeed_job.py`, `glassdoor_job.py` | **UNCHANGED** | FR-016 — raw stays source-shaped |
| `alembic/versions/030_*.py` and earlier | **UNCHANGED** | Principle IV — existing migrations are never edited |
| `smoke_test_scraped_jobs_merge.py` | **MODIFIED (additive)** | New expectations in `CASES` + new edge-case tests. No existing assertion touched |
| `smoke_test_auto_scrape/_matched_claim/_auto_expiration.py` | **UNCHANGED** | Must pass as-is (FR-022) |
| `docs/live-per-source-schemas.md` | **MODIFIED** | Merged-table section + the FR-009a `remote` discrepancy note |

## Complexity Tracking

> Deviations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Editing a smoke test, against FR-022's literal wording** ("all existing smoke tests MUST pass unchanged... any smoke-test edit would signal an unintended regression") | Constitution Principle II **requires** permanent new behavior to be captured by a smoke test. The two rules collide only on wording: FR-022's intent is "no existing assertion is weakened to make this pass", which the plan honors — every edit to `smoke_test_scraped_jobs_merge.py` is *additive*. Declared here per Principle II's requirement that intentional test changes be named. | Leaving the smoke test alone would violate Principle II and ship five columns with zero executable contract. Writing a *new* smoke-test file was rejected: the merge test already owns the projection contract and its `CASES` table is the natural extension point; a parallel file would split one contract across two places. |
| **`ScrapedJob` ORM model gains columns that no API exposes** | The model is the model *of that table*; omitting the columns would make it lie about the schema, and the future service will read them through it. | Leaving the ORM untouched and reaching the columns only via raw SQL was rejected — it would leave `models/scraped_job.py` describing a table that no longer exists as described, a Principle I defect in code. Cost is 5 extra small columns per `GET /jobs` row fetched from PG and discarded at serialization; response unchanged, no extra query. |
| **`salary_disclosed` on Glassdoor may describe different figures than the row's own salary amounts** | Implemented as the spec directs (FR-010, FR-005a). Verified: `salary_source` ← `jobDetailsData.salarySource` (`jobs.py:611`) while `jsonld_salary_min/max` ← the employer's JSON-LD `baseSalary` (`jobs.py:628`) — **two payloads**. Shipped 008 already splits this way (`salary_period` ← `jobDetailsData.payPeriod`, `jobs.py:610`), so this is inherited, not introduced. | "Fixing" it here was rejected as out of scope and a Principle III violation — it would change shipped 008 semantics under a feature that promises to be additive (FR-020). Routed instead to research.md R2: implement as specified, document the limitation in `docs/live-per-source-schemas.md`, and surface it for the FR-005d review. **Recommend a follow-up spec** if employer-vs-estimate precision on Glassdoor turns out to matter. |

### Fidelity defects found while planning (Principle I — flagged, not silently fixed)

- **Constitution §II names three smoke tests; four exist.** `smoke_test_scraped_jobs_merge.py`
  (added by 008) is missing from the list, and FR-022 inherits the omission by reference. The
  authoritative list for this feature is the four files on disk (research.md R5).
  **Not fixed by this feature, deliberately.** A draft task amended the constitution inline and was
  dropped: Governance requires every amendment to carry a documented change, **a version bump**, and
  propagation to dependent templates — none of which belongs in an unrelated feature's diff.
  Correcting the enumeration is a **PATCH-level** change (factual correction; no principle
  redefined) and needs its own `/speckit-constitution` run. This feature is unaffected: FR-022 and
  FR-022a bind smoke-test *assertions*, not the constitution's list.
- **`README.md:136` says smoke tests "expect migrations through **029**".** Head is `030`, and
  will be `031`. Stale since 008. Fixed by task T046 — a plain doc correction with no governance
  attached.
- Constitution Principle I says to correct doc rot when discovered. Both are recorded here so
  neither is lost; only the one that can be fixed without a governance process is carried as a task.
