# Feature Specification: Scrape-Phase Orchestrator (As-Built)

**Feature Branch**: `docs/spec-baseline`

**Created**: 2026-07-14

**Status**: As-Built Baseline (documents current behavior; proposes no changes)

**Input**: User description: "Produce an AS-BUILT specification of the CURRENT scrape-phase orchestrator."

---

## Overview *(as-built context)*

This is an **as-built specification** (Constitution Principle I) of the scrape-phase
orchestrator: the Chrome extension **service worker** modules under `extension/background/`
(`auto_scrape.js`, `auto_scrape_config.js`, `auto_scrape_init.js`, `poll.js`) and their backend
control surface (`backend/routers/auto_scrape.py`, `backend/core/auto_scrape_lifecycle.py`). It
documents what the code does today, including known limitations and doc-vs-code drift; it
proposes no changes.

The behavioral contract for the **backend** side is `backend/smoke_test_auto_scrape.py`
(Constitution Principle II), which exercises the `/admin/auto-scrape/*` endpoints (state,
config, cycle, sessions). The **service-worker orchestration JS** itself has no automated test
(see KL-6).

**Scope:**

- The cycle **trigger/alarm** (`auto_scrape_next_cycle`), the 30-second `jha_poll` self-bootstrap,
  and SW-startup init.
- **Pre-cycle probes** (`preCycleCheck` / `probeSiteSession`) and their session-state writes.
- The **sites × keywords matrix** loop (`runScrapeMatrix`), per-scan config keyword push,
  **trigger-scan + run-log polling** (`triggerScanAndWait`).
- **Cycle status transitions** (`scrape_running → scrape_complete`, or `failed`) and the
  guarded backend transition.
- The **Redis wake** to the post-scrape orchestrator.
- **Hardening**: auto-pause on precheck failures, dead-session suspension, CAPTCHA handling,
  abort flags, scheduling backoff, orphan/stale cleanup.
- The **post-cycle-455 stale-threshold fix**.

**Scope note.** The per-scan job scraping itself (content scripts walking paginated results and
`POST /jobs/ingest`) is covered by spec `002`; this spec covers the *orchestration* around it.
The post-scrape phase (dedup/matching after `scrape_complete`) is spec `001`.

**Authentication.** Every `/admin/auto-scrape/*` route requires bearer auth via
`get_current_user`; the SW sends `Authorization: Bearer <authToken>` on all calls (Principle VII).

## Clarifications

### Session 2026-07-14

Authored directly from source (`extension/background/auto_scrape.js`, `auto_scrape_config.js`,
`auto_scrape_init.js`, `poll.js`; `routers/auto_scrape.py`; `core/auto_scrape_lifecycle.py`)
plus `docs/current-workflow.md` §4/§8 and `smoke_test_auto_scrape.py`. No open questions
required a user decision; behavior was fully determined by the code.

**Verification pass (against the extension background modules, `routers/auto_scrape.py`,
`routers/extension.py`, `core/auto_scrape_lifecycle.py`, `smoke_test_auto_scrape.py`):**

- Finding: **Bug 3** — the run-log status field is non-monotonic. → Correction:
  `update_run_log` (`routers/extension.py`) protects a `completed` row only from **non-status**
  updates; a `failed → completed` PUT is allowed (it even clears `error_message` and can trigger
  sync-dedup), and an explicit `status` in the body can flip `completed → failed`. The
  orchestrator's `_fetchRunLog` trusts the **latest** status as terminal, so a race between the
  60-min stale-cleanup (`failed`) and the real scan completion (`completed`) resolves
  last-writer-wins. Captured as **KL-8**.
- Finding: multi-instance handling was under-documented. → Correction: a single logical owner is
  tracked by `instance_id`; `cleanup-orphan-cycles` compares the caller's id to the stored
  `extension_instance_id` and fails `scrape_running` cycles on mismatch, **but** `heartbeat`
  overwrites the stored id whenever a different instance heartbeats (last-writer-wins), and
  `_recent_instances` / `/instances` track all heartbeats within a 5-minute window. Added FR-023
  and KL-9.
