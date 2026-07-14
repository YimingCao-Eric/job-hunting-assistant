# Standardization & Optimization Backlog — Matching Pipeline (spec 004)

**Purpose**: Existing-code standardization and optimization items for the matching pipeline,
from comparing spec `004-matching-pipeline` against the constitution (`.specify/memory/constitution.md`)
and the code. **No new features.** Nothing here is implemented — a review artifact only.

**Effort key**: **XS** <1h · **S** a few hours · **M** 1–2 days · **L** ≥1 week.
**Risk** = risk of *making the fix* (to behavior the smoke suite guards).

**Related backlogs**: `001` post-scrape (`specs/001-post-scrape-phases-1-2/standardization-backlog.md`),
`002` jobs, `003` dedup, `005` scrape orchestrator (each in its own `specs/*/` folder).

**Scope compared**: `backend/matching/*.py` (`pipeline.py`, `extractor.py`, `gates.py`,
`scorer.py`, `llm_scorer.py`, `normaliser.py`, `step_b.py`, `constants.py`,
`skill_aliases_persist.py`) and `backend/routers/matching.py` against spec `004-matching-pipeline`
and the constitution.

---

### What already conforms (no action — recorded for completeness)

- **Async background execution (Principle VI)** — `POST /jobs/match` schedules stages via
  `asyncio.create_task` in a fresh `AsyncSessionLocal`; the request session is not reused.
- **Auth (Principle VII)** — every route in `routers/matching.py` requires `get_current_user`.
- **Forward-compatible JSONB (Principle VII)** — `match_reports.match_level_counts` /
  `gate_skip_counts` / `debug_log` are additive JSONB.
- **Gating** — config `llm` and `OPENAI_API_KEY` are checked before LLM stages run (400/422).
- **Mutation scope** — the pipeline mutates only `scraped_jobs`; per-source append-only tables
  (CC-1) are untouched. `gates.py` and `scorer.py` are pure functions (no DB/async/LLM).

### Backlog (severity-ordered)

| ID | Category | Severity | Source | Risk | Effort |
|----|----------|----------|--------|------|--------|
| M1 | Structure (3× Step-B) | HIGH | KL-1 | Medium | M |
| M7 | Test coverage | HIGH | SC-006 | Low | M–L |
| M8 | Test coverage (pure fns) | HIGH | FR-005/010 | Low | S |
| M2 | Duplicated helpers/constant | MEDIUM | KL-2 | Low | S |
| M3 | Naming (stage vocabulary) | MEDIUM | Constitution naming | Low | S |
| M4 | Structure (implicit state machine) | MEDIUM | KL-3 | Medium | M |
| M6 | Duplicated normalization | MEDIUM | CC-10/CC-11 | Low–Med | S–M |
| M9 | Observability (token/cost) | MEDIUM | KL-8 | Low | S–M |
| M10 | Observability (multi-worker) | MEDIUM | KL-4 | Medium | M |
| M13 | Correctness/latency (per-job commit) | MEDIUM | KL-5 | Medium | M |
| M14 | Cost/latency (no LLM caching) | MEDIUM | — | Medium | M |
| M5 | Duplicated logic | LOW | — | Low | S |
| M11 | Observability (crash stubs) | LOW | KL-6 | Low | S |
| M12 | Latency (sessions/job) | LOW | FR-012 | Low | S |
| M15 | Quality (silent CPU fallback) | LOW | FR-008 | Low | S |

---

### M1 — Three parallel Step-B extraction implementations (KL-1)
- **Category**: Structure / naming
- **Impact**: HIGH. JD extraction exists three times with overlapping-but-different logic:
  `pipeline.run_cpu_work` / `run_llm_extraction_gates`, the router's
  `_run_step_b_extraction_all_passed` (default mode), and `matching/step_b.py::run_step_b_extraction`
  (not wired into the `/jobs/match` background modes — likely dead). Behavior can drift between
  them; the dead copy misleads readers.
