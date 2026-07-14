# Feature Specification: Matching Pipeline (As-Built)

**Feature Branch**: `docs/spec-baseline`

**Created**: 2026-07-14

**Status**: As-Built Baseline (documents current behavior; proposes no changes)

**Input**: User description: "Produce an AS-BUILT specification of the CURRENT matching pipeline."

---

## Overview *(as-built context)*

This is an **as-built specification** (Constitution Principle I) of the matching pipeline in
`backend/matching/` (`pipeline.py`, `extractor.py`, `gates.py`, `scorer.py`, `llm_scorer.py`,
`normaliser.py`, `step_b.py`, `constants.py`, `skill_aliases_persist.py`) and its HTTP surface
in `backend/routers/matching.py`. It documents what the code does today, including known
limitations; it proposes no changes. Where prose docs disagree with the code, the code is
authoritative.

**Scope:**

- The four staged "buttons" run via `POST /jobs/match` as **background asyncio tasks**:
  **Button 1** `cpu_only` (CPU extraction + gates), **Button 2** `llm_extraction_gates`
  (LLM extraction + gates), **Button 3** `cpu_score` (CPU pre-score),
  **Button 4** `llm_score` (LLM re-score), plus the legacy `mode=None` Step-B extraction.
- How each stage reads and writes the matching fields on `scraped_jobs`.
- The asyncio background-task execution model and `GET /match/status`.
- `match_reports` metrics + `debug_log`, and the report/reset/undo/dismiss routes.
- `OPENAI_API_KEY` and config `llm`-flag gating.

**Store note.** The pipeline reads and mutates the legacy `scraped_jobs` table only; the
per-source tables are not involved (ties to spec `002` KL-1). Both LLM stages use OpenAI model
`gpt-4o-mini` (`MATCHING_MODEL` / `LLM_SCORE_MODEL`).

**Stage sequencing is encoded in nullable columns, not an explicit status.** Eligibility for
each stage is expressed as predicates over `matched_at`, `match_skip_reason`, `match_level`,
and `confidence` — the pipeline is an implicit state machine over `scraped_jobs` columns.

**Authentication.** Every route in `routers/matching.py` requires bearer auth via
`get_current_user` (Constitution Principle VII).

## Clarifications

### Session 2026-07-14

Authored directly from source (`matching/pipeline.py`, `routers/matching.py`, `gates.py`,
`scorer.py`, `constants.py`, `extractor.py`, `models/match_report.py`, `schemas/match_report.py`)
plus the Matching section of `README.md`. No open questions required a user decision; behavior
was fully determined by the code.

**Verification pass (against `backend/matching/*.py` and `routers/matching.py`):**

- Finding: token accounting was omitted. → Correction: `llm_score_job` captures
  `usage.prompt_tokens`/`usage.completion_tokens` as `token_in`/`token_out` **per call** and
  records them in the pipeline trace via `emit_llm_trace_event` / `llm_trace_sink` (surfacing in
  the report `debug_log`). There is **no** aggregate token or cost rollup — `match_reports` has
  no token columns. Captured in FR-023 and an observability edge case (KL-8).
