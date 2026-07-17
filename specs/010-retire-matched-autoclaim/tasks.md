---
description: "Task list for feature 010 — Retire the Vestigial Post-Scrape Matched-Claim"
---

# Tasks: Retire the Vestigial Post-Scrape Matched-Claim

**Input**: Design documents from `/specs/010-retire-matched-autoclaim/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/cycle-output.md](./contracts/cycle-output.md), [quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included — not as TDD, but because Constitution Principle II makes the smoke suite the authoritative behavioral contract, and FR-011 requires it to assert the new behavior. Smoke changes here are named, deliberate consequences of the spec, never edits-until-green.

**Organization**: Grouped by user story. Note the coupling explained under Phase 3 — US1 and US3 share one function and one suite assertion.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (user-story phases only)
- **Letter-suffixed IDs** (`T022a`, `T045a`): tasks inserted after the initial numbering, kept in execution position rather than appended at the end. Existing IDs are never renumbered — the same convention the spec uses for `FR-007a`, `FR-011a`, etc. Read them in document order, not numeric order.

## Path Conventions

Web app: `backend/` (FastAPI, Python 3.11) and `frontend/src/` (React/TS). Docs at repo root and `docs/`. Governance at `.specify/memory/`.

## ⚠️ Two landmines — read before starting

1. **The backend image has NO source mount.** Code edits are silently ignored until `docker compose up -d --build backend`. A green suite against stale code is this feature's most likely failure. Rebuild before every verification.
2. **Do not re-derive the naive constitutional reading.** Two independent readings already concluded "4 sites falsified, MAJOR amendment". It is **1 site, PATCH**. The permitted-mutation clauses name no performer; the smoke-suite clause pins the surviving filename. See spec § "Considered and rejected". **Read the clause, not a summary.**

---

## Phase 1: Setup & Baseline

**Purpose**: Establish a known-good starting point and capture the "before" measurements US2 compares against. Capture these **before** any edit — after the change they are unrecoverable.

- [X] T001 Rebuild and confirm the stack is healthy: `docker compose up -d --build backend`, then `docker compose exec backend python -c "print('ok')"`
- [X] T002 Confirm the FK precondition for smoke fixtures: at least one row in `extension_run_logs`. Without it the claim smoke tests `[SKIP]` and verify nothing
- [X] T003 [P] Capture the pre-change baseline for US2's before/after comparison: run `docker compose exec backend python smoke_test_auto_expiration.py` and save the output; record a `GET /jobs` sample (first page: ids, order, field set); record the most recent completed cycle's `cleanup_results` and `match_results` from `auto_scrape_cycles`
- [X] T004 [P] Confirm the current suite is green **before** touching anything, so any later failure is attributable: run `smoke_test_auto_scrape.py`, `smoke_test_matched_claim.py`, `smoke_test_scraped_jobs_merge.py` in `backend/`

**Checkpoint**: baseline captured, suite green, rebuild loop working.

---

## Phase 2: Foundational (Blocking Prerequisites)

**None.** This feature removes rather than adds: no shared module, table, migration, or scaffold precedes the user stories. Stated explicitly so its absence reads as a finding, not an oversight.

The one thing that *could* have lived here — a schema change — does not exist by design (FR-003), which is also what makes rollback a pure code revert (FR-016).

---

## Phase 3: User Story 1 — Freshly scraped jobs stay unclaimed (P1) 🎯 MVP

**Goal**: After a scan and post-scrape run, newly ingested jobs are still unclaimed, so the downstream filtering/matching service has a non-empty work queue. This is the feature's reason for existing and its one hard blocker (FR-001, FR-002, SC-001, SC-002).

**Independent test**: Run a scan, wait for `post_scrape_complete`, query the claim state of that scan's rows. All unclaimed.

> **Coupling — why the marker and Phase 4c live here, not in US3.** US1 and US3 are not cleanly separable, and pretending otherwise would produce a broken increment. Both touch the *same* `run_post_scrape_phase` finalize write, and `smoke_test_auto_scrape.py:629` hard-asserts that a completed cycle carries `claim_summary`. Removing the claim without writing the marker and updating that assertion leaves the suite **red** — which Principle II forbids ("a change is not done until the relevant smoke tests pass"). So the *producer* side (marker + Phase 4c) ships with US1; US3 keeps the *reader* side (the history view). US1 therefore stands alone as a shippable, suite-green MVP.

### Implementation

- [X] T005 [US1] In `backend/auto_scrape/post_scrape_orchestrator.py`, remove the `from auto_scrape.matching_claim import claim_unmatched_rows` import (line ~28)
- [X] T006 [US1] In `backend/auto_scrape/post_scrape_orchestrator.py` `run_post_scrape_phase`, delete the Phase-2 block (the `claim_unmatched_rows` call, the `claim_summary` comprehension, and its `_update_cycle` write) and fold `match_results={"claim_summary": None, "claim_retired": True}` into the existing finalize `_update_cycle` call alongside `status` and `completed_at`. **Three cycle writes become two** — `cleanup_results`, then a single finalize write carrying status, completion time, and the marker. Leave the heartbeat, failure path, and status transition untouched (FR-001, FR-006, FR-007, FR-013)
- [X] T007 [US1] Update the module docstring in `backend/auto_scrape/post_scrape_orchestrator.py` to describe the flow as Phase 1 auto-expiration → finalize, with no claim phase (FR-012, Principle I)
- [X] T008 [US1] Delete `backend/auto_scrape/matching_claim.py` (FR-017 — the module GOES; git history is the downstream service's copy)

### Smoke — the behavioral contract (FR-011)

- [X] T009 [US1] In `backend/smoke_test_matched_claim.py`, remove the `from auto_scrape.matching_claim import claim_unmatched_rows` import (line 19) and update the module docstring to describe the file's new purpose: no automatic claim occurs, and the flag's invariants still hold
- [X] T010 [US1] In `backend/smoke_test_matched_claim.py`, replace `test_basic_claim` (lines 81-139) with `test_post_scrape_leaves_rows_unclaimed`: insert unclaimed per-source fixtures + their canonical twins, insert an `auto_scrape_cycles` row in `scrape_complete`, call `run_post_scrape_phase(cycle_id)`, then assert every fixture is **still `matched = FALSE`** on both tables and the cycle carries `{"claim_summary": None, "claim_retired": True}`. Clean up fixtures. This is the direct FR-001/SC-001 proof and exercises the orchestrator end-to-end, which nothing did before
- [X] T011 [US1] In `backend/smoke_test_matched_claim.py`, delete `test_atomic_three_table_claim` (lines 294-296) — a `[SKIP]` stub for a three-table atomic claim that no longer exists
- [X] T012 [US1] In `backend/smoke_test_matched_claim.py` `main()` (lines 299-304), update the call list to match the new test set
- [X] T013 [US1] In `backend/smoke_test_auto_scrape.py` Phase 4c (lines ~626-654), rewrite the `match_results` assertion: require `claim_summary` **present and explicitly `None`** (not absent, not zeroed) and `claim_retired is True`. Delete the `cs = mr["claim_summary"]` block including the `set(cs.keys()) != {"linkedin","indeed","glassdoor"}` exact-equality gate. Leave the `cleanup_results` and `dedup_task_id` blocks in the same function **UNCHANGED** (FR-011, FR-005)

### Verify

- [X] T014 [US1] Rebuild (`docker compose up -d --build backend`), then confirm the deleted module is gone and nothing dangles: `docker compose exec backend python -c "import auto_scrape.matching_claim"` must raise `ModuleNotFoundError`, and `docker compose exec backend python -c "import auto_scrape.post_scrape_orchestrator; print('clean')"` must succeed
- [X] T015 [US1] Run `docker compose exec backend python smoke_test_matched_claim.py` — all `[OK]`, **zero `[SKIP]`**, exit 0. A `[SKIP]` is not a pass; it means the FK precondition was missing and nothing was verified
- [X] T016 [US1] Run `docker compose exec backend python smoke_test_auto_scrape.py` — must pass, and the line `[SKIP] Phase 4c no post_scrape_complete row` must be **absent** from output. Phase 4c is guarded by a status check with a silent skip branch; a green run that skipped proves nothing about this feature

**Checkpoint**: US1 is independently shippable — the blocker is cleared and the suite is green. MVP complete.

---

## Phase 4: User Story 2 — Everything else behaves exactly as before (P1)

**Goal**: Auto-expiration, the job listing, ingest, dismissal, and the scrape paths are indistinguishable from before (FR-005, FR-010, SC-003, SC-004).

**Independent test**: Compare each against the T003 baseline. Zero difference.

**No code changes.** Every task here is verification. If any requires a code edit, the change was not surgical and Principle III has been breached — stop and re-examine rather than adjusting.

- [X] T017 [P] [US2] Run `docker compose exec backend python smoke_test_auto_expiration.py` and diff against the T003 baseline — same rows expired, same counts, same `cleanup_results` shape (FR-005, SC-003)
- [X] T018 [P] [US2] Run `docker compose exec backend python smoke_test_scraped_jobs_merge.py` — its `matched is False` at-ingest assertion (line ~432) must still pass **unchanged**, because ingest never wrote the flag (FR-003)
- [X] T019 [P] [US2] Compare a `GET /jobs` first page against the T003 baseline — same jobs, same order, same field set, and each job still carries a `matched` field (now varying rather than uniformly `true`) (FR-010, SC-004)
- [X] T020 [P] [US2] Run `docker compose exec backend python scripts/verify_matched_column.py` — exit 0; the column contract is intact on all three per-source tables (FR-003, FR-017)
- [X] T021 [US2] Confirm the retained invariant coverage in `backend/smoke_test_matched_claim.py` still runs and passes: the schema pre-flight (`_verify_required_columns`, lines 37-51) and the canonical/per-source agreement assertion (lines ~194-206). These guard invariants this change does **not** touch and must not have been dropped alongside the retired behavior (FR-011a, SC-008)
- [X] T022 [US2] Confirm `hasPartialResults` in `frontend/src/components/auto-scrape/CycleHistory.tsx` (lines 13-20) was **NOT** modified. Its `match_results !== null` disjunct is provably redundant — expiration always writes `cleanup_results` first — so touching it would be a drive-by (Principle III)
- [X] T022a [US2] Verify the **failed-cycle path** by inspection of `backend/auto_scrape/post_scrape_orchestrator.py` (FR-007a): confirm `match_results` is written **only** in the finalize `_update_cycle` call, and that the `cleanup_results` write and the failure-path `_update_cycle` (in the `except` block) do **not** carry it. A cycle that fails before finalizing must therefore record no claim indication, while its expiration results survive independently.
      **Why inspection, not a test**: FR-007a is satisfied *by construction* — a failed cycle never reaches finalize — so there is no behavior to exercise, only a structure to confirm. Fault injection would be needed to test it, which the suite already documents as a deliberate SKIP. But the property is silent-breakable: a future refactor moving the marker earlier (e.g. back into Phase 2's old slot) would violate FR-007a with nothing to catch it. This task is the guard.

**Checkpoint**: nothing regressed.

---

## Phase 5: User Story 3 — The cycle history tells the truth (P2)

**Goal**: A completed cycle's history entry says the claim is retired; historical cycles keep rendering their real counts (FR-008, FR-009, SC-006, SC-007).

**Independent test**: View the cycle history. New cycles read "claim retired"; pre-change cycles read their original "N claimed".

> The producer side shipped in US1 (see the Phase 3 coupling note). This phase is the reader.

- [X] T023 [US3] In `frontend/src/components/auto-scrape/CycleHistory.tsx` (lines ~101-105), update the results cell to serve **three shapes** per [contracts/cycle-output.md](./contracts/cycle-output.md): check `claim_summary` for a **truthy** value first (historical counts), then `claim_retired` (render "claim retired"), then fall back to `notes` / `—`. **Precedence is load-bearing** — `null` is falsy so new cycles fall through correctly, but reversing the order makes historical cycles claim they retired, a false statement about cycles that really did claim rows
- [ ] T024 [US3] Verify a cycle completed **after** the change renders `claim retired` and shows no claim count (SC-006)
- [ ] T025 [US3] Verify a cycle completed **before** the change still renders its original `N claimed`, unchanged (FR-008, SC-007). This is the regression the precedence ordering exists to prevent
- [X] T026 [P] [US3] Confirm `frontend/src/types/autoScrape.ts` (line ~93) needs **no** change — `match_results` is already `Record<string, unknown> | null` and accommodates all three shapes
- [X] T027 [P] [US3] Confirm `backend/schemas/auto_scrape.py` (lines ~50, ~106) needs **no** change — `match_results` is already `Optional[dict[str, Any]]`

**Checkpoint**: reporting is honest for both old and new cycles.

---

## Phase 6: Governance & Documentation (Cross-Cutting)

**Purpose**: FR-012 through FR-014. The document set is **closed and enumerated** — do not expand it. FR-012b/c exclusions are decisions, not oversights.

### Constitution — exactly one site (FR-013)

- [X] T028 In `.specify/memory/constitution.md` Additional Constraints → Module layout (line ~200), correct the parenthetical `auto_scrape/` "(post-scrape pipeline: expiration, **claim**, orchestration)" → "(post-scrape pipeline: expiration, orchestration)". **This is the only substantive constitutional change**
- [X] T029 In `.specify/memory/constitution.md`, bump the version line (line ~255) `1.1.0` → **`1.1.1`** and update `Last Amended`. **PATCH**: no principle removed, renamed, or redefined; nothing added or materially expanded — a factual clarification
- [X] T030 In `.specify/memory/constitution.md`, update the SYNC IMPACT REPORT header block to record the PATCH bump and its rationale
- [X] T031 Confirm the three **non**-amendments, and do not make them (FR-013a/b/c): Principle II's smoke-test list is unchanged (`smoke_test_matched_claim.py` survives under its own filename); both Principle V permitted-mutation clauses are unchanged (actor-agnostic — they permit the flip without naming a performer); the agreement invariant is unchanged (it transfers to the downstream service for free)
- [X] T032 Confirm the propagation obligation is a genuine no-op (FR-013d): verify by search that no file under `.specify/templates/`, `.specify/scripts/`, or command files references the claim, the flag, or the post-scrape phase structure

### Authoritative runtime docs (highest priority — readers are sent there because it is supposed to be true)

- [X] T033 Rewrite the post-scrape section of `docs/current-workflow.md` **wholesale** (FR-012a): remove the Phase-2 account (~60 lines: `:37`, `:56`, `:72`, `:76`, `:123-133`, `:186-190`, `:294-321`, `:396-399`, `:416`, `:439-445`) **and** retire the dead Phase 3-6 stub narrative in the same section, so the account reads coherently as scrape → expire → finalize. This deliberately absorbs pre-existing debt because the section cannot be made truthful piecemeal (SC-011)
- [X] T034 [P] In `docs/jha-onboarding.md`, correct the phase-structure statements (`:6023-6027`, `:6543`, `:6606-6609`, `:6664-6667`, `:6786`, `:6859-6860`, `:6900`) and add a "retired 2026-07" banner to §30.4's `claim_unmatched_rows` archaeology (`:6116-6140`) rather than deleting the history
- [X] T035 [P] In `docs/live-per-source-schemas.md`, correct the claim-as-lifecycle-symmetry statements (`:206`, `:240`, `:414`, `:420-423`) — the 1:1 correspondence is now held in **two** places (ingest, expiration), not three

### Remaining in-scope docs

- [X] T036 [P] In `PROJECT-SUMMARY.md`, correct the phase list (`:41`) and the claim-flips-both sync mechanism (`:67-68`, `:114`)
- [X] T037 [P] In `README.md` (`:144`) and `backend/README.md` (`:55`, `:277`), correct the **description** of `smoke_test_matched_claim.py` — the file survives under its name, but no longer "exercises DB helpers for matched-claim"
- [X] T038 [P] In `SPEC-KIT-TUTORIAL.md` (`:57`), correct `matching_claim.py` "(LIVE, documented, self-contained)" — the module is deleted

### Forward-looking status (FR-012d)

- [X] T039 [P] In `filter-matching-service-design.md`, update JHA-B (`:22`, `:76-81`) from "⛔ STILL REQUIRED — blocker" to shipped. This is the design doc this feature exists to unblock — leaving it asserting the blocker stands would be false the moment this lands
- [X] T040 [P] In `jha-prereq-cmds.md` (`:5-8`, `:91-151`) and `PROJECT-SUMMARY.md` (`:157-161`), update JHA-B status from pending to shipped
- [X] T041 Confirm the exclusions were honored and are legible as decisions, not oversights (FR-012b/c): `specs/00{1,2,6,7,8}-*/` and `SPLIT-SEARCH-ONLY-GUIDE.md` are **untouched** (historical records); pre-existing rot **outside** the rewritten post-scrape section — both READMEs' dedup/matching architecture, `step3-filter-matching-design.md`, the `matched_at` / `extracted-count` staleness — is **untouched** (separate work item)

---

## Phase 7: Validation & Close

- [X] T042 Rebuild, then run the **full** suite: `smoke_test_auto_scrape.py`, `smoke_test_auto_expiration.py`, `smoke_test_matched_claim.py`, `smoke_test_scraped_jobs_merge.py`. All green, no `[SKIP]`, and zero assertions describing retired behavior (SC-005)
- [ ] T043 **The real proof** — run a live scan end to end, let post-scrape complete, then verify per [quickstart.md](./quickstart.md) Step 4: the cycle shows `status = post_scrape_complete` and `match_results = {"claim_summary": null, "claim_retired": true}`; the run performed **one** phase of work rather than two, with no other observable change to how the scan completes; and **scoped to that scan's `scan_run_id`**, `SELECT matched, count(*) ... GROUP BY matched` returns `f | N` with **no `t` row** (SC-001, SC-002, SC-009). Do **not** run a global count — the pre-existing corpus is deliberately still claimed (FR-004b) and a global count shows mostly `t`, looking like failure
- [ ] T044 Verify agreement holds after the live scan: `SELECT count(*) FROM scraped_jobs s JOIN linkedin_jobs l ON l.id = s.source_row_id WHERE s.matched <> l.matched` returns `0` (SC-008)
- [X] T045 Confirm no artifact of this change encodes claim **irreversibility** — not in a test, docstring, or comment (FR-004c, plan §6). Our guarantee is only that *this system* never claims and never un-claims; the downstream service plans a `matched=FALSE` re-entry and owns that question (`RE-ENTRY-WRITE`). An assertion here would forbid, by our code, behavior our own consumer intends
- [X] T045a Verify **SC-010** against the closed document set: re-read the 8 in-scope documents enumerated in FR-012 (`.specify/memory/constitution.md`, `docs/current-workflow.md`, `docs/jha-onboarding.md`, `docs/live-per-source-schemas.md`, `PROJECT-SUMMARY.md`, `README.md`, `backend/README.md`, `SPEC-KIT-TUTORIAL.md`) and confirm **zero** statements contradict the shipped behavior. Scope the check to that set only — SC-010 is measured against the closed enumeration, never an open-ended repository search, which is what makes it falsifiable at all. Documents excluded by FR-012b/c are outside this measurement by design (SC-010)
- [ ] T046 Update `specs/010-retire-matched-autoclaim/checklists/retirement.md` — close any items the implementation resolves (T022a closes CHK026), and record deviations if the built result differs from the plan. Confirm **FR-014** is satisfied before landing: the constitutional correction, the behavior change, the spec, and the smoke-test changes are all in **one** commit/PR. The Phase 1-7 increments are a working order, not shipping units — landing any subset alone violates FR-014

---

## Dependencies

```text
Phase 1 (Setup & Baseline)  ← T003 baseline MUST precede any edit; it is unrecoverable after
        │
        ▼