- Finding: config reload timing was omitted. → Correction: the orchestrator config is fetched
  **fresh per cycle at three separate points** (`max_consecutive_precheck_failures` on the
  precheck-fail path, `max_consecutive_dead_session_cycles` after cycle creation, and
  `enabled_sites`/`keywords` before the matrix), each defaulting on fetch failure;
  `min_cycle_interval_ms` is read from **state** at each schedule; the per-pair search-config
  keyword is pushed to `/config` immediately before each scan. A mid-cycle change is only picked
  up next cycle (or via a `config_change_pending` matrix abort). Added FR-024.
- Finding: the cycle_phase self-bootstrap guard needed to be explicit. → Correction: the poll
  bootstraps the alarm only when `(enabled | test_cycle_pending) && !exit_requested &&
  cycle_phase ∉ {scrape_running, postscrape_running} && no existing alarm`. `cycle_phase` is
  **SW-managed** (set `scrape_running` in `runOneCycle`, reset to `idle` in its `finally`), so it
  reflects the scrape phase only; the `postscrape_running` guard value is rarely set by the SW.
  Refined in FR-002.
- Finding: precheck config-loadability target. → Correction: `preCycleCheck` tests the **search**
  config (`fetchConfig`), not the orchestrator config, for `config_unavailable`. Clarified in
  FR-004.
- Verified with no discrepancy: the alarm/bootstrap flow, probe classifications, guarded
  `scrape_complete` transition (409/404/idempotent), matrix trigger body
  (`scan_all_position:1/total:2`), 60-min stale threshold + `error_message` clear (FR-021), the
  auto-pause/dead-session/CAPTCHA hardening, SC-4 scheduling, and startup stale cleanup.
  `smoke_test_auto_scrape.py` covers the backend endpoints only (KL-6 stands).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run one auto-scrape cycle end to end (Priority: P1)

When the cycle alarm fires (and auto-scrape is enabled), the service worker probes each site,
creates a cycle row, scrapes every eligible site × keyword pair, marks the cycle
`scrape_complete`, and wakes the backend post-scrape orchestrator.

**Why this priority**: This is the core loop that produces every scraped job and hands off to
the post-scrape phase.

**Independent Test**: With auto-scrape enabled and live sessions, let the
`auto_scrape_next_cycle` alarm fire and observe: session probes recorded, an
`auto_scrape_cycles` row created `scrape_running`, run-logs per matrix entry, the cycle ending
`scrape_complete`, and a Redis wake published.

**Acceptance Scenarios**:

1. **Given** the alarm fires with `enabled=true` (or `test_cycle_pending=true`) and not
   `exit_requested`, **When** `onAutoScrapeAlarm` runs, **Then** it calls `runOneCycle`, and for
   a continuous run reschedules the next cycle afterward (unless paused/exited mid-cycle).
2. **Given** `preCycleCheck` returns `ok` (backend healthy, config loadable, ≥1 live session),
   **When** the cycle proceeds, **Then** a cycle row is created via `POST /admin/auto-scrape/cycle`
   with `status="scrape_running"`, and `precheck_status="ok"` is recorded.
3. **Given** the matrix of `enabled_sites ∩ live-eligible sites` × config `keywords`, **When**
   `runScrapeMatrix` runs, **Then** for each pair it pushes the keyword to the search config,
   triggers a scan, waits for the run-log to reach a terminal status, and accumulates
   `scans_attempted/succeeded/failed` + `failures_by_reason` + `run_log_ids` onto the cycle.
4. **Given** the matrix completes without abort, **When** the cycle finalizes, **Then** the
   cycle is set `scrape_complete` with `completed_at`, `cleanup-invalid-entries` is called, and
   `wake-orchestrator` publishes a Redis wake for the post-scrape subscriber.
5. **Given** the matrix was aborted (exit/stop/backend-down/watchdog/config-change), **When** the
   cycle finalizes, **Then** it is set `failed` with an `error_message` describing the abort.

---

### User Story 2 - Detect dead sessions and harden against blocks (Priority: P1)

Before and during a cycle, the orchestrator probes each site's login session, records
live/expired/captcha/rate-limited state, notifies the user on CAPTCHA or session death,
suspends persistently-failing sites, and auto-pauses after repeated precheck failures.

