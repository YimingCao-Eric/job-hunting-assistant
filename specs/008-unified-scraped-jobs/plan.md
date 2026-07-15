# Implementation Plan: Unified Scraped Jobs Table with Dual-Write Ingest

**Branch**: `008-unified-scraped-jobs` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-unified-scraped-jobs/spec.md`

## Summary

Replace the legacy single-site `scraped_jobs` table with a unified, site-agnostic one, and make
`POST /jobs/ingest` write both the per-source row and one canonical row in a single
transaction. `GET /jobs` and `GET /jobs/{id}` then read the canonical table and return
canonical field names, so a scan's results finally reach the frontend — and become the substrate
matching will consume.

The technical approach is smaller than it looks. `get_db` already commits once per request, so
the dual-write needs **no transaction plumbing** (R1). The projection maps from the
**per-source params dict** the existing builders already produce — not from `source_raw` — so
~280 lines of extraction logic are reused rather than duplicated (R6). The bulk of the work is
one migration, one pure mapper module, and honest removal of the surfaces the redesign strands.

**The load-bearing structural fact**: `source_row_id` is polymorphic across three tables, so
**no foreign key and no cascade is possible** (data-model.md). Every "the database will keep
these in sync" instinct is unavailable. The 1:1 correspondence is a code invariant upheld by
matched predicates in three places (ingest, claim, expire) — which is exactly why FR-030/032/033
demand smoke coverage of it.

## Technical Context

**Language/Version**: Python 3.11 (backend), JavaScript (Chrome MV3 extension, React UI)

**Primary Dependencies**: FastAPI, SQLAlchemy 2.x (async), Alembic, asyncpg, Pydantic v2

**Storage**: PostgreSQL (system of record); Redis (cache/coordination — untouched here)

**Testing**: `backend/smoke_test_*.py` — standalone scripts run via `python <file>`, not pytest

**Target Platform**: Linux server (Docker); Chrome MV3 extension; React SPA

**Project Type**: Web service + browser extension + SPA

**Performance Goals**: None specified. This feature targets correctness, not latency. Ingest
gains one INSERT per posting — negligible against the network scrape it follows.

**Constraints**:
- Constitution CC-12 — no indexes beyond PK/UNIQUE/FK without demonstrated need
- Constitution CC-1 — per-source rows permit exactly two mutations (matched flip, TTL delete)
- `docs/live-per-source-schemas.md` is authoritative for per-site lineage (FR-012)
- Per-source tables must stay observably unchanged (FR-009)
- **Host Python is broken** (`ModuleNotFoundError: 'encodings'`) — all execution via Docker

**Scale/Scope**: `scraped_jobs` starts at 0 rows. Per-source tables: 39/45/48 columns. Ingest
volume is one POST per scraped card.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

Evaluated against constitution v1.1.0.

| Principle | Status | Evidence |
|---|---|---|
| **I. As-Built Fidelity** | ✅ PASS | Spec describes current behavior accurately; research.md cites `path:line` for every claim. Found and recorded two things the spec missed: the live `recordSkip` caller (R9b) and the admin_cleanup CC-1 conflict (R10). |
| **II. Smoke Tests Are the Contract** | ✅ PASS | One new test (FR-030/031); three intentional, declared changes (FR-032, FR-033, legacy shape). Each traces to a requirement — none is "edit until green". Declared in plan + quickstart. |
| **III. Surgical, Behavior-Preserving** | ✅ PASS | Per-source ingest, scan, auto-scrape untouched. Mapper reuses existing builders rather than reimplementing. No drive-by refactors. Deletions are required by FR-024/025/026, not opportunistic. |
| **IV. Migration & Schema Discipline** | ✅ PASS | New migration `030` chained off head `029`; no existing migration edited. `gen_random_uuid()` PK, `snake_case`. Dual-write atomic via the session's transaction (R1). Indexes limited to PK/UNIQUE/FK — see below. |
| **V. Data-Model Invariants** | ✅ PASS | Per-source rows stay append-only and source-shaped. Canonical row is derived, atomically dual-written, with exactly the three permitted mutations (matched, dismissed, TTL delete). Normalization lives on the canonical row only. |
| **VI. Async Background Execution** | ✅ PASS | No background-task changes. `auto_expiration` / `matching_claim` keep caller-managed transactions and fresh sessions. |
| **VII. Auth Boundary & Forward-Compatible Outputs** | ✅ PASS | All touched routes keep bearer auth. `admin_cleanup` response keys retained at `0` rather than removed (R10), following the `marked_failed_dedup_tasks` precedent. |

### CC-12 — resolved, not violated

The spec carried this in as an open gate item. **Resolved**: create only the `id` PK, `UNIQUE
(job_url)`, and the `scan_run_id` FK index. The mapping doc's `ix_scraped_jobs_source` and
`ix_scraped_jobs_posted_at` are **dropped** — no demonstrated need exists at 0 rows, and
`source_site` has cardinality 3. Full reasoning in R5. **No Complexity Tracking entry needed.**

### CC-10 / CC-11 — resolved by constitution v1.1.0

Previously deferred to this gate. Principle V now states that CC-10/CC-11 govern *where*
normalized data lives (the derived row), not *when* it is computed. Normalizing inside the
ingest transaction is compliant because per-source rows stay source-shaped. **Not a gate item.**

### Post-Phase-1 re-check

Re-evaluated after design. **All gates still pass.** Two findings surfaced during design and
were resolved *toward* the constitution rather than around it:

- **R10 (admin_cleanup)**: design revealed that adapting the sweeps would require either
  breaking the 1:1 invariant or violating CC-1. Retirement is the only compliant path. This
  strengthens compliance rather than deviating from it.
- **R9b (skip_reason 200 no-op)**: deviates from FR-024's literal text, not from any
  principle. It is a **spec** deviation requiring sign-off, tracked below — not a constitution
  violation.

## Project Structure

### Documentation (this feature)

```text
specs/008-unified-scraped-jobs/
├── plan.md                          # This file
├── spec.md                          # Feature spec (9 clarifications recorded)
├── research.md                      # Phase 0 — 13 decisions, verified against source
├── data-model.md                    # Phase 1 — unified table + per-site projection
├── quickstart.md                    # Phase 1 — validation guide (Docker)
├── contracts/
│   └── api-surface-delta.md         # Phase 1 — UNCHANGED/CHANGED/NEW/DELETED per route
├── checklists/
│   └── requirements.md              # Spec quality checklist (16/16)
└── tasks.md                         # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

