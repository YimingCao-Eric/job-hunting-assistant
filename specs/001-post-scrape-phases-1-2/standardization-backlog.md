# Standardization & Optimization Backlog — Post-Scrape Phases 1 & 2

**Created**: 2026-07-14
**Scope**: Existing code for the post-scrape orchestrator Phases 1 & 2 only. **No new features.**
**Sources compared**: `spec.md` (as-built) · `.specify/memory/constitution.md` · code
(`backend/auto_scrape/post_scrape_orchestrator.py`, `auto_expiration.py`, `matching_claim.py`,
`backend/scheduler.py`, `backend/core/system_settings.py`, `backend/core/redis_client.py`) ·
`smoke_test_auto_expiration.py`, `smoke_test_matched_claim.py`, `smoke_test_auto_scrape.py` ·
`docs/current-workflow.md`, `docs/current-schemas.md`.

> This is a review artifact, not an implementation plan. Nothing here is implemented.
> Effort key: **XS** <1h · **S** a few hours · **M** 1–2 days · **L** ≥1 week.
> Risk = risk of *making the fix* (to behavior guarded by the smoke suite).

---

## What already conforms (no action — recorded for completeness)

Per the constitution these are **adhered** and should stay as-is:

- **CC-1** append-only with the two carve-outs (one-way `matched` false→true; auto-expiration
  DELETE by shelf life) — matches code exactly.
- **CC-3 / CC-8 / CC-12** — FK `scan_run_id` ON DELETE RESTRICT, server-side `scrape_time`,
  minimum index set (PK, `job_url` UNIQUE, FK index on `scan_run_id`).
- **Atomic multi-table writes** — Phase 1 (3 DELETEs) and Phase 2 (3 UPDATE-RETURNINGs) each
  run inside one caller-owned `async with db.begin()` transaction (Constitution Principle IV;
  spec FR-007/FR-010).
- **Async background execution** — heartbeat runs as `asyncio.create_task`; every DB operation
  opens its own fresh `AsyncSessionLocal` (Constitution Principle VI).
- **UUID `gen_random_uuid()` PKs, snake_case columns** throughout.
- **CC-10/CC-11** (normalization at merge, not ingest) — not exercised by Phases 1–2; no
  violation.

---

## Backlog (severity-ordered)

| ID | Category | Severity | Source | Risk | Effort |
|----|----------|----------|--------|------|--------|
| B1 | Transaction/atomicity | HIGH | KL-1 / §15.2 / FR-012,FR-014 | Medium | M |
| B2 | Test coverage | HIGH | FR-010 / US3-AC3 | Low | M |
| B3 | Doc-vs-code drift | MEDIUM | FR-019 / current-workflow.md | None | S |
| B4 | Structure/duplication | MEDIUM | Constitution "module layout" | Low | S |
| B5 | Observability | MEDIUM | KL-3 / FR-012 | Low–Med | S |
| B6 | CC-rule vs performance | MEDIUM | CC-12 / FR-006,FR-009 | Medium | S+gov |
| B7 | Test coverage | MEDIUM | FR-006 / US2-AC4 | Low | XS |
| B8 | Test coverage | MEDIUM | FR-019 (reaper) | Low | S |
| B9 | Test coverage | MEDIUM | FR-003,FR-016 (failure) | Low | S |
| B10 | Error handling | MEDIUM | FR-016 vs FR-003 | Low | XS |
| B11 | Doc-vs-code drift | MEDIUM | current-schemas.md:546 | None | XS |
| B12 | Naming | MEDIUM | KL-5 | High | L |
| B13 | Known limitation (design) | MEDIUM | KL-4 | High | L |
| B14 | Transaction/atomicity | LOW | FR-008 | Low–Med | S |
| B15 | Dead code | LOW | Constitution III | Low | XS |
| B16 | Dead code | LOW | FR-013 | Low | XS |
| B17 | Test coverage | LOW | FR-005 | Low | XS |
| B18 | Test coverage | LOW | FR-008 (cleanup_results) | Low | XS |
| B19 | Error handling / Observability | LOW | error taxonomy | Low | S |
| B20 | Doc-vs-code drift | LOW | DD-1 | None | XS |

---