- **Risk**: Medium — verify `step_b.py` callers; consolidate onto one extraction entry point.
- **Effort**: M.

### M7 — No smoke/contract test for the matching pipeline (SC-006)
- **Category**: Test coverage (missing)
- **Impact**: HIGH. None of the four stages, the eligibility predicates, gate/score rules,
  background execution, gating, timeout/fallback, or the crash path is covered by an automated
  test. Per Constitution Principle II this is the prerequisite for any behavior-preserving change.
- **Risk**: Low. **Effort**: M–L (seed fixtures across stages; a deterministic LLM stub).

### M8 — Pure-function gates/scorer are untested (cheap, high value)
- **Category**: Test coverage (missing)
- **Impact**: HIGH-value, cheap. `run_hard_gates` (gate order/thresholds) and `cpu_prescore`
  (level thresholds, coverage math, alias normalization) are pure functions — the exact
  behavioral contract most at risk — yet have no unit tests. A table-driven test would lock
  FR-005/FR-010.
- **Risk**: Low. **Effort**: S.

### M2 — Duplicated helpers and `STEP_B_CONCURRENCY` (KL-2)
- **Category**: Duplicated logic
- **Impact**: MEDIUM. `_merge_profile_raw`, `_coerce_skill_list`, `_profile_skill_strings`, and
  `STEP_B_CONCURRENCY = 8` are defined independently in both `pipeline.py` and
  `routers/matching.py`; a change to concurrency or profile-merge must touch both.
- **Risk**: Low — extract to a shared module. **Effort**: S.

### M3 — Inconsistent stage vocabulary across code/comments/reports
- **Category**: Naming / convention
- **Impact**: MEDIUM. The same stages are named "Button 1–4", "Step A/B/C/D", the mode strings
  (`cpu_only`/`llm_extraction_gates`/`cpu_score`/`llm_score`), and the `matching_mode` report
  labels (`cpu_work`/`cpu`/`llm`/`cpu_score`/`llm_score`, plus `*_crashed`). No single canonical
  glossary; the report `matching_mode` label set overlaps but is not identical to the request
  mode set.
- **Risk**: Low. **Effort**: S (document a canonical mapping; align labels where safe).

### M4 — Stage sequencing is an implicit column state machine (KL-3)
- **Category**: Structure / robustness
- **Impact**: MEDIUM. Eligibility for each stage is encoded across nullable columns
  (`matched_at`, `match_skip_reason`, `match_level`, `confidence`) with no explicit status field
  or documented transition table; hand-editing or a new caller can easily land a job in an
  inconsistent state.
- **Risk**: Medium (adding a status column is a schema/migration change). **Effort**: M. Likely
  **document** the state table this round rather than add a column.

### M6 — Normalization is scattered; boundary vs future merge normalization unclear (CC-10/CC-11)
- **Category**: Duplicated / to-be-duplicated normalization
- **Impact**: MEDIUM. `matching/normaliser.py` owns **skill-alias** normalization
  (`skill_aliases.json`, `normalise_list`, `lru_cache`), re-invoked independently in `scorer.py`,
  `llm_scorer.py`, and `extractor.py`. Separately, CC-10/CC-11 designate **salary/nested**
  normalization as a *merge-stage* concern that the not-yet-built post-scrape Phase 3
  (`match_candidates`) will introduce. Without a shared normalization contract, the merge stage
  risks a **second, overlapping** normalization layer (skills vs salary/fields) with duplicated
  responsibility. Flag the boundary now, before Phase 3 builds merge normalization.
- **Risk**: Low–Medium (documentation/consolidation; no behavior change yet). **Effort**: S–M.

### M9 — No aggregate token/cost accounting (KL-8)
- **Category**: Observability
- **Impact**: MEDIUM. `llm_score_job` records `token_in`/`token_out` per call in the trace/
  `debug_log` only; `match_reports` has no token or cost columns, so per-run LLM spend is not
  queryable without parsing each report's `debug_log`.