**Why this priority**: Without this the scraper would hammer logged-out/blocked sites and
generate junk; it protects the user's accounts and the pipeline's data quality.

**Independent Test**: Drive `PUT /admin/auto-scrape/sessions/{site}` with each
`last_probe_status` and assert the `SiteSessionState` transitions (failure counters, backoff,
one-shot notification); force N consecutive precheck failures and assert auto-pause.

**Acceptance Scenarios**:

1. **Given** a probe result, **When** `probeSiteSession` classifies it, **Then** it returns one
   of `live` / `expired` / `rate_limited` / `captcha` / `unknown_treat_as_live` / `unknown`
   from the final URL, HTTP status, and body markers, and `PUT /sessions/{site}` records it
   (`unknown_treat_as_live` is stored as `unknown`).
2. **Given** `PUT /sessions/{site}`, **When** status is `live` → reset `consecutive_failures`
   and `notified_user`; `expired`/`captcha` → increment failures and (on a live→dead transition)
   send a one-shot "session died" notification; `rate_limited` → double `backoff_multiplier`
   (capped at 64).
3. **Given** a site with `consecutive_failures ≥ max_consecutive_dead_session_cycles`
   (default 24) or `last_probe_status="captcha"`, **When** the matrix is built, **Then** that
   site is excluded (suspended).
4. **Given** `preCycleCheck` fails, **When** the failure count reaches
   `max_consecutive_precheck_failures` (default 3), **Then** the orchestrator auto-pauses
   (`PUT state {enabled:false}`) and writes a `failed` cycle row; a subsequent `ok` precheck
   resets the counter to 0.
5. **Given** probed sites include CAPTCHA, **When** the precheck completes, **Then** a
   `requireInteraction` notification is fired per captcha site; clicking it opens that site's
   probe URL.

---

### User Story 3 - Control, schedule, and clean up cycles (Priority: P2)

The user enables/pauses/test-runs/shuts-down auto-scrape from the dashboard; the orchestrator
schedules the next cycle with backoff and cleans up orphaned/stale cycles across restarts.

**Why this priority**: Operational control and self-healing; secondary to running the cycle.

**Independent Test**: Toggle `/enable`, `/pause`, `/test-cycle`, `/shutdown`, `/restart-cycle`
and assert the state flags; simulate a new SW instance and a backend restart and assert orphan/
stale cycles are marked `failed`.

**Acceptance Scenarios**:

1. **Given** the `jha_poll` alarm (every 30s), **When** it fires, **Then** it polls
   `/extension/pending` (manual scan/stop), heartbeats `/admin/auto-scrape/heartbeat`, and polls
   `/admin/auto-scrape/state`; if `enabled`/`test_cycle_pending` and not `exit_requested` and no
   cycle active and no existing alarm, it self-bootstraps the `auto_scrape_next_cycle` alarm.
2. **Given** a completed continuous cycle, **When** `scheduleNextCycle` runs, **Then** it sleeps
   `max(0, min_cycle_interval_ms − elapsed)`, extended to a 5-minute cooldown when the cycle was
   trivially short (`elapsed < 30s` and `scans_succeeded == 0`, "SC-4"), and stores
   `next_cycle_at`.
3. **Given** a new SW instance boots, **When** `initAutoScrape` runs, **Then** it assigns an
   `instance_id`, sets `enabled=false` / `cycle_phase="idle"` (never auto-resumes), closes orphan
   scrape popups, and calls `cleanup-orphan-cycles` (which marks `scrape_running` cycles `failed`
   when the stored `extension_instance_id` differs).
4. **Given** the backend restarts, **When** `cleanup_stale_cycles_at_startup` runs, **Then**
   cycles stuck in `scrape_running`/`postscrape_running` for >2 hours are marked `failed` and
   `cycle_phase` is reset to `idle`.
5. **Given** `exit_requested` is set (via `/shutdown`), **When** the SW observes it (poll or
   alarm), **Then** `handleGracefulExit` closes popups, clears the alarm, and disables
   auto-scrape.

---

### Edge Cases