### B1 — Phase 2 crash window loses the claimed set (KL-1 / §15.2)
- **Category**: Transaction / atomicity
- **Severity**: HIGH
- **Description**: `claim_unmatched_rows` commits `matched=TRUE` at the end of Phase 2, but
  `claim_summary` and the terminal `post_scrape_complete` status are written afterward in
  separate `_update_cycle` calls. A process death in that window leaves rows permanently
  `matched=TRUE`, `claim_summary` never persisted, and — because the claim filters
  `WHERE matched=FALSE` — those rows can never be re-claimed. The reaper (B3/FR-019) marks the
  cycle `failed` but does **not** un-claim the rows.
- **Impact**: Silent, unrecoverable loss of the claimed row set for that cycle; the rows are
  flagged "processed" while no downstream processing occurred. Recovery is manual.
- **Risk of fixing**: Medium — options include persisting `claim_summary` (and/or the claimed
  row ids) inside the same transaction as the claim, or making the claim replayable. Any change
  touches the `matched` one-way invariant (CC-1) and ordering, so it must stay behavior-
  preserving and be guarded by new tests (see B2).
- **Effort**: M

### B2 — Atomic three-table claim is only covered by a SKIPped test
- **Category**: Test coverage (weak)
- **Severity**: HIGH
- **Description**: The core atomicity guarantee (all three UPDATEs commit or roll back together,
  FR-010 / US3-AC3) is asserted only by `test_atomic_three_table_claim`, which is a documented
  `[SKIP]` (needs manual fault injection). There is no automated coverage.
- **Impact**: A regression that broke cross-table atomicity would pass CI. This is the safety
  net B1's fix depends on.
- **Risk of fixing**: Low (adding a test). Requires a fault-injection harness (e.g. force the
  3rd UPDATE to raise and assert the first two rolled back).
- **Effort**: M

### B3 — Stale-cycle reaper is undocumented in the workflow doc
- **Category**: Doc-vs-code drift
- **Severity**: MEDIUM
- **Description**: `scheduler.cleanup_stale_postscrape` (runs every ~1 min; marks
  `postscrape_running` cycles `failed` after >10 min stale heartbeat, or NULL heartbeat with
  `started_at` >5 min ago — FR-019) has **zero mentions** in `docs/current-workflow.md`. The
  spec omitted it too until the 2026-07-14 verification pass.
- **Impact**: Operators/readers don't know stuck cycles auto-fail; behavior looks like a hang.
- **Risk of fixing**: None (docs only).
- **Effort**: S

### B4 — Canonical per-source table list is duplicated in ≥4 places
- **Category**: Structure / duplication
- **Severity**: MEDIUM
- **Description**: `("linkedin_jobs","indeed_jobs","glassdoor_jobs")` (and the site→table
  mapping) is hardcoded independently in `auto_expiration.py` (tuple), `matching_claim.py`
  (`table_for_site` dict), and repeatedly in both smoke tests. No single source of truth.
- **Impact**: Adding a 4th source, or renaming a table, means editing many disconnected spots;
  drift risk. Mild tension with the constitution's "do not introduce parallel modules" intent.
- **Risk of fixing**: Low — extract one shared constant/mapping and import it.
- **Effort**: S

### B5 — Claimed rows are discarded with no durable trail (KL-3)
- **Category**: Observability
- **Severity**: MEDIUM
- **Description**: `claim_unmatched_rows` returns the full rows, but the orchestrator keeps only
  `claim_summary` counts and logs the rest; the row payloads (ids/urls) are dropped (FR-012).
- **Impact**: After a crash (B1) there is no record of *which* rows were claimed, so manual
  recovery has nothing to work from. Compounds B1.
- **Risk of fixing**: Low–Medium (even logging the claimed ids, or persisting them, is additive).
- **Effort**: S

### B6 — Phase 1 & Phase 2 filters full-scan (CC-12 tension)
- **Category**: CC-rule adherence vs performance
- **Severity**: MEDIUM
- **Description**: `WHERE matched=FALSE` (Phase 2) and `WHERE scrape_time < …` (Phase 1) have no
  supporting index — CC-12 permits only PK, `job_url` UNIQUE, and the `scan_run_id` FK index.
  Every cycle therefore does an O(n) sequential scan/UPDATE of each table.
- **Impact**: Negligible at current volume (~1k rows/table) but grows linearly; a long-lived
  deployment will see rising per-cycle cost.
