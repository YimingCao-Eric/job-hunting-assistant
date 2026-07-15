# Phase 0 Research: Search-Only Backend

All unknowns are resolved against the current code and the spec's resolved clarifications.
No NEEDS CLARIFICATION remain.

## D-1. Command wording vs. resolved clarifications (reconciliation)

- **Decision**: Follow the spec's resolved clarifications, not the conditional phrasing in the
  `/speckit-plan` command args. Specifically: **no** Alembic migration 030 (D1 = leave,
  FR-006a); **keep** the Phase 2 matched-claim and the `matched` column, and **keep**
  `smoke_test_matched_claim.py` / its `_verify_required_columns` (D2 = keep, FR-014).
- **Rationale**: The command said *"(5) if D1=drop, add migration 030"* — a conditional whose
  guard is false, since D1 resolved to *leave*. It also said *"remove matched-claim/…per D2"*;
  under the resolved **D2 = keep**, "per D2" means keep. Constitution Principle II independently
  forbids removing `smoke_test_matched_claim.py`, since it is the behavioral contract for the
  retained Phase 2 claim + `matched` column. Both readings converge on: no migration, keep
  matched-claim.
- **Alternatives considered**: (a) Treat the command as an override that flips D1→drop /
  D2→remove — rejected: it would contradict the just-approved spec (FR-006a, FR-014) and violate
  Principle II by deleting a passing smoke test for retained behavior. If the user *does* want to
  flip D1 or D2, that is a spec change to make first, then re-plan.

## D-2. Removal order (never import a deleted module)

- **Decision**: Unwire references top-down **before** deleting files: (1) `main.py` +
  orchestrator + extension + admin_cleanup + jobs + `models/__init__.py`; (2) prune
  schema/config fields; (3) delete packages/routers/models/schemas/`dedup_task_cleanup.py`;
  (4) verify.
- **Rationale**: Python resolves imports at module load. If a kept module still imports a deleted
  one, the app fails to boot (violates the boot/health acceptance gate at that commit). Removing
  the *references* first means every intermediate state is boot-safe.
- **Evidence (kept modules that import removed ones today)**:
  - `main.py` → imports 5 removed routers + `core.dedup_task_cleanup`.
  - `auto_scrape/post_scrape_orchestrator.py` → `from dedup.service import run_dedup`,
    `from matching.pipeline import (...)`, and `cfg.llm`.
  - `routers/extension.py` → `from dedup.service import run_dedup`,
    `from models.dedup_task import DedupTask`; `cfg.dedup_mode == "sync"` trigger.
  - `routers/admin_cleanup.py` → `from models.dedup_task import DedupTask`.
  - `routers/jobs.py` → `from models.job_report import JobReport` (+ `has_report` EXISTS).
  - `models/__init__.py` → imports `DedupReport, DedupTask, MatchReport, JobReport, SkillCandidate`.
- **Alternatives considered**: delete-first then fix imports — rejected: leaves the tree
  un-bootable between steps and makes bisection painful.

## D-3. `routers/jobs.py` — how much to change

- **Decision**: Make the **minimal forced** change only: remove the `JobReport` import and the
  `has_report` computation (`list_jobs` and `get_job`), returning jobs without `has_report`.
  **Leave** the match/dedup query-filter parameters and branches as-is.
- **Rationale**: The `has_report` logic must go because the `JobReport` model is deleted. The
  filter branches (`match_skip_reason`, `match_level`, `matching_mode`, `removal_stage`,
  `dedup_type`, `dedup_similarity_score`, `fit_score` ordering, etc.) reference **`ScrapedJob`
  model attributes that remain** (the model and its columns are not pruned — no migration), so
  they still resolve and run. After removal those columns are simply always NULL/empty, making
  the filters harmless no-ops. Keeping them is behavior-preserving (Principle III) and avoids
  touching the large `list_jobs` filter block. FastAPI ignores unknown query params, so the React
  UI sending them is unaffected either way.
- **Alternatives considered**: strip all vestigial match/dedup filter params now — deferred as
  **optional cleanup** (larger diff, no functional benefit for search-only, and the columns still
  exist). Flag for a future cleanup pass, not this feature.

## D-4. `post_scrape_orchestrator.py` — output must stay identical