- **Backend unreachable at precheck**: `preCycleCheck` returns `backend_down`; the cycle
  fails/increments the precheck counter (fetch failures in the SW are generally swallowed
  best-effort).
- **All sessions dead / no matrix overlap**: precheck `all_sessions_dead`, or `enabled_sites`
  not overlapping live-eligible sites → the cycle row is marked `failed` (no scans run).
- **Server-error / network probe**: HTTP 5xx or a thrown fetch is classified
  `unknown_treat_as_live` — the orchestrator **fails open** and treats the site as live for the
  matrix (stored as `unknown`).
- **`scrape_complete` race**: the backend transition is guarded by `WHERE status="scrape_running"`;
  a second attempt on an already-complete cycle returns the row idempotently, and a non-running
  cycle yields HTTP 409 (404 if missing).
- **Trigger-scan contention**: `POST /extension/trigger-scan` 409 with `scan_pending`/
  `stop_cooldown` is retried (≤5 attempts / 60s, jittered); `scan_in_progress` throws
  immediately.
- **Run-log never appears**: if no matching run-log appears within 60s (Phase A), or it never
  reaches a terminal status within the 30-minute scan timeout (Phase B), `triggerScanAndWait`
  throws `timeout` and that matrix entry is counted failed.
- **Config change mid-cycle**: `config_change_pending` aborts the **matrix** (finishing the
  current cycle as `failed`); exit/stop/backend-down/watchdog abort the **whole cycle**.
- **SW suspension**: the orchestrator runs in a service worker that suspends after ~30s idle;
  alarms + keepalive keep it running, but a long `triggerScanAndWait` depends on the SW staying
  alive.

## Requirements *(mandatory)*

### Functional Requirements

**Triggers, alarms, bootstrap**

- **FR-001**: The system MUST run a cycle when the `auto_scrape_next_cycle` alarm fires via
  `onAutoScrapeAlarm`: if `exit_requested` → graceful exit; else if neither `enabled` nor
  `test_cycle_pending` → no-op; else run `runOneCycle` and (continuous only) reschedule.
- **FR-002**: The `jha_poll` alarm (every 0.5 min) MUST poll `/extension/pending`, heartbeat
  `/admin/auto-scrape/heartbeat` (when enabled/test-pending), and poll `/admin/auto-scrape/state`;
  the state poll MUST self-bootstrap the `auto_scrape_next_cycle` alarm (`when = now + 1s`) only
  when **all** guards hold: `(enabled | test_cycle_pending)` AND `!exit_requested` AND
  `cycle_phase ∉ {scrape_running, postscrape_running}` AND no existing `auto_scrape_next_cycle`
  alarm. `cycle_phase` is SW-managed (set `scrape_running` in `runOneCycle`, reset to `idle` in
  its `finally`), so it reflects the scrape phase only.
- **FR-003**: On SW startup (`onStartup`/`onInstalled`), `initAutoScrape` MUST assign an
  `instance_id`, set `enabled=false` and `cycle_phase="idle"` (never auto-resume), close orphan
  scrape popups, and — for a new instance — call `cleanup-orphan-cycles`.

**Pre-cycle probes**

- **FR-004**: `preCycleCheck` MUST verify `/health` (`status=="ok"`, else `backend_down`) and
  **search**-config loadability via `fetchConfig` (else `config_unavailable`), then probe each of
  `linkedin`/`indeed`/`glassdoor` via `probeSiteSession`, `PUT /sessions/{site}` for each, and
  collect `sites_with_live_session` (status `live` or `unknown_treat_as_live`); zero live →
  `all_sessions_dead`; else `ok`.
- **FR-005**: `probeSiteSession` MUST fetch the site's probe URL with credentials and classify:
  CAPTCHA (URL/body markers), `expired` (login/authwall redirect), `rate_limited` (HTTP 429, or
  403 without captcha markers), `live` (2xx without captcha markers),
  `unknown_treat_as_live` (5xx or thrown fetch), else `unknown`.

**Cycle row & status transitions**