- **Risk of fixing**: Medium — the fix (a partial index `WHERE matched=false`, or a
  `scrape_time` index) needs a **new Alembic migration** *and* a documented **CC-12 exception**
  (a governance decision, not just code). Flag; do not add speculatively.
- **Effort**: S (migration) + governance sign-off

### B7 — No test that expiration ignores `matched` (FR-006 / US2-AC4)
- **Category**: Test coverage (missing)
- **Severity**: MEDIUM
- **Description**: `smoke_test_auto_expiration.py` only inserts `matched=FALSE` rows. The
  requirement that expiration deletes old rows **regardless of `matched`** is unverified.
- **Impact**: A regression scoping deletion to `matched=FALSE` (leaking claimed rows past shelf
  life) would pass CI.
- **Risk of fixing**: Low. **Effort**: XS (add a `matched=TRUE` old row to the existing test).

### B8 — Reaper has no test (FR-019)
- **Category**: Test coverage (missing)
- **Severity**: MEDIUM
- **Description**: `cleanup_stale_postscrape`'s two transition conditions (stale >10 min; NULL
  heartbeat + `started_at` >5 min) are untested.
- **Impact**: The recovery mechanism that unblocks stuck cycles could silently break.
- **Risk of fixing**: Low. **Effort**: S (seed cycles with backdated timestamps, assert `failed`).

### B9 — Failure handlers have no test (FR-003 outer, FR-016 inner)
- **Category**: Test coverage (missing)
- **Severity**: MEDIUM
- **Description**: The exception paths that set `status='failed'` + `error_message` +
  `completed_at` are unverified by any smoke test (the happy path is covered by
  `smoke_test_auto_scrape.py`).
- **Impact**: A regression that swallowed errors or left cycles in `postscrape_running` would
  pass CI.
- **Risk of fixing**: Low. **Effort**: S.

### B10 — Inner failure handler is not status-guarded (unlike the outer one)
- **Category**: Error handling
- **Severity**: MEDIUM
- **Description**: `run_post_scrape_phase`'s `except` writes `status='failed'` with **no**
  `WHERE status=…` guard (FR-016), whereas the outer handler in `process_pending_cycles`
  guards on `WHERE status='postscrape_running'` (FR-003). If the reaper already marked the cycle
  `failed`, the inner handler overwrites its `error_message`/`completed_at` (last-writer-wins),
  clobbering the more accurate "stale heartbeat" provenance.
- **Impact**: Inconsistent, occasionally misleading failure attribution.
- **Risk of fixing**: Low — add the same status guard for symmetry. **Effort**: XS.

### B11 — Dangling reference to deleted `step1-schema-design.md`
- **Category**: Doc-vs-code drift
- **Severity**: MEDIUM
- **Description**: `docs/current-schemas.md:546` (and prose elsewhere) cite "Known Limitation
  §15.2 in `step1-schema-design.md`", but that file was removed (commit `1b4c398`). The
  canonical statement of KL-1 no longer has a home.
- **Impact**: Broken provenance for the project's highest-impact known limitation.
- **Risk of fixing**: None — relocate the §15.2 text into a live doc (this spec's KL-1 now
  carries it) and fix the references. **Effort**: XS.

### B12 — Inconsistent run-log id naming (KL-5)
- **Category**: Naming
- **Severity**: MEDIUM
- **Description**: The same UUID appears as `scan_run_id` (per-source tables, claim RETURNING),
  `scrape_run_id`, and `runId` (extension/other layers).
- **Impact**: Cognitive load and copy/paste bugs across the ingest→claim boundary.
- **Risk of fixing**: **High** — a true rename touches many call sites, the extension payload
  contract, and needs a column-rename migration; it is not surgical. Per Constitution Principle
  III (surgical, behavior-preserving) the recommended action is to **document a glossary
  mapping**, not rename. **Effort**: L if renamed; XS if documented.

### B13 — Phase 1 & 2 operate globally, not per-cycle (KL-4)
- **Category**: Known limitation (design)
- **Severity**: MEDIUM
- **Description**: Both expiration and claim act on the whole table at execution time, not on
  the current cycle's rows. A cycle's `claim_summary` therefore counts rows from other cycles,
  and expiration deletes regardless of originating cycle.