- Finding: the LLM-score call has its own timeout. → Correction: `llm_score_job` calls OpenAI
  with `max_tokens=600`, `response_format=json_object`, and an internal `timeout=120.0`
  (distinct from extraction's 150s `asyncio.wait_for`). Added to FR-012.
- Finding: the match-level value space differs by stage. → Correction: `cpu_prescore` only ever
  assigns `strong_match`/`stretch_match`/`weak_match`, but `llm_score_job` may return
  **`possible_match`** (a 4th level CPU never produces). Added to US2/edge cases.
- Finding: "fallback when llm disabled" needed to be explicit. → Correction: when config `llm`
  is false, the **default** stage extracts with `cpu_extract_jd` (no LLM), and `cpu_prescore`
  makes the final call (`stretch`/`weak` split at `cpu_binary_threshold`, `send_to_llm=false`);
  Button 2 (400) and Button 4 (422) are **blocked at the route** rather than falling back.
- Finding: the language gate is Button-1-only. → Correction: `language_gate_jd` runs only in
  `run_cpu_work`; Button 2 re-runs `run_hard_gates` but **not** the language gate. Noted in FR-008.
- Finding: no matching smoke test. → Confirmed **testing gap** (SC-006): no targeted test covers
  the stage eligibility predicates, gate/score rules, background execution, gating, timeout/
  fallback, or the crash path.
- Verified with no discrepancy: the four stage eligibility predicates, gate order/rules
  (`yoe`>+1.0, `salary`<min, `education` degree/field, `visa` `"false"`), `cpu_prescore`
  thresholds/levels + alias normalization, the 150s extraction timeout → CPU fallback, Button-4
  2-attempt/1s-backoff retry, per-stage crash stub (`*_crashed`), `match_reports` fields, and
  bearer auth on every route.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trigger a matching stage as a background run (Priority: P1)

A user clicks a "matching button" in the dashboard. The backend validates the mode and its
gating, starts the stage as a background task, and immediately returns "started" — the UI polls
status until it finishes.

**Why this priority**: This is the invocation contract for every matching stage and the source
of the non-blocking execution model.

**Independent Test**: `POST /jobs/match {mode}` for each valid mode and assert HTTP returns
`{status:"started", mode}` immediately, `GET /match/status` reports `{running:true, mode}` while
in flight and `{running:false, mode:null}` after, and a `match_reports` row is written.

**Acceptance Scenarios**:

1. **Given** a valid `mode` (`cpu_only` / `llm_extraction_gates` / `cpu_score` / `llm_score`,
   or omitted), **When** `POST /jobs/match` runs, **Then** the stage is scheduled via
   `asyncio.create_task` in a **fresh** DB session, tracked in `_BACKGROUND_TASKS`, and the
   response is `{status:"started", mode}` without waiting for completion.
2. **Given** an unrecognized `mode`, **When** posted, **Then** HTTP 422 ("Invalid matching
   mode").
3. **Given** `mode = "llm_extraction_gates"` with config `llm` disabled, **When** posted,
   **Then** HTTP 400; **Given** `mode = "llm_score"` with `llm` disabled **or** `OPENAI_API_KEY`
   unset, **Then** HTTP 422.
4. **Given** a running stage, **When** `GET /match/status` runs, **Then** it returns the first
   live task's `{running:true, mode}`; with none live, `{running:false, mode:null}`.

---

### User Story 2 - The four-stage extraction → gate → score → re-score flow (Priority: P1)

Each stage advances eligible jobs by reading the fields written by the prior stage and writing
its own, so a job flows from raw JD to a scored match level.

**Why this priority**: This is the core value — turning scraped jobs into ranked matches — and
defines the field contract every stage depends on.

**Independent Test**: Seed passed (`skip_reason IS NULL`) jobs and run the four stages in order,
asserting the field state after each: extraction fields → gate `match_skip_reason` → `fit_score`/
`match_level` → LLM `confidence`/`match_level`.

**Acceptance Scenarios**:

1. **Given** eligible jobs (`skip_reason IS NULL`, `matched_at IS NULL`, not dismissed),
   **When** Button 1 (`run_cpu_work`) runs, **Then** each job gets CPU-extracted fields
   (`extracted_yoe`, `salary_min/max_extracted`, `education_*`, `visa_req`, `required_skills`,
   `nice_to_have_skills`, `jd_incomplete`), `matching_mode="cpu"`, `matched_at=now`; a failing
   **language gate** or **hard gate** sets `match_skip_reason` + `removal_stage="cpu_work"`; a
   per-job exception sets `match_skip_reason="extraction_failed"`, `jd_incomplete=true`.
2. **Given** extracted, gate-ok, unscored jobs (`matched_at IS NOT NULL`,
   `match_skip_reason IS NULL`, `match_level IS NULL`), **When** Button 2
   (`run_llm_extraction_gates`) runs, **Then** each job is re-extracted via the LLM (150s
   timeout → CPU fallback), hard gates re-run (`removal_stage="llm_extraction"` on fail), at
   concurrency 8.
3. **Given** extracted, gate-ok jobs, **When** Button 3 (`run_cpu_score_pipeline`) runs,
   **Then** `cpu_prescore` writes `fit_score`, `req_coverage`, `match_level`
   (`strong_match` / `stretch_match` / `weak_match`), and `match_reason`.
4. **Given** CPU-scored jobs in the middle range (`stretch_match`/`weak_match` with
   `0 < fit_score < cpu_strong_threshold`) **or** `jd_incomplete`, that are unscored by the LLM
   (`match_level IS NOT NULL`, `confidence IS NULL`), **When** Button 4
   (`run_llm_score_pipeline`) runs, **Then** the LLM writes `match_level`, `match_reason`,
   `blocking_gap`, `gap_adjacency`, `confidence`, `matching_mode="llm"` (concurrency 8, 2
   attempts, per-job fresh session/commit).
5. **Given** hard gates, **When** `run_hard_gates` runs, **Then** it returns the first failing
   gate in order — `yoe_gate` (JD YOE exceeds profile YOE + 1.0), `salary_gate` (JD salary <
   config `salary_min`), `education_gate` (profile degree below required, or
   `education_field_qualified is False`), `visa_gate` (`needs_sponsorship` and `visa_req="false"`)
   — else `None`.

---

### User Story 3 - Inspect, reset, and correct matching state (Priority: P2)

A user watches progress, reads run metrics, and reverts stages or dismisses jobs.

**Why this priority**: Supporting operations for observing and correcting matching; secondary to
running it.

**Independent Test**: Run a stage, then call `GET /match/status`, `GET /match/logs`,
`GET /match/reports`, and the various `undo-button*` / `reset*` / `dismiss` routes and assert the
returned counts and the cleared fields.

**Acceptance Scenarios**:

1. **Given** past runs, **When** `GET /match/reports` runs, **Then** the 50 most recent
   `match_reports` are returned (newest first); `GET /match/reports/{id}` returns one (404 if
   absent); `POST /match/reports/{id}/debug` appends to its `debug_log` ring buffer.
2. **Given** the `undo-button1..4` / `reset-gates` / `reset-score` / `reset` routes, **When**
   called, **Then** they clear the documented field subsets (e.g. `undo-button1` clears dedup
   service skip reasons + all matching fields; `undo-button4` clears only LLM-score fields) and
   return a `{reset_count}`.
3. **Given** a job, **When** `POST /jobs/match/dismiss/{id}` runs, **Then** it 404s if absent,
   422s unless the job is scored or gate-failed, else sets `dismissed=true`; `undismiss/{id}`
   reverses it (clearing extraction/score fields when it was not gate-failed).

---

### Edge Cases

- **LLM extraction timeout** (Button 2 / default `llm` mode): a >150s `llm_extract_jd` call is
  caught, the job falls back to `cpu_extract_jd`, and the outcome is counted as `cpu_fallback`.
- **Per-job failure** in Button 1: sets `match_skip_reason="extraction_failed"`,
  `removal_stage="cpu_work"`, `jd_incomplete=true`, `matched_at=now`, and continues.
- **Per-job failure** in Button 2/default: sets `jd_incomplete=true`, counts `fail`, and
  continues (`asyncio.gather(..., return_exceptions=True)`).
- **Button 4 without `OPENAI_API_KEY`**: rejected at the route (422); even if reached, each job
  raises `RuntimeError("OPENAI_API_KEY is not set")` and is counted failed after 2 attempts.
- **Language gate**: empty JD or `LangDetectException` → pass (no skip); otherwise a JD language
  not in `allowed_languages` (default `["en"]`) sets `match_skip_reason="language"`.
- **`cpu_prescore` with no required skills**: `req_coverage=None`; if `llm` mode → `stretch_match`
  + `send_to_llm=true`, else `stretch_match` + `send_to_llm=false`; zero overlap → `weak_match`.
- **Stage crash**: any exception in a `run_*` stage triggers `db.rollback()` and writes a zeroed
  stub `match_reports` row (`matching_mode="<stage>_crashed"`) plus a `run_crash` trace, commits
  the stub, and re-raises (the background wrapper logs it).
- **Multi-worker status**: `_BACKGROUND_TASKS` and `/match/logs` are per-process; a task or log
  line on another worker process is invisible to `/match/status` and `/match/logs`.
- **LLM introduces a 4th match level**: `cpu_prescore` only assigns
  `strong_match`/`stretch_match`/`weak_match`, but `llm_score_job` may assign `possible_match`,
  so a job's `match_level` value space depends on which stage last wrote it.
- **Token accounting is per-call only**: LLM `token_in`/`token_out` live in the trace/`debug_log`;
  there is no aggregate token or cost total on `match_reports` (see KL-8).

## Requirements *(mandatory)*

### Functional Requirements

**Execution model & gating**

- **FR-001**: `POST /jobs/match` MUST validate `mode ∈ {cpu_only, llm_extraction_gates,
  cpu_score, llm_score}` or null (422 otherwise), then schedule `_matching_background(mode)` via
  `asyncio.create_task`, track it in `_BACKGROUND_TASKS` (removed on done), and return
  `{status:"started", mode}` without awaiting completion.
- **FR-002**: `_matching_background` MUST open a **fresh** `AsyncSessionLocal` (the request
  session is closed after the HTTP response) and dispatch to the stage function; unhandled
  exceptions MUST be logged, not raised to the caller.
- **FR-003**: `mode = "llm_extraction_gates"` MUST be rejected (400) when config `llm` is false;
  `mode = "llm_score"` MUST be rejected (422) when config `llm` is false **or** when
  `OPENAI_API_KEY` is unset.
- **FR-004**: `GET /match/status` MUST return `{running, mode}` for the first non-done task in
  `_BACKGROUND_TASKS`, else `{running:false, mode:null}`; `GET /match/logs` MUST return the
  matching-logger ring buffer (max 2000 lines).

**Button 1 — CPU extraction + gates (`run_cpu_work`)**

- **FR-005**: Eligibility MUST be `skip_reason IS NULL AND matched_at IS NULL AND
  dismissed = false`. For each job it MUST run `cpu_extract_jd`, apply the extracted fields,
  `matching_mode="cpu"`, then the **language gate** and **hard gates**.
- **FR-006**: A language-gate hit MUST set `match_skip_reason="language"`,
  `removal_stage="cpu_work"`, `matched_at=now`, record skill candidates, and continue; a
  hard-gate hit MUST set `match_skip_reason=<gate>`, `removal_stage="cpu_work"`. Every processed
  job MUST get `matched_at=now`; per-job exceptions MUST set
  `match_skip_reason="extraction_failed"`, `jd_incomplete=true`.

**Button 2 — LLM extraction + gates (`run_llm_extraction_gates`)**

- **FR-007**: Eligibility MUST be `skip_reason IS NULL AND match_skip_reason IS NULL AND
  matched_at IS NOT NULL AND match_level IS NULL AND dismissed = false`. Jobs MUST be processed
  concurrently (semaphore of `STEP_B_CONCURRENCY = 8`) with a shared `db_lock` around DB writes.
- **FR-008**: Each job MUST call `llm_extract_jd` under a 150s `asyncio.wait_for` timeout,
  falling back to `cpu_extract_jd` (counted `cpu_fallback`) on timeout, then re-run
  `run_hard_gates` (`removal_stage="llm_extraction"` on failure, else cleared) and record skill
  candidates. Button 2 does **not** re-run the language gate (that gate is Button-1-only).

**Button 3 — CPU pre-score (`run_cpu_score_pipeline`)**

- **FR-009**: Eligibility MUST be `skip_reason IS NULL AND matched_at IS NOT NULL AND
  match_skip_reason IS NULL AND dismissed = false`. For each job it MUST call `cpu_prescore`
  and write `fit_score`, `req_coverage`, `match_level`, `match_reason`.
- **FR-010**: `cpu_prescore` MUST compute `req_coverage = |matched_required| / |required|` (or
  None), `fit_score = req_coverage + nth_bonus × nth_bonus_weight`, and assign `match_level`:
  `strong_match` when `fit_score ≥ cpu_strong_threshold`; middle-range → `stretch_match` with
  `send_to_llm=true` when config `llm`, else `stretch_match`/`weak_match` split at
  `cpu_binary_threshold`; zero required overlap → `weak_match`. Skills MUST be alias-normalized
  (`normaliser`) before comparison to profile skills.

**Button 4 — LLM re-score (`run_llm_score_pipeline`)**

- **FR-011**: Eligibility MUST be `skip_reason IS NULL AND matched_at IS NOT NULL AND
  match_skip_reason IS NULL AND match_level IS NOT NULL AND confidence IS NULL AND
  dismissed = false`, restricted to jobs that are (`stretch_match`/`weak_match` with
  `0 < fit_score < cpu_strong_threshold`) **or** `jd_incomplete`.
- **FR-012**: For each eligible job it MUST, at concurrency 8, open its own short-lived
  `AsyncSessionLocal`(s) per job, call `llm_score_job` (OpenAI `gpt-4o-mini`, `max_tokens=600`,
  `response_format=json_object`, internal `timeout=120.0`; up to 2 attempts with a 1s backoff),
  and commit `match_level`, `match_reason`, `blocking_gap`, `gap_adjacency`, `confidence`,
  `matching_mode="llm"` per job; a missing `OPENAI_API_KEY` MUST fail the job. `llm_score_job`
  MUST validate `match_level` (one of `strong_match`/`possible_match`/`stretch_match`/
  `weak_match`) and default `confidence` to `"medium"` when out of range.

**Default / legacy Step-B (`mode=None` → `_run_step_b_extraction_all_passed`)**

- **FR-013**: With no mode, the system MUST run JD extraction only (no hard gates) over all
  `skip_reason IS NULL` jobs, using `llm_extract_jd` (with 150s timeout → CPU fallback) when
  config `llm` else `cpu_extract_jd`, setting `matched_at=now` and `matching_mode` accordingly.

**Synchronous helper routes**

- **FR-014**: `POST /jobs/match/gates` MUST run `run_hard_gates` synchronously over extracted,
  ungated jobs and set `match_skip_reason` + `removal_stage`
  (`llm_extraction` for education/visa gates, else `cpu_work`), returning gate counts.
- **FR-015**: `POST /jobs/match/score` MUST run `cpu_prescore` synchronously over extracted,
  gate-ok, unscored jobs and return score counts (a legacy path parallel to Button 3).
- **FR-016**: `GET /jobs/match` MUST return HTTP 501; `GET /jobs/match/extracted-count` MUST
  return the count of `skip_reason IS NULL AND matched_at IS NOT NULL` jobs.

**Resets, undo, dismiss**

- **FR-017**: The reset/undo routes MUST clear the documented field subsets and return
  `{reset_count}`: `reset-gates` (only `match_skip_reason`), `reset-score` (score fields),
  `reset` (all matching fields), `undo-button1` (dedup service skip reasons + all matching
  fields), `undo-button2` (scores + revert `education/visa` gates + `matching_mode` llm→cpu),
  `undo-button3` (score fields), `undo-button4` (LLM-score fields only).
- **FR-018**: `POST /jobs/match/dismiss/{id}` MUST 404 (absent) / 422 (not scored or
  gate-failed) / else set `dismissed=true`; `undismiss/{id}` MUST clear `dismissed` and, when the
  job was not gate-failed, also clear extraction/score fields.

**Reports, metrics, debug log**

- **FR-019**: Each stage MUST write a `match_reports` row with `dedup_run_id`, `trigger`,
  `matching_mode` (the stage label), `total_processed`, `total_gate_skipped`,
  `total_cpu_decided`, `total_llm_scored`, `total_failed`, `total_cpu_fallback`,
  `match_level_counts`, `gate_skip_counts`, and `duration_ms`, and MUST flush its `core.trace`
  buffer into the report's `debug_log` (ring-buffered to `settings.debug_log_ring_size`).
- **FR-020**: On a stage crash, the system MUST `rollback`, write a zeroed stub `match_reports`
  row (`matching_mode="<stage>_crashed"`) with a `run_crash` trace, commit it, and re-raise.
- **FR-021**: `GET /match/reports` MUST return the 50 newest reports; `GET /match/reports/{id}`
  one (404 if absent); `POST /match/reports/{id}/debug` MUST append events to `debug_log`.

**Token accounting**

- **FR-023**: For LLM calls, `llm_score_job` MUST record per-call `token_in`
  (`usage.prompt_tokens`) and `token_out` (`usage.completion_tokens`) into the pipeline trace
  via `emit_llm_trace_event` / `llm_trace_sink` (surfaced in the report `debug_log`). The system
  does **not** aggregate tokens or cost onto `match_reports` (the table has no token columns).

**Cross-cutting**

- **FR-022**: Every route in `routers/matching.py` MUST require bearer auth via
  `get_current_user`.

### Known Limitations *(as-built; not defects to fix in this round)*

- **KL-1 — Three parallel Step-B implementations**: `pipeline.run_cpu_work` /
  `run_llm_extraction_gates`, the router's `_run_step_b_extraction_all_passed` (default mode),
  and `matching/step_b.py::run_step_b_extraction` all perform JD extraction with overlapping but
  non-identical logic; `step_b.py` is not wired into the `/jobs/match` background modes.
- **KL-2 — Duplicated helpers/constants**: `_merge_profile_raw`, `_coerce_skill_list`,
  `_profile_skill_strings`, and `STEP_B_CONCURRENCY = 8` are defined independently in both
  `pipeline.py` and `routers/matching.py`.
- **KL-3 — Implicit column state machine**: stage eligibility is encoded across nullable columns
  (`matched_at`, `match_skip_reason`, `match_level`, `confidence`), with no explicit status
  field; the ordering contract is implicit and easy to violate by hand.
- **KL-4 — Per-worker task/log visibility**: `_BACKGROUND_TASKS` and the `/match/logs` ring
  buffer are process-globals; in a multi-worker deployment `/match/status` and `/match/logs` see
  only the handling worker's state.
- **KL-5 — Button 4 commits per job (non-atomic run)**: unlike stages 1–3 (one commit at run
  end), LLM re-score commits each job in its own session, so a mid-run failure leaves a partial
  set of LLM-scored jobs persisted.
- **KL-6 — Crash stubs pollute `match_reports`**: a crash commits a zeroed `*_crashed` report
  row, so report history/counts include non-runs (parallels dedup KL-7).
- **KL-7 — Two score entry points**: Button 3 (`cpu_score` background) and `POST /jobs/match/score`
  (synchronous, legacy) both run `cpu_prescore` over near-identical eligibility.
- **KL-8 — No aggregate token/cost accounting**: LLM token usage is recorded per call in the
  trace only; `match_reports` has no token/cost rollup, so per-run LLM spend is not queryable
  without parsing each report's `debug_log`.

### Key Entities

- **`scraped_jobs`** (subject rows): read/written across stages. Extraction fields
  (`extracted_yoe`, `salary_min_extracted`, `salary_max_extracted`, `education_req_degree`,
  `education_req_field`, `education_field_qualified`, `visa_req`, `required_skills`,
  `nice_to_have_skills`, `jd_incomplete`); pipeline-state fields (`matched_at`, `matching_mode`,
  `match_skip_reason`, `removal_stage`); score fields (`fit_score`, `req_coverage`,
  `match_level`, `match_reason`); LLM-score fields (`confidence`, `blocking_gap`,
  `gap_adjacency`); `dismissed`.
- **`match_reports`**: one row per stage run. Integer `id`, `dedup_run_id` (FK →
  `dedup_reports`, ON DELETE SET NULL), `trigger`, `matching_mode`, the six `total_*` counters,
  `match_level_counts` (JSONB), `gate_skip_counts` (JSONB), `duration_ms`, `debug_log` (JSONB),
  `created_at`.
- **Config (`SearchConfigRead`)**: `llm` (enables Buttons 2/4 and LLM extraction), `salary_min`,
  `needs_sponsorship`, `allowed_languages`, `nth_bonus_weight`, `cpu_strong_threshold`,
  `cpu_binary_threshold`. Profile (`profile.json`) supplies skills, YOE, and education for gates
  and scoring.
- **Skill aliases** (`skill_aliases.json` via `normaliser` / `skill_aliases_persist`): canonical
  skill mapping used to normalize JD and profile skills before comparison.
- **`OPENAI_API_KEY`** (env): required for LLM extraction and LLM re-score; both LLM stages use
  `gpt-4o-mini`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every functional requirement (FR-001…FR-023) is traceable to a specific line/area
  in `matching/pipeline.py`, `routers/matching.py`, or the stage modules with no contradiction.
- **SC-002**: For seeded jobs, running the four stages in order yields the field states in
  US2/AC1–5 and a `match_reports` row per stage with the correct `matching_mode` label.
- **SC-003**: `POST /jobs/match` returns before the stage completes, `GET /match/status` reflects
  the in-flight mode, and the gating rules (FR-003) reject `llm`/`OPENAI_API_KEY`-missing runs.
- **SC-004**: `run_hard_gates` returns the first failing gate in the documented order, and
  `cpu_prescore` assigns `match_level` per the thresholds (FR-010).
- **SC-005**: Each Known Limitation (KL-1…KL-8) is reproducible against the current code and
  none describes an intended future design.
- **SC-006** (testing gap): There is **no** targeted smoke/contract test for the matching
  pipeline in the current suite; the stage eligibility predicates, gate/score rules, background
  execution, gating, and crash path are unverified by an automated test — a Principle II
  prerequisite for any behavior-preserving change.

## Assumptions

- `scraped_jobs`, `match_reports`, `skill_candidates`, and `dedup_reports` exist at the current
  Alembic head; extraction/score/LLM columns exist on `scraped_jobs`.
- "As implemented" refers to the code on branch `docs/spec-baseline` at 2026-07-14; this spec
  introduces no requirements beyond describing existing behavior.
- `config.json` supplies the `llm` flag and thresholds; `profile.json` and `skill_aliases.json`
  are present; `OPENAI_API_KEY` may or may not be set (the gating rules handle both).
- The current smoke suite (`smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`,
  `smoke_test_matched_claim.py`) does not cover matching; behavior is documented from source and
  the README API contract.
