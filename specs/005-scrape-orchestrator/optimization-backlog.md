# Standardization & Optimization Backlog — Scrape-Phase Orchestrator (spec 005)

**Purpose**: Existing-code standardization and optimization items for the scrape-phase
orchestrator, from comparing spec `005-scrape-orchestrator` against the constitution
(`.specify/memory/constitution.md`) and the code. **No new features.** Nothing here is
implemented — a review artifact only.

**Effort key**: **XS** <1h · **S** a few hours · **M** 1–2 days · **L** ≥1 week.
**Risk** = risk of *making the fix* (to behavior the smoke suite guards).

**Related backlogs**: `001` post-scrape (`specs/001-post-scrape-phases-1-2/standardization-backlog.md`),
`002` jobs, `003` dedup, `004` matching (each in its own `specs/*/` folder).

**Scope compared**: the extension SW modules (`extension/background/auto_scrape.js`,
`auto_scrape_config.js`, `auto_scrape_init.js`, `poll.js`), `backend/routers/auto_scrape.py`,
`backend/routers/extension.py` (run-log path), `backend/core/auto_scrape_lifecycle.py`, and
`smoke_test_auto_scrape.py` against spec `005-scrape-orchestrator` and the constitution.

---

### What already conforms (no action — recorded for completeness)

- **Bearer auth (Principle VII)** — every `/admin/auto-scrape/*` route requires
  `get_current_user`; the SW always sends the token.
- **Guarded status transition** — `scrape_running → scrape_complete` is
  `WHERE status="scrape_running"` (idempotent / 409 / 404), consistent with the atomic-transition
  discipline in spec 001.
- **Self-healing** — startup stale-cycle cleanup (`>2h → failed`, `cycle_phase=idle`) and
  new-instance orphan-cycle cleanup.
- **Forward-compatible JSONB (VII)** — `auto_scrape_cycles` / `auto_scrape_state` JSONB payloads
  are additive.
- **Hardening present** — auto-pause, dead-session suspension, CAPTCHA notify/exclude,
  rate-limit backoff, SC-4 scheduling cooldown.

### Backlog (severity-ordered)

| ID | Category | Severity | Source | Risk | Effort |
|----|----------|----------|--------|------|--------|
| S1 | Correctness (state-machine gap) | HIGH | KL-8 (Bug 3) | Medium | S |
| S2 | Test coverage (SW orchestrator) | HIGH | KL-6 | Medium | L |
| S3 | Duplicated state logic (SW↔backend) | MEDIUM | KL-5 | Medium | M |
| S4 | Correctness (instance race) | MEDIUM | KL-9 | Medium | M |
| S5 | Doc-vs-code drift (§4) | MEDIUM | KL-1 | None | S |
| S6 | Convention (constants split) | MEDIUM | FR-024 / KL-4 | Low | S |
| S7 | Reliability (fail-open probes) | MEDIUM | KL-3 | Low–Med | S |
| S8 | Observability | MEDIUM | — | Low | M |
| S9 | JS convention / structure | LOW | Constitution layout | Low | M |
| S10 | Config timing (mid-cycle reads) | LOW | FR-024 | Low | S |
| S11 | Dead/vestigial code | LOW | FR-002 | Low | XS |

---

### S1 — `failed → completed` run-log state-machine gap (Bug 3, KL-8)
- **Category**: Correctness (state machine)
- **Impact**: HIGH. `update_run_log` (`routers/extension.py`) protects a `completed` run-log only
  from **non-status** updates; a `failed → completed` PUT is permitted (it clears `error_message`
  and can trigger sync-dedup), and an explicit `status` can flip `completed → failed`. Combined
  with the 60-min stale-cleanup that can mark a healthy long scan `failed`, the terminal status
  the orchestrator reads is last-writer-wins — cycle accounting (`scans_succeeded/failed`) can be
  wrong depending on write ordering.
- **Risk**: Medium — enforcing monotonic transitions (`running → {completed,failed}`, terminal
  is sticky) changes what late PUTs do; must not regress the cycle-455 fix.
- **Effort**: S (add a status-transition guard in `update_run_log`).

### S2 — No automated test for the SW orchestrator (KL-6)
- **Category**: Test coverage (missing)
- **Impact**: HIGH. `smoke_test_auto_scrape.py` covers the backend `/admin/auto-scrape/*`
  endpoints only; the bulk of the logic — `runOneCycle`, the matrix loop, `preCycleCheck`/probe
  classification, `triggerScanAndWait`, scheduling/backoff, abort handling — lives in
  service-worker JS with **no** automated test. Per Constitution Principle II this is the gap
  most limiting any safe change to the orchestrator.
- **Risk**: Medium (SW testing needs a harness — mock `chrome.*` + `fetch`).
- **Effort**: L.

### S3 — Cycle state duplicated across `chrome.storage.local` and the backend (KL-5)
- **Category**: Duplicated state logic (SW ↔ backend)
- **Impact**: MEDIUM. Enable/phase/instance/interval/counters live in **both**
  `chrome.storage.local._autoScrape` and the backend `auto_scrape_state` row, kept in sync by
  polling; many SW→backend writes are best-effort `try/catch` (swallowed), so a transient failure
  desyncs the two authorities (e.g. `consecutive_precheck_failures` tracked in both places and
  updated separately).