- **FR-006**: The cycle row MUST be created via `POST /admin/auto-scrape/cycle`
  (`cycle_id` from `nextval('auto_scrape_cycle_id_seq')`, `status="scrape_running"`,
  `phase_heartbeat_at`), and `PUT /admin/auto-scrape/cycle/{id}` MUST update counters/fields
  (always refreshing `phase_heartbeat_at`).
- **FR-007**: Transitioning to `scrape_complete` MUST be guarded by
  `WHERE status="scrape_running"`: success returns the row; an already-`scrape_complete` cycle
  returns idempotently; any other current status yields HTTP 409; a missing cycle yields 404.
- **FR-008**: A cycle MUST be marked `failed` (with `error_message` + `completed_at`) on
  precheck failure, all-sessions-suspended, no matrix overlap, or matrix abort.

**Matrix loop & scan polling**

- **FR-009**: `runScrapeMatrix` MUST iterate `matrixSites × keywords`; before each pair it MUST
  check abort flags (`_checkAbortFlags`) and break on abort. For each pair it MUST push the
  keyword to the search config (`_updateConfigKeyword`; site-specific field), run
  `triggerScanAndWait`, read the run-log terminal status, update the cycle's running counters,
  and sleep `inter_scan_delay` (30s).
- **FR-010**: `_triggerScanWithRetry` MUST wait for scan idle (≤60s), then
  `POST /extension/trigger-scan {website, scan_all:true, scan_all_position:1, scan_all_total:2}`,
  retrying ≤5 attempts within a 60s deadline on 409 `scan_pending`/`stop_cooldown` (jittered
  sleep), throwing immediately on 409 `scan_in_progress` or other errors.
- **FR-011**: `triggerScanAndWait` MUST start active polling, then Phase A: poll
  `/extension/run-log` up to 60s for a run-log matching the site and started within 5s of the
  trigger; Phase B: poll that run-log every 5s until non-`running` or the 30-minute timeout
  (throwing `timeout` on either deadline). A matrix entry succeeds only when its run-log ends
  `completed`.

**Redis wake**