- **Impact**: `claim_summary` is not a faithful per-cycle metric; concurrent cycles interfere.
- **Risk of fixing**: **High** — cycle-scoping the claim would require tagging rows by cycle and
  reworking the matched mechanism; likely out of scope for a behavior-preserving round. Flag as
  a design caveat (probable WONTFIX this round). **Effort**: L.

### B14 — Phase 1 `cleanup_results` write is a separate transaction from the DELETEs
- **Category**: Transaction / atomicity
- **Severity**: LOW
- **Description**: DELETEs commit, then `cleanup_results` is written in a distinct
  `_update_cycle` session (FR-008). A crash between leaves rows deleted but the deletion
  uncounted — a low-impact, symmetric analogue of B1.
- **Impact**: Bookkeeping loss only (no data loss beyond the intended deletion).
- **Risk of fixing**: Low–Medium. **Effort**: S. (Likely accept, or fold into B1's transaction
  redesign.)

### B15 — Dead imports kept "for Phase 4 redesign"
- **Category**: Dead code
- **Severity**: LOW
- **Description**: `post_scrape_orchestrator.py` imports `run_dedup` and four `matching.pipeline`
  functions with `# noqa: F401`; none are used (the pipelines are stubbed).
- **Impact**: Misleading dependency graph; import-time coupling to unused modules.
- **Risk of fixing**: Low — remove until the pipelines return, or leave with the existing intent
  comment. **Effort**: XS.

### B16 — Dead per-cycle computation feeding the matching stub
- **Category**: Dead code
- **Severity**: LOW
- **Description**: Every cycle reads the config file and computes `llm_enabled` /
  `has_openai_key`, then passes them to `_run_matching_for_cycle`, which ignores them (FR-013
  stub).
- **Impact**: Wasted per-cycle I/O and noise; implies functionality that isn't wired.
- **Risk of fixing**: Low. **Effort**: XS. (Defer until Phase 5 lands, or gate behind the stub.)

### B17 — `get_shelf_life_days` coercion untested (FR-005)
- **Category**: Test coverage (missing)
- **Severity**: LOW
- **Description**: The default-7-on-missing/invalid/<1 logic has no test.
- **Impact**: A regression in the safety default would silently change retention.
- **Risk of fixing**: Low. **Effort**: XS.

### B18 — `cleanup_results` shape not asserted end-to-end (FR-008)
- **Category**: Test coverage (missing)
- **Severity**: LOW
- **Description**: `smoke_test_auto_scrape.py` asserts `match_results`/`claim_summary` on a
  `post_scrape_complete` cycle but does not assert `cleanup_results` (`deleted_per_table` +
  `shelf_life_days`).
- **Impact**: The Phase 1 output contract is only unit-tested, not verified in the cycle row.
- **Risk of fixing**: Low. **Effort**: XS.

### B19 — Free-form error messages, no error taxonomy
- **Category**: Error handling / observability
- **Severity**: LOW
- **Description**: Three distinct hardcoded failure strings ("Top-level exception…",
  "Post-scrape phase failed: …", "…died mid-phase (stale heartbeat)") with no codes/categories;
  no emitted metrics/counters for deleted/claimed volumes, durations, or failure rates (only
  logs + the cycle JSONB).
- **Impact**: Harder to aggregate/alert on failure modes; no dashboards.
- **Risk of fixing**: Low. **Effort**: S.

### B20 — Docs show `db.commit()` where code uses `db.begin()` (DD-1)
- **Category**: Doc-vs-code drift
- **Severity**: LOW
- **Description**: `docs/current-workflow.md` §5 illustrates Phase 1/2 with explicit
  `await db.commit()`; the code uses `async with db.begin():`. Behavior-equivalent but the
  snippet is not literal.
- **Impact**: Minor reader confusion.
- **Risk of fixing**: None (docs only). **Effort**: XS.

---

## Suggested sequencing (if/when a hardening round is authorized)

1. **Cover before you change**: B2, B7, B8, B9, B17, B18 (tests first — they guard everything
   else per Constitution Principle II/III).
2. **Then the HIGH data-integrity item**: B1 (+ B5 for the recovery trail; B14 folds in).
3. **Cheap, no-risk cleanups**: B3, B11, B20 (docs); B10, B15, B16 (code hygiene); B4 (DRY).
4. **Governance-gated**: B6 (needs a CC-12 exception before any index migration).
5. **Document, don't rename / re-architect this round**: B12 (glossary), B13 (design caveat).
