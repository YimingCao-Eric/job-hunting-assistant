# Standardization & Optimization Backlog — Dedup Pipeline (spec 003)

**Purpose**: Existing-code standardization and optimization items for the dedup pipeline,
from comparing spec `003-dedup-pipeline` against the constitution (`.specify/memory/constitution.md`)
and the code. **No new features.** Nothing here is implemented — a review artifact only.

**Effort key**: **XS** <1h · **S** a few hours · **M** 1–2 days · **L** ≥1 week.
**Risk** = risk of *making the fix* (to behavior the smoke suite guards).

**Related backlogs**: `001` post-scrape (`specs/001-post-scrape-phases-1-2/standardization-backlog.md`),
`002` jobs, `004` matching, `005` scrape orchestrator (each in its own `specs/*/` folder).

**Scope compared**: `backend/dedup/service.py`, `backend/routers/dedup.py` (and the
`backend/routers/extension.py` post-scan trigger) against spec `003-dedup-pipeline` and the
constitution. Sources: the dedup service + router, `models/dedup_report.py`, `schemas/dedup.py`,
`core/database.py`, README dedup notes.

---

### What already conforms (no action — recorded for completeness)

- **Async background execution (Principle VI)** — post-scan dedup runs via
  `asyncio.create_task` with its **own** `AsyncSessionLocal` and a heartbeat; not tied to the
  request.
- **Atomic decision writes** — all per-row `skip_reason`/dedup-field UPDATEs plus the
  `dedup_reports` row commit in one transaction (all-or-nothing).
- **Auth (Principle VII)** — every route in `routers/dedup.py` requires `get_current_user`.
- **Forward-compatible JSONB (Principle VII)** — `dedup_reports.debug_log` /
  `gate_results` / `skip_reason_counts` are additive JSONB.
- **Safe restart** — orphan `running` `dedup_tasks` are marked `failed` on boot with **no**
  auto-rerun (`mark_stale_dedup_tasks_failed`, B-18).
- **Mutation scope** — dedup writes only `scraped_jobs` (the mutable legacy table); the
  per-source append-only tables (CC-1) are untouched.

### Backlog (severity-ordered)

| ID | Category | Severity | Source | Risk | Effort |
|----|----------|----------|--------|------|--------|
| D1 | Test coverage | HIGH | SC-006 | Low | M |
| D2 | Duplicated / dead code | MEDIUM | KL-1 / FR-006 | Low | S |
| D3 | Structure (filter vs dedup) | MEDIUM | KL-1 | Medium | M |
| D4 | Correctness (reset over-reach) | MEDIUM | KL-4 | Low | XS |
| D5 | Scalability | MEDIUM | KL-5 | Medium | M |
| D6 | Scalability / convention | MEDIUM | KL-2 | Medium | M |
| D7 | Duplicated logic | MEDIUM | KL-6 | Low | S |
| D8 | Convention (config-in-code) | LOW | FR-005/006 | Low | S |
| D9 | Correctness / observability | LOW | KL-7 | Low | S |
| D10 | Convention / robustness | LOW | FR-018 | Low | S |
| D11 | Observability | LOW | — | Low | M |

---

### D1 — No smoke/contract test for the dedup pipeline
- **Category**: Test coverage (missing)
- **Impact**: HIGH. The suite (`smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`,
  `smoke_test_matched_claim.py`) has **zero** targeted coverage of dedup: Pass 0/1 gate rules,
  Pass 2 `hash_exact` keep-oldest / `cosine` keep-older, `_resolve_chains`, the DB
  `resolve-chains` repair, `reset`, the transaction boundary, and the crash path are all
  unverified. Per Constitution Principle II (smoke tests are the behavioral contract), this is
  the prerequisite for any behavior-preserving change to `run_dedup`.
- **Risk**: Low (adding tests). **Effort**: M (seed corpus + assert per-row outcomes and report
  totals; a deterministic cosine fixture with ≥10 rows).

### D2 — `run_pass_1` duplicates `_pass1_metrics_linear` (and is unused by `run_dedup`)
- **Category**: Duplicated / likely dead code
- **Impact**: MEDIUM. `run_pass_1` (pure, returns `(reason, timings)`) and
  `_pass1_metrics_linear` (inlined, updates gate metrics) implement the **same** five-gate
  logic twice. `run_dedup` calls only `_pass1_metrics_linear`; `run_pass_1` is exported from
  `dedup/__init__.py` but not used on the dedup run path. A gate-rule change must be made in two
  places or they silently diverge.
- **Risk**: Low — verify external callers of `run_pass_1`; if only the `__init__` export, remove
  it, or refactor both to share one gate function. **Effort**: S.

### D3 — "Dedup" module conflates content filtering with deduplication (KL-1)
- **Category**: Structure / module layout
- **Impact**: MEDIUM. Pass 0/1 assign non-duplicate `skip_reason`s (blacklists, job-type,
  contract/remote/sponsorship/agency, title-mismatch); only Pass 2 deduplicates. The single
  `run_dedup` name, one `dedup_reports` row, and the mixed `DEDUP_SERVICE_SKIP_REASONS` list
  blur "filter" and "dedup." Tension with the constitution's feature-oriented module layout.