Phase 2 (Foundational)      ← empty by design
        │
        ▼
Phase 3 (US1, P1) 🎯 MVP    ← the blocker; ships suite-green and standalone
        │
        ├─────────────────► Phase 4 (US2, P1)  — verification only, no code
        │
        └─────────────────► Phase 5 (US3, P2)  — reader side
                    │
                    ▼
        Phase 6 (Governance & Docs)  — needs the final built behavior to describe
                    │
                    ▼
        Phase 7 (Validation & Close)
```

**Story independence**:
- **US1** — fully independent. Ships alone as the MVP with a green suite.
- **US2** — depends on US1 only in that there must be a change to verify. No code of its own.
- **US3** — depends on US1's producer change (the marker must exist to render). The reader is otherwise independent.

**Within-phase ordering**: T005 → T006 → T007 are the same file, sequential. T008 after T006 (do not delete the module while it is still imported). T009-T012 are the same file, sequential. T013 is a different file — parallelizable with T009-T012 in principle, but sequenced here since both must land before T016 verifies.

## Parallel Execution Examples

**Phase 1**: T003 and T004 together (different concerns, both read-only).

**Phase 4 (US2)**: T017, T018, T019, T020 all together — four independent read-only verifications, no shared state. T022a is also independent (pure source inspection) and can join them.

**Phase 5 (US3)**: T026 and T027 together — two independent "confirm no change needed" checks in different files.

**Phase 6**: T034, T035, T036, T037, T038 together (five distinct docs); then T039, T040 together. T033 runs alone — it is a wholesale section rewrite and the largest single edit in the feature.

## Implementation Strategy

**MVP = Phase 1 + Phase 3 (US1).** That clears the downstream service's one hard blocker and leaves the suite green. Everything after is correctness assurance (US2), honest reporting (US3), and fidelity (Phase 6).

**Suggested increments**:
1. **Increment 1 (MVP)**: Phases 1 + 3 → `matched` stays FALSE; suite green; JHA-B unblocked.
2. **Increment 2**: Phase 4 → proof nothing regressed.
3. **Increment 3**: Phase 5 → cycle history honest.
4. **Increment 4**: Phases 6 + 7 → governance, docs, live verification.

All four should land in **one change** per FR-014: an intentional behavior change must be reflected in the spec and its smoke test together, and the constitutional correction accompanies the behavior it describes. The increments are a working order, not shipping units.

**If it goes wrong**: rollback is a pure code revert with no migration and no data repair (FR-016, plan § Rollback). Rows left unclaimed are swept by the next post-scrape run automatically; it is safe even if the downstream service already claimed some.
