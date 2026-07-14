# Feature Specification: Post-Scrape Orchestrator — Phases 1 & 2 (As-Built)

**Feature Branch**: `docs/spec-baseline`

**Created**: 2026-07-14

**Status**: As-Built Baseline (documents current behavior; proposes no changes)

**Input**: User description: "Produce an AS-BUILT specification documenting the CURRENT behavior of the backend post-scrape orchestrator Phases 1 and 2, exactly as implemented."

---

## Overview *(as-built context)*

This is an **as-built specification** (per Constitution Principle I). It describes what
`backend/auto_scrape/post_scrape_orchestrator.py` and its Phase 1 / Phase 2 helpers
(`auto_expiration.py`, `matching_claim.py`) actually do today, including known limitations.
It proposes no changes. Where the code disagrees with prior prose documentation, the code's
behavior is authoritative and the discrepancy is flagged.

The behavioral contract is the existing smoke suite (Constitution Principle II):
`backend/smoke_test_auto_expiration.py` and `backend/smoke_test_matched_claim.py`. Every
requirement below MUST agree with those tests.

**Scope of this spec:**

- The atomic cycle claim (status transition `scrape_complete → postscrape_running`).
- **Phase 1** — auto-expiration (delete per-source rows past shelf life).
- **Phase 2** — matched-claim (flip `matched` false→true across the three per-source tables).
- The finalization writes (`cleanup_results`, `match_results` with `claim_summary`, terminal
  status `post_scrape_complete`), and the supporting infrastructure that bounds these phases
  (wake paths, heartbeat, per-cycle failure handling, and the `cleanup_stale_postscrape`
  stale-cycle reaper).

