# JHA Standardization & Optimization Backlog

**Purpose**: A cross-feature backlog of **existing-code** standardization and optimization
items, produced by comparing the as-built specs (`specs/*/spec.md`) against the constitution
(`.specify/memory/constitution.md`) and the code. **No new features.** Nothing here is
implemented — this is a review artifact.

**Effort key**: **XS** <1h · **S** a few hours · **M** 1–2 days · **L** ≥1 week.
**Risk** = risk of *making the fix* (to behavior the smoke suite guards).

**Related**: the post-scrape Phases 1–2 backlog lives at
`specs/001-post-scrape-phases-1-2/standardization-backlog.md` (items B1–B20). Items there
marked cross-cutting (e.g. the duplicated canonical site-table list, B4) recur here as J7.

---

## Section 1 — Jobs ingest & job-listing routes

**Scope compared**: `backend/routers/jobs.py`, `backend/routers/job_reports.py` (and
`backend/main.py` router wiring) against spec `002-jobs-ingest-listing` and the constitution.
Sources: the two routers, `schemas/scraped_job.py`, `schemas/job_report.py`,
`docs/current-schemas.md` (CC-7, the `*_COLS` constants), README API section.

### What already conforms (no action — recorded for completeness)

- **CC-7** — each per-source INSERT uses `ON CONFLICT (job_url) DO NOTHING` with the CTE/
  `UNION ALL` pattern returning `(id, already_exists)`; re-scrape silently no-ops.
- **CC-10 / CC-11** — `build_*_params` store salary/nested values faithfully to source vocab and
  keep nested objects as JSONB; no normalization at ingest.
- **Append-only (CC-1)** — ingest only INSERTs into per-source tables (never UPDATE/DELETE).
- **Auth (Constitution VII)** — every route in both routers depends on `get_current_user`;
  none is exempt.
- **Async / fresh session** — all routes use `Depends(get_db)`; UUID PKs, snake_case columns.

> **Clarification on "the legacy dual-write to `scraped_jobs`"**: there is **no dual-write**.
> Each `POST /jobs/ingest` request writes **exactly one** table. The real issue is a **dual
> *store*** (per-source tables vs the legacy `scraped_jobs`), captured as **J1**.

### Backlog (severity-ordered)

| ID | Category | Severity | Source | Risk | Effort |
|----|----------|----------|--------|------|--------|
| J1 | Architecture (dual store) | HIGH | KL-1 | High | L |
| J2 | Test coverage | HIGH | US1 / FR-001…008 | Low | M |
| J3 | Test coverage | HIGH | FR-009 / SC-004 | Low | S |
| J4 | Doc-vs-code drift (`*_COLS`) | MEDIUM | DD-1 | None–Med | S |
| J5 | Error handling | MEDIUM | KL-6 / FR-006 | Low–Med | S |
| J6 | Duplicated logic | MEDIUM | FR-004/005 | Low | S |
| J7 | Duplicated logic (cross-feature) | MEDIUM | Constitution layout | Low | S |
| J8 | Structure | MEDIUM | Constitution III/layout | Low–Med | M |
| J9 | Structure / module layout | MEDIUM | Constitution layout | Low | M |
| J10 | Correctness / consistency | MEDIUM | KL-2/KL-4/KL-5 | Medium | M |
| J11 | Test coverage | MEDIUM | FR-012/013/016-019 | Low | S |
| J12 | Error handling | LOW | FR-011 | Low | S |
| J13 | Structure (route ordering) | LOW | — | Low | XS |
| J14 | Observability | LOW | — | Low | S |
| J15 | Observability | LOW | — | Low | M |
| J16 | Observability / config | LOW | Constitution error-handling | Low | XS |

---

### J1 — Dual job store; per-source rows orphaned from the read/report path (KL-1)
- **Category**: Architecture
- **Impact**: HIGH. `POST /jobs/ingest` writes per-source tables (`linkedin_jobs` etc.) when
  `source_raw` is present, but every read/update route (`GET /jobs`, `GET /jobs/{id}`,
  `GET /jobs/skipped`, `PUT /jobs/{id}`) and the entire matching/dedup/report ecosystem operate
  only on `scraped_jobs`. Per-source-ingested rows cannot be listed, matched, or reported
  through these routes — they are effectively write-only until a (not-yet-built) bridge moves
  them into `scraped_jobs` / `match_candidates`. Whichever path the extension actually uses
  determines whether jobs surface at all.
