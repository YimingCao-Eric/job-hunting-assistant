# JHA — Current workflow (post-scrape account current as of 2026-07-16)

> Single-page reference for how a JHA cycle works end-to-end, with explicit markers for **what's shipped** and **what lives outside this backend**.
>
> Read this first when:
> - Picking up the project after a break
> - Onboarding to JHA
> - Deciding what to build next
> - Debugging a cycle that didn't behave as expected
>
> For DDL details see `current-schemas.md`. For session history see `session-record-2026-05-07.md`. For comprehensive project history see `jha-onboarding.md`.

---

## Table of contents

1. [Where we are in the workflow (status snapshot)](#1-where-we-are-in-the-workflow-status-snapshot)
2. [Glossary](#2-glossary)
3. [The full workflow — diagram](#3-the-full-workflow--diagram)
4. [Stage 1 — Extension orchestrator (scrape phase)](#4-stage-1--extension-orchestrator-scrape-phase)
5. [Stage 2 — Backend post-scrape orchestrator (post-scrape phase)](#5-stage-2--backend-post-scrape-orchestrator-post-scrape-phase)
6. [What gets persisted after a healthy cycle](#6-what-gets-persisted-after-a-healthy-cycle)
7. [What's next — and where it lives](#7-whats-next--and-where-it-lives)
8. [Extension-side behavior post-cycle 455 fix](#8-extension-side-behavior-post-cycle-455-fix)

---

## 1. Where we are in the workflow (status snapshot)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  SCRAPE PHASE                  POST-SCRAPE PHASE                         │
│  ════════════                  ═════════════════                         │
│                                                                          │
│  Extension orchestrator        Phase 1: Auto-expiration         ✅ LIVE  │
│  ✅ LIVE                       Finalize (no claim phase)        ✅ LIVE  │
│                                                                          │
│                                — that is the whole post-scrape run —     │
│                                                                          │
│  Filtering / matching moved OUT of this backend entirely:                │
│  a separate standalone service reads scraped_jobs and claims rows        │
│  itself via `matched`.                                        📦 SEPARATE│
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

✅ LIVE     — production-ready, validated end-to-end
📦 SEPARATE — not this codebase; a standalone service (see §7)
```

**Today:**

- Scrape phase is fully working
- The post-scrape run is **one phase — auto-expiration — then finalize**. Nothing else.
- **The matched-claim (formerly Phase 2) is retired** (feature 010). Rows are left `matched=FALSE` after a scrape so the standalone filtering/matching service can claim them itself. `auto_scrape/matching_claim.py` is deleted.
- **Dedup and matching are not in this backend.** The `dedup/`, `matching/`, and `profile/` packages were deleted by the search-only split, along with the `_run_dedup_for_cycle` / `_run_matching_for_cycle` / `_compute_match_results` stubs that older revisions of this document described as "Phases 4-6". They do not exist. The `match_candidates` design ("Phase 3") was superseded by the canonical `scraped_jobs` table (feature 008).
- That work now belongs to a **standalone service** (`filter-matching-service-design.md`), which consumes `scraped_jobs` and owns the `matched` claim.
- Auto-apply remains a distant product idea, not in this codebase.

---

## 2. Glossary

Terms used in this document, defined once here:

| Term | Definition |
|---|---|
| **Per-source tables** | The three site-specific scrape tables: `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`. Each one matches its site's natural field shape (51, 61, 69 columns respectively). Created in migration 025; replaces the legacy unified `scraped_jobs` table. |
| **`match_candidates`** | **Abandoned design — does not exist and is not planned.** It was to be a merged table built from claimed per-source rows. Superseded by `scraped_jobs` (feature 008), which is now the canonical merged table written at ingest by atomic dual-write. Consumers read `scraped_jobs` directly; there is no build phase. |
| **`scraped_jobs`** | The canonical, site-agnostic merged table — one row per posting, written in the same transaction as its per-source row (feature 008). This is the table downstream consumers read. |
| **`scan_run_id`** | UUID FK to `extension_run_logs.id`. Every per-source row carries this; identifies which scrape produced it. |
| **`matched`** | BOOLEAN column on the three per-source tables (migration 028) and on canonical `scraped_jobs` (migration 030). Default FALSE on insert. **Nothing in JHA flips it** — the post-scrape claim was retired (feature 010). It is reserved as the **processed-marker of the standalone filtering/matching service**, which claims rows itself with `WHERE matched = FALSE`, flipping the canonical row and its per-source origin together in one transaction so the two never disagree. |
| **`shelf_life_days`** | Setting in `system_settings` (default 7). Per-source rows older than this get DELETEd by Phase 1 auto-expiration. |
| **Cycle** | A single end-to-end run of the auto-scrape pipeline. Identified by `auto_scrape_cycles.cycle_id`. Goes through `scrape_running → scrape_complete → postscrape_running → post_scrape_complete`. |
| **Run-log** | A row in `extension_run_logs`. Tracks one site/keyword scan within a cycle. A 3×3 cycle (3 sites × 3 keywords) produces 9 run-logs. |
| **Claim** | Flipping `matched=FALSE → TRUE` on a row to mark it taken for processing. **JHA no longer does this** — the post-scrape auto-claim was retired (feature 010). The term now refers to what the standalone filtering/matching service does when it picks up rows. Not to be confused with the *cycle* claim below. |
| **Cycle claim** | The orchestrator's atomic `scrape_complete → postscrape_running` status transition, which stops two backend workers processing the same cycle. Unrelated to `matched`; still live. |
| **Matrix** | The combinatorial set of [site, keyword] pairs the extension orchestrator iterates through within a cycle. |

---

## 3. The full workflow — diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: EXTENSION ORCHESTRATOR (auto_scrape.js in SW)            ✅ LIVE   │
│                                                                              │
│  Triggered by: alarm (auto_scrape_next_cycle) OR manual enable.             │
│                                                                              │
│  ├─ pre-cycle check: probe all 3 sites, verify backend reachable            │
│  ├─ create cycle row: status='scrape_running'                               │
│  ├─ matrix loop: 3 sites × N keywords (N from config)                       │
│  │    For each [site, keyword]:                                             │
│  │      ├─ POST /extension/trigger-scan {website, keyword}                  │
│  │      ├─ poll until run-log appears                                       │
│  │      └─ poll run-log until terminal status (completed or failed)         │
│  ├─ post-cycle: cleanup invalid entries                                     │
│  └─ when matrix done: cycle.status = 'scrape_complete'                      │
│                                                                              │
│  Per-source tables get rows ingested with matched=FALSE during this stage.  │
│  Each row carries scan_run_id pointing to its run-log.                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ↓
                    Redis publish wakes backend orchestrator
                                  ↓
                    Atomic claim transitions cycle.status:
                     scrape_complete → postscrape_running
                                  ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: BACKEND POST-SCRAPE ORCHESTRATOR                                   │
│ (run_post_scrape_phase in post_scrape_orchestrator.py)                      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 1 — AUTO-EXPIRATION                              ✅ LIVE  │        │
│  │                                                                  │        │
│  │  await run_auto_expiration(db)                                  │        │
│  │  → For each table in (linkedin_jobs, indeed_jobs, glassdoor_jobs│        │
│  │     , scraped_jobs)                                              │        │
│  │     DELETE WHERE scrape_time + shelf_life_days < NOW()           │        │
│  │  → Returns {"deleted_per_table": {...}, "shelf_life_days": N}   │        │
│  │  → Writes to cycle.cleanup_results immediately                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ FINALIZE — one write, no claim phase                   ✅ LIVE  │        │
│  │                                                                  │        │
│  │  await _update_cycle(                                            │        │
│  │      cycle_id,                                                   │        │
│  │      status="post_scrape_complete",                              │        │
│  │      completed_at=now(),                                         │        │
│  │      match_results={"claim_summary": None,                       │        │
│  │                     "claim_retired": True},                      │        │
│  │  )                                                               │        │
│  │                                                                  │        │
│  │  Rows scraped by this cycle are left matched=FALSE.              │        │
│  │  Nothing in JHA claims them (feature 010).                       │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  That is the entire post-scrape run: expire, then finalize.                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ↓
              matched=FALSE rows wait here for a SEPARATE service
                                  ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STANDALONE FILTERING / MATCHING SERVICE            📦 SEPARATE PROJECT      │
│ (not this codebase — see filter-matching-service-design.md)                  │
│                                                                              │
│  Reads canonical scraped_jobs, claims rows itself:                          │
│    UPDATE ... SET matched=TRUE WHERE matched=FALSE                          │
│    (canonical row + its per-source origin, one transaction)                  │
│  Then filters and matches, writing its own tables.                          │
│                                                                              │
│  Dedup and matching used to be described here as backend "Phases 3-6".      │
│  Those packages and stubs were DELETED by the search-only split and the     │
│  match_candidates design was superseded by scraped_jobs (feature 008).      │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ↓
                    Next cycle fires from alarm
                    (sleep 0ms after success;
                     longer if precheck failed or rate-limited)
```
---

## 4. Stage 1 — Extension orchestrator (scrape phase)

**Status:** ✅ LIVE — fully working, validated 2026-04-29 with 5-hour run, re-validated 2026-05-07 with cycle 481.

### What runs

`extension/auto_scrape/auto_scrape.js` in the service worker. Triggered by:
- Chrome alarm `auto_scrape_next_cycle` (the normal ongoing case)
- User clicks "Enable" in the popup (manual start)
- `runOneCycle(testCycle=true)` from the dashboard for a single test cycle

### What it does

1. **Pre-cycle check:** probes LinkedIn, Indeed, Glassdoor by fetching a known-stable URL on each. Records `status: live | rate_limited | logged_out | offline` per site. Aborts the cycle if backend is unreachable.

2. **Creates the cycle row:** POST `/admin/auto-scrape/cycle` returns `cycle_id`. Cycle row is in `auto_scrape_cycles` with `status='scrape_running'`.

3. **Loads config:** GET `/admin/auto-scrape/config` returns the user's site list and keyword list. Default config is 3 sites × 3 keywords = 9 matrix entries.

4. **Matrix loop:** for each [site, keyword] pair:
   - POST `/extension/trigger-scan {website, keyword}` to ask backend to allow a scan
   - Backend responds 200 (allowed) or 409 (`stop_cooldown` / `scan_in_progress`)
   - SW waits up to 60 seconds for a run-log row to appear with the new `scan_run_id`
   - SW polls run-log status every few seconds until terminal (`completed` or `failed`)

5. **Post-cycle:** POST `/admin/cleanup-invalid-entries` cleans up any orphaned/incomplete rows from this cycle's runs.

6. **Schedule next cycle:** Chrome alarm set for 0ms (sleep) after a successful cycle. Longer delay (with backoff) if precheck failed or sites were rate-limited.

### What gets ingested per scan

For each matrix entry, the content script (popup tab) walks through paginated results on the site's job-search URL. Each job listing is:
- Scraped via the site's API (LinkedIn Voyager, Indeed mosaic+graphql, Glassdoor RSC)
- POSTed to `/jobs/ingest` with `{website, source_raw, scan_run_id, ...}`
- Backend routes to the right per-source table via `INSERT INTO {table} ... ON CONFLICT (job_url) DO NOTHING RETURNING id`

**Result of stage 1:** rows in per-source tables with `matched=FALSE`, all carrying `scan_run_id` pointing to their respective run-log.

### Cycle 481 example

```
matrix [1/3][1/3]: linkedin / "software engineer"
  → run-log appeared
  → run-log terminal: completed (320 jobs scraped)
matrix [1/3][2/3]: linkedin / "AI engineer"
  → run-log terminal: completed (310 jobs scraped)
matrix [1/3][3/3]: linkedin / "machine learning engineer"
  → run-log terminal: completed (322 jobs scraped)
matrix [2/3][1/3]: indeed / "software engineer"
  → run-log terminal: completed (76 jobs scraped)
... (5 more)
cycle done: status=scrape_complete, scans_succeeded=9, scans_failed=0

→ cycle.status transitions to 'scrape_complete'
→ Redis publishes wake event to backend orchestrator
```

---

## 5. Stage 2 — Backend post-scrape orchestrator (post-scrape phase)

**Status:** one phase — auto-expiration ✅ LIVE — then finalize. That is the whole post-scrape run.

There is no Phase 2 and no Phases 3-6. The matched-claim (Phase 2) was **retired by feature 010**; the dedup/matching/`match_candidates` work that used to be described here as "Phases 3-6" was **deleted by the search-only split** and is not coming back to this orchestrator — it belongs to a separate, standalone filtering/matching service (§7).

### What runs

`backend/auto_scrape/post_scrape_orchestrator.py` — the function `run_post_scrape_phase(cycle_id)`.

Triggered by Redis publish from the extension orchestrator when `scrape_complete` is set.

Atomically transitions `cycle.status: scrape_complete → postscrape_running` to claim the cycle for processing (this prevents two backend workers from processing the same cycle).

**The whole flow:**

```text
claim the cycle ──▶ Phase 1: auto-expiration ──▶ finalize
                          │                          │
                    write cleanup_results     write status + completed_at + match_results
                                              (2 cycle writes total)
```

### Phase 1 — Auto-expiration ✅ LIVE

```python
async with AsyncSessionLocal() as db:
    await run_auto_expiration(db)
    await db.commit()

# run_auto_expiration internals:
# - Read shelf_life_days from system_settings (default 7)
# - For each per-source table:
#     DELETE FROM {table}
#     WHERE scrape_time < NOW() - make_interval(days => :d)
# - Return {"deleted_per_table": {...}, "shelf_life_days": N}

await _update_cycle(cycle_id, cleanup_results=expiration_results)
```

**Effect:** rows in per-source tables older than shelf_life_days get permanently deleted. CC-1's amended carve-out allows this DELETE.

**Output written immediately:** `cycle.cleanup_results`

### Finalize — no claim phase

```python
# Feature 010 retired the matched-claim that used to run here.
await _update_cycle(
    cycle_id,
    status="post_scrape_complete",
    completed_at=datetime.now(timezone.utc),
    match_results={"claim_summary": None, "claim_retired": True},
)
```

**Effect:** the cycle is done. Rows scraped by this cycle are left **`matched=FALSE`**.

**Output written:** `cycle.status`, `cycle.completed_at`, `cycle.match_results` — one write, folded together.

### Why there is no claim phase (feature 010)

Until feature 010 a Phase 2 ran here (`claim_unmatched_rows` in `auto_scrape/matching_claim.py`, now deleted). It flipped `matched=FALSE → TRUE` on every unclaimed row in all three per-source tables and on their canonical `scraped_jobs` twins, and recorded per-site counts as `match_results.claim_summary`.

It was built to hand rows to the dedup/matching pipelines. **Those were deleted by the search-only split**, so the claim had no consumer: `matched` was written on every row and read by nothing.

Worse, it was actively harmful. The planned standalone filtering/matching service claims rows itself with `WHERE matched = FALSE`. Because Phase 2 pre-claimed everything at the end of every cycle, that service would have found **zero** rows. Retiring the claim was its one hard blocker.

**Now:** `matched` stays `FALSE` after a scrape. Nothing in JHA claims rows; the downstream service owns the claim. The column stays on all four tables — it is that service's processed-marker, not dead weight.

**Retired for free:** the old crash window is gone. Phase 2 committed `matched=TRUE` in one transaction and its `claim_summary` in a separate one; a crash between them left rows permanently claimed with no record, and because the claim filtered `WHERE matched = FALSE` they could never be re-claimed (recovery was manual). Nothing flips them now, so the window cannot occur.

### `match_results` — three shapes a reader must handle

| Shape | Produced by | Meaning |
|---|---|---|
| `{"claim_summary": {"linkedin": N, ...}}` | cycles completed **before** feature 010 | historical record — real counts, never rewritten |
| `{"claim_summary": null, "claim_retired": true}` | cycles completed **since** | the run completed and performed no automatic claim |
| `null` | cycles that **failed** before finalizing | no claim indication |

`claim_summary` is **retained as an explicit `null`** — "no counts were produced". It must never be read as zeroed counts, which would mean "the phase ran and claimed nothing". Readers check `claim_summary` for a truthy value **first**, then `claim_retired`: reversing that order renders historical cycles as "claim retired", a false statement about cycles that really did claim rows.

The marker is written **only** in the finalize call, so a cycle that fails before finalizing records no claim indication while its `cleanup_results` survive independently.

### Dedup, matching, and `match_candidates` — not here

Earlier revisions of this document described Phases 3-6 (`build_match_candidates`, `_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`) as the next workstream or as stubs. **None of those functions exist** — the `dedup/`, `matching/`, and `profile/` packages were deleted by the search-only split, and the `match_candidates` design was superseded by the canonical `scraped_jobs` table (feature 008).

That work now belongs to a **separate standalone service** that reads `scraped_jobs`, claims rows via `matched`, and writes its own tables. See `filter-matching-service-design.md`. The backend orchestrator is search-only and ends at finalize.

---

## 6. What gets persisted after a healthy cycle

After a cycle reaches `post_scrape_complete`, the database state is:

### Per-source tables

- New rows from this cycle's scans are present with **`matched=FALSE`** — the post-scrape run does not claim them (feature 010). They are the standalone filtering/matching service's work queue.
- Older rows (>7 days by default) deleted by Phase 1 — from the three per-source tables **and** canonical `scraped_jobs`, so a canonical row never outlives the per-source row it derives from.
- All rows carry `scan_run_id` pointing to their respective run-log
- Each per-source row has a canonical `scraped_jobs` twin written in the same transaction at ingest, and the two always agree about `matched`.

> **Note on the pre-010 backlog:** rows ingested *before* the claim was retired are `matched=TRUE`, claimed by the old Phase 2. They were not back-filled to FALSE. Only rows scraped after the retirement are guaranteed unclaimed. When checking that the retirement works, scope the query to a fresh scan's `scan_run_id` — a global `SELECT matched, count(*) ... GROUP BY matched` will show plenty of `t` from the backlog and look like failure.

### `auto_scrape_cycles` row

```json
{
  "cycle_id": 481,
  "status": "post_scrape_complete",
  "started_at": "2026-05-07T05:40:54Z",
  "completed_at": "2026-05-07T07:00:02Z",
  "scans_attempted": 9,
  "scans_succeeded": 9,
  "scans_failed": 0,
  "cleanup_results": {
    "shelf_life_days": 7,
    "deleted_per_table": {
      "linkedin_jobs": 0,
      "indeed_jobs": 0,
      "glassdoor_jobs": 0
    }
  },
  "match_results": {
    "claim_summary": null,
    "claim_retired": true
  }
}
```

`claim_summary: null` means **"no claim counts were produced"** — the phase is retired. It does not mean "claimed zero". Cycles completed **before** feature 010 still carry their real counts (e.g. `{"claim_summary": {"linkedin": 952, "indeed": 197, "glassdoor": 157}}`) and are never rewritten; readers must handle both shapes, checking `claim_summary` for a truthy value first. A cycle that **failed** before finalizing has `match_results: null` and no claim indication at all.

### `extension_run_logs`

9 rows (one per matrix entry), all with `status='completed'`, `error_message=NULL` (post cycle 455 fix).

---

## 7. What's next — and where it lives

**Not in this backend.** The backend is search-only: scrape, ingest, expire, serve. Everything below either moved out or was superseded.

| Item | Where it lives now | Status |
|---|---|---|
| **Filtering / dedup** | Standalone service (`filter-matching-service-design.md`) | 🆕 To build. Reads canonical `scraped_jobs`; claims rows via `matched`. The old backend `dedup/` package was **deleted** by the search-only split — recoverable from git history if the service wants to port it. |
| **Matching (CPU + LLM)** | Same standalone service | 🆕 To build. The old `matching/` package was **deleted**; same recovery route. |
| **`match_candidates`** | — | ❌ **Abandoned.** Superseded by canonical `scraped_jobs` (feature 008). There is no build phase; consumers read `scraped_jobs` directly. |
| **Profile input** | JHA frontend + a JHA-owned `profile` table | 🆕 To build (prerequisite **JHA-C**). The service reads the active profile. |
| **Auto-apply** | — | 📅 Distant product idea. Requires filtering and matching to exist first. |
| **Frontend UI for `shelf_life_days`** | JHA frontend | 🔧 Backend already supports it via `system_settings`; the UI does not read/write it yet. |

### Prerequisites for the standalone service

Tracked in `jha-prereq-cmds.md`:

- **JHA-A** — extend the canonical `scraped_jobs` projection with the filter columns. ✅ **Shipped** (feature 009, migration 031).
- **JHA-B** — retire the vestigial post-scrape matched-claim so `matched` stays `FALSE`. ✅ **Shipped** (feature 010). This was the one hard blocker: until it landed, the service's `WHERE matched = FALSE` claim would have found zero rows after any cycle.
- **JHA-C** — profile input page on the frontend. 🆕 Still needed.

## 8. Extension-side behavior post-cycle 455 fix

Cycle 455 (2026-05-07 04:06) exposed a bug where the backend's `trigger_scan` endpoint was using a 5-minute stale-cleanup threshold. LinkedIn scans with full pagination take ~33 minutes legitimately, so the cleanup was firing on healthy long scans, falsely marking them `failed`.

**Patch applied:** raise threshold from 5 to 60 minutes; clear `error_message` on terminal-success.

**Effect today:**

- LinkedIn scans up to ~33 minutes complete cleanly with `status='completed'`, `error_message=NULL`
- Backend's stale-cleanup threshold is 60 minutes — only catches genuinely stuck B-23 cases
- `error_message` cleared on terminal-success (defense-in-depth against future stale guard messages)
- SW orchestrator's 30-min `triggerScanAndWait` timeout still exists but no longer cascades catastrophically — Bug 2 deferred but no longer urgent

**Validation:** cycle 481 ran the same 3×3 matrix as cycle 455. Pre-fix: 0 succeeded, 9 failed (false reports). Post-fix: 9 succeeded, 0 failed, 1306 jobs ingested.

For the full incident write-up, see `cycle-455-incident-report.md`.

---

*End of workflow document. For DDL details: `current-schemas.md`. For session history: `session-record-2026-05-07.md`. For project history: `jha-onboarding.md`.*