Marked per the user's request. **UNCHANGED files are not listed** except where a subtlety
matters.

```text
backend/
├── alembic/versions/
│   └── 030_unified_scraped_jobs.py          # NEW — drop + recreate, down_revision="029"
├── core/
│   ├── scraped_job_projection.py            # NEW — pure per-site mapper (R6)
│   └── database.py                          # UNCHANGED — already gives one tx/request (R1)
├── models/
│   └── scraped_job.py                       # REWRITTEN — unified ORM model
├── schemas/
│   └── scraped_job.py                       # CHANGED — ScrapedJobRead canonical;
│                                            #   ScrapedJobDetail DELETED;
│                                            #   ScrapedJobIngest UNCHANGED
├── routers/
│   ├── jobs.py                              # CHANGED — dual-write; GET/PUT rewritten;
│   │                                        #   /jobs/skipped DELETED;
│   │                                        #   legacy fallback DELETED;
│   │                                        #   skip_reason branch → 200 no-op
│   └── admin_cleanup.py                     # CHANGED — job sweeps retired (R10)
├── auto_scrape/
│   ├── auto_expiration.py                   # CHANGED — + 4th DELETE (FR-027)
│   ├── matching_claim.py                    # CHANGED — + 4th UPDATE (FR-028)
│   └── post_scrape_orchestrator.py          # UNCHANGED
├── smoke_test_scraped_jobs_merge.py         # NEW — FR-030, FR-031
├── smoke_test_auto_expiration.py            # CHANGED — + canonical assertion (FR-032)
├── smoke_test_matched_claim.py              # CHANGED — + canonical assertion (FR-033)
├── smoke_test_auto_scrape.py                # CHANGED — off legacy shape
├── main.py                                  # UNCHANGED
└── scheduler.py                             # UNCHANGED

extension/                                   # UNCHANGED (see Deviation D1)
frontend/                                    # UNCHANGED — spec 007 owns adaptation (FR-021)
docs/live-per-source-schemas.md              # CHANGED — write back the 3 departures (FR-012)
```

**Structure Decision**: The existing `backend/` layout is kept exactly. One new module in
`core/` (the mapper) and one new migration. No new packages — Constitution's module layout
forbids parallel or catch-all modules, and `core/` (cross-cutting infrastructure) is the only
listed home that fits a pure, dependency-free transform used by the router now and matching
later (R6).

## Implementation Sequence

Ordered so the backend boots at every step.

1. **Migration `030`** — drop legacy `scraped_jobs`, create unified. Three indexes only.
2. **ORM model** — rewrite `models/scraped_job.py` to match. (Boots; nothing reads it yet.)
3. **Mapper** — `core/scraped_job_projection.py`, pure functions, per-site. Unit-testable
   without a DB.
