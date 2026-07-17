# Step 3 — Filter & Matching pipeline design

> Design document for the post-scrape **filter** (Phase 4) and **matching** (Phase 5) pipelines, plus the supporting schemas and cycle finalization. Consolidates all decisions from the design discussion as of this writing.
>
> **Status:** draft for review. Open questions listed in §13 (notably `pending_applications` details P1–P5 and frontend UI1–UI6, which were posed but not yet answered).
>
> **Goal (verbatim from project owner):** better matching of user resumes to job descriptions while minimizing cost — money (LLM tokens) and time (latency) — without compromising matching accuracy.
>
> **Companions:** `step1-match-candidates.md` (base projection design), `current-workflow.md`, `current-schemas.md`, `jha-onboarding.md`.
> **Supersedes:** the earlier v1/v2 drafts of `step3-pipeline-design.md` (Phase 4 "dedup redesign" + Phase 5 "5-stage matching") — the phase structure and verdict model have been redesigned since.

---

## Table of contents

1. [Scope & phase map](#1-scope--phase-map)
2. [The verdict model](#2-the-verdict-model)
3. [Architecture & invariants](#3-architecture--invariants)
4. [Schemas](#4-schemas)
5. [Phase 4 — Filter (7 steps)](#5-phase-4--filter-7-steps)
6. [Phase 5 — Matching (2 steps)](#6-phase-5--matching-2-steps)
7. [Phase 6 — Cycle finalization](#7-phase-6--cycle-finalization)
8. [Cost-optimization principles](#8-cost-optimization-principles)
9. [Transactions & crash recovery](#9-transactions--crash-recovery)
10. [Telemetry & observability](#10-telemetry--observability)
11. [Smoke tests](#11-smoke-tests)
12. [Decision log](#12-decision-log)
13. [Open questions](#13-open-questions)

---

## 1. Scope & phase map

### Post-scrape orchestrator phases

| Phase | Name | Status | Notes |
|---|---|---|---|
| 1 | Auto-expiration | ✅ LIVE | Extended by this design (sweeps `filtered_jobs`, `pending_applications`, orphaned `match_candidates`) |
| 2 | Matched-claim | ✅ LIVE | Unchanged |
| 3 | Build `match_candidates` | designed earlier | Purge-and-rebuild per cycle; per-platform projection; unchanged by this doc |
| **4** | **Filter** | **THIS DOC** | 7 steps: blacklist → field gates → dedup → CPU extraction → CPU gates → LLM extraction → LLM gates |
| **5** | **Matching** | **THIS DOC** | 2 steps: CPU skills-gap score → LLM matching |
| 6 | Cycle finalization | THIS DOC (updated) | Writes `pending_applications`, blacklist re-entry, teardown, JSONB aggregate |
| 7 | Auto-apply | 📅 LATER | Future workstream |

### What this workstream delivers

- `match_candidates` gains **CPU- and LLM-extraction columns** (they persist extraction output between steps; the table itself is still purged at cycle end)
- New persistent table **`filtered_jobs`** — audit trail of every gate failure and scored rejection
- New persistent table **`pending_applications`** — the matched jobs shown on the frontend (schema drafted; final details pending P1–P5)
- Blacklist **re-entry mechanism**: `matched=FALSE` reset on blacklisted per-source rows
- Two new pipeline modules: `auto_scrape/filter_pipeline.py`, `auto_scrape/matching_pipeline.py`
- Migrations 030 (`match_candidates` incl. extraction columns), 031 (`filtered_jobs`), 032 (`pending_applications`, once P1–P5 close)
- A LinkedIn-style two-pane frontend page for pending applications (design pending UI1–UI6)

### What does not change

- Algorithms imported, not reimplemented: `cpu_extract_jd` (adapted — education fields dropped), `run_hard_gates` (adapted — per-step gate subsets), `record_skill_candidates`, `normalise_list`, hash/cosine dedup logic from `dedup/service.py`
- Legacy `/jobs/match`, `/jobs/dedup` endpoints and the `scraped_jobs` path — untouched, parallel
- Sync-dedup hook in `routers/extension.py` — untouched
- Per-source ingest contract and migrations 025–029

### Explicitly deprecated / removed (vs the legacy pipeline)

| Legacy element | Fate | Reason |
|---|---|---|
| Pass-1 JD-text gates (`title_mismatch`, `contract_mismatch`, `remote_mismatch`, `sponsorship`, `agency_jd`) | **Deprecated** | Judged unreliable. Their concerns are covered by field gates (contract/remote), CPU/LLM keyword gates (sponsorship), or dropped (below). |
| Agency detection (company-name and JD-text) | **Removed entirely** (temporarily) | Unreliable; may return in a future redesign |
| CPU education extraction (`education_req_degree`, `education_req_field`, `education_field_qualified`) | **Removed from CPU extraction** | Unreliable in practice; education is LLM-only (Step 6 extract, Step 7 gate) — plus a field-based check in Step 2 when the source provides `education_requirements` |
| LLM skill extraction | **Removed** | LLM over-extracts; skills are CPU-only (alias-vocabulary scan) |
| Four-level `match_level` (`strong/possible/stretch/weak`) | **Replaced** by binary verdict | See §2 |
| `_resolve_chains` / chain resolution | **Not used** by new pipeline | Flagged rows are deleted immediately; chains cannot form |

---

## 2. The verdict model

Every job a cycle processes ends in exactly one of four terminal states:

| Terminal state | Where it goes | Frontend visibility |
|---|---|---|
| **`matched`** | `pending_applications` | ✅ Shown, sorted by `required_coverage` desc, tie-break `preferred_coverage` desc |
| **`not_matched`** | `filtered_jobs` (with `filter_type` + `filter_reason`) | ❌ Not shown; audit table only |
| **Duplicate** (dedup) | Silently dropped — counted in `cycle.match_results` JSONB only | ❌ |
| **Blacklisted** | Silently dropped this cycle — counted in JSONB; per-source row gets `matched=FALSE` re-entry at Phase 6 | ❌ (re-evaluated next cycle) |

### Paths to `matched` (exactly two)

1. `required_coverage == 1.00` — every required skill in the JD matches the profile. Auto-matched; never sent to LLM. (Accepted trade-off: perfect-coverage jobs get no LLM narrative. `llm_reason` is null for them.)
2. LLM matching (Phase 5 Step 2) judges the job interview-worthy.

### Paths to `not_matched`

| Path | `filter_type` | `filter_reason` examples |
|---|---|---|
| Filter gates 1 (field gates) | `field_gate` | `language`, `experience_level`, `education`, `industry`, `title`, `job_function` |
| CPU extraction found empty/error JD | `cpu_gate` | `jd_incomplete`, `extraction_failed` |
| Filter gates 2 (CPU keyword gates) | `cpu_gate` | `yoe_gate`, `salary_gate`, `visa_gate` |
| LLM extraction failed | `llm_gate` | `extraction_failed` |
| Filter gates 3 (LLM keyword gates) | `llm_gate` | `yoe_gate`, `salary_gate`, `visa_gate`, `education_gate` |
| CPU skills-gap score below threshold | `coverage` | `low_required_coverage` (`required_coverage < 0.50`) |
| LLM matching says no | `llm_reject` | LLM's stated rejection reason category |

### The LLM band

Only jobs with `0.50 ≤ required_coverage < 1.00` reach LLM matching:

- `== 1.00` → auto-`matched` (skip LLM: definitively a fit)
- `< 0.50` → auto-`not_matched` (skip LLM: HR would not interview a candidate missing half the required skills)
- `0.50–0.99` → the ambiguous middle; LLM decides

The `0.50` low threshold maps onto the existing `cfg.cpu_binary_threshold` (default 0.50); no new config field.

### CPU-only mode (`cfg.llm=False`)

Degraded by design ("scores only" mode):

- Step 6/7 (LLM extraction/gates) skipped → visa/education filtering is only as good as CPU substring matching
- Phase 5 Step 2 skipped → no LLM narrative for anything
- `matched` = only `required_coverage == 1.00` jobs (**pending P3**: whether to relax this to `>= cpu_strong_threshold`, since strict 1.00 makes the pending list very sparse in CPU-only mode)
- Everything in `0.50–0.99` has no LLM to promote it → `not_matched` (`filter_reason='cpu_only_unresolved'`), unless P3 changes this

---

## 3. Architecture & invariants

### Data flow

```
Per-source tables ──Phase 2 claim──▶ claim_results
                                          │
                                          ▼
                          Phase 3: build match_candidates
                          (purge WHERE cycle_id first — re-entry safe)
                                          │
                                          ▼
        ┌─────────────────────────────────────────────────────────┐
        │ Phase 4 — FILTER                                        │
        │                                                         │
        │ Step 1  Blacklist (user-preference fields)              │
        │           → silent drop + in-memory blacklist_list      │
        │ Step 2  Filter gates 1 (profile-fact fields)            │
        │           → filtered_jobs('field_gate') + DELETE        │
        │ Step 3  Dedup (hash_exact + cosine TF-IDF)              │
        │           → silent drop (JSONB count only) + DELETE     │
        │ Step 4  CPU keyword extraction                          │
        │           → write extraction columns on match_candidates│
        │           → record_skill_candidates (all rows)          │
        │           → jd_incomplete/extraction_failed filtered    │
        │ Step 5  Filter gates 2 (CPU keyword gates)              │
        │           → filtered_jobs('cpu_gate') + DELETE          │
        │ Step 6  LLM keyword extraction    [llm mode only]       │
        │           → write llm_* columns on match_candidates     │
        │ Step 7  Filter gates 3 (LLM keyword gates) [llm only]   │
        │           → filtered_jobs('llm_gate') + DELETE          │
        └───────────────────────────┬─────────────────────────────┘
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │ Phase 5 — MATCHING                                      │
        │                                                         │
        │ Step 1  CPU skills gap score                            │
        │           required_coverage / missing_required /        │
        │           preferred_coverage / matched_preferred        │
        │           == 1.00 → matched (auto)                      │
        │           <  0.50 → filtered_jobs('coverage') + DELETE  │
        │           0.50–0.99 → LLM band                          │
        │ Step 2  LLM matching              [llm mode only]       │
        │           binary verdict per job:                       │
        │           yes → matched                                 │
        │           no  → filtered_jobs('llm_reject') + DELETE    │
        └───────────────────────────┬─────────────────────────────┘
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │ Phase 6 — FINALIZATION                                  │
        │ Step A  Aggregate cycle.match_results JSONB             │
        │ Step B  Write matched jobs → pending_applications       │
        │         (merged snapshot: per-source ⨝ match_candidates │
        │          ⨝ scoring results)                             │
        │ Step C  Blacklist re-entry: matched=FALSE on per-source │
        │ Step D  Teardown: DELETE match_candidates WHERE cycle_id│
        └─────────────────────────────────────────────────────────┘
```

### Invariants

| # | Invariant |
|---|---|
| **I1** | `match_candidates` is **mutable single-cycle scratch**. Phase 3 inserts; Phase 4/5 write extraction columns and delete flagged rows; Phase 6 purges the cycle's rows. Not historical. |
| **I2** | Extraction output (CPU Step 4, LLM Step 6) is **persisted on `match_candidates` columns**, not in memory — Phase 5 and the Phase 6 `pending_applications` write read them from the table. |
| **I3** | **Blacklist = user-editable-preference-driven** filtering (company, location, remote, workplace, employment type, salary). Blacklisted rows re-enter: `matched=FALSE` reset at Phase 6, re-claimed and re-evaluated next cycle against possibly-edited rules — until the per-source row expires. |
| **I4** | **Filter gates = fixed-profile-fact-driven** filtering (language, experience level, education, industry, title, YOE, visa). No re-entry — the profile rarely changes, so re-evaluation is pointless. Failures go to `filtered_jobs`. |
| **I5** | **Dedup corpus** = per-source rows whose `(source, source_id)` is **not** in the current cycle's `match_candidates` (i.e., prior cycles' jobs — regardless of `matched` value) **∪** `pending_applications`. Duplicates are silently dropped: JSONB count only, no `filtered_jobs` row. |
| **I6** | **Skills are CPU-extracted only** (alias-vocabulary scan). The LLM never extracts or augments skill lists. Known trade-off: `required_coverage` is blind to skills absent from `skill_aliases.json` and to paraphrase; the vocabulary is kept current via `record_skill_candidates` + the Skills review page. |
| **I7** | **Salary is gated three times**: Step 1 (field, employer-disclosed only), Step 5 (CPU-extracted from JD), Step 7 (LLM-extracted). Steps 1 and 5 exist to kill doomed rows before they cost LLM tokens; Step 7 is the accurate final word. Do not "optimize away" the earlier checks — they are cost gates, not accuracy gates. |
| **I8** | **Verdict is binary**: `matched` → `pending_applications`; `not_matched` → `filtered_jobs`. No four-level output. `not_matched` jobs are not displayed on the frontend. |
| **I9** | **`filtered_jobs` lifetime is bound to per-source lifetime** — Phase 1 deletes `filtered_jobs` rows whose `(source, source_id)` no longer exists in any per-source table. Applies uniformly to all `filter_type` values (pending OQ19 confirmation). |
| **I10** | **`pending_applications` is a self-contained snapshot** with a 30-day shelf life, swept by Phase 1. It must not depend on per-source joins at read time, because per-source expires at `shelf_life_days` (default 7) — 23 days before the pending row does. (Pending P1 confirmation, but forced by the lifetime mismatch.) |
| **I11** | **Cycles never run concurrently** (also protects scrape-side anti-bot detection). Single-cycle scratch needs no isolation. |
| **I12** | **Re-entry is purge-and-rebuild**: Phase 3's first action is `DELETE FROM match_candidates WHERE cycle_id = :cid`. LLM extraction re-runs on re-entry — accepted cost (jobs turn over fast; re-entry is rare). |
| **I13** | **Failed-cycle cleanup** resets `matched=FALSE` on per-source rows the cycle claimed (derived from `cycle.run_log_ids` → `scan_run_id`), and purges its `match_candidates` rows. Lives in `core/auto_scrape_lifecycle.py`. |
| **I14** | **One DB transaction per step**; LLM calls always happen **outside** transactions. No transaction spans an LLM call. |
| **I15** | **No new `SearchConfigRead` fields.** Thresholds map onto existing knobs: `cpu_binary_threshold` (0.50 LLM-band floor), `cpu_strong_threshold` (P3 candidate for CPU-only matched threshold), `dedup_fuzzy_threshold`, `salary_min`, `needs_sponsorship`, `allowed_languages`, blacklist arrays, `remote_only`, `no_contract`. |
| **I16** | **No legacy retirement in this workstream.** `scraped_jobs`, the 4-button pipeline, and the legacy frontend stay untouched and parallel. |

---

## 4. Schemas

### 4.1 `match_candidates` — migration 030

Base projection columns per `step1-match-candidates.md`, plus lineage, plus **extraction columns** (I2: extraction persists on the table). One migration; the extraction columns ship now because Phase 4 Steps 4/6 write them.

```sql
-- migration 030
CREATE TABLE match_candidates (
  -- IDENTITY ----------------------------------------------------------
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   TEXT NOT NULL CHECK (source IN ('linkedin','indeed','glassdoor')),
  source_id                TEXT NOT NULL,

  -- LINEAGE -----------------------------------------------------------
  cycle_id                 UUID NOT NULL REFERENCES auto_scrape_cycles(id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- TITLE / COMPANY / LOCATION / EMPLOYMENT / SKILLS / COMP / JD -------
  -- (25 projection columns exactly as designed in step1-match-candidates.md:
  --  title, title_canonical, company_canonical_name, company_industry,
  --  location_city, location_state, location_country, is_remote,
  --  workplace_type, employment_type, experience_level, job_functions,
  --  job_taxonomy, job_taxonomy_label, language, skills,
  --  education_requirements, salary_min, salary_max, salary_currency,
  --  salary_period, salary_disclosed, description_html, ...)

  -- CPU EXTRACTION (Phase 4 Step 4 writes) -----------------------------
  cpu_extracted_yoe        REAL,
  cpu_salary_min           NUMERIC(12,2),
  cpu_salary_max           NUMERIC(12,2),
  cpu_required_skills      JSONB,          -- list[str], canonical names
  cpu_nice_to_have_skills  JSONB,          -- list[str]
  cpu_visa_req             TEXT,           -- 'true' | 'false' | 'unknown'
  jd_incomplete            BOOLEAN,

  -- LLM EXTRACTION (Phase 4 Step 6 writes; NULL in cpu-only mode) ------
  llm_yoe                  REAL,
  llm_salary_min           NUMERIC(12,2),
  llm_visa_req             TEXT,
  llm_education_requirement TEXT,          -- free-form normalized requirement
  standardized_jd          TEXT,           -- compressed normalized JD (~150 words target;
                                           -- prompt design deferred to prompt-engineering stage)

  CONSTRAINT match_candidates_source_id_unique UNIQUE (source, source_id)
);

CREATE INDEX idx_mc_cycle_id  ON match_candidates(cycle_id);
CREATE INDEX idx_mc_source_id ON match_candidates(source, source_id);
```

Notes:

- **No CPU education columns.** `education_req_degree` / `education_req_field` / `education_field_qualified` are removed — unreliable in practice. Education is checked (a) field-based in Step 2 when the source provides `education_requirements`, and (b) LLM-based in Steps 6–7.
- **No LLM skill columns.** Skills are CPU-only (I6).
- Scoring outputs (`required_coverage` etc.) are **not** on this table — they're computed in Phase 5 and written into `pending_applications` (matched) or carried as `filter_reason` context (not_matched).
- Still purged at cycle end (I1). The extraction columns exist to pass state between steps and into the Phase 6 merge — not for history.

### 4.2 `filtered_jobs` — migration 031

```sql
-- migration 031
CREATE TABLE filtered_jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   TEXT NOT NULL CHECK (source IN ('linkedin','indeed','glassdoor')),
  source_id                TEXT NOT NULL,
  cycle_id                 UUID NOT NULL REFERENCES auto_scrape_cycles(id) ON DELETE RESTRICT,
  filter_type              TEXT NOT NULL CHECK (filter_type IN
                             ('field_gate','cpu_gate','llm_gate','coverage','llm_reject')),
  filter_reason            TEXT NOT NULL,
  detail                   JSONB,           -- optional context: e.g. required_coverage value,
                                            -- missing_required list, LLM rejection text
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fj_source_id          ON filtered_jobs(source, source_id);
CREATE INDEX idx_fj_cycle_id           ON filtered_jobs(cycle_id);
CREATE INDEX idx_fj_type_reason        ON filtered_jobs(filter_type, filter_reason);
```

- **Five `filter_type` values** — see §2 table for the reason vocabulary per type.
- **No `dedup` type** — duplicates are silently dropped (JSONB count only).
- **No `blacklist` type** — blacklisted rows re-enter (I3); they never write here.
- `(source, source_id)` is **not unique** — the same job can be filtered in multiple cycles (e.g., after a failed-cycle reset re-claims it).
- Accumulates across cycles; pruned by Phase 1 when the underlying per-source row expires (I9).
- No `similarity_score` / `original_*` columns (they existed in the earlier draft for dedup rows; dedup no longer writes here).

### 4.3 `pending_applications` — migration 032 (draft; pending P1–P5)

**Role (decided):** persistent, holds **matched jobs only**, 30-day shelf life, self-contained snapshot merging the per-source row + `match_candidates` extraction + Phase 5 scoring (I10). `UNIQUE(source, source_id)` with upsert.

**Draft schema (recommended, pending P1–P5 confirmation):**

```sql
-- migration 032 (DRAFT — do not implement until P1–P5 are answered)
CREATE TABLE pending_applications (
  -- IDENTITY & LINEAGE -------------------------------------------------
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   TEXT NOT NULL CHECK (source IN ('linkedin','indeed','glassdoor')),
  source_id                TEXT NOT NULL,
  cycle_id                 UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,     -- created_at + 30 days

  -- CARD-LIST DISPLAY (left column) ------------------------------------
  title                    TEXT NOT NULL,
  company_name             TEXT,
  location_display         TEXT,            -- pre-formatted "Vancouver, BC · Remote"
  salary_display           TEXT,            -- pre-formatted "$90k–120k/yr" or NULL
  posted_at                TIMESTAMPTZ,     -- original posting date from per-source
  is_remote                BOOLEAN,

  -- SCORING (sort keys + badges) ---------------------------------------
  required_coverage        REAL NOT NULL,   -- primary sort desc
  preferred_coverage       REAL,            -- tie-break sort desc
  match_source             TEXT NOT NULL CHECK (match_source IN ('cpu_perfect','llm')),

  -- DETAIL PANE (right side) -------------------------------------------
  description_html         TEXT NOT NULL,   -- snapshot; survives per-source expiry
  apply_url                TEXT,
  job_url                  TEXT,
  employment_type          TEXT,
  experience_level         TEXT,
  jd_skills                JSONB,           -- cpu_required + cpu_nice_to_have from extraction
  matched_required         JSONB,           -- skills user has
  missing_required         JSONB,           -- gap chips
  matched_preferred        JSONB,
  llm_reason               TEXT,            -- hiring-manager narrative; NULL for cpu_perfect
  company_industry         TEXT,

  CONSTRAINT pending_applications_source_id_unique UNIQUE (source, source_id)
);

CREATE INDEX idx_pa_sort       ON pending_applications(required_coverage DESC, preferred_coverage DESC);
CREATE INDEX idx_pa_expires_at ON pending_applications(expires_at);
```

**Write semantics (recommended, pending P4):** `INSERT … ON CONFLICT (source, source_id) DO UPDATE SET <all fields>, expires_at = NOW() + interval '30 days'`. If a previously-matched job is re-evaluated (via blacklist re-entry or failed-cycle reset) and comes out `not_matched`, the stale `pending_applications` row is **deleted**.

**Open items** (§13): P1 merge strategy formally confirmed (Option A is forced by lifetime mismatch but awaits sign-off), P2 exact column set (incl. whether a `status`/dismiss column ships now or with Phase 7), P3 CPU-only matched threshold, P4 upsert/delete semantics, P5 expiry sweep ownership.

### 4.4 Migration order

| Migration | Content | Blocked by |
|---|---|---|
| 030 | `match_candidates` incl. extraction columns | — |
| 031 | `filtered_jobs` | 030 |
| 032 | `pending_applications` | P1–P5 answered |

---

## 5. Phase 4 — Filter (7 steps)

Module: `backend/auto_scrape/filter_pipeline.py`. Entry point:

```python
async def run_filter_pipeline(
    cycle_id: UUID,
    mc_ids: list[UUID],
    cfg: SearchConfigRead,
    settings: Settings,
    llm_enabled: bool,
    has_openai_key: bool,
) -> tuple[UUID, list[BlacklistEntry]]:
    """
    Returns (dedup_task_id, blacklist_list).
    blacklist_list: [(mc_id, source, source_id, reason)] — held by the
    orchestrator until Phase 6 Step C (matched=FALSE re-entry).
    Each step = one DB transaction (I14). LLM calls in Step 6 run outside
    any transaction.
    """
```

Each filtering step follows the same write pattern:

```python
# per step, one transaction:
#   1. INSERT INTO filtered_jobs (...) for flagged rows   (skipped for Step 1 & 3)
#   2. DELETE FROM match_candidates WHERE id = ANY(:flagged_ids)
```

### Step 1 — Blacklist

**Definition (I3):** filtering driven by **user-editable preferences**. Editing a preference should give previously-excluded jobs another chance — hence re-entry instead of `filtered_jobs`.

**Fields checked** (all on `match_candidates`):

| Field | Config knob | Check |
|---|---|---|
| `company_canonical_name` | `blacklist_companies` | case-insensitive substring |
| `location_city` / `location_state` / `location_country` | `blacklist_locations` | substring against joined location string |
| `is_remote`, `workplace_type` | `remote_only` | if remote_only and not remote → flag |
| `employment_type` | `no_contract` | if no_contract and type is CONTRACT/TEMPORARY → flag |
| `salary_min`, `salary_max`, `salary_currency`, `salary_period` | `salary_min` | **only when `salary_disclosed = TRUE`** — employer-posted salaries only; site estimates ignored. Annualize per `salary_period` before comparing. |

**Output:** in-memory `blacklist_list` of `(mc_id, source, source_id, reason)`; rows deleted from `match_candidates`; **no `filtered_jobs` write**; counts land in `cycle.match_results.blacklisted`. Per-source `matched=FALSE` reset happens at Phase 6 Step C (not here — a crash between Step 1 and Phase 6 is covered by the failed-cycle reset, I13).

### Step 2 — Filter gates 1 (`match_candidates` field gates)

**Definition (I4):** filtering driven by **fixed profile facts** — things about the user that rarely change. No re-entry.

**Fields checked:**

| Field | Gate | Notes |
|---|---|---|
| `title_canonical` | title relevance | against `cfg.target_titles` when set (whitelist) |
| `company_industry` | industry exclusion | profile-driven; exact rule set TBD at implementation |
| `experience_level` | seniority mismatch | e.g., exclude EXECUTIVE/DIRECTOR tiers for an early-career profile |
| `language` | language | field check when present; **when NULL (LinkedIn never sets it), run `langdetect` on `description_html` as fallback** — cheap CPU, keeps the gate in one place |
| `education_requirements` | education (field-based) | only when the source provides it (e.g., Glassdoor `education_labels`); LLM re-checks at Step 7 |
| `job_functions`, `job_taxonomy`, `job_taxonomy_label` | function/taxonomy relevance | exact rule set TBD at implementation |

**Output:** `filtered_jobs(filter_type='field_gate', filter_reason=<gate>)` + DELETE.

### Step 3 — Dedup (hash_exact + cosine TF-IDF)

**Corpus (I5):**

```sql
WITH per_source_jds AS (
    SELECT 'linkedin' AS source, job_posting_id AS source_id, description_text AS jd
      FROM linkedin_jobs WHERE description_text IS NOT NULL
    UNION ALL
    SELECT 'indeed', jobkey, description_text
      FROM indeed_jobs WHERE description_text IS NOT NULL
    UNION ALL
    SELECT 'glassdoor', listing_id, description
      FROM glassdoor_jobs WHERE description IS NOT NULL
)
SELECT ps.* FROM per_source_jds ps
WHERE NOT EXISTS (
    SELECT 1 FROM match_candidates mc
    WHERE mc.source = ps.source AND mc.source_id = ps.source_id
      AND mc.cycle_id = :this_cycle
)
-- plus pending_applications (self-contained: has its own description_html)
UNION ALL
SELECT source, source_id, description_html FROM pending_applications
WHERE expires_at > NOW();
```

- The current cycle's own `match_candidates` rows are excluded (a row must not compare against itself). The `matched` column plays no role in corpus membership.
- JD is unique per job (owner-confirmed): no case where one job has two different JDs.

**Pass 2A — hash_exact:** SHA-256 of stripped JD, computed on the fly (no stored hash column). Batch rows matching a corpus hash → duplicate. Within-batch collisions: first row (earliest `created_at`, then UUID lex order) wins; later ones are duplicates.

**Pass 2B — cosine TF-IDF:** algorithm imported from `dedup/service.py:_run_cosine`. Threshold `cfg.dedup_fuzzy_threshold / 100.0`. Short-circuits: threshold == 0, corpus < 10 rows, or empty batch. Batch size `settings.dedup_cosine_batch_size`.

**Output:** duplicates are **silently dropped** — `DELETE FROM match_candidates`, counted in `cycle.match_results.deduped`, **no `filtered_jobs` row** (OQ14). A `DedupTask` row (status running → completed) is created for `cycle.dedup_task_id`; a `DedupReport` row records pass metrics (`trigger='auto_scrape_cycle:{cycle_id}'`).

**Ordering rationale:** dedup runs *before* extraction so no extraction effort (CPU or LLM) is spent on duplicates.

### Step 4 — CPU keyword extraction

Runs `cpu_extract_jd` (adapted: education outputs removed) on every surviving row; **writes results to the `cpu_*` columns on `match_candidates`** (I2).

**Extracted fields:** `cpu_extracted_yoe`, `cpu_salary_min`, `cpu_salary_max`, `cpu_required_skills`, `cpu_nice_to_have_skills`, `cpu_visa_req`, `jd_incomplete`.

**Side effects & filters within this step:**

- `record_skill_candidates(db, required, nth)` is called for **every** extracted row — including rows later filtered at Step 5/7. Vocabulary growth is independent of match outcome (OQ12).
- `jd_incomplete = TRUE` rows → `filtered_jobs('cpu_gate', 'jd_incomplete')` + DELETE. These are mostly scrape error pages, not real JDs (F11).
- Per-row extraction exception → `filtered_jobs('cpu_gate', 'extraction_failed')` + DELETE. Never aborts the cycle.

**Runs in both modes** (OQ1 = A): even when LLM mode is on and Step 6 will re-extract, Step 4+5 pre-filter doomed rows so they never cost an LLM call. CPU compute is free; tokens are not.

### Step 5 — Filter gates 2 (CPU keyword gates)

Gates on the CPU-extracted values. **Three gates: YOE + salary + visa.** (No education — LLM-only. No agency — removed.)

| Gate | Reads | Rule |
|---|---|---|
| YOE | `cpu_extracted_yoe` vs `profile._extracted.yoe` | fail if `required − profile > 1.0` (legacy tolerance) |
| Salary | `cpu_salary_min` vs `cfg.salary_min` | fail if extracted max/min below config floor — second of the three salary checks (I7) |
| Visa | `cpu_visa_req` vs `cfg.needs_sponsorship` | fail if sponsorship needed and `visa_req == 'false'` |

**Output:** `filtered_jobs('cpu_gate', <gate>)` + DELETE.

### Step 6 — LLM keyword extraction  `[llm mode only]`

Skipped when `not (cfg.llm AND has_openai_key)`.

**Extracted fields → `llm_*` columns on `match_candidates`:**

| Field | Why LLM |
|---|---|
| `llm_yoe` | disambiguates multi-number YOE statements ("5 years software, 2 in ML") |
| `llm_salary_min` | catches phrasing CPU regex misses — third salary source (I7) |
| `llm_visa_req` | understands implicit signals ("must be eligible to work in Canada") |
| `llm_education_requirement` | "degree or equivalent experience" needs judgment |
| `standardized_jd` | compressed normalized JD (~150 words) consumed by Phase 5 Step 2; **prompt design deferred to the prompt-engineering stage** |

**Not extracted:** skills (I6), role_summary/responsibilities/implicit_skills (folded into `standardized_jd`).

**Mechanics:**

- One LLM call per job (OQ2 = A; batching noted as a future optimization — see §8)
- `asyncio.Semaphore(STEP_B_CONCURRENCY)` (= 8), model `gpt-4o-mini` (`MATCHING_MODEL`)
- **Prompt ordering rule:** static content (instructions) FIRST, per-job JD LAST — maximizes OpenAI automatic prefix caching (§8)
- All calls outside DB transactions (I14); results written in one short transaction after the gather
- Per-row failure → `filtered_jobs('llm_gate', 'extraction_failed')` + DELETE

### Step 7 — Filter gates 3 (LLM keyword gates)  `[llm mode only]`

Re-runs **all four** gates with LLM-extracted values (F6 = a — a row that passed a CPU gate can fail the LLM gate if LLM extracted a stricter value):

| Gate | Reads |
|---|---|
| YOE | `llm_yoe` vs profile |
| Salary | `llm_salary_min` vs `cfg.salary_min` — third salary check (I7) |
| Education | `llm_education_requirement` vs profile education |
| Visa | `llm_visa_req` vs `cfg.needs_sponsorship` |

**Output:** `filtered_jobs('llm_gate', <gate>)` + DELETE.

Survivors of Step 7 (or Step 5 in CPU-only mode) are Phase 5's input.


---

## 6. Phase 5 — Matching (2 steps)

Module: `backend/auto_scrape/matching_pipeline.py`. Entry point:

```python
async def run_matching_pipeline(
    cycle_id: UUID,
    cfg: SearchConfigRead,
    settings: Settings,
    llm_enabled: bool,
    has_openai_key: bool,
) -> list[MatchedJob]:
    """
    Input: all match_candidates WHERE cycle_id = :cid (Phase 4 survivors —
    extraction columns already populated).
    Returns the matched list (in-memory) for the Phase 6 pending_applications
    write. not_matched rows have already been written to filtered_jobs and
    deleted from match_candidates by the time this returns.
    """
```

### Step 1 — CPU skills gap score

**The scoring model (F7 final):**

| Output | Definition | Role |
|---|---|---|
| `required_coverage` | `|matched_required| / |required|`, from `cpu_required_skills` ∩ profile skills (both normalised via `normalise_list`) | **Primary score.** Sort key, band router. |
| `missing_required` | required skills not in profile | The gap — display chips + LLM matching input |
| `preferred_coverage` | `|matched_nth| / |nth|` | **Tie-break sort key only.** Does not affect banding. |
| `matched_preferred` | nth skills the user has | Display only |

No combined `fit_score`. The rationale: required and nice-to-have are asymmetric — a recruiter asks "do they have the must-haves?" first; nice-to-haves are flavor. One honest number (`required_coverage`) plus the gap list beats a blended score that hides where the gap is.

**Edge case — no required skills extracted** (`cpu_required_skills` empty, `jd_incomplete=false`): coverage is undefined. Rule: treat as `required_coverage = NULL` → route to the LLM band in LLM mode (the LLM can judge from `standardized_jd`); in CPU-only mode → `not_matched` (`filter_reason='no_required_skills'`). This mirrors the legacy `cpu_prescore` insufficient-data path.

**Banding (the routing decision):**

```python
low = cfg.cpu_binary_threshold          # default 0.50

if required_coverage == 1.00:
    verdict = MATCHED  (match_source='cpu_perfect', llm_reason=None)
elif required_coverage is None:
    llm mode → LLM band;  cpu-only → NOT_MATCHED('coverage', 'no_required_skills')
elif required_coverage < low:
    verdict = NOT_MATCHED  → filtered_jobs('coverage', 'low_required_coverage',
                                            detail={'required_coverage': x,
                                                    'missing_required': [...]})
else:  # low ≤ coverage < 1.00 — the ambiguous middle
    llm mode → LLM band (Step 2 decides)
    cpu-only → NOT_MATCHED('coverage', 'cpu_only_unresolved')   # pending P3
```

- `== 1.00` never reaches the LLM (owner decision, Inaccuracy-4: "Accept it"). Perfect-coverage jobs carry `match_source='cpu_perfect'` and a null `llm_reason`. Accepted trade-off: the best matches get the least analysis.
- `< 0.50`: HR would not interview a candidate missing half the must-haves — auto-reject without spending tokens.
- CPU-only middle band: currently `not_matched` (nothing can promote it). **P3 open:** relax CPU-only `matched` to `>= cpu_strong_threshold` (0.85) so the pending list isn't nearly empty in CPU-only mode.

**Known accuracy trade (I6, on the record):** `required_coverage` is computed from CPU substring extraction against `skill_aliases.json`. It cannot see paraphrased or unknown skills, so the denominator can be too small and coverage can over-state. Owner accepted this for zero token cost + determinism; mitigation is vocabulary growth via `record_skill_candidates` + weekly alias review.

### Step 2 — LLM matching  `[llm mode only]`

**Input per job:** `standardized_jd` (never the raw `description_html` — that's the point of standardizing), `cpu_required_skills`, `missing_required`, `required_coverage`, plus the profile context (skills, YOE, recent titles) loaded once per cycle.

**Output per job — binary:**

```json
{
  "verdict": "matched" | "not_matched",
  "reason":  "2-3 sentences. If matched: why interview-worthy, main strengths.
              If not_matched: the decisive gap."
}
```

The legacy 4-level prompt (`build_llm_score_prompt`) is replaced with a binary interview-decision prompt: *"Would you advance this candidate to a phone screen for this role? Answer matched/not_matched with a reason."* The gap-adjacency reasoning steps from the legacy prompt are kept as chain-of-thought scaffolding; only the answer schema changes. Full prompt text is deferred to the prompt-engineering stage alongside `standardized_jd`.

**Routing of results:**

- `matched` → in-memory matched list (`match_source='llm'`, `llm_reason=<reason>`) → Phase 6 writes to `pending_applications`
- `not_matched` → `filtered_jobs('llm_reject', 'llm_not_interview_worthy', detail={'reason': ..., 'required_coverage': ...})` + DELETE

**Mechanics:** one call per job, `Semaphore(8)`, `gpt-4o-mini` (`LLM_SCORE_MODEL`), `response_format=json_object`, profile-first prompt ordering (§8), calls outside transactions (I14).

**LLM-call failure handling (open — see §13 Q-LLMFAIL):** the middle band exists precisely because CPU could not decide, so "fall back to CPU verdict" has no defined meaning here. Recommended default pending decision: apply `required_coverage >= cfg.cpu_strong_threshold → matched, else not_matched('llm_reject','llm_call_failed')` — a one-line deterministic tiebreak that errs toward keeping near-misses.

### Phase 5 outputs

| Set | Destination |
|---|---|
| `matched` (cpu_perfect ∪ llm-yes) | returned in-memory → Phase 6 Step B → `pending_applications` |
| `not_matched` (< 0.50, cpu_only_unresolved, llm-no) | already in `filtered_jobs`; rows deleted from `match_candidates` |

After Phase 5, `match_candidates` contains exactly the matched rows (everything else was deleted). Phase 6 Step B reads them (joined to per-source for snapshot fields), then Step D purges.

---

## 7. Phase 6 — Cycle finalization

Four steps, in order:

### Step A — Aggregate `cycle.match_results` JSONB

Runs first, before any teardown. Shape:

```json
{
  "claim_summary":      {"linkedin": 952, "indeed": 197, "glassdoor": 157},
  "candidates_built":   1306,
  "duration_ms":        87432,
  "blacklisted":        {"blacklisted_company": 3, "salary_below_min": 11, "not_remote": 40},
  "deduped":            {"hash_exact": 402, "cosine": 23},
  "filtered_by_type":   {
      "field_gate": {"language": 47, "experience_level": 12},
      "cpu_gate":   {"yoe_gate": 320, "salary_gate": 12, "jd_incomplete": 31, "visa_gate": 6},
      "llm_gate":   {"education_gate": 18, "visa_gate": 9},
      "coverage":   {"low_required_coverage": 210},
      "llm_reject": {"llm_not_interview_worthy": 96}
  },
  "matched":            {"cpu_perfect": 14, "llm": 65},
  "llm_used":           true
}
```

All keys additive; existing dashboard tolerates unknown keys.

### Step B — Write `pending_applications`

For each matched job: read its `match_candidates` row (extraction columns) + its per-source row (title, URLs, posting date, salary display fields) + the Phase 5 scoring output, merge into one self-contained snapshot row, upsert into `pending_applications` (`ON CONFLICT (source, source_id) DO UPDATE`, fresh 30-day `expires_at`).

Blocked on migration 032 / P1–P5. Until then, Step B logs and counts only ("frontend dark" interim state).

### Step C — Blacklist re-entry

```sql
-- one transaction, three UPDATEs (mirrors matched-claim pattern)
UPDATE linkedin_jobs  SET matched = FALSE WHERE job_posting_id = ANY(:linkedin_ids);
UPDATE indeed_jobs    SET matched = FALSE WHERE jobkey        = ANY(:indeed_ids);
UPDATE glassdoor_jobs SET matched = FALSE WHERE listing_id    = ANY(:glassdoor_ids);
```

IDs come from the in-memory `blacklist_list` Phase 4 Step 1 returned. Re-entered rows are re-claimed next cycle and re-evaluated against possibly-edited blacklist rules, until they expire from per-source.

### Step D — Teardown

```sql
DELETE FROM match_candidates WHERE cycle_id = :cid;
```

### Phase 1 extension (auto-expiration additions)

`run_auto_expiration` gains three sweeps after the existing per-source deletes, same transaction:

1. `DELETE FROM filtered_jobs fj WHERE NOT EXISTS (<per-source row with same (source, source_id)>)` — I9
2. `DELETE FROM pending_applications WHERE expires_at < NOW()` — I10 (once 032 ships)
3. `DELETE FROM match_candidates WHERE cycle_id IN (SELECT id FROM auto_scrape_cycles WHERE status IN ('failed','post_scrape_complete'))` — defensive orphan sweep

`cleanup_results` JSONB gains matching keys (additive).

---

## 8. Cost-optimization principles

The stated goal: max matching accuracy per token and per second. These are the levers this design uses (and the ones deliberately deferred):

| # | Principle | Where |
|---|---|---|
| C1 | **Cheap gates before expensive steps.** CPU extraction + CPU gates (Steps 4–5) always run before LLM extraction (Step 6), even in LLM mode — every row they kill is an LLM call saved. Same for dedup before extraction, and the `<0.50` band before LLM matching. | Steps 3–7, Phase 5 banding |
| C2 | **The LLM band.** Only the ambiguous middle (`0.50–0.99` coverage) costs LLM-matching tokens. Definitive fits (`==1.00`) and definitive failures (`<0.50`) are decided by CPU. | Phase 5 Step 1 |
| C3 | **`standardized_jd` compression.** Phase 5 Step 2 reads the ~150-word standardized JD, not the raw 400–1200-word JD — roughly 70% input-token cut on the matching call. Paid for once in Step 6 (which reads the raw JD anyway). | Step 6 → Phase 5 Step 2 |
| C4 | **Prefix caching by prompt ordering.** Static instructions + profile context FIRST, per-job content LAST, in every LLM prompt. Identical prefixes across a cycle's calls get OpenAI's automatic prefix-cache discount (~50% on cached input tokens). Free win; costs only prompt discipline. | Steps 6, Phase 5 Step 2 |
| C5 | **Skills stay CPU.** Zero tokens for skill extraction; accuracy trade documented at I6. | Step 4 |
| C6 | **One call per job for now; batching later.** Batch-N-jobs-per-call (5–10 per call) cuts per-call overhead and repeated instruction tokens, at the cost of error isolation. Noted for the future prompt-engineering stage together with `standardized_jd` and the matching prompt. OpenAI Batch API (50% off, 24 h) rejected — breaks the continuous cycle. | Step 6, Phase 5 Step 2 |
| C7 | **Re-extraction on re-entry accepted.** No extraction cache. Jobs turn over fast; crash re-entry is rare; a cache table isn't worth its complexity yet. | I12 |

---

## 9. Transactions & crash recovery

- **One transaction per step** (I14). LLM calls (Step 6, Phase 5 Step 2) run outside transactions; their DB writes happen in a short transaction after the `asyncio.gather`.
- **Same-process re-entry:** Phase 3 purges `WHERE cycle_id = :cid` and rebuilds (I12). Committed step deletions from the earlier attempt are irrelevant — the rebuild starts from the claim batch again.
- **Process killed:** lifecycle cleanup marks the cycle `failed`, resets `matched=FALSE` on per-source rows via `cycle.run_log_ids → scan_run_id` (I13), purges its `match_candidates`. The next cycle re-claims everything, including rows the dead cycle had blacklisted (they get re-blacklisted — one wasted evaluation, no data loss).
- **`filtered_jobs` rows from a failed cycle stay** — decisions were valid when made; the re-run may add new rows for the same `(source, source_id)`, which the non-unique key permits.
- **Crash between Phase 6 Step B and Step C:** matched rows are already in `pending_applications` (upsert makes the re-run idempotent); blacklist re-entry is covered by the failed-cycle reset.

---

## 10. Telemetry & observability

| Artifact | Content |
|---|---|
| `cycle.match_results` JSONB | Full per-cycle counts (§7 Step A shape) — the primary dashboard surface |
| `DedupReport` | `trigger='auto_scrape_cycle:{cycle_id}'`; hash/cosine pass metrics; debug_log via trace flush |
| `DedupTask` | running→completed lifecycle; UUID stored on `cycle.dedup_task_id` |
| `MatchReport` | `matching_mode='auto_scrape_cycle'`; totals mapped: `total_processed`=Phase-5 input, `total_gate_skipped`=Phase-4 filtered, `total_llm_scored`=LLM-band size, `match_level_counts`={matched, not_matched} (binary reuse of the JSONB column); debug_log via trace flush |
| `filtered_jobs` | per-job audit: why anything was excluded, queryable by `(source, source_id)` or `(cycle_id, filter_type)` |
| JhaTrace events | `blacklist_start/done`, `field_gates_done`, `pass_2_hash_done`, `pass_2_cosine_done/skipped`, `cpu_extract_done`, `cpu_gates_done`, `llm_extract_start/done`, `llm_gates_done`, `coverage_banding_done`, `llm_match_start/done`, `job_fail`, `finalize_done` |
| `_BRIDGE_LOGGERS` | add `auto_scrape.filter_pipeline`, `auto_scrape.matching_pipeline`, `auto_scrape.match_candidates_build` |

---

## 11. Smoke tests

| File | Coverage |
|---|---|
| `smoke_test_match_candidates_build.py` | (from Phase 3 design) build, re-entry purge, per-source projection, partial batch |
| `smoke_test_filter_pipeline.py` | blacklist per-field (incl. salary_disclosed=false ignored; blacklist_list returned; no filtered_jobs write) · field gates per-field (incl. language NULL→langdetect fallback) · dedup hash within-batch + vs-per-source + vs-pending_applications + corpus excludes current MCs + cosine skip/flag + silent-drop (no filtered_jobs row) · CPU extraction column writes + jd_incomplete filter + record_skill_candidates fires for later-filtered rows · CPU gates yoe/salary/visa · LLM extraction column writes (mocked) + failure filter · LLM gates all four (mocked) · per-step transaction isolation · empty batch no-op |
| `smoke_test_matching_pipeline.py` | coverage exact-1.00 → matched(cpu_perfect) · 0.49 → filtered('coverage') · 0.50/0.99 → LLM band · empty-required-skills routing (both modes) · CPU-only middle band → cpu_only_unresolved · LLM matched/not_matched routing (mocked) · LLM failure default (once Q-LLMFAIL is decided) · sort keys present on matched output |
| `smoke_test_finalize.py` | JSONB aggregate keys · blacklist matched=FALSE reset round-trip · teardown leaves 0 rows · pending_applications upsert + re-eval delete (once 032 ships) |
| `smoke_test_auto_expiration.py` (extend) | filtered_jobs cascade when per-source expires · pending_applications expiry · orphaned match_candidates sweep |

Conventions unchanged: `AsyncSessionLocal`, schema pre-flight, deterministic IDs, cleanup, `[OK]/[SKIP]`, run inside the backend container. LLM functions are always mocked in smoke tests.

Manual end-to-end (after wiring): run a one-keyword LinkedIn cycle in CPU-only mode → verify JSONB counts reconcile (`built = blacklisted + deduped + Σfiltered + matched`), `match_candidates` empty, blacklist round-trip (add company → blacklisted count > 0 and `matched=FALSE`; remove → flows through next cycle).

---

## 12. Decision log

Every decision made in the design discussion, with its rationale — so future edits don't silently relitigate them.

| # | Decision | Rationale |
|---|---|---|
| D1 | Phase 4 = filter (7 steps), Phase 5 = matching (2 steps) | Clean split: everything that excludes vs everything that scores |
| D2 | Blacklist vs filter-gate split = **user-editable preference vs fixed profile fact** (not "subjective vs objective") | The re-entry behavior follows naturally: editing a preference should re-admit old jobs; profile facts rarely change |
| D3 | Salary sits in **Blacklist** (Step 1) | `cfg.salary_min` is user-editable → jobs excluded by it deserve re-entry when it's lowered |
| D4 | Step 1 salary check reads **employer-disclosed salaries only** (`salary_disclosed=TRUE`) | Site-estimated salaries are unreliable |
| D5 | Salary gated **three times** (field / CPU-extracted / LLM-extracted) | Fill rate of the field is <100%; checks 1–2 are cost gates killing rows before LLM spend; check 3 is the accurate word |
| D6 | Pass-1 JD-text gates **deprecated** | Judged unreliable in practice |
| D7 | Agency detection **removed entirely** (temporarily) | Unreliable; revisit later |
| D8 | CPU education extraction **removed**; education = Step 2 field check (when source provides) + Step 6/7 LLM | CPU education extraction unreliable in practice |
| D9 | **Skills are CPU-only**; LLM never extracts skills | LLM over-extracts; determinism + zero token cost preferred; accuracy trade accepted and documented (I6) |
| D10 | `record_skill_candidates` **kept**, fires in Step 4 for all rows incl. later-filtered | Vocabulary growth is independent of match outcome; it's the only mechanism keeping `skill_aliases.json` current |
| D11 | Step 6 LLM extracts: `llm_yoe`, `llm_salary_min`, `llm_visa_req`, `llm_education_requirement`, `standardized_jd` | Judgment-requiring fields only; summary-ish fields folded into `standardized_jd` |
| D12 | `standardized_jd` prompt design **deferred** to prompt-engineering stage | It's a prompt project, not a schema project |
| D13 | Scoring = **`required_coverage` primary + `missing_required` gap list**; `preferred_coverage` tie-break only; no blended `fit_score` | Matches how HR reads resumes: must-haves first; one honest number beats a blend that hides where the gap is |
| D14 | LLM band = `[0.50, 1.00)`; `==1.00` auto-matched, `<0.50` auto-rejected | 100% coverage is definitively fit; missing half the must-haves is definitively not; only the ambiguous middle earns tokens |
| D15 | `==1.00` **excluded** from LLM ("Accept it, not Tweak it") | Cost-rational; trade-off (best matches get no narrative) accepted on the record |
| D16 | Verdict is **binary** matched/not_matched; four-level `match_level` retired | Simpler, matches the actual decision ("would HR interview?") |
| D17 | `matched` → `pending_applications` only; `not_matched` → `filtered_jobs`; not_matched **not displayed** | Frontend shows the pending list only; filtered_jobs is audit |
| D18 | Dedup duplicates and blacklisted rows are **silent drops** (JSONB counts, no filtered_jobs rows) | Duplicates aren't rejections; blacklisted rows re-enter — showing either as "rejected" is noise/misleading |
| D19 | Extraction output persists on **`match_candidates` columns** (not in-memory dicts) | Survives step boundaries; feeds the Phase 6 merge |
| D20 | CPU extraction+gates run **even in LLM mode** | Free pre-filter saves LLM calls (C1) |
| D21 | One LLM call per job; batching + OpenAI Batch API noted for later | Error isolation now; token savings later (C6) |
| D22 | One transaction per step; LLM calls outside transactions | No minutes-long transactions holding locks |
| D23 | Crash recovery = purge-and-rebuild (same-process) + failed-cycle `matched=FALSE` reset via `run_log_ids` | Dumb recovery beats phase-resume state machines |
| D24 | `pending_applications` = matched-only, self-contained snapshot, 30-day shelf life, `UNIQUE(source, source_id)` upsert | Per-source expires at 7 days — the pending row must carry everything it displays |
| D25 | Two cycles never run concurrently | Concurrent scraping risks anti-bot detection; also simplifies scratch-table semantics |
| D26 | `dedup_mode='sync'` extension hook and all legacy paths untouched | Parallel operation until a separate retirement workstream |

---

## 13. Open questions

### Blocking migration 032 / Phase 6 Step B (`pending_applications`)

| # | Question | Recommendation on the table |
|---|---|---|
| P1 | Merge strategy — confirm full self-contained snapshot (Option A) | Forced by the 30-day vs 7-day lifetime mismatch; awaiting sign-off |
| P2 | Final column set — `nice_to_have_skills` display? `status`/dismiss column now or with Phase 7? | Show matched/missing chips; defer `status` unless dismiss is wanted in v1 |
| P3 | CPU-only mode matched threshold: exactly `1.00`, or `>= cpu_strong_threshold` (0.85)? | Strict 1.00 makes the CPU-only pending list nearly empty; 0.85 keeps it useful |
| P4 | Upsert refreshes on re-match; re-eval to not_matched **deletes** the stale pending row? | Yes-delete recommended |
| P5 | 30-day expiry swept by Phase 1? | Yes recommended |

### Blocking the frontend page

| # | Question | Recommendation |
|---|---|---|
| UI1 | New page + route (`/applications` / `/pending` / `/matches`)? | New page |
| UI2 | Pagination? | Cursor pagination on `(required_coverage, id)` |
| UI3 | Card/detail layout sign-off; dismiss button in v1? | Two-pane LinkedIn-style as proposed; dismiss ties to P2 |
| UI4 | Filters in v1? | Sorted list + source filter only |
| UI5 | Empty state | Design it |
| UI6 | Real-time updates? | Poll-on-mount + refresh button |

### Other

| # | Question | Recommendation |
|---|---|---|
| Q-LLMFAIL | Phase 5 Step 2 LLM-call failure for a middle-band job — no CPU verdict exists by construction. Filter, retry, or threshold-tiebreak? | `>= cpu_strong_threshold → matched, else not_matched('llm_call_failed')` |
| Q-NAME | Keep `filtered_jobs` name, or rename `rejected_jobs` now that scored rejects land there too? | Keep `filtered_jobs`; `filter_type` carries the distinction |
| OQ19 | `filtered_jobs` cascade-delete uniform across all five `filter_type` values? | Yes, uniform |
| Q-GATE-RULES | Step 2 exact rules for `company_industry`, `job_functions`, `job_taxonomy*`, `experience_level` — where do the allowed/blocked lists come from (profile? config? hardcoded)? | Define at implementation; likely small config-driven lists |
| Q-STDJD | `standardized_jd` + LLM-matching prompt text | Deferred to prompt-engineering stage (with C4 prefix-ordering and C6 batching considered together) |

---

*End of design document.*