- **Risk**: High. Unifying the stores or bridging per-source → `scraped_jobs` is a genuine
  design change, not a surgical edit; it interacts with the post-scrape Phase 3 work
  (`match_candidates`, still unbuilt).
- **Effort**: L. Flag as a design decision for a future workstream, not a fix this round.

### J2 — No router-level test for ingest routing / dedup / malformed handling
- **Category**: Test coverage (missing)
- **Impact**: HIGH. The P1 ingest path (three-path precedence, per-source routing, CC-7
  `already_exists`, malformed→400) has no targeted smoke/contract test. `smoke_test_auto_scrape.py`
  hits some `/jobs` endpoints over HTTP but does not cover ingest routing per path.
- **Risk**: Low (adding tests). **Effort**: M.

### J3 — `*_COLS` ↔ `build_*_params` contract is untested (drift → runtime 500)
- **Category**: Test coverage (missing)
- **Impact**: HIGH-value, cheap. If a column is added to `LINKEDIN_COLS` but not to
  `build_linkedin_params` (or vice versa), the mismatch only fails at runtime as a 500 on the
  next ingest. A pure-Python assertion (`set(<SITE>_COLS) == set(build_<site>_params keys)`,
  and JSONB set == `<SITE>_JSONB_COLS`) would catch it in CI (SC-004).
- **Risk**: Low. **Effort**: S.

### J4 — `*_COLS` constants disagree with `current-schemas.md` (DD-1)
- **Category**: Doc-vs-code drift
- **Impact**: MEDIUM. `LINKEDIN_COLS` inserts 36 columns and `INDEED_COLS` 42, but the schema
  doc documents 51 / 61 columns and (line 44) calls the constants "the live source of truth"
  for current columns. The constants are the **INSERT subset**; ~a dozen documented columns per
  table (LinkedIn `job_state`, `expire_at`, `postal_address`, `benefits`, `title_entity_urn`,
  `top_level_company_apply_url`, …; Indeed `more_loc_url`, `create_date`, `expired`,
  `display_title`, `salary_text`, …) plus server-defaulted `id`/`scrape_time`/`matched` are
  never written at ingest.
- **Impact of the gap itself**: readers assume ingest populates the whole table; it does not —
  those columns are permanently NULL.
- **Risk**: None to fix the wording; Medium if reconciling means deciding whether the unwritten
  columns should be dropped (a schema/migration decision).
- **Effort**: S (reword doc to "insert columns"; separately, review the never-populated columns).

### J5 — Only `AttributeError`/`TypeError` map to 400; everything else is a 500 (KL-6)
- **Category**: Error handling
- **Impact**: MEDIUM. The per-source flatteners catch only those two exception types as 400.
  A `KeyError`, `ValueError`, or a DB `IntegrityError` (e.g. the Indeed
  `CHECK (mosaic_present OR graphql_present)` firing) surfaces as HTTP 500 for what is really a
  bad-payload condition.
- **Risk**: Low–Medium (broaden the caught set carefully; keep genuine server errors as 500).
- **Effort**: S.

### J6 — Duplicated per-source INSERT templates and route branches
- **Category**: Duplicated logic
- **Impact**: MEDIUM. `INSERT_LINKEDIN_JOB` / `INSERT_INDEED_JOB` / `INSERT_GLASSDOOR_JOB` are
  the identical CTE/`UNION ALL` template differing only by table/cols/JSONB; the three route
  branches (linkedin/indeed/glassdoor) are structurally identical (build → execute → log →
  return, same `except`). Any change to the CC-7 pattern or the malformed handler must be edited
  three times.
- **Risk**: Low — a statement-factory and a `{site: (builder, stmt)}` dispatch would collapse it.
- **Effort**: S.

### J7 — Canonical site→table list duplicated across modules (cross-feature)
- **Category**: Duplicated logic
- **Impact**: MEDIUM. The `linkedin/indeed/glassdoor` → table mapping appears independently in
  `jobs.py`, `auto_scrape/matching_claim.py`, and `auto_scrape/auto_expiration.py` (and the
  smoke tests). Same item as feature 001's **B4**. Adding a 4th source or renaming a table means
  editing many disconnected spots.
- **Risk**: Low — one shared constant. **Effort**: S.

### J8 — `ingest_job` is a ~270-line monolith with three inlined paths
- **Category**: Structure
- **Impact**: MEDIUM. Lines 628–899 inline the skip-reason, per-source, and legacy paths with
  deep nesting; the three paths cannot be unit-tested in isolation. Tension with Constitution
  Principle III (surgical, legible change).