4. **Ingest dual-write** — extend `RETURNING id` → `RETURNING id, scrape_time` (R2); call the
   mapper; `INSERT … ON CONFLICT (job_url) DO NOTHING`. Delete the legacy fallback; make
   `skip_reason` a 200 no-op.
5. **Read paths** — rewrite `GET /jobs`, `GET /jobs/{id}`, `PUT /jobs/{id}`; delete
   `GET /jobs/skipped`; update schemas.
6. **Lifecycle symmetry** — 4th DELETE in `auto_expiration`; 4th UPDATE in `matching_claim`.
7. **admin_cleanup** — retire the three job sweeps, keep keys at 0.
8. **Smoke tests** — new merge test; extend the two lifecycle tests; migrate `auto_scrape`.
9. **Doc write-back** — the three FR-012 departures into `docs/live-per-source-schemas.md`.

Steps 1–2 and 3 are independent and can run in parallel. Step 4 depends on 1–3.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

**No constitutional violations.** CC-12 and CC-10/CC-11 are resolved (above), not deviated
from. The table is intentionally empty.

## Deviations — APPROVED 2026-07-15

Not constitutional violations — deviations from the **spec's original text**, surfaced by facts
the spec did not have. **Both approved by the user on 2026-07-15**; they are settled decisions
and `tasks.md` implements them as specified here.

**Both have since been folded back into the spec** (FR-024 and FR-026, amended 2026-07-15 after
`/speckit-analyze` flagged the spec/plan contradiction). They are no longer deviations from the
spec — spec, plan, contracts, and tasks now agree. The sections below are retained as the
decision record: *why* the spec says what it now says.

### D1 — `skip_reason` returns 200 no-op, not 400 (FR-024) — ✅ APPROVED

**Spec says**: "Ingest MUST NOT accept or record a skip reason."

**Plan does**: records nothing (intent met), but returns 200 rather than 400.

**Why**: the spec assumed no live caller. There is one. `recordSkip`
(`extension/content/shared/messaging.js:102-169`) fires on **every skipped card** across all
three sites and sends no `source_raw`. A 400 triggers its 3× retry with 1s/2s/3s backoff —
**~6 seconds of dead wait per skipped card**, plus log noise. It does not set
`_backendDownDuringScan` (that is `ingestJob`-only), so scans would not fail, just degrade.

**Alternative** (recommended follow-up): remove `recordSkip` from the extension, then drop the
no-op branch and the legacy `ScrapedJobIngest` fields. Out of scope here — the user asked to
keep the scrape paths unchanged.

**Risk if rejected**: choosing the literal 400 makes scans measurably slower on skip-heavy runs.

### D2 — `admin_cleanup` job sweeps retired rather than adapted (FR-026) — ✅ APPROVED

**Spec says**: "MUST operate on the unified store's canonical fields, **or** be retired where
the condition it screened for can no longer arise."

**Plan does**: retires all three sweeps — including two whose conditions *can* still arise.

**Why**: adapting is not available. Deleting only the canonical row breaks the 1:1 invariant
(SC-002); deleting the per-source row violates CC-1, which permits exactly two mutations. With
both closed, retirement is the only compliant option (R10). Only the mismatched-website sweep
retires under the spec's literal "can no longer arise" clause; the other two retire because the
remedy itself is unconstitutional.

**Mitigation**: auto-expiration still reclaims aged rows by TTL. Response keys stay at `0`
(Principle VII), following the `marked_failed_dedup_tasks` precedent already in that file.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Period vocabulary map misses real tokens (R7) | **Medium** | Silent NULL periods | Inferred, not observed — could not query live data (host Python broken). `projection_unknown_salary_period` warning; quickstart gates on an empty grep after a real scan. |
| `scrape_time` defaulted instead of copied | Low | Expiration leaves orphans on the boundary | R2 mandates copying; quickstart asserts `s.scrape_time = l.scrape_time`. |
| Someone adds a cascading FK on `source_row_id` | Medium | Fails at migration time | Polymorphic — impossible. Called out in research.md, data-model.md, and this plan. |
| Frontend stays broken longer than expected | High | Jobs page unusable | Accepted (FR-021). Page is empty today regardless. Hand-off list in contracts. |
| Migration is one-way (R11) | Certain | No `alembic downgrade` | Accepted — 0 rows, legacy consumers deleted. Raises loudly rather than silently mis-restoring. |

## Open Question for `/speckit-tasks`

`docs/live-per-source-schemas.md` still cross-references the deleted `docs/current-schemas.md`
(flagged in the constitution's Sync Impact Report). Step 9's write-back is the natural moment
to fix it — worth folding into that task.