- **Decision**: Remove the dedup/matching imports, the three stub functions
  (`_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`), the `cfg.llm`
  read (`llm_enabled` / `has_openai_key`), and the `dedup_task_id` write. Compute
  `match_results = {"claim_summary": claim_summary}` directly and write it, then finalize
  `post_scrape_complete`.
- **Rationale**: The stubs already return `None`/`{}`/no-op (spec 001 FR-013), so removing them
  and inlining `{"claim_summary": claim_summary}` produces the **identical** persisted cycle
  output (`cleanup_results`, `match_results == {"claim_summary": {...}}`, terminal status). The
  `cfg.llm` read must go because `llm` is being dropped from `SearchConfigRead` (it would
  `AttributeError`). `cycle.dedup_task_id` defaults NULL, so dropping the explicit NULL write is
  a no-op. This satisfies FR-005/FR-014 and keeps `smoke_test_auto_expiration.py` behavior.
- **Alternatives considered**: keep reading config for other reasons — rejected: after removing
  matching, `cfg` was used **only** for `llm`; the config read can be dropped entirely.

## D-5. `routers/admin_cleanup.py` — preserve the response contract

- **Decision**: Remove the `DedupTask` import and the stale-dedup-task `UPDATE` (`result5`);
  return the existing `marked_failed_dedup_tasks` response key as constant `0`.
- **Rationale**: `admin_cleanup` is a kept, registered router. Its `CleanupInvalidEntriesResponse`
  (in `schemas/auto_scrape.py`, kept) includes `marked_failed_dedup_tasks`. Deleting the
  `DedupTask` model removes the ORM path, but keeping the response key (=0) honors Principle VII
  (don't remove existing output keys) and avoids editing the kept `schemas/auto_scrape.py`. The
  `dedup_tasks` table is orphaned (no writers), so `0` is always accurate.
- **Alternatives considered**: raw-SQL the `dedup_tasks` UPDATE to keep marking — rejected:
  pointless work against a table nothing writes to anymore. Remove the response key — rejected:
  needless contract break.

## D-6. Config loads despite legacy keys

- **Decision**: Dropping `llm` / `dedup_mode` from `SearchConfigRead`/`SearchConfigUpdate` is
  safe for existing on-disk config files.
- **Rationale**: `SearchConfigRead` is a plain Pydantic v2 `BaseModel` with no
  `model_config = ConfigDict(extra="forbid")`, so Pydantic's default `extra="ignore"` silently
  drops unknown keys. A config document still carrying `llm`/`dedup_mode` loads without error
  (FR-006 / SC-006). On the next `write_config_file`, the dropped keys naturally fall out.
- **Alternatives considered**: add an explicit migration of the config file — unnecessary; the
  ignore-on-read + drop-on-write behavior is sufficient and lower-risk.

## D-7. Orphaned schema objects — inventory is *documented*, not dropped

- **Decision**: Do **not** create migration 030. Document the orphaned tables/columns in
  [data-model.md](./data-model.md) as a reference for a *future* drop migration, and require that
  the future migration derive its exact object list programmatically from the SQLAlchemy models +
  the source migrations (011/012/014/015/017/018/019/021/022) rather than by hand.
- **Rationale**: D1 = leave (FR-006a). Hand-copying a drop list risks omissions/typos; the
  constitution's migration discipline (Principle IV) plus the user's "never by hand" instruction
  mean the authoritative list is the model/migration definitions themselves, consulted when (if)
  the drop is scheduled.
- **Alternatives considered**: write 030 now behind a flag — rejected: out of scope and against
  the resolved D1.

## D-8. Optional cleanups (explicitly out of scope, flagged)

- `core/config.py::dedup_cosine_batch_size` becomes unused after `dedup/` is deleted; leaving it
  is harmless. `debug_log_ring_size` may still be referenced by `core/trace.py`. **Decision**:
  leave both (Principle III — don't touch untouched code without need); note as future cleanup.
- Vestigial match/dedup filter params in `list_jobs` (D-3): leave; future cleanup.
- `schemas/debug_log.py` is still imported by `routers/extension.py` (`DebugLogAppend`) — verify
  during implementation that no removed module was its only consumer before considering deletion;
  default **keep**.
