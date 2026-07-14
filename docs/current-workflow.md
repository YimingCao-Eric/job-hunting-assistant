# JHA — Current workflow (as of 2026-05-07)

> Single-page reference for how a JHA cycle works end-to-end, with explicit markers for **what's shipped**, **what's stubbed**, and **what's next**.
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
7. [What's deferred to future workstream](#7-whats-deferred-to-future-workstream)
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
│  ✅ LIVE                       Phase 2: Matched-claim           ✅ LIVE  │
│                                Phase 3: Build match_candidates  ⏳ NEXT  │
│                                Phase 4: Dedup                   🔜 STUB  │
│                                Phase 5: Matching pipeline       🔜 STUB  │
│                                Phase 6: Compute match_results   🔜 STUB  │
│                                                                          │
│                                Phase 7: Auto-apply              📅 LATER │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

✅ LIVE     — production-ready, validated end-to-end (cycle 481, 2026-05-07)
⏳ NEXT     — the next workstream to start
🔜 STUB     — function exists in code but is a no-op placeholder
📅 LATER    — designed in concept; not in the codebase yet
```

**Today (2026-05-07):**

- Scrape phase is fully working
- Post-scrape Phases 1 and 2 just shipped this session and are validated
- Phase 3 (build `match_candidates`) is the next workstream — this is where dedup and matching will consume the rows that Phase 2 claimed
- Phases 4-6 exist as stubs in `post_scrape_orchestrator.py` (`_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`) — they currently return `None` / `{}` and don't do real work
- Phase 7 (auto-apply) is a future product workstream

---

## 2. Glossary

Terms used in this document, defined once here:

| Term | Definition |
|---|---|
| **Per-source tables** | The three site-specific scrape tables: `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`. Each one matches its site's natural field shape (51, 61, 69 columns respectively). Created in migration 025; replaces the legacy unified `scraped_jobs` table. |
| **`match_candidates`** | The merged ephemeral table built from claimed per-source rows. **Future workstream** — does not exist yet. This is where Phase 3 will consolidate rows from all three per-source tables into a unified shape that the dedup and matching pipelines can operate on. |
| **`scan_run_id`** | UUID FK to `extension_run_logs.id`. Every per-source row carries this; identifies which scrape produced it. |
| **`matched`** | BOOLEAN column on per-source tables (added in migration 028). Default FALSE on insert; transitions to TRUE once per row when the post-scrape orchestrator's Phase 2 claims it. Never transitions back. |
| **`shelf_life_days`** | Setting in `system_settings` (default 7). Per-source rows older than this get DELETEd by Phase 1 auto-expiration. |
| **Cycle** | A single end-to-end run of the auto-scrape pipeline. Identified by `auto_scrape_cycles.cycle_id`. Goes through `scrape_running → scrape_complete → postscrape_running → post_scrape_complete`. |
| **Run-log** | A row in `extension_run_logs`. Tracks one site/keyword scan within a cycle. A 3×3 cycle (3 sites × 3 keywords) produces 9 run-logs. |
| **Claim** | Phase 2's atomic UPDATE that flips `matched=FALSE → TRUE` on all unmatched rows across all three per-source tables in one transaction. The "claim batch" is the set of rows returned by RETURNING. |
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
│  │     DELETE WHERE scrape_time + shelf_life_days < NOW()          │        │
│  │  → Returns {"deleted_per_table": {...}, "shelf_life_days": N}   │        │
│  │  → Writes to cycle.cleanup_results immediately                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 2 — MATCHED-CLAIM                                ✅ LIVE  │        │
│  │                                                                  │        │
│  │  await claim_unmatched_rows(db)                                 │        │
│  │  → For each table in (linkedin_jobs, indeed_jobs, glassdoor_jobs│        │
│  │     UPDATE SET matched=TRUE WHERE matched=FALSE RETURNING *     │        │
│  │     (all three UPDATEs in one transaction)                      │        │
│  │  → Returns {"linkedin": [rows], "indeed": [rows], "glassdoor":  │        │
│  │             [rows]}                                              │        │
│  │  → claim_summary = {site: count} held in memory                 │        │
│  │  → claim_results (the actual rows) currently logged then        │        │
│  │     discarded — Phase 3 will consume them when wired in         │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 3 — BUILD match_candidates                       ⏳ NEXT  │        │
│  │                                                                  │        │
│  │  Will take Phase 2's claim_results (the actual rows from all 3  │        │
│  │  per-source tables) and merge them into a unified ephemeral     │        │
│  │  table called match_candidates with a normalized schema:        │        │
│  │  - canonical title, company, location, salary, JD text          │        │
│  │  - back-references to source per-source row IDs                 │        │
│  │  - all three sites' rows in one logical pool                    │        │
│  │                                                                  │        │
│  │  This is the "merge step" the per-source schema design          │        │
│  │  always anticipated. Salary normalization (CC-10) and nested    │        │
│  │  object flattening (CC-11) happen here.                         │        │
│  │                                                                  │        │
│  │  THIS DOES NOT EXIST YET. It's the next workstream.             │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 4 — DEDUP                                        🔜 STUB  │        │
│  │                                                                  │        │
│  │  Currently: _run_dedup_for_cycle returns None                   │        │
│  │  Future:                                                         │        │
│  │   - hash_exact dedup on (title, company, location)              │        │
│  │   - cosine TF-IDF dedup on JD text                              │        │
│  │   - skip_reason / dedup_original_job_id written back to         │        │
│  │     match_candidates                                             │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 5 — MATCHING PIPELINE                            🔜 STUB  │        │
│  │                                                                  │        │
│  │  Currently: _run_matching_for_cycle is a no-op                  │        │
│  │  Future:                                                         │        │
│  │   - CPU extraction (regex/keyword skill matching)               │        │
│  │   - LLM extraction (gpt-4o-mini structured output)              │        │
│  │   - CPU pre-scoring (gate non-viable rows cheaply)              │        │
│  │   - LLM hiring-manager judgment (final score on gated rows)     │        │
│  │   - Writes match_score, match_report to per-row                 │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Phase 6 — COMPUTE match_results                        🔜 STUB  │        │
│  │                                                                  │        │
│  │  Currently: _compute_match_results returns {}                   │        │
│  │  Future: aggregate matching pipeline outputs into a JSONB       │        │
│  │  with keys like:                                                │        │
│  │   - matched_count, dedup_skipped, gate_failures,                │        │
│  │   - llm_calls, llm_tokens, by_site stats                        │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  Final write — single _update_cycle:                                        │
│    match_results = {                                                        │
│      "claim_summary": {linkedin: N, indeed: N, glassdoor: N},               │
│      ... (Phase 6 will add more keys here)                                  │
│    }                                                                        │
│  cycle.status = 'post_scrape_complete'                                      │
│                                                                              │
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

**Status:** Phases 1 and 2 ✅ LIVE; Phases 3-6 not yet implemented or stubbed.

### What runs

`backend/auto_scrape/post_scrape_orchestrator.py` — the function `run_post_scrape_phase(cycle_id)`.

Triggered by Redis publish from the extension orchestrator when `scrape_complete` is set.

Atomically transitions `cycle.status: scrape_complete → postscrape_running` to claim the cycle for processing (this prevents two backend workers from processing the same cycle).

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

### Phase 2 — Matched-claim ✅ LIVE

```python
async with AsyncSessionLocal() as db:
    claim_results = await claim_unmatched_rows(db)
    await db.commit()

# claim_unmatched_rows internals:
# - For each table in (linkedin_jobs, indeed_jobs, glassdoor_jobs):
#     UPDATE {table} SET matched=TRUE
#     WHERE matched=FALSE
#     RETURNING <relevant columns>
# - All three UPDATEs in one transaction
# - Return {"linkedin": [rows], "indeed": [rows], "glassdoor": [rows]}

claim_summary = {site: len(rows) for site, rows in claim_results.items()}
# claim_summary held in memory; written at end of cycle alongside Phase 6 output
```

**Effect:** every per-source row that was `matched=FALSE` is now `matched=TRUE`. The returned `claim_results` (the actual rows) is the input that Phase 3 will eventually consume.

**Why atomic across three tables:** if linkedin's UPDATE succeeds but indeed's fails, we'd have linkedin rows flagged with no downstream processing. Transaction wrap rolls back all three together.

**Why flag BEFORE Phase 3-6 work:** if matching crashes mid-flight, rows leave behind a "claimed but not actually matched" state. Recovery is manual but contained. Documented as Known Limitation §15.2.

**Currently:** `claim_results` (the rows themselves) is logged and discarded. Only `claim_summary` (the counts) is preserved for `cycle.match_results`.

**When Phase 3 wires in:** `claim_results` will become the input to building `match_candidates`.

### Phase 3 — Build `match_candidates` ⏳ NEXT WORKSTREAM

**This phase does not exist in code yet.** This is where today's "next steps" begin.

**Concept:**

```python
# Future shape:
async with AsyncSessionLocal() as db:
    match_candidates = await build_match_candidates(db, claim_results)
    # Inserts into a match_candidates table (or in-memory) with a unified schema:
    #   match_candidate_id UUID
    #   source_table VARCHAR     -- 'linkedin_jobs' | 'indeed_jobs' | 'glassdoor_jobs'
    #   source_row_id UUID       -- back-reference to the per-source row
    #   scan_run_id UUID         -- inherited from per-source row
    #   canonical_title TEXT
    #   canonical_company TEXT
    #   canonical_location TEXT
    #   normalized_salary_min/max/currency/period   -- normalized per CC-10
    #   jd_text TEXT             -- best-available description
    #   ... (TBD)
```

**Open design questions:**

- Is `match_candidates` a real durable table or an in-memory ephemeral build per cycle?
- How does deduplication across the three sites work? (LinkedIn job + Indeed job for same posting)
- How is salary normalization handled when sites use different vocab (`YEARLY` vs `YEAR` vs `ANNUAL`)?
- Where does the canonical title/company come from when multiple sources disagree?
- What's the merge contract when `header.applyUrl` (Glassdoor) is unresolved RSC ref?

These questions are the substantive design work for the next workstream.

### Phase 4 — Dedup 🔜 STUB

```python
# Currently:
async def _run_dedup_for_cycle(cycle_id) -> Optional[UUID]:
    # stub returns None
    return None
```

**Future:** consume `match_candidates`, run hash_exact then cosine TF-IDF, write `skip_reason` and `dedup_original_job_id` to flag duplicates. Returns `dedup_task_id` UUID for tracking.

### Phase 5 — Matching pipeline 🔜 STUB

```python
# Currently:
async def _run_matching_for_cycle(cycle_id, llm_enabled, has_openai_key) -> None:
    # stub: logs and returns
    return
```

**Future:** for each non-deduped `match_candidate`:
1. CPU extraction (regex/keyword) extracts skills from JD text
2. LLM extraction (gpt-4o-mini structured output) extracts skills, requirements, must-haves from JD
3. CPU pre-scoring gates rows that obviously don't match resume (cheap path)
4. LLM hiring-manager judgment scores remaining rows (expensive path)
5. Writes `match_score`, `match_report_id` per row

### Phase 6 — Compute `match_results` 🔜 STUB

```python
# Currently:
async def _compute_match_results(post_scrape_started_at) -> dict:
    return {}  # empty stub
```

**Future:** aggregate matching pipeline outputs into a JSONB with keys like `matched_count`, `dedup_skipped`, `gate_failures`, `llm_calls`, `llm_tokens`, `by_site` stats. These get merged with `claim_summary` (from Phase 2) in the single final `_update_cycle(match_results=...)` write.

### Final write

```python
await _update_cycle(cycle_id, match_results={
    "claim_summary": claim_summary,
    **match_results,   # currently {}; will gain Phase 6 keys
})

await _update_cycle(
    cycle_id,
    status="post_scrape_complete",
    completed_at=datetime.now(timezone.utc),
)
```

---

## 6. What gets persisted after a healthy cycle

After a cycle reaches `post_scrape_complete`, the database state is:

### Per-source tables

- New rows from this cycle's scans are present with `matched=TRUE` (claimed by Phase 2)
- Older rows (>7 days by default) deleted by Phase 1
- All rows carry `scan_run_id` pointing to their respective run-log

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
    "claim_summary": {
      "linkedin": 952,
      "indeed": 197,
      "glassdoor": 157
    }
  }
}
```

When Phase 3-6 wire in, `match_results` will gain additional keys (still has `claim_summary` plus more).

### `extension_run_logs`

9 rows (one per matrix entry), all with `status='completed'`, `error_message=NULL` (post cycle 455 fix).

---

## 7. What's deferred to future workstream

In priority order:

| Item | Phase | Notes |
|---|---|---|
| **Build `match_candidates`** | Phase 3 | The next workstream. Depends on design pass for cumulative-vs-per-cycle dedup, salary normalization vocab, canonical field selection. |
| **Wire dedup pipeline** | Phase 4 | Once `match_candidates` exists, hash_exact + cosine TF-IDF dedup operates on it. |
| **Wire matching pipeline** | Phase 5 | Once dedup leaves filtered rows, CPU + LLM matching runs on them. |
| **Wire `_compute_match_results`** | Phase 6 | Once matching produces scored rows, aggregate stats. Phase 4c smoke test is forward-compatible for added keys. |
| **Auto-apply** | Phase 7 | Distant. Requires both dedup and matching functional. |
| **Frontend UI for shelf_life_days** | UI | Backend supports it via `system_settings`; frontend reads/writes via API. |
| **Retire legacy `scraped_jobs`** | Cleanup | After Phases 4-6 wire into the per-source path, the old unified table can be dropped. |

### Recommended sequencing for Phase 3

The matched mechanism plan went through 6 rounds of conflict scans before converging — too many. Goal for Phase 3 is to reduce that to 1-2 rounds. Recommended approach:

1. Read existing `backend/matching/pipeline.py` and dedup code in their entirety
2. Copy relevant function signatures into the plan doc with `# UNCHANGED` markers
3. Annotate with `# NEW` markers where the new code goes
4. Do ONE conflict scan pass to catch baseline issues
5. Implement with same TARGETED INSERTION discipline as Step 7 of the matched mechanism

---

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