- **Risk**: Medium (splitting the pipeline is not surgical). **Effort**: M. Likely **document**
  the two concerns rather than split this round.

### D4 — `reset` clears `language`, a reason dedup never sets (KL-4)
- **Category**: Correctness
- **Impact**: MEDIUM. `DEDUP_SERVICE_SKIP_REASONS` includes `language`, so
  `POST /jobs/dedup/reset` clears `skip_reason = "language"` rows — but the dedup passes never
  produce `language` (it originates in matching). Reset therefore over-reaches into another
  subsystem's reason if any row carries `skip_reason = "language"`; if nothing sets it, the
  entry is dead config. Either way it should not be in the dedup-owned list.
- **Risk**: Low. **Effort**: XS (drop `language` from the list after confirming who sets it).

### D5 — Cosine builds an in-memory corpus of all passing jobs (KL-5)
- **Category**: Scalability
- **Impact**: MEDIUM. `_run_cosine` pulls **all** `skip_reason IS NULL` jobs (beyond the
  survivor set) into memory, `fit_transform`s a TF-IDF matrix (`max_features=10000`), and
  computes batched similarity against the full matrix — O(N) memory and ≈O(N²) comparisons per
  run. Fine at current volume; degrades as `scraped_jobs` grows.
- **Risk**: Medium (bounding the corpus or blocking changes similarity results). **Effort**: M.

### D6 — Manual dedup runs synchronously in the request (KL-2)
- **Category**: Scalability / convention
- **Impact**: MEDIUM. `POST /jobs/dedup` executes the whole pipeline (including the cosine cost
  of D5) inside the HTTP request, unlike the post-scan path which backgrounds it
  (`asyncio.create_task` + fresh session — the Principle VI pattern). Large corpora risk request
  timeouts.
- **Risk**: Medium (backgrounding changes the response contract — it currently returns the
  report synchronously). **Effort**: M.

### D7 — Two independent chain resolvers duplicate the walk (KL-6)
- **Category**: Duplicated logic
- **Impact**: MEDIUM. `_resolve_chains` (in-memory, Pass-2 flags) and
  `resolve_dedup_chains_in_db` (persisted removed rows) implement the same depth-20,
  cycle-guarded walk in two places; a change to walk semantics must touch both.
- **Risk**: Low — extract a shared walk helper. **Effort**: S.

### D8 — Filter term-lists are hardcoded in `service.py`
- **Category**: Convention (config-in-code)
- **Impact**: LOW. `JOB_TYPE_TERMS`, `AGENCY_COMPANY_TERMS`, `CONTRACT_TERMS`,
  `REMOTE_MISMATCH_TERMS`, `SPONSORSHIP_TERMS`, `AGENCY_JD_TERMS` are literal tuples in code, so
  changing the filter vocabulary requires a code change/deploy rather than config.
- **Risk**: Low. **Effort**: S (move to config/settings if runtime tuning is desired).

### D9 — Crash path commits a zeroed stub report (KL-7)
- **Category**: Correctness / observability
- **Impact**: LOW–MEDIUM. On any exception, partial decision writes are rolled back but a
  zero-valued `dedup_reports` row is committed. In the report history it is indistinguishable
  from a real no-op run except via the `run_crash` event in `debug_log`, so dashboards/counts
  over-count "successful empty" runs.
- **Risk**: Low. **Effort**: S (flag the stub, e.g. a status/`trigger` marker, or omit the row).

### D10 — `run_dedup` relies on the caller to commit (FR-018)
- **Category**: Convention / robustness
- **Impact**: LOW–MEDIUM. Success-path writes are `flush`ed, not committed; the commit is the
  `get_db()` dependency (manual) or the explicit commit in `_run_dedup_for_scan` (sync). A
  future caller that forgets to commit would **silently** lose all dedup writes with no error.
- **Risk**: Low. **Effort**: S (document the contract prominently, or commit explicitly inside
  `run_dedup`).

### D11 — No dedup metrics/counters beyond per-run report rows
- **Category**: Observability
- **Impact**: LOW. Tracing (`JhaTrace` events, ring-buffered `debug_log`) and the per-run
  `dedup_reports` metrics are solid, but there are no aggregate counters (flag rates by gate,
  run durations, failure rates) for dashboards/alerting across runs.
- **Risk**: Low. **Effort**: M.

---

### Suggested sequencing (dedup)

1. **Cover before you change**: **D1** (no dedup smoke test — the Principle II prerequisite).
2. **Cheap correctness/cleanup**: D4 (reset over-reach), D9/D10 (crash stub + commit contract),
   D2/D7 (de-duplicate the gate + chain-walk logic).
3. **Then scale/convention**: D5 (corpus bound) and D6 (background the manual run) — coupled,
   and both change observable behavior, so do them behind the D1 test net.
4. **Document, don't re-architect this round**: D3 (filter/dedup conflation), D8 (term-lists),
   D11 (aggregate metrics).