**Explicitly out of scope (documented only as as-built no-ops):** Phases 3–6 (build
`match_candidates`, dedup, matching pipeline, compute `match_results`). In the current code
`_run_dedup_for_cycle`, `_run_matching_for_cycle`, and `_compute_match_results` are **stubs**
that return `None` / do nothing / return `{}` respectively ("Phase 4.5: pipeline disabled
pending redesign"). They are described here only insofar as they affect the cycle's persisted
output.

## Clarifications

### Session 2026-07-14

This session was a verification pass: the spec was checked line-by-line against
`backend/auto_scrape/post_scrape_orchestrator.py`, `auto_expiration.py`, `matching_claim.py`,
`backend/scheduler.py`, `backend/core/redis_client.py`, `backend/core/system_settings.py`, and
the two smoke tests. Findings were corrected against the source (authoritative for an as-built
spec). No open questions required a user decision.

- Finding: KL-2 and the "hard process death" edge case claimed there is **no** auto-recovery /
  reaper for cycles stuck in `postscrape_running`. → Correction: **A reaper exists.**
  `scheduler.cleanup_stale_postscrape` runs every ~1 minute and sets `status='failed'`,
  `error_message='Post-scrape orchestrator died mid-phase (stale heartbeat)'`, `completed_at`
  for any `postscrape_running` cycle whose `phase_heartbeat_at < NOW() - 10min`, OR whose
  `phase_heartbeat_at IS NULL AND started_at < NOW() - 5min`. It marks stuck cycles **failed**;
  it does **not** re-queue them and does **not** un-claim (`matched=TRUE`) rows. KL-1, KL-2,
  FR-019, and the affected edge cases were updated accordingly.
- Finding: partial-failure behavior across cycles was unspecified (the user asked for it). →
  Correction: `process_pending_cycles` claims **all** `scrape_complete` cycles in one atomic
  UPDATE and processes them sequentially; one cycle's failure is caught, marked `failed`, and
  does **not** stop processing of the remaining cycles. Captured in FR-002/FR-003 and a new
  edge case.
- Finding: the outer (per-cycle) failure handler in `process_pending_cycles` writes a
  **different** message than the inner handler and **is** status-guarded. → Correction:
  documented in FR-003 (outer: `error_message='Top-level exception in run_post_scrape_phase'`,
  guarded by `WHERE status='postscrape_running'`) vs FR-016 (inner: unguarded, dynamic message).
- Finding: `cleanup_results` is written in a **separate** transaction from the Phase 1 DELETEs
  (a symmetric micro-window to KL-1). → Correction: clarified in FR-008/FR-018.
- Verified with no discrepancy: FR-001 (APScheduler `interval, minutes=1` poll →
  `process_pending_cycles`; Redis channel `auto_scrape:cycle_complete`), FR-002, FR-004…FR-018,
  and both smoke tests. The smoke tests call the phase helpers then `await db.commit()` manually
  rather than via `async with db.begin()`; this is behavior-equivalent (the helpers use the
  session's existing transaction and the caller owns the boundary) and is **not** a discrepancy.

## User Scenarios & Testing *(mandatory)*

The "actor" in these scenarios is the backend post-scrape orchestrator processing one cycle.
Scenarios describe observable system behavior, and acceptance scenarios are traceable to the
smoke suite where one exists.

### User Story 1 - Claim a completed cycle and finalize it (Priority: P1)

When a scrape cycle reaches `scrape_complete`, the orchestrator claims it exactly once, runs
Phase 1 then Phase 2, records their outputs, and drives the cycle to a terminal status. This
is the end-to-end orchestration that makes Phases 1 and 2 run and be persisted.

**Why this priority**: This is the control flow that invokes both phases and produces the
`auto_scrape_cycles` row that operators and downstream stages read. Without it, neither phase
runs and no results are persisted.

**Independent Test**: With a cycle row in `scrape_complete`, trigger `process_pending_cycles()`
(via Redis wake or the 1-minute poll) and observe the cycle transition through
`postscrape_running` to `post_scrape_complete`, with `cleanup_results` and
`match_results.claim_summary` populated. (No dedicated smoke test exists for the full
orchestration; Phases 1 and 2 are individually covered — see Stories 2 and 3.)

**Acceptance Scenarios**:

1. **Given** exactly one cycle with `status = "scrape_complete"`, **When**
   `process_pending_cycles()` runs, **Then** that cycle's status becomes `postscrape_running`
   with `phase_heartbeat_at` set, and the cycle id is returned by the claiming UPDATE.
2. **Given** two backend workers both run `process_pending_cycles()` concurrently against the
   same `scrape_complete` cycle, **When** they race, **Then** the atomic
   `UPDATE ... WHERE status='scrape_complete' ... RETURNING id` guarantees only one worker
   receives the id and processes the cycle (the other receives an empty set).
3. **Given** a claimed cycle whose Phase 1 and Phase 2 complete without error, **When**
   finalization runs, **Then** the cycle ends with `status = "post_scrape_complete"`,
   `completed_at` set, `cleanup_results` set, and `match_results = {"claim_summary": {...}}`.
4. **Given** any exception raised inside `run_post_scrape_phase`, **When** the handler runs,
   **Then** the cycle's `status` is set to `failed`, `error_message` records the exception
   type and message, and `completed_at` is set.

---

### User Story 2 - Phase 1: expire stale per-source rows (Priority: P2)

Phase 1 deletes rows in the three per-source tables whose `scrape_time` is older than the
configured shelf life, then records what was deleted onto the cycle.

**Why this priority**: This is the auto-expiration behavior guaranteed by
`smoke_test_auto_expiration.py`. It is the CC-1 carve-out (append-only tables may be
DELETE-expired by shelf life).

**Independent Test**: Fully covered by `smoke_test_auto_expiration.py`: insert one old row
(30 days) and one fresh row into `linkedin_jobs`, call `run_auto_expiration(db)`, and assert
the old row is deleted, the fresh row preserved, and the result reports at least one deletion.

**Acceptance Scenarios**:

1. **Given** `system_settings.shelf_life_days = N` (default 7 when unset, non-integer, or < 1),
   **When** `run_auto_expiration(db)` runs, **Then** for each table in
   (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`) it deletes exactly the rows where
   `scrape_time < NOW() - make_interval(days => N)`.
2. **Given** a row older than the shelf life and a row newer than it, **When** Phase 1 runs,
   **Then** the old row is deleted and the fresh row is preserved (per
   `smoke_test_auto_expiration.py`).
3. **Given** the DELETEs complete, **When** the function returns, **Then** it returns
   `{"deleted_per_table": {<table>: <count>, ...}, "shelf_life_days": N}` and the orchestrator
   writes this verbatim to `cycle.cleanup_results` immediately (in its own `_update_cycle`
   write, before Phase 2 begins).
4. **Given** rows past the shelf life with `matched = TRUE` and rows with `matched = FALSE`,
   **When** Phase 1 runs, **Then** both are deleted — expiration ignores `matched` and is not
   scoped to the current cycle (it operates on the whole table).

---

### User Story 3 - Phase 2: claim unmatched rows across all three tables atomically (Priority: P2)

Phase 2 flips `matched` from `FALSE` to `TRUE` for every unmatched row in the three per-source
tables, returning the claimed rows. Only the per-site **counts** are persisted; the returned
rows are consumed in-memory and then discarded (Phases 3–6 that would use them are stubs).

**Why this priority**: This is the claim-and-flag behavior guaranteed by
`smoke_test_matched_claim.py`, and it is the second of the two CC-1-permitted mutations
(the one-way `matched` false→true flip).

**Independent Test**: Covered by `smoke_test_matched_claim.py`: insert one `matched=FALSE` row
into each of the three tables, call `claim_unmatched_rows(db)`, and assert each row is returned
and its `matched` is now `TRUE`; a scoped second UPDATE returns zero rows (idempotence).

**Acceptance Scenarios**:

1. **Given** unmatched rows exist, **When** `claim_unmatched_rows(db)` runs, **Then** for each
   site it executes `UPDATE {table} SET matched = TRUE WHERE matched = FALSE RETURNING
   id, job_url, scan_run_id, scrape_time`, and returns
   `{"linkedin": [...], "indeed": [...], "glassdoor": [...]}` keyed by site (not table name).
2. **Given** a claimed row, **When** re-inspected, **Then** its `matched` is `TRUE`; re-running
   the same `WHERE matched = FALSE` UPDATE against that row flips zero rows (the claim is a
   one-way, idempotent operation — verified scoped in `smoke_test_matched_claim.py`).
3. **Given** all three UPDATEs run inside a single caller-managed transaction
   (`async with db.begin()`), **When** any one of the three fails, **Then** all three roll back
   together — no table is left with rows flagged claimed while another table's claim was lost.
   (The atomic three-table property is asserted by a documented manual fault-injection test
   that `smoke_test_matched_claim.py` currently SKIPs.)
4. **Given** Phase 2 returns `claim_results`, **When** the orchestrator processes it, **Then**
   it computes `claim_summary = {site: len(rows)}` in memory, **discards** the row payloads,
   and later persists only `claim_summary` under `cycle.match_results`.
5. **Given** unmatched rows exist that were NOT scraped in the current cycle, **When** Phase 2
   runs, **Then** they are also claimed — the claim targets every `matched = FALSE` row in each
   table globally, not only rows tied to the current cycle.

---

### Edge Cases

- **No pending cycles**: `process_pending_cycles()` returns immediately when the claiming
  UPDATE returns no ids; nothing runs.
- **Concurrent workers**: two workers cannot both claim the same cycle — the atomic
  status-transition UPDATE serializes the claim; the loser gets an empty id set.
- **`shelf_life_days` missing / invalid / < 1**: `get_shelf_life_days` returns the safety
  default `7`.
- **Empty tables / no unmatched rows**: Phase 1 reports `0` deletions per table; Phase 2
  returns empty lists and `claim_summary` counts of `0`. Both are valid healthy outcomes.
- **Exception during Phase 1 or Phase 2**: `run_post_scrape_phase` sets the cycle to `failed`
  with `error_message` and `completed_at`. Note Phase 1's `cleanup_results` may already be
  committed before a Phase 2 failure (they are separate sessions/transactions and a separate
  `_update_cycle` write).
- **Hard process death (not a Python exception) mid-phase**: the `except` block does not run;
  the cycle is left in `postscrape_running` with a stale (or NULL) `phase_heartbeat_at`. The
  `cleanup_stale_postscrape` reaper (scheduler, ~1 min) eventually transitions it to `failed`
  once the heartbeat is stale >10 min (or NULL with `started_at` >5 min ago). It is marked
  `failed`, not re-queued (see KL-2).
- **Crash window between Phase 2 and the final write** (KNOWN LIMITATION): Phase 2 commits
  `matched = TRUE` immediately, but `claim_summary` and the terminal status are written later.
  If the process dies in between, rows are permanently `matched = TRUE` while `claim_summary`
  was never persisted. The cycle does not reach `post_scrape_complete`; the reaper eventually
  marks it `failed`. Because the claim filters on `matched = FALSE`, a re-run will NOT re-claim
  those rows — the claimed set is lost to any future in-memory consumer, and the reaper does not
  un-claim them. Recovery is manual and contained (see KL-1).
- **One cycle fails among several claimed**: `process_pending_cycles` claims all
  `scrape_complete` cycles at once and processes them sequentially; a failure in one cycle is
  caught, that cycle is marked `failed`, and the remaining cycles are still processed.
- **Redis unavailable (`REDIS_URL` unset)**: the subscriber logs and disables itself; the cycle
  is still picked up by the APScheduler 1-minute fallback poll.
- **Subscriber error in `process_pending_cycles`**: logged as non-fatal; the poll retries.

## Requirements *(mandatory)*

### Functional Requirements

**Triggers & cycle claim**

- **FR-001**: The system MUST wake `process_pending_cycles()` via two independent paths: a Redis
  pub/sub subscriber on channel `REDIS_CHANNEL_AUTO_SCRAPE` (instant) and an APScheduler
  ~1-minute fallback poll. If `REDIS_URL` is unset, the subscriber MUST disable itself and log,
  leaving the poll as the sole wake path.
- **FR-002**: The system MUST claim work with a single atomic statement:
  `UPDATE auto_scrape_cycles SET status='postscrape_running', phase_heartbeat_at=NOW()
  WHERE status='scrape_complete' RETURNING id`, committed before processing. The statement
  claims **all** currently `scrape_complete` cycles at once; the system MUST then process each
  returned cycle id sequentially. This claim MUST prevent two workers from processing the same
  cycle.
- **FR-003**: For each claimed cycle the system MUST invoke `run_post_scrape_phase(cycle_id)`
  inside a try/except so that a failure in one cycle does not stop processing of the others. If
  that call raises (i.e. the failure escaped `run_post_scrape_phase`'s own handler), the system
  MUST attempt to set that cycle to `failed`, guarded by `WHERE status='postscrape_running'`,
  with `error_message='Top-level exception in run_post_scrape_phase'` and `completed_at`. (This
  outer message and status guard differ from the inner handler in FR-016.)

**Heartbeat**

- **FR-004**: While a cycle is processing, the system MUST run a background heartbeat task that
  every ~30 seconds updates `phase_heartbeat_at` for that cycle where its status is still
  `postscrape_running`, and MUST cancel that task when processing ends (success or failure).
  Heartbeat update failures MUST be logged and non-fatal.

**Phase 1 — Auto-expiration**

- **FR-005**: The system MUST read `shelf_life_days` from `system_settings` via
  `get_shelf_life_days`, which MUST return the stored integer, or `7` when the value is
  unset, non-integer, or less than `1`.
- **FR-006**: The system MUST delete, from each of `linkedin_jobs`, `indeed_jobs`, and
  `glassdoor_jobs`, all rows where `scrape_time < NOW() - make_interval(days => shelf_life_days)`,
  regardless of `matched` and not scoped to the current cycle.
- **FR-007**: The three Phase 1 DELETEs MUST execute within a single transaction (the caller
  wraps the call in `async with db.begin()`; `run_auto_expiration` itself does not open a
  transaction).
- **FR-008**: `run_auto_expiration` MUST return
  `{"deleted_per_table": {<table>: <rowcount>, ...}, "shelf_life_days": <N>}`, and the
  orchestrator MUST persist this verbatim to `cycle.cleanup_results` in its own write
  (a separate `_update_cycle` session/transaction, not the DELETE transaction), immediately
  after Phase 1 and before Phase 2. (A crash after the DELETEs commit but before this write
  leaves rows deleted yet unrecorded — a symmetric micro-window to KL-1.)

**Phase 2 — Matched-claim**

- **FR-009**: The system MUST, for each of the three tables, execute
  `UPDATE {table} SET matched = TRUE WHERE matched = FALSE RETURNING id, job_url, scan_run_id,
  scrape_time`, and return the claimed rows in a dict keyed by **site** name
  (`linkedin` / `indeed` / `glassdoor`), each value a list of row dicts.
- **FR-010**: The three Phase 2 UPDATEs MUST execute within a single transaction (caller wraps
  the call in `async with db.begin()`; `claim_unmatched_rows` itself does not open a
  transaction), so they commit together or roll back together.
- **FR-011**: The `matched` flip MUST be one-way (`FALSE → TRUE` only) and idempotent by
  construction (`WHERE matched = FALSE`): a row already `TRUE` is never re-claimed.
- **FR-012**: The system MUST derive `claim_summary = {site: count_of_claimed_rows}` from the
  Phase 2 result, MUST discard the returned row payloads (they are logged, not persisted), and
  MUST NOT persist the claimed rows anywhere.

**Stubbed phases (as-built no-ops)**

- **FR-013**: `_run_dedup_for_cycle` MUST return `None` (leaving `cycle.dedup_task_id` NULL),
  `_run_matching_for_cycle` MUST perform no matching work, and `_compute_match_results` MUST
  return `{}`. The orchestrator MUST still call these in sequence and log their (no-op)
  completion.

**Finalization**

- **FR-014**: The system MUST write `cycle.match_results = {"claim_summary": claim_summary,
  **match_results}`, where `match_results` is currently the empty dict returned by the
  `_compute_match_results` stub — so today `match_results` contains only `claim_summary`.
- **FR-015**: The system MUST then set `cycle.status = "post_scrape_complete"` with
  `completed_at = NOW()` as the terminal successful state. Every `_update_cycle` write MUST also
  refresh `phase_heartbeat_at`.
- **FR-016**: On any exception within `run_post_scrape_phase`, the system MUST set
  `status='failed'`, `error_message='Post-scrape phase failed: <type>: <message>'`, and
  `completed_at`. (Note: this inner failure write is not guarded by a status WHERE clause.)

**Order & atomicity invariants**

- **FR-017**: Phases MUST run strictly in order: cycle claim → Phase 1 (+ write
  `cleanup_results`) → Phase 2 (compute `claim_summary` in memory) → stub dedup (write
  `dedup_task_id=NULL`) → stub matching → compute `match_results` (`{}`) → write
  `match_results` → set `post_scrape_complete`.
- **FR-018**: Phase 1 and Phase 2 MUST each run in their own `AsyncSessionLocal` session and
  their own transaction; they are NOT part of one combined transaction. Consequently a Phase 2
  failure does not roll back Phase 1's committed deletes (nor the separately-committed
  `cleanup_results` write).

**Stale-cycle reaper**

- **FR-019**: A scheduled job `cleanup_stale_postscrape` MUST run every ~1 minute and set
  `status='failed'`, `error_message='Post-scrape orchestrator died mid-phase (stale heartbeat)'`,
  and `completed_at` for every cycle where `status='postscrape_running'` AND either
  `phase_heartbeat_at < NOW() - 10 minutes` OR
  (`phase_heartbeat_at IS NULL` AND `started_at < NOW() - 5 minutes`). The reaper MUST only
  transition such cycles to `failed`; it MUST NOT re-queue them and MUST NOT modify per-source
  rows (claimed `matched=TRUE` rows are left as-is).

### Known Limitations *(as-built; not defects to fix in this round)*

- **KL-1 — Crash window between Phase 2 and the final write**: `matched = TRUE` is committed at
  the end of Phase 2, but `claim_summary` and the terminal status are written afterward. A
  process death in between leaves rows permanently claimed (`matched = TRUE`) while
  `claim_summary` is never persisted and the cycle never reaches `post_scrape_complete`; the
  `WHERE matched = FALSE` filter prevents any re-claim. The `cleanup_stale_postscrape` reaper
  (FR-019) will eventually mark the cycle `failed`, but it does **not** un-claim the rows or
  recover `claim_summary`. Recovery of the claimed set is manual. (Referenced in prior docs as
  §15.2 / "claimed but not actually matched".)
- **KL-2 — Reaper marks stuck cycles failed but does not re-queue them**: a hard crash (not a
  Python exception) leaves the cycle in `postscrape_running` with a stale/NULL
  `phase_heartbeat_at`. The `cleanup_stale_postscrape` reaper (FR-019) transitions such cycles
  to `failed` (after >10 min stale heartbeat, or NULL heartbeat with `started_at` >5 min ago),
  which unblocks the stuck state — but there is **no** mechanism that re-runs the post-scrape
  phase or reverts a partially-applied cycle. Any per-source rows already claimed in that cycle
  remain `matched=TRUE`.
- **KL-3 — Claim payload is discarded**: the rows returned by Phase 2 (the intended input to the
  not-yet-built Phase 3 `match_candidates`) are logged and dropped; only counts survive. When a
  cycle claims rows, that specific claimed set cannot be reconstructed later.
- **KL-4 — Global (not cycle-scoped) operations**: both Phase 1 expiration and Phase 2 claim
  operate on the entire table contents at execution time, not on rows tied to the current cycle.
  A cycle's `claim_summary` therefore reflects all rows that were unmatched at that moment.
- **KL-5 — Inconsistent run-log id naming**: the claimed rows carry `scan_run_id`; elsewhere the
  same concept appears as `scrape_run_id` / `runId`. Documented, not renamed.

### Documentation Discrepancy *(as-built note)*

- **DD-1**: `docs/current-workflow.md` §5 illustrates Phase 1 and Phase 2 with explicit
  `await db.commit()` calls. The actual code instead wraps each phase in
  `async with db.begin():` (an auto-commit/rollback transaction block) inside a fresh
  `AsyncSessionLocal()` session. The effect (one committed transaction per phase) is
  equivalent; the illustrated code is not literal. This spec follows the code.

### Key Entities

- **`auto_scrape_cycles` row**: the cycle record. Relevant fields for this spec: `id` (UUID PK,
  `gen_random_uuid()`), `cycle_id` (BigInt human id), `status`
  (`scrape_complete → postscrape_running → post_scrape_complete`, or `failed`),
  `phase_heartbeat_at`, `cleanup_results` (JSONB, Phase 1 output), `dedup_task_id` (UUID, NULL
  in stub), `match_results` (JSONB, holds `claim_summary`), `error_message`, `completed_at`.
- **Per-source job tables** (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`): append-only
  ingest tables. Relevant columns: `id` (UUID PK), `scan_run_id` (FK to `extension_run_logs`),
  `job_url`, `scrape_time` (drives expiration), `matched` (boolean, false→true one-way claim
  flag). `indeed_jobs` additionally has `mosaic_present` (referenced by the smoke test's schema
  pre-flight).
- **`system_settings`**: key/value table; `shelf_life_days` key drives Phase 1 (default 7).
- **`cleanup_results` (JSONB)**: `{"deleted_per_table": {table: count}, "shelf_life_days": N}`.
- **`claim_summary` (in `match_results` JSONB)**: `{"linkedin": N, "indeed": N, "glassdoor": N}`
  — the only surviving product of Phase 2.

## Success Criteria *(mandatory)*

These criteria verify the spec faithfully matches current behavior; they are the pass
conditions for treating this document as an accurate baseline.

### Measurable Outcomes

- **SC-001**: `smoke_test_auto_expiration.py` passes unchanged: an old row is deleted, a fresh
  row is preserved, and the result reports `deleted_per_table.linkedin_jobs >= 1`.
- **SC-002**: `smoke_test_matched_claim.py` passes unchanged: each seeded `matched=FALSE` row in
  all three tables is returned by the claim and ends `matched=TRUE`; the scoped idempotence
  check flips exactly 1 then 0 rows.
- **SC-003**: Every functional requirement (FR-001…FR-019) is verifiable against the current
  code in `post_scrape_orchestrator.py`, `auto_expiration.py`, `matching_claim.py`, and
  `scheduler.py` (FR-019) with no contradiction — i.e., a reviewer can point to the exact line
  implementing each FR.
- **SC-004**: A healthy cycle deterministically ends as `status = "post_scrape_complete"` with
  `cleanup_results` populated and `match_results` containing exactly `{"claim_summary": {...}}`
  (no additional keys, since Phases 4–6 are stubs), matching the example in
  `docs/current-workflow.md` §6.
- **SC-005**: Each documented Known Limitation (KL-1…KL-5) and the discrepancy (DD-1) is
  traceable to specific current code behavior — none describes an intended future design. In
  particular, the reaper claims in KL-1/KL-2/FR-019 match `scheduler.cleanup_stale_postscrape`.

## Assumptions

- The three per-source tables and `system_settings` are provisioned by prior Alembic migrations
  (the matched-claim smoke test explicitly checks for `matched` columns and migration 028); this
  spec assumes the schema at the current migration head.
- At least one `extension_run_logs` row exists to satisfy the `scan_run_id` foreign key when
  exercising the smoke tests (both tests SKIP if none exists).
- "As implemented" refers to the code on the current branch (`docs/spec-baseline`) at the time
  of writing (2026-07-14); this spec is not a design proposal and introduces no requirements
  beyond describing existing behavior.
- Phases 3–6 remain stubs ("Phase 4.5: pipeline disabled pending redesign"); any behavior they
  would add is out of scope and intentionally absent from the current cycle output.