- **FR-012**: On a completed cycle, `_wakeOrchestrator` MUST `POST /admin/auto-scrape/wake-orchestrator`
  (`{cycle_id}`), which publishes a Redis wake on the auto-scrape channel; this is best-effort
  (the backend's 1-minute poll is the fallback).

**Hardening**

- **FR-013** (auto-pause): Consecutive precheck failures MUST be counted; on reaching
  `max_consecutive_precheck_failures` (default 3) the orchestrator MUST auto-pause
  (`enabled=false`); a subsequent `ok` precheck resets the counter.
- **FR-014** (dead-session suspension): Sites with `consecutive_failures ≥
  max_consecutive_dead_session_cycles` (default 24) or `last_probe_status="captcha"` MUST be
  excluded from the matrix.
- **FR-015** (session accounting): `PUT /sessions/{site}` MUST, per `last_probe_status`, reset
  on `live`, increment + one-shot-notify on `expired`/`captcha` (only on a live→dead
  transition), and exponentially back off (`×2`, cap 64) on `rate_limited`.
- **FR-016** (CAPTCHA notify): captcha sites MUST trigger a `requireInteraction` notification;
  clicking it MUST open that site's probe URL.
- **FR-017** (abort): `_checkAbortFlags` MUST abort the whole **cycle** on `exit_requested` /
  `stopRequested` / `_backendDownDuringScan` / `_watchdogTripped`, and abort just the **matrix**
  on `config_change_pending`.

**Scheduling & lifecycle cleanup**

- **FR-018**: `scheduleNextCycle` MUST sleep `max(0, min_cycle_interval_ms − elapsed)`, extended
  to a 5-minute cooldown when `elapsed < 30s` and `scans_succeeded == 0` (SC-4), then set the
  alarm and store `next_cycle_at`.
- **FR-019**: `cleanup-orphan-cycles` MUST mark `scrape_running` cycles `failed` when the stored
  `extension_instance_id` differs from the caller's (no-op when it matches);
  `cleanup_stale_cycles_at_startup` MUST mark `scrape_running`/`postscrape_running` cycles older
  than 2 hours `failed` and reset `cycle_phase` to `idle`.
- **FR-020** (graceful exit): `handleGracefulExit` MUST be idempotent (single in-flight), close
  scrape popups, clear the cycle alarm, and disable auto-scrape state.

**Cycle-455 stale-threshold fix**

- **FR-021**: The backend run-log stale-cleanup threshold behind `trigger-scan` MUST be **60
  minutes** (raised from 5), and `error_message` MUST be cleared on terminal success — so
  legitimately long scans (LinkedIn full pagination ~33 min) complete as `completed` with
  `error_message=NULL` instead of being falsely failed (validated by cycle 481 vs 455).

**Multi-instance handling**

- **FR-023**: A single logical owner MUST be tracked by `instance_id` (SW-assigned):
  `cleanup-orphan-cycles` compares the caller's `current_instance_id` to the stored
  `extension_instance_id` and marks `scrape_running` cycles `failed` on mismatch (no-op on
  match); `heartbeat` MUST update the stored `extension_instance_id` whenever a heartbeat with a
  different id arrives (last-writer-wins) and record it in `_recent_instances`; `GET /instances`
  MUST return instances that heartbeated within the last 5 minutes.

**Config reload timing**

- **FR-024**: The orchestrator config MUST be read fresh each cycle at three points —
  `max_consecutive_precheck_failures` (precheck-fail path), `max_consecutive_dead_session_cycles`
  (after cycle creation), and `enabled_sites`/`keywords` (before the matrix) — each falling back
  to a default on fetch failure; `min_cycle_interval_ms` MUST be read from **state** at each
  schedule; a mid-cycle config change is picked up only on the next cycle or via a
  `config_change_pending` matrix abort.

**Cross-cutting**

- **FR-022**: Every `/admin/auto-scrape/*` route MUST require bearer auth via `get_current_user`.

### Known Limitations *(as-built; not defects to fix in this round)*

- **KL-1 — Doc-vs-code drift in workflow §4**: the doc lists probe statuses as
  `live|rate_limited|logged_out|offline` (code uses
  `live|expired|rate_limited|captcha|unknown_treat_as_live|unknown`), shows the trigger-scan body
  as `{website, keyword}` (code sends `{website, scan_all:true, scan_all_position:1,
  scan_all_total:2}` and pushes the keyword via `PUT /config` separately), and says "sleep 0ms
  after success" (code uses the `min_cycle_interval` / SC-4 logic). Code is authoritative.
- **KL-2 — Fixed `scan_all_position:1/total:2`**: auto-scrape always sends position 1 of 2, so
  the extension router's post-scan sync-dedup (which fires only when `position == total`) never
  triggers for auto-scrape scans — dedup runs via the post-scrape orchestrator (spec 001)
  instead. The `2` is a constant, not the real matrix size.
- **KL-3 — Fail-open probes**: 5xx and thrown fetches are treated as `unknown_treat_as_live`, so
  a site can enter the matrix while actually unreachable, producing failed scans that count
  toward its dead-session suspension.
- **KL-4 — Two config surfaces**: the matrix is driven by the orchestrator config
  (`/admin/auto-scrape/config` `enabled_sites` + `keywords`), but each scan's keyword is pushed
  into the *search* config (`/config` site-specific fields) right before the scan — two separate
  config stores kept in sync per pair.
- **KL-5 — Best-effort state, dual storage**: cycle-critical flags live in both
  `chrome.storage.local._autoScrape` and the backend `auto_scrape_state` row, synced by polling;
  many SW→backend writes are best-effort (`try/catch` swallowed), so transient failures can
  desync the two.
- **KL-6 — No test for the SW orchestrator**: `smoke_test_auto_scrape.py` covers the backend
  `/admin/auto-scrape/*` endpoints (state/config/cycle/sessions) but not the service-worker
  orchestration JS (`runOneCycle`, matrix loop, probes, scheduling) — the bulk of the logic is
  unverified by an automated test.
- **KL-7 — In-memory instance tracker**: `_recent_instances` (5-minute window) is a
  process-global on the backend, lost on restart and not shared across workers.
- **KL-8 — Bug 3: run-log status is non-monotonic**: `update_run_log`
  (`routers/extension.py`) protects a `completed` run-log only from **non-status** updates; a
  `failed → completed` PUT is permitted (and clears `error_message`, and can trigger sync-dedup),
  while an explicit `status` in the body can also flip `completed → failed`. Combined with the
  60-min stale-cleanup that can mark a healthy long scan `failed`, the terminal status the
  orchestrator reads is last-writer-wins, not a monotonic lifecycle.
- **KL-9 — Instance ownership is last-writer-wins**: `heartbeat` overwrites the stored
  `extension_instance_id` on any differing heartbeat, so with two live instances the stored owner
  flips to whoever heartbeated most recently — making `cleanup-orphan-cycles`' mismatch check
  racy (it may or may not fire depending on heartbeat ordering).

### Key Entities

- **`auto_scrape_cycles`**: one row per cycle. `id` (UUID), `cycle_id` (BigInt from sequence),
  `status` (`scrape_running → scrape_complete`/`failed`, then post-scrape phases per spec 001),
  `started_at`, `completed_at`, `phase_heartbeat_at`, `precheck_status`, `precheck_details`,
  `scans_attempted/succeeded/failed`, `failures_by_reason`, `run_log_ids`, `error_message`.
- **`auto_scrape_state`** (singleton id=1): JSONB `state` with `enabled`, `cycle_phase`,
  `test_cycle_pending`, `exit_requested`, `config_change_pending`, `consecutive_precheck_failures`,
  `next_cycle_at`, `min_cycle_interval_ms`, `extension_instance_id`, `last_sw_heartbeat_at`.
- **`auto_scrape_config`** (singleton id=1): `enabled_sites`, `keywords`, interval/delay/timeout,
  `max_consecutive_precheck_failures`, `max_consecutive_dead_session_cycles`, downstream toggles.
- **`site_session_state`** (per site): `last_probe_status`, `last_probe_at`,
  `consecutive_failures`, `notified_user`, `backoff_multiplier`, `updated_at`.
- **SW `chrome.storage.local._autoScrape`**: mirror of enable/phase/instance/interval/counters,
  plus abort flags (`_autoScrape_exit_requested`, `stopRequested`, `_backendDownDuringScan`,
  `_watchdogTripped`, `_autoScrape_config_change_pending`).
- **`extension_run_logs`**: one row per matrix scan (spec 002/dedup); the orchestrator polls
  these by run-log id for terminal status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every functional requirement (FR-001…FR-024) is traceable to a specific line/area
  in `extension/background/auto_scrape*.js`, `poll.js`, `routers/auto_scrape.py`,
  `routers/extension.py` (FR-021, KL-8), or `core/auto_scrape_lifecycle.py` with no contradiction.
- **SC-002**: A healthy cycle deterministically ends `scrape_complete` with per-matrix run-log
  ids recorded and a Redis wake published (matching the cycle-481 example in workflow §4).
- **SC-003**: The backend endpoint contract passes `smoke_test_auto_scrape.py` unchanged
  (state/config validation, cycle create/complete, session probe transitions).
- **SC-004**: The hardening paths reproduce: auto-pause at the precheck threshold, site
  suspension at the dead-session threshold, one-shot session-death notification, and CAPTCHA
  notification + exclusion.
- **SC-005**: Each Known Limitation (KL-1…KL-9) and the cycle-455 fix (FR-021) is reproducible
  against the current code; none describes an intended future design.

## Assumptions

- The `auto_scrape_cycles`, `auto_scrape_state`, `auto_scrape_config`, `site_session_state`, and
  `extension_run_logs` tables exist at the current Alembic head (singletons seeded).
- "As implemented" refers to the code on branch `docs/spec-baseline` at 2026-07-14; this spec
  introduces no requirements beyond describing existing behavior.
- The extension runs as an MV3 service worker with `alarms`, `notifications`, `windows`, `tabs`,
  and `storage` permissions; the backend is reachable at the configured `backendUrl` with a
  valid bearer token; Redis may or may not be available (the poll fallback covers its absence).
- The post-cycle-455 fix (FR-021) lives in the backend `trigger-scan` / run-log stale-cleanup
  path (extension run-log handling), described in workflow §8; this spec documents its effect,
  not its exact line location.
