# Implementation Plan: Search-Only Backend

**Branch**: `030-search-only-backend` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-search-only-backend/spec.md`

## Summary

Reduce the JHA backend to a **search-only** system: remove the dedup, matching, and profile
capabilities (plus the skills and issue-report surfaces that only serve them), keeping
scraping/ingest, config, jobs storage, search run-logs, and the auto-scrape + post-scrape
orchestrator (Phases 1 & 2). The removal is executed in **dependency order** so the backend
never imports a deleted module: unwire from the top (`main.py`, post-scrape phase calls, the
extension sync-dedup trigger, admin-cleanup), then delete the packages/routers/models/schemas,
then prune the leftover field references and config fields.

Per the resolved clarifications in the spec, this plan **does not** create a destructive Alembic
migration (D1 = leave; FR-006a) and **keeps** the Phase 2 matched-claim and `matched` column
(D2 = keep; FR-014). The dual store stays split (D3 = deferred). See
[research.md](./research.md) for the decision reconciliation against the command wording.

## Technical Context

**Language/Version**: Python 3.11 (async)

**Primary Dependencies**: FastAPI, SQLAlchemy (async), Alembic, Pydantic v2, APScheduler,
redis.asyncio, PostgreSQL

**Storage**: PostgreSQL (system of record), Redis (coordination). No schema migration in this
feature — orphaned dedup/match tables and `scraped_jobs` columns remain at Alembic head 029.

**Testing**: `backend/smoke_test_auto_scrape.py`, `backend/smoke_test_auto_expiration.py`
(acceptance gates), `backend/smoke_test_matched_claim.py` (retained, unaffected).

**Target Platform**: Linux server (Docker), FastAPI app `backend/main.py`.

**Project Type**: Web service (FastAPI backend) within a larger repo (Chrome extension + React UI
are out of scope for this feature).

**Performance Goals**: N/A — subtractive change; retained paths keep their current behavior.

**Constraints**: The backend MUST never import a deleted module at any commit boundary (execute
in dependency order). Acceptance: boots, `/health` = ok, the two search smoke tests pass unchanged.

**Scale/Scope**: ~12 files deleted (3 packages + routers/models/schemas), ~7 files modified,
0 new files (no migration). No frontend changes in scope.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.0.0.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. As-Built Fidelity | ✅ PASS | Plan is grounded line-by-line in current code (main.py, post_scrape_orchestrator.py, extension.py, admin_cleanup.py, jobs.py, schemas). Removed stubs (`_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`) are the documented Phase 4.5 no-ops. |
| II. Smoke Tests Are the Behavioral Contract | ✅ PASS | `smoke_test_auto_scrape.py` + `smoke_test_auto_expiration.py` pass **unchanged** (acceptance). `smoke_test_matched_claim.py` is **retained unchanged** — it exercises the kept Phase 2 claim + `matched` column. There are **no** dedup/matching smoke tests to remove (specs 003/004 SC-006 confirm none exist). |
| III. Surgical, Behavior-Preserving Change | ✅ PASS (deliberate change) | This is an intentional capability removal, called out explicitly in the spec and this plan. Retained paths are edited only as forced by deleted symbols (e.g. `JobReport`/`has_report` in jobs.py). No drive-by refactors of untouched code. |
| IV. Migration & Schema Discipline | ✅ PASS | No schema change this feature (D1 = leave, FR-006a). No existing migration edited/reordered. A future drop migration, if written, chains off 029 and derives its exact object list from the models + migrations 011/012/014/015/017/018/019/021/022 — never by hand (documented in [data-model.md](./data-model.md)). |
| V. Data-Model Invariants | ✅ PASS | Per-source tables' append-only + one-way `matched` flip + shelf-life expiration are untouched (Phase 1 & 2 kept). `matched` column retained (D2). |
| VI. Async Background Execution | ✅ PASS | We remove the sync-dedup `asyncio.create_task` trigger; the retained post-scrape orchestrator keeps its async/own-session model. No request-scoped background work introduced. |
| VII. Auth Boundary & Forward-Compatible Outputs | ⚠️ PASS w/ note | Every removed route was authed; remaining routes keep bearer auth (only `/health` exempt). Pruning typed API response fields (`ScrapedJobRead` dedup/match fields, `has_report`) is a deliberate, spec-backed API contract change (FR-008), not a JSONB-aggregate mutation. The admin-cleanup response key `marked_failed_dedup_tasks` is **kept** (constant `0`) to stay forward-compatible. See Complexity Tracking. |

**Result**: PASS. One noted deviation (typed response-field pruning) is spec-backed and tracked below.

## Project Structure

### Documentation (this feature)

```text
specs/006-search-only-backend/
├── plan.md              # This file
├── research.md          # Phase 0: decision reconciliation + removal-order rationale
├── data-model.md        # Phase 1: schema/response-field impact + orphaned-object inventory
├── quickstart.md        # Phase 1: boot/health/route/smoke validation guide
├── contracts/
│   └── api-surface-delta.md   # Removed endpoints + pruned response fields
├── checklists/
│   ├── requirements.md  # (from /speckit-specify + /speckit-clarify)
│   └── reduction.md     # (from /speckit-checklist)
└── tasks.md             # (created later by /speckit-tasks)
```

### Source Code (repository root) — change map

Legend: **DELETED** (removed entirely) · **MODIFIED** (edited, kept) · **UNCHANGED** (must not touch)

```text
backend/
├── main.py                              # MODIFIED — unregister removed routers; drop dedup_task_cleanup startup hook + import
│
├── dedup/                               # DELETED (package: __init__.py, service.py)
├── matching/                            # DELETED (package: pipeline, extractor, gates, scorer,
│   │                                    #          llm_scorer, normaliser, step_b, constants,
│   │                                    #          skill_aliases_persist, skill_aliases.json, __init__)
├── profile/                            # DELETED (package: service, pdf_extractor, resume_parser, __init__)
│
├── routers/
│   ├── dedup.py                         # DELETED
│   ├── matching.py                      # DELETED
│   ├── profile.py                       # DELETED
│   ├── skills.py                        # DELETED
│   ├── job_reports.py                   # DELETED
│   ├── jobs.py                          # MODIFIED — drop JobReport import + has_report EXISTS logic
│   ├── extension.py                     # MODIFIED — drop sync-dedup trigger + _run_dedup_for_scan + dedup imports
│   ├── admin_cleanup.py                 # MODIFIED — drop DedupTask import + stale-dedup-task marking (keep response key=0)
│   ├── config.py                        # UNCHANGED (reads/writes whatever fields the schema defines)
│   ├── auto_scrape.py                   # UNCHANGED
│   ├── extension.py … run_log_ws.py     # (run_log_ws) UNCHANGED
│
├── models/
│   ├── dedup_report.py                  # DELETED
│   ├── dedup_task.py                    # DELETED
│   ├── match_report.py                  # DELETED
│   ├── job_report.py                    # DELETED
│   ├── skill_candidate.py               # DELETED
│   ├── __init__.py                      # MODIFIED — drop imports + __all__ for the 5 deleted models
│   ├── scraped_job.py                   # UNCHANGED (table/columns stay — no migration; model attrs still referenced by filters)
│   ├── auto_scrape_*.py, extension_*.py, site_session_state.py  # UNCHANGED
│
├── schemas/
│   ├── dedup.py                         # DELETED
│   ├── match_report.py                  # DELETED
│   ├── job_report.py                    # DELETED
│   ├── profile.py                       # DELETED
│   ├── skill_candidate.py               # DELETED
│   ├── debug_log.py                     # UNCHANGED (still imported by extension.py DebugLogAppend) — verify at impl
│   ├── scraped_job.py                   # MODIFIED — prune dedup/match fields from ScrapedJobRead/Detail/JobUpdate + has_report
│   ├── config.py                        # MODIFIED — drop `llm` + `dedup_mode` from SearchConfigRead/Update
│   ├── __init__.py                      # UNCHANGED (does not import any removed schema)
│   ├── auto_scrape.py, extension.py, run_log.py  # UNCHANGED
│
├── core/
│   ├── dedup_task_cleanup.py            # DELETED (only main.py used it)
│   ├── config.py                        # OPTIONAL — `dedup_cosine_batch_size` becomes unused (leave or drop; low-risk to leave)
│   ├── config_file.py, config, auth, database, trace, redis_client, system_settings, auto_scrape_lifecycle  # UNCHANGED
│
├── auto_scrape/
│   ├── post_scrape_orchestrator.py      # MODIFIED — drop dedup/matching imports + Phase 4–6 stub calls + cfg.llm read
│   ├── auto_expiration.py               # UNCHANGED (Phase 1)
│   ├── matching_claim.py                # UNCHANGED (Phase 2 — pure SQL, no matching-pkg dependency)
│
├── scheduler.py                         # UNCHANGED
├── alembic/                             # UNCHANGED (no new migration)
├── smoke_test_auto_scrape.py            # UNCHANGED (acceptance)
├── smoke_test_auto_expiration.py        # UNCHANGED (acceptance)
└── smoke_test_matched_claim.py          # UNCHANGED (retained per D2=keep; imports matching_claim)
```

**Structure Decision**: Existing FastAPI backend layout (constitution "Module layout"). No new
modules; the change is deletions + surgical edits to the files that reference deleted symbols.

## Execution order (dependency-safe)

Ordered so that at no step does a kept module import a deleted one. Each numbered group is a
safe commit boundary (backend still boots).

1. **Unwire references (top-down)** — MODIFIED files, before any deletion:
   - `main.py`: remove the 5 removed-router imports + `include_router` calls; remove the
     `dedup_task_cleanup` import and its startup-hook call.
   - `auto_scrape/post_scrape_orchestrator.py`: remove `from dedup.service import run_dedup`,
     `from matching.pipeline import (...)`, the three stub functions, and the `cfg.llm` read +
     dedup/matching phase calls; set `match_results = {"claim_summary": claim_summary}` directly.
   - `routers/extension.py`: remove `_run_dedup_for_scan`, the `cfg.dedup_mode == "sync"`
     trigger block, and the `dedup.service` / `models.dedup_task` imports (and the now-unused
     config read if it has no other use).
   - `routers/admin_cleanup.py`: remove the `DedupTask` import + the stale-dedup-task UPDATE;
     return `marked_failed_dedup_tasks=0` (keep the key).
   - `routers/jobs.py`: remove `from models.job_report import JobReport` and the `has_report`
     EXISTS computation in `list_jobs` / `get_job`.
   - `models/__init__.py`: drop the 5 deleted-model imports + `__all__` entries.
2. **Prune schemas/config fields** — MODIFIED:
   - `schemas/scraped_job.py`: prune dedup/match fields + `has_report` from
     `ScrapedJobRead`/`ScrapedJobDetail`/`JobUpdate`.
   - `schemas/config.py`: drop `llm` + `dedup_mode` from both models.
3. **Delete packages/routers/models/schemas** — DELETED (now unreferenced):
   `dedup/`, `matching/`, `profile/`, `routers/{dedup,matching,profile,skills,job_reports}.py`,
   `models/{dedup_report,dedup_task,match_report,job_report,skill_candidate}.py`,
   `schemas/{dedup,match_report,job_report,profile,skill_candidate}.py`,
   `core/dedup_task_cleanup.py`.
4. **Verify** — boot, `/health`, route enumeration, and run the three smoke tests
   (see [quickstart.md](./quickstart.md)).

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Typed API response fields pruned from `ScrapedJobRead`/`ScrapedJobDetail`/`JobUpdate` (Principle VII forward-compat note) | FR-008 explicitly requires the search-only read path to stop exposing dedup/match fields and `has_report` | Keeping the fields (always null) would contradict the spec's "search-only" contract and leave the removed matching surface implied in the API. Principle VII's additive rule targets stored **JSONB aggregates** (e.g. `match_results`), not typed HTTP response models; this pruning is a deliberate, spec-backed change. The one genuine aggregate-style response key (`marked_failed_dedup_tasks`) is preserved as `0`. |
| Orphaned dedup/match tables + `scraped_jobs` columns left in the DB (no migration 030) | D1 = leave (FR-006a): a destructive drop is irreversible and higher-risk; the reduction is achievable without it | Dropping now (migration 030) risks data loss and a larger blast radius during a removal-only change. Deferring keeps the change reversible and boot-safe; a future migration can drop precisely, derived from models + migrations. |