- **Risk**: Low. **Effort**: S–M (roll token totals into `match_reports`).

### M10 — `/match/status` and `/match/logs` are per-worker (KL-4)
- **Category**: Observability
- **Impact**: MEDIUM. `_BACKGROUND_TASKS` and the `/match/logs` 2000-line ring buffer are
  process-globals; under a multi-worker deployment the UI polling `/match/status` may miss a run
  happening on another worker, and `/match/logs` shows only the handling worker.
- **Risk**: Medium (a shared store changes the status contract). **Effort**: M.

### M13 — Button 4 commits per job (non-atomic run) (KL-5)
- **Category**: Correctness / latency
- **Impact**: MEDIUM. Unlike stages 1–3 (one commit at run end), LLM re-score commits each job
  in its own session, so a mid-run failure leaves a partial set of LLM-scored jobs persisted,
  and per-job commit adds overhead.
- **Risk**: Medium (batching commits changes failure semantics). **Effort**: M.

### M14 — No caching of LLM extraction/scoring results (cost/latency)
- **Category**: Cost / latency
- **Impact**: MEDIUM. Every eligible job triggers a fresh `gpt-4o-mini` call (extraction and/or
  scoring); re-running a stage re-calls the LLM for jobs whose JD/profile did not change
  (eligibility filters mitigate but do not eliminate). No result cache keyed on JD hash + profile
  version, and no request batching.
- **Risk**: Medium (caching changes when the model is consulted). **Effort**: M. Flag as an
  optimization to weigh against freshness.

### M5 — `_coerce_skill_list` defined in three modules
- **Category**: Duplicated logic
- **Impact**: LOW. The same coercion helper appears in `pipeline.py`, `routers/matching.py`, and
  `llm_scorer.py`.
- **Risk**: Low. **Effort**: S (single shared helper).

### M11 — Crash stubs pollute `match_reports` (KL-6)
- **Category**: Observability / correctness
- **Impact**: LOW–MEDIUM. A stage crash commits a zeroed `*_crashed` report row, so report
  history/counts include non-runs (parallels dedup D9).
- **Risk**: Low. **Effort**: S (mark or omit the stub).

### M12 — LLM re-score opens several short-lived sessions per job (FR-012)
- **Category**: Latency
- **Impact**: LOW. `run_llm_score_pipeline.process_one` opens multiple `AsyncSessionLocal`s per
  job (prompt-build read, pre-call read, post-call write) — 3+ DB round-trips where fewer would
  do.
- **Risk**: Low. **Effort**: S.

### M15 — Silent CPU fallback on LLM extraction timeout (FR-008)
- **Category**: Quality
- **Impact**: LOW. A >150s `llm_extract_jd` falls back to `cpu_extract_jd` (counted
  `cpu_fallback`) and the job proceeds as if fully extracted — no LLM retry — silently lowering
  extraction quality for slow JDs.
- **Risk**: Low. **Effort**: S (retry/flag policy).

---

### Suggested sequencing (matching)

1. **Cover before you change**: **M8** (pure-function gate/scorer tests — trivial, high value),
   then **M7** (stage-level tests).
2. **De-dup / clarify structure**: M2, M5 (shared helpers), M1 (collapse the 3× Step-B), M3
   (canonical stage vocabulary), M4 (document the column state machine).
3. **Observability**: M9 (token rollup), M11 (crash-stub marker), M10 (multi-worker status).
4. **Cost/latency, behind the M7/M8 test net**: M13 (batch Button-4 commits), M12 (fewer
   sessions/job), M14 (LLM result caching), M15 (fallback policy).
5. **Document, don't re-architect this round**: **M6** — record the normalization boundary
   (skills vs future merge-stage salary/field normalization per CC-10/CC-11) before Phase 3 is
   built, so the two layers share a contract instead of duplicating.