- **Risk**: Low–Medium (extract per-path helpers, behavior-preserving; guard with J2).
- **Effort**: M.

### J9 — `jobs.py` mixes ingest-mapping, SQL, and routing in one 1190-line module
- **Category**: Structure / module layout
- **Impact**: MEDIUM. `build_*_params` flatteners (~280 lines), the INSERT constants, and the
  listing/detail/update/skipped routes all live in one file. The constitution's module-layout
  standard favors feature-oriented separation; a per-source ingest-mapper module would split
  mapping from routing.
- **Risk**: Low. **Effort**: M.

### J10 — Dedup semantics diverge between the two stores (KL-2/KL-4/KL-5)
- **Category**: Correctness / consistency
- **Impact**: MEDIUM. `content_duplicate` is always `false` on the per-source path (content-hash
  dedup exists only on the legacy path); `job_url` uniqueness is per-table only (no cross-table
  global uniqueness); the skip-reason path forces `job_url = NULL` (never dedups); empty/
  whitespace JD normalizes to the empty-string hash, so all empty-JD legacy jobs collide as
  content duplicates.
- **Risk**: Medium (changing dedup behavior touches guarded ingest semantics).
- **Effort**: M.

### J11 — Missing tests for listing filters, `has_report`, CC-7, and the report flow
- **Category**: Test coverage (missing)
- **Impact**: MEDIUM. No tests for `GET /jobs` `dedup_status` semantics (passed/removed/all),
  `has_report` pending-only, CC-7 re-ingest `already_exists`, or the report upsert/validation/
  dismiss flow (at-most-one-pending, wrong_gate 422, `_validate_detail` rules).
- **Risk**: Low. **Effort**: S.

### J12 — Salary fields bypass the coercion helpers
- **Category**: Error handling
- **Impact**: LOW–MEDIUM. LinkedIn `salary_min/max` (`first_breakdown.get("minSalary")`) and
  Indeed `salary_min/max` (`ext.get("min")`) are inserted raw into NUMERIC columns without
  `_to_int_or_none`/validation, unlike most other numeric fields. A string/garbage salary from
  source would raise and surface as a 500 (see J5).
- **Risk**: Low. **Effort**: S.

### J13 — Route ordering is correct but fragile
- **Category**: Structure
- **Impact**: LOW. `/jobs/reports*` (job_reports router) resolves correctly only because
  `main.py` includes `job_reports_router` **before** `jobs_router`; if that order were flipped,
  `GET /jobs/{job_id}` would capture `/jobs/reports` as `job_id="reports"` and 422. A latent
  trap with no guardrail.
- **Risk**: Low — add a comment/ordering test, or make the report routes a distinct prefix.
- **Effort**: XS.

### J14 — Vestigial ingest log lines
- **Category**: Observability
- **Impact**: LOW. The legacy path emits `ingest_embedding_done … took_ms=0 note="n/a"` and
  similar placeholder `ingest_dedup_done`/`ingest_db_done` lines left from a removed embedding
  step — misleading log noise implying a stage that no longer exists.
- **Risk**: Low. **Effort**: S.

### J15 — No ingest metrics/counters
- **Category**: Observability
- **Impact**: LOW–MEDIUM. Only per-request logs; no counters for ingest volume, path
  distribution (skip / per-source / legacy), `already_exists` rate, `content_duplicate` rate, or
  malformed-400 rate — so path health isn't dashboardable.
- **Risk**: Low. **Effort**: M.

### J16 — Log level set redundantly
- **Category**: Observability / config
- **Impact**: LOW. `logging.getLogger("routers.jobs").setLevel(INFO)` is set in **both**
  `jobs.py:29` (at import) and `main.py:34`. The module-level override also diverges from how
  other modules defer to app-level log config.
- **Risk**: Low. **Effort**: XS (drop the module-level `setLevel`; keep the central one).

---

### Suggested sequencing (if/when a hardening round is authorized)

1. **Cover before you change**: J3 (contract test — trivial, high value), J2, J11.
2. **Cheap, no-risk cleanups**: J4/J16 (docs/config), J13 (ordering guard), J14 (log noise),
   J6/J7 (DRY the per-source templates and site list).
3. **Then the correctness/error items**: J5, J12, J10.
4. **Structure**: J8, J9 (behind the J2/J3 test net).
5. **Design decision, not a surgical fix this round**: J1 (dual store) — needs a workstream and
   likely couples to the unbuilt post-scrape Phase 3 (`match_candidates`).