- **Risk**: Medium (choosing a single source of truth changes the sync model).
- **Effort**: M.

### S4 — Instance ownership is last-writer-wins (KL-9)
- **Category**: Correctness (multi-instance)
- **Impact**: MEDIUM. `heartbeat` overwrites the stored `extension_instance_id` on any differing
  heartbeat, so with two live SW instances the stored owner flips to whoever heartbeated most
  recently — making `cleanup-orphan-cycles`' mismatch check racy (it may or may not fire). Two
  instances could also both bootstrap cycles.
- **Risk**: Medium (a real ownership lease is a design change).
- **Effort**: M. Likely document + a minimal guard this round.

### S5 — Doc-vs-code drift in workflow §4 (KL-1)
- **Category**: Doc-vs-code drift
- **Impact**: MEDIUM. `docs/current-workflow.md` §4 lists the wrong probe status set
  (`logged_out`/`offline` vs the code's `expired`/`captcha`/`unknown_treat_as_live`), the wrong
  trigger-scan body (`{website, keyword}` vs `{website, scan_all:true, scan_all_position:1,
  scan_all_total:2}` + separate keyword push), and "sleep 0ms after success" vs the
  `min_cycle_interval`/SC-4 logic.
- **Risk**: None (docs only). **Effort**: S.

### S6 — Two config surfaces + hardcoded `position:1/total:2` (KL-2/KL-4)
- **Category**: Convention / correctness
- **Impact**: MEDIUM. The matrix is driven by the orchestrator config
  (`/admin/auto-scrape/config`), but each scan's keyword is pushed into the **search** config
  (`/config`) per pair — two stores synced per iteration. Separately, the trigger body hardcodes
  `scan_all_position:1, scan_all_total:2`, so the extension router's sync-dedup
  (`position == total`) never fires for auto-scrape (dedup runs via the post-scrape orchestrator
  instead) — a constant masquerading as the real matrix size.
- **Risk**: Low. **Effort**: S (document the split; make the position/total meaningful or drop it).

### S7 — Probes fail open (KL-3)
- **Category**: Reliability
- **Impact**: MEDIUM. HTTP 5xx and thrown fetches are classified `unknown_treat_as_live`, so a
  site can enter the matrix while actually unreachable, producing failed scans that count toward
  its dead-session suspension (a slow degradation rather than a clean skip).
- **Risk**: Low–Medium (fail-closed could suppress legitimate scans on transient blips).
- **Effort**: S.

### S8 — Thin orchestrator observability
- **Category**: Observability
- **Impact**: MEDIUM. Cycle progress lives in `console.log` in the SW plus the `auto_scrape_cycles`
  row; there is no structured metric/counter stream for cycles started/completed/failed, per-site
  success rates, precheck-failure trends, or backoff state — operators reconstruct health from
  logs and the cycles list.
- **Risk**: Low. **Effort**: M.

### S9 — `auto_scrape.js` is a 1231-line multi-concern module
- **Category**: JS convention / structure
- **Impact**: LOW. Probes, cycle lifecycle, matrix loop, run-log polling, scheduling, graceful
  exit, and popup cleanup all live in one file with many `self.*` global exports; mild tension
  with the constitution's feature-oriented layout (Python side) applied to the SW.
- **Risk**: Low. **Effort**: M (split into probe/matrix/lifecycle modules).

### S10 — Mid-cycle config reads are point-in-time inconsistent (FR-024)
- **Category**: Config timing
- **Impact**: LOW. The orchestrator config is fetched fresh at three separate points per cycle
  (precheck threshold, dead-session threshold, `enabled_sites`/`keywords`); a config change
  between those reads yields a cycle that mixes old and new values.
- **Risk**: Low. **Effort**: S (snapshot config once per cycle).

### S11 — Vestigial `postscrape_running` bootstrap guard (FR-002)
- **Category**: Dead / vestigial code
- **Impact**: LOW. The poll's self-bootstrap guard checks `cycle_phase ∈ {scrape_running,
  postscrape_running}`, but `cycle_phase` is SW-managed and only ever set to `scrape_running`/
  `idle`; nothing sets `postscrape_running` on the state singleton, so that guard branch is
  effectively dead.
- **Risk**: Low. **Effort**: XS (confirm and remove, or wire the backend phase to set it).

---

### Suggested sequencing (scrape orchestrator)

1. **Highest-value correctness**: **S1** (run-log state-machine guard — small, real data-integrity
   fix) and **S5/S11** (doc drift + dead guard — near-zero risk).
2. **Test net**: **S2** (SW orchestrator harness) — precondition for the riskier items.
3. **Behind the test net**: S3 (single source of truth for cycle state), S4 (instance ownership),
   S7 (probe fail-open policy), S6 (config-surface split / position-total), S10 (snapshot config).
4. **Then**: S8 (metrics) and S9 (module split).
