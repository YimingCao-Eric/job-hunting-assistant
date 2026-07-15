---
description: "Task list for Search-Only Backend reduction"
---

# Tasks: Search-Only Backend

**Input**: Design documents from `specs/006-search-only-backend/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api-surface-delta.md, quickstart.md

**Tests**: No new test suites are written (none were requested and there are no dedup/matching
smoke tests to update — specs 003/004 SC-006). The **existing** smoke tests are the acceptance
gates and are run as verification tasks (Constitution Principle II).

**Structure note (subtractive feature)**: Because the backend must never import a deleted module
at any commit boundary, the code edits + deletions form ONE dependency-ordered sequence and live
in **Phase 2 (Foundational)**. The three P1 user stories are then **independent verification
lenses** on that single removal — each is independently *testable* (boot / search path /
orchestrator) even though the implementation is atomic. Decisions honored: **D1 = leave** (no
migration 030), **D2 = keep** (matched-claim + `matched` column), **D3 = deferred** (dual store).

---

## Phase 1: Setup (Baseline)

**Purpose**: Capture a known-good pre-change baseline so regressions are attributable.

- [ ] T001 Confirm the working tree is on branch `030-search-only-backend` and Alembic is at head `029`, and that `backend/alembic/versions/` contains no `030_*` file (no new/destructive migration is introduced by this feature — FR-006a).
- [ ] T002 Record a green baseline: run `backend/smoke_test_auto_scrape.py`, `backend/smoke_test_auto_expiration.py`, and `backend/smoke_test_matched_claim.py` and note they pass (or SKIP for missing `extension_run_logs`) BEFORE any change.

---

## Phase 2: Foundational (The Removal — Blocking Prerequisites)

**Purpose**: Perform the entire reduction in dependency-safe order. **⚠️ CRITICAL**: every task in
Group A (unwire references) MUST complete before any task in Group B (delete files), or the
backend will import a deleted module and fail to boot. No user-story verification can begin until
this phase is complete and the backend boots.

### Group A — Unwire references in KEPT files (all different files → parallelizable)

- [X] T003 [P] In `backend/main.py`, remove the imports and `include_router(...)` calls for the `dedup`, `matching`, `profile`, `skills`, and `job_reports` routers; remove `from core.dedup_task_cleanup import mark_stale_dedup_tasks_failed` and its startup-hook call + log block (the `n_orphan = await mark_stale_dedup_tasks_failed()` section) in `lifespan`.
- [X] T004 [P] In `backend/auto_scrape/post_scrape_orchestrator.py`, remove `from dedup.service import run_dedup` and `from matching.pipeline import (...)`; delete the stub functions `_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`; in `run_post_scrape_phase` remove the `cfg`/`llm_enabled`/`has_openai_key` read and the dedup/matching/`_compute_match_results` calls, set `match_results = {"claim_summary": claim_summary}` and write it directly, and drop the `dedup_task_id` write; remove now-unused imports (`os`, `read_config_file`, `SearchConfigRead`) if no longer referenced.
- [X] T005 [P] In `backend/routers/extension.py`, remove `from dedup.service import run_dedup` and `from models.dedup_task import DedupTask`; delete the `_run_dedup_for_scan` helper and the post-scan sync-dedup trigger block (the `cfg.dedup_mode == "sync"` → `asyncio.create_task(_run_dedup_for_scan(log_id))` section in the run-log PUT handler); remove the now-unused `read_config_file` / `SearchConfigRead` imports if they have no other use in the file.
- [X] T006 [P] In `backend/routers/admin_cleanup.py`, remove `from models.dedup_task import DedupTask` and the stale-dedup-task `UPDATE` (`result5` / `marked_failed_dedup_tasks` computation); return the existing `marked_failed_dedup_tasks` response field as the constant `0` (keep the key for forward-compat, Principle VII).
- [X] T007 [P] In `backend/routers/jobs.py`, remove `from models.job_report import JobReport`; remove the `pending_report_exists`/`has_report` `EXISTS` computation and its use in `list_jobs` (return `ScrapedJobRead.model_validate(job)` from `result.scalars().all()`) and in `get_job` (return `ScrapedJobDetail.model_validate(job)`); leave the match/dedup query-filter params/branches unchanged (they reference retained `ScrapedJob` columns — see research D-3).
- [X] T008 [P] In `backend/models/__init__.py`, remove the imports and `__all__` entries for `DedupReport`, `DedupTask`, `MatchReport`, `JobReport`, and `SkillCandidate`.
- [X] T009 [P] In `backend/schemas/scraped_job.py`, prune all dedup/match fields and `has_report` from `ScrapedJobRead` (which `ScrapedJobDetail` inherits) and prune the match fields from `JobUpdate` (retain `dismissed`), per the field list in `data-model.md` §A; `ScrapedJobIngest`/`ScrapedJobIngestResponse` stay unchanged.
- [X] T010 [P] In `backend/schemas/config.py`, remove the `llm` and `dedup_mode` fields from both `SearchConfigRead` and `SearchConfigUpdate` (leave all other fields).

### Group B — Delete now-unreferenced modules (depends on ALL of Group A: T003–T010)

- [X] T011 Sweep for stragglers: grep the backend (excluding the files slated for deletion) for any remaining `import`/`from` referencing `dedup`, `matching`, `profile`, `skills`, `job_report`, `dedup_task`, `dedup_report`, `match_report`, `skill_candidate`, or `dedup_task_cleanup`; resolve any hit found in a KEPT file before proceeding.
- [X] T012 [P] Delete the `backend/dedup/` package (`__init__.py`, `service.py`).
- [X] T013 [P] Delete the `backend/matching/` package (`__init__.py`, `pipeline.py`, `extractor.py`, `gates.py`, `scorer.py`, `llm_scorer.py`, `normaliser.py`, `step_b.py`, `constants.py`, `skill_aliases_persist.py`, `skill_aliases.json`).
- [X] T014 [P] Delete the `backend/profile/` package (`__init__.py`, `service.py`, `pdf_extractor.py`, `resume_parser.py`).
- [X] T015 [P] Delete routers `backend/routers/dedup.py`, `matching.py`, `profile.py`, `skills.py`, `job_reports.py`.
- [X] T016 [P] Delete models `backend/models/dedup_report.py`, `dedup_task.py`, `match_report.py`, `job_report.py`, `skill_candidate.py`.
- [X] T017 [P] Delete schemas `backend/schemas/dedup.py`, `match_report.py`, `job_report.py`, `profile.py`, `skill_candidate.py` (do NOT delete `schemas/debug_log.py` — still used by `routers/extension.py`).
- [X] T018 Delete `backend/core/dedup_task_cleanup.py`.

**Checkpoint**: The backend imports cleanly and boots. Group B is complete only if `T011` found no residual references in kept files.

---

## Phase 3: User Story 1 — Backend boots and serves search-only (Priority: P1) 🎯 MVP

**Goal**: The reduced backend starts cleanly with no references to removed modules and serves only the search-relevant surface.

**Independent Test**: Start the backend and call `/health`; enumerate routes and confirm no removed surface is served.

- [ ] T019 [US1] Start the backend (compose up / `uvicorn main:app`); confirm it boots with no `ImportError`/`ModuleNotFoundError` or traceback referencing `dedup`, `matching`, `profile`, `skills`, `job_report`, or `dedup_task_cleanup`, and that `GET /health` returns `200 {"status":"ok","db":"ok"}` (FR-007, FR-015, FR-016, SC-001).
- [ ] T020 [US1] Enumerate served routes (inspect `app.routes` or probe representative paths) and confirm NONE of `/jobs/dedup*`, `/jobs/match*`, `/match/*`, `/dedup/*`, `/profile*`, `/skills*`, `/jobs/reports*`, `/jobs/{id}/report` are served (each → `404`), while `/jobs`, `/jobs/ingest`, `/config`, `/extension/*`, `/admin/auto-scrape/*`, `/admin/...cleanup...`, and `/health` remain (FR-001–FR-003, SC-003, per `contracts/api-surface-delta.md`).

**Checkpoint**: US1 independently verified — the MVP (a booting, search-only backend) is met.

---

## Phase 4: User Story 2 — Scrape, ingest, and browse jobs still work (Priority: P1)

**Goal**: Ingest, listing, detail, and update behave as spec 002, minus the pruned dedup/match fields and the issue-report flow.

**Independent Test**: Exercise the three ingest paths and the listing filters; confirm responses carry no pruned fields and no `has_report`.

- [ ] T021 [US2] Verify `POST /jobs/ingest` for all three paths (skip-reason; per-source linkedin/indeed/glassdoor; legacy) returns the same `{id, already_exists, content_duplicate, skip_reason}` outcomes and table targeting as spec 002, and that ingest-time URL + content-hash dedup still work (FR-009, SC-004).
- [ ] T022 [US2] Verify `GET /jobs` with `dedup_status` (`unset`/`passed`/`removed`/`all`), `website`, date, and pagination filters returns the expected row sets and `{items, total, limit, offset}` envelope, and that each returned job carries NONE of the pruned dedup/match fields and NO `has_report` key; verify `GET /jobs/{id}` and `GET /jobs/skipped` likewise (FR-008, FR-010, SC-004).
- [ ] T023 [US2] Verify `PUT /jobs/{id}` accepts only `dismissed` (match fields removed from `JobUpdate`), and that `GET /config` no longer exposes `llm`/`dedup_mode` while a config file still containing those keys loads without error (FR-006, FR-011, SC-006).

**Checkpoint**: US2 independently verified — the search read/write path is intact and pruned.

---

## Phase 5: User Story 3 — Auto-scrape and post-scrape expiration/claim still run (Priority: P1)

**Goal**: Auto-scrape cycles and the post-scrape orchestrator (Phase 1 + Phase 2 only) run unchanged, with no sync-dedup and no Phase 4–6 calls.

**Independent Test**: Confirm run-log completion schedules no dedup, a cycle finalizes via Phase 1+2, and the acceptance smoke tests pass.

- [ ] T024 [US3] Verify a `PUT /extension/run-log/{id}` transition to `completed` schedules NO sync-dedup background task (no dedup task created; no dedup log line), and the completion response is otherwise unchanged (FR-004, SC-005).
- [ ] T025 [US3] Verify a cycle in `scrape_complete` processed by the post-scrape orchestrator reaches `post_scrape_complete` through claim → Phase 1 (`cleanup_results`) → Phase 2 (`match_results = {"claim_summary": {...}}`) with NO dedup/matching phase side effects (FR-005, FR-014, SC-005).
- [ ] T026 [US3] Run the acceptance gates `backend/smoke_test_auto_scrape.py` and `backend/smoke_test_auto_expiration.py` and confirm both pass unchanged; also run `backend/smoke_test_matched_claim.py` and confirm it still passes (retained Phase 2 + `matched` column; D2=keep) (FR-016, SC-002, Constitution Principle II).

**Checkpoint**: US3 independently verified — the orchestrator and its contract tests are intact.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation sync and explicitly-deferred cleanups.

- [ ] T027 [P] Update backend docs that reference removed endpoints/capabilities (`backend/README.md`, and `docs/current-workflow.md` / `docs/current-schemas.md` where they describe dedup/matching/profile/skills/issue-report surfaces) to reflect the search-only surface; do not rewrite unrelated sections (Principle III).
- [ ] T028 [P] Confirm the explicitly-deferred cleanups from `research.md` are intentionally left (no action) and noted: `core/config.py::dedup_cosine_batch_size` (now unused), the vestigial match/dedup filter params in `routers/jobs.py`, and the orphaned dedup/match tables/columns (no migration 030). Optionally remove `dedup_cosine_batch_size` if a low-risk cleanup is desired.
- [ ] T029 Run the full `quickstart.md` validation end-to-end and confirm every Definition-of-Done item passes; re-confirm `backend/alembic/versions/` head is still `029` with no `030_*` file added (FR-006a).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. Group A (T003–T010) BLOCKS Group B (T011–T018). BLOCKS all user-story verification.
- **User Stories (Phase 3–5)**: All depend on Foundational completing and the backend booting. Once the backend boots, US1/US2/US3 verifications are independent and can run in parallel.
- **Polish (Phase 6)**: Depends on all user-story verifications passing.

### Critical ordering (the never-import-a-deleted-module rule)

- T003–T010 (unwire, all `[P]`) → T011 (straggler sweep) → T012–T018 (delete, all `[P]`) → boot checkpoint → US verifications.

### Parallel Opportunities

- **Group A**: T003, T004, T005, T006, T007, T008, T009, T010 are all different files → run in parallel.
- **Group B**: T012–T018 are distinct files/dirs → run in parallel (after T011).
- **Verification**: after boot, US1 (T019–T020), US2 (T021–T023), and US3 (T024–T026) are independent → parallel.
- **Polish**: T027 and T028 are independent → parallel.

---

## Parallel Example: Phase 2 Group A (unwire)

```bash
# All unwiring edits touch different files — do them together:
Task: "T003 main.py — unregister removed routers + drop dedup_task_cleanup startup hook"
Task: "T004 post_scrape_orchestrator.py — drop dedup/matching imports + Phase 4–6 stubs + cfg.llm"
Task: "T005 extension.py — drop sync-dedup trigger + _run_dedup_for_scan + dedup imports"
Task: "T006 admin_cleanup.py — drop DedupTask; keep marked_failed_dedup_tasks=0"
Task: "T007 jobs.py — drop JobReport import + has_report EXISTS"
Task: "T008 models/__init__.py — drop 5 deleted-model imports + __all__"
Task: "T009 schemas/scraped_job.py — prune dedup/match fields + has_report"
Task: "T010 schemas/config.py — drop llm + dedup_mode"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1: Setup (baseline green).
2. Phase 2: Foundational — the full dependency-safe removal (Group A → sweep → Group B → boot).
3. Phase 3: US1 — verify boot/health/route enumeration. **STOP and VALIDATE** — this is the MVP (a booting, search-only backend).

### Incremental Delivery

Because the removal is atomic, the increments are the three verification lenses, run after the
single Foundational change: US1 (boots + surface) → US2 (search path intact) → US3 (orchestrator +
smoke gates). Each is an independent go/no-go on the same change; a failure in any sends you back
to the specific Group-A/B task that caused it.

---

## Notes

- `[P]` = different files, no incomplete-task dependency.
- `[US#]` labels are on verification-phase tasks; Setup/Foundational/Polish carry none.
- The only hard sequence is **unwire (A) → sweep → delete (B) → boot → verify**; everything else is parallelizable.
- No new Alembic migration (D1). `matched` column + `smoke_test_matched_claim.py` retained (D2). Dual store untouched (D3).
- Commit after Group A (boot-safe), after Group B (search-only), and after each verification phase.
