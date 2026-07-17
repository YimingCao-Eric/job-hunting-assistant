# Filtering & Matching Service — Design (current-codebase edition)

> A ground-up redesign of the old `step3-filter-matching-design.md` for the **current**
> search-only JHA codebase. The old doc targeted a pre-split codebase and no longer matches
> reality; this keeps its proven verdict model and cost principles but re-targets storage,
> packaging, and inputs to today's `scraped_jobs`, and folds in four review decisions (§0.1).
>
> **What this is:** a new, separate project ("filtering" + "matching", formerly dedup + matching)
> that consumes the canonical **`scraped_jobs`** table and produces a shortlist of jobs worth
> applying to, plus an audit trail of everything it filtered.
>
> **Decided:** same-DB access (portable local ↔ AWS via `DATABASE_URL`) · on-demand trigger ·
> OpenAI `gpt-4o-mini` · profile **entered on the JHA frontend**, persisted in the shared DB (§7).

---

## Build status (as of 2026-07-17)

| Prereq | State | Notes |
|---|---|---|
| **JHA-A** — extend the canonical projection | ✅ **SHIPPED** (feature 009, Alembic **031**) | `scraped_jobs` carries the five filter columns. Vocab resolved against a live scan (below). |
| **JHA-B** — retire the vestigial matched-claim | ⛔ **STILL REQUIRED — blocker** | `auto_scrape/post_scrape_orchestrator.py:179` still calls `claim_unmatched_rows`, which flips `matched=TRUE` on all three per-source tables **and** `scraped_jobs`. Until removed, this service's `WHERE matched=FALSE` claim finds **no rows** after any auto-scrape cycle. |
| **JHA-C** — profile input page | 🆕 **NEW** (from the frontend-source decision) | A Profile page on the JHA frontend writes a validated profile to a JHA-owned `profile` table; this service reads it (§7). |

**Live-scan vocab resolutions baked into JHA-A** (the service must code to these, not to the old design's assumptions):

- **`employment_type` is a closed SEVEN-value set:** `FULL_TIME · PART_TIME · CONTRACT · TEMPORARY · INTERNSHIP · PERMANENT · VOLUNTEER`. `PERMANENT` (Indeed "Permanent") is a **tenure** axis, not hours — a permanent job may be full- or part-time. `no_contract` blacklists must exclude `CONTRACT`/`TEMPORARY`, **not** treat `PERMANENT`/`FULL_TIME`/`PART_TIME` as contracts.
- **`workplace_type` ∈ `REMOTE · HYBRID · ONSITE`, but is ALWAYS NULL for Glassdoor** (the scraper doesn't capture `remote_work_types` — a separate scraper-layer follow-up). A field gate or blacklist keyed on `workplace_type` **silently excludes the entire Glassdoor corpus**, because NULL matches no equality predicate. For remote filtering, prefer the tri-state `remote` boolean (populated on all three sites); treat `workplace_type IS NULL` as "unknown — do not exclude", never as "not remote".
- **`salary_disclosed=TRUE` for Indeed includes `EXTRACTION`** — pay parsed from the employer's JD prose. It is employer-authored (so counts as disclosed) but less structured than a stated salary field; treat it as provenance, not a guarantee of parse accuracy.
- **`language` is Indeed-only** (LinkedIn/Glassdoor NULL) — keep the `langdetect`-on-`description` fallback (§6, Step 2).

---

## 0. What changed from the old design

The old design assumed a codebase that no longer exists. Each is re-resolved below:

| Old design assumed… | Current reality | Resolution |
|---|---|---|
| A per-cycle **`match_candidates`** is *built* in Phase 3 from claim results | Feature 008 already made **`scraped_jobs`** the canonical merged table | **Input is `scraped_jobs` directly.** No build phase. |
| Imports `cpu_extract_jd`, `run_hard_gates`, `dedup/service.py`, `record_skill_candidates`, `normalise_list`, `skill_aliases.json` | All deleted in the search-only split | **Reimplement/port** them into this service (documented in `specs/003`/`004`; recoverable from git `d738bc1`). |
| Rich 25-col projection with workplace_type, employment_type, language, education, salary_disclosed… | `scraped_jobs` now carries all five (27 cols) | ✅ **DONE — JHA-A (migration 031)** extended the canonical projection, so the service reads only `scraped_jobs` — no per-source joins. |
| Config carries matching knobs; profile parsing exists in-app | Both removed in the split | Service owns its config (§8); profile is an input format (§7). |
| `scraped_jobs` is the untouched *legacy* table | It's the *canonical* table | Results go to **new tables this service owns** (`filtered_jobs`, `matched_jobs`), same DB. |
| Runs as backend orchestrator Phases 4–6 | Backend is search-only | Runs as a **standalone on-demand process** (§2). |

### 0.1 Four review decisions folded in

1. **No per-source joins — extend the canonical projection instead.** The point of `scraped_jobs`
   is to be the one table consumers read; joining three site tables re-introduces the coupling it
   removed. So the extra gate fields are **added to `scraped_jobs`** via a small JHA change (§1).
2. **Reuse the `matched` column as the processed marker.** `matched` was designed as the
   "claimed for downstream matching" flag; this service claims (`FALSE→TRUE`) rows as it processes
   them. JHA must **retire its now-vestigial auto-claim** so `matched` stays `FALSE` until this
   service claims it (§1).
3. **Record dedup drops — don't drop silently.** Because dedup can be wrong (#4), a silently
   dropped duplicate would vanish with no way to see or reverse the mistake. Every dedup drop is
   **audited** with the kept job's id + similarity.
4. **Dedup key = company + location + JD, not JD alone.** Identical JDs for the *same role in
   different regions* are genuine separate openings, not duplicates. Location is part of the key.

---

## 1. Prerequisite JHA changes (see `jha-prereq-cmds.md`)

Three small features must land in the **current JHA repo** before this service is built. Commands
for JHA-A/JHA-B (Claude Code + Spec Kit) are in the companion file `jha-prereq-cmds.md`; JHA-C is
new and still needs a playbook.

- **JHA-A — Extend the canonical `scraped_jobs` projection.** ✅ **SHIPPED (feature 009, migration
  031).** Added `employment_type`, `workplace_type`, `language`, `education_requirements`,
  `salary_disclosed`, populated per-site at dual-write time. Vocab resolved against a live 3-site
  scan (see Build-status box): seven-token employment set incl. `PERMANENT`; LinkedIn
  `workplace_type` from its URN enum (1=ONSITE/2=REMOTE/3=HYBRID); Glassdoor `workplace_type`
  always NULL; Indeed `EXTRACTION` → `salary_disclosed=TRUE`. *(Decision #1)*
- **JHA-B — Retire the vestigial post-scrape matched-claim.** ⛔ **STILL REQUIRED — the one hard
  blocker.** `run_post_scrape_phase` (`auto_scrape/post_scrape_orchestrator.py:179`) still calls
  `claim_unmatched_rows` (`auto_scrape/matching_claim.py`), which flips `matched=FALSE→TRUE` on all
  three per-source tables and `scraped_jobs` at the end of every auto-scrape cycle. Remove that
  Phase-2 call so `matched` stays `FALSE` until **this** service claims it; keep the `matched`
  column; update `smoke_test_matched_claim.py`. *(Decision #2)*
- **JHA-C — Profile input on the frontend.** 🆕 A **Profile** page on the JHA frontend (alongside
  Config) lets the user enter their profile (skills, YOE, titles, education, preferences, resume
  text — the §7 shape); the JHA backend validates and persists it to a JHA-owned `profile` table
  (one active row) in the shared Postgres. This service reads the active profile at run start (§7).
  Stored in the DB, not a file, so it stays portable local ↔ AWS with the same `DATABASE_URL`.

After JHA-A/B/C, this service reads **only** `scraped_jobs` + the `profile` row, owns the `matched`
claim, and needs no per-source joins.

---

## 2. Project shape & deployment

Standalone **Python** project (separate repo) — the algorithms to port are Python; the LLM path
uses the OpenAI SDK.

```
filter-matcher/
  pyproject.toml
  src/filtermatch/
    __main__.py            # CLI: `python -m filtermatch run [--limit N] [--cpu-only]`
    config.py · db.py · models.py · profile.py · pipeline.py
    ingest.py              # claim + read a batch of scraped_jobs (matched=FALSE)
    filtering/  blacklist.py · field_gates.py · dedup.py · cpu_extract.py · cpu_gates.py
                llm_extract.py · llm_gates.py · skill_vocab.py  (+ skill_aliases.json)
    matching/   coverage.py · llm_match.py
    migrations/            # Alembic for THIS service's tables only
  smoke_tests/ · Dockerfile · .env.example
```

**Portable local ↔ AWS — only config changes:** one Docker image, behavior chosen by env.

| Concern | Local | AWS |
|---|---|---|
| DB | `DATABASE_URL=…@localhost:5432/jha` (Docker Postgres) | `…@<rds-endpoint>:5432/jha` (RDS) |
| OpenAI key | `.env` / `OPENAI_API_KEY` | Secrets Manager / SSM → env |
| Profile | JHA `profile` table (same `DATABASE_URL`); `PROFILE_PATH` file as override | same `profile` table via RDS; file/S3 override for CI |
| Invoke | `docker run … python -m filtermatch run` | ECS/Fargate task or Lambda-container, on demand |
| Migrations | `alembic upgrade head` (local) | same, once against RDS |

Stateless between runs (all state in Postgres). Its Alembic chain is **separate** from JHA's — use
its own version table (`alembic_version_filtermatch`) so heads never collide. It follows JHA's
schema conventions (snake_case, UUID PKs, atomic writes).

---

## 3. The verdict model (unchanged — old §2)

| State | Where | Shown |
|---|---|---|
| **matched** | `matched_jobs` | ✅ shortlist |
| **not_matched** | `filtered_jobs` | ❌ audit |
| **duplicate** | `filtered_jobs` (`filter_type='dedup'`) — **now audited, not silent (#3)** | ❌ |
| **blacklisted** | dropped, `matched=FALSE` re-entry | ❌ (re-evaluated next run) |

Two paths to **matched**: `required_coverage == 1.00` (auto, no LLM) or the LLM says
interview-worthy. LLM band `[0.50, 1.00)`. Binary verdict. Old §2 + decision log §12 still govern.

---

## 4. Input: `scraped_jobs` (extended per JHA-A)

The service **claims** a batch: selects `scraped_jobs WHERE matched = FALSE` (optionally
`ORDER BY scrape_time` `LIMIT batch_limit`), flips them `matched = TRUE` in the same transaction
(the claim), and processes them. Blacklist re-entry resets `matched = FALSE`.

After JHA-A, `scraped_jobs` carries everything the gates need — the service reads **one table, no
per-source joins**:

- **From 008:** `id, source_site, source_row_id, site_job_id, job_url, apply_url, scrape_time,
  posted_at, matched, dismissed, title, company, location_text, description, remote, industry,
  experience_level, salary_min, salary_max, salary_currency, salary_period`.
- **Added by JHA-A:** `employment_type, language, education_requirements, salary_disclosed,
  workplace_type`.

> **Read these columns per the Build-status box, not the old design's assumptions.** Chiefly:
> `workplace_type` is NULL for **all** Glassdoor rows (gate on `remote`, not `workplace_type`, or
> you silently drop Glassdoor); `employment_type` is a seven-token set incl. `PERMANENT` (tenure,
> not a contract); `language` is Indeed-only (langdetect fallback); Indeed `salary_disclosed=TRUE`
> includes prose-extracted (`EXTRACTION`) pay.

Fields the old projection canonicalized that JHA still doesn't (`title_canonical`,
`company_canonical_name`, split city/state/country): the service derives what it needs from raw
`title` / `company` / `location_text` (e.g., a light canonical-company normalizer for the dedup
key in §6.3). Skills come from **CPU extraction on the JD** (I6), not a projected column.

---

## 5. Data model — tables this service owns (same DB, own migrations)

No processed-marker table — the `matched` column is the marker (decision #2).

### 5.1 `filtered_jobs` (audit of everything excluded, incl. duplicates)

```sql
CREATE TABLE filtered_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scraped_job_id UUID NOT NULL,                 -- references scraped_jobs.id (soft, cross-owner)
  source_site    TEXT NOT NULL,
  site_job_id    TEXT NOT NULL,
  run_id         UUID NOT NULL,
  filter_type    TEXT NOT NULL CHECK (filter_type IN
                   ('field_gate','cpu_gate','llm_gate','coverage','llm_reject','dedup')),
  filter_reason  TEXT NOT NULL,
  detail         JSONB,        -- coverage: {required_coverage, missing_required};
                               -- dedup: {kept_scraped_job_id, similarity, match_kind}
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_fj_scraped_job ON filtered_jobs(scraped_job_id);
CREATE INDEX ix_fj_type_reason ON filtered_jobs(filter_type, filter_reason);
```

**Now six `filter_type` values** — `dedup` added (#3). A `dedup` row records `detail =
{kept_scraped_job_id, similarity, match_kind}` so a wrongly-dropped job is visible and reversible.
Still **no `blacklist` type** (blacklisted rows genuinely re-enter). Not unique on the job — a job
can be filtered in multiple runs.

### 5.2 `matched_jobs` (the shortlist — was `pending_applications`)

Self-contained snapshot (survives `scraped_jobs` shelf-life expiry). `UNIQUE(source_site,
site_job_id)` upsert; re-eval to not_matched deletes the stale row.

```sql
CREATE TABLE matched_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scraped_job_id     UUID NOT NULL,
  source_site        TEXT NOT NULL,
  site_job_id        TEXT NOT NULL,
  run_id             UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,       -- created_at + 30 days
  -- display snapshot
  title TEXT NOT NULL, company TEXT, location_text TEXT, salary_display TEXT,
  posted_at TIMESTAMPTZ, remote BOOLEAN, job_url TEXT, apply_url TEXT,
  description TEXT NOT NULL,                      -- snapshot; sanitize on display (DOMPurify)
  -- scoring
  required_coverage  REAL NOT NULL,             -- primary sort desc
  preferred_coverage REAL,                       -- tie-break desc
  match_source       TEXT NOT NULL CHECK (match_source IN ('cpu_perfect','llm')),
  jd_skills JSONB, matched_required JSONB, missing_required JSONB, matched_preferred JSONB,
  llm_reason         TEXT,                        -- NULL for cpu_perfect
  CONSTRAINT matched_jobs_uni UNIQUE (source_site, site_job_id)
);
CREATE INDEX ix_mj_sort    ON matched_jobs(required_coverage DESC, preferred_coverage DESC);
CREATE INDEX ix_mj_expires ON matched_jobs(expires_at);
```

The service sweeps `matched_jobs WHERE expires_at < NOW()` and `filtered_jobs` whose
`scraped_job_id` no longer exists, at the start of each run (JHA's auto-expiration only knows the
per-source/`scraped_jobs` tables, not these).

### 5.3 Per-run extraction state (in-memory)

The old design persisted CPU/LLM extraction on `match_candidates` because a cycle spanned phases
with crash recovery. An **on-demand single-pass run holds extraction in memory** per job — only
final verdicts persist (`matched_jobs` / `filtered_jobs`). Idempotency comes from the `matched`
claim + the `matched_jobs` upsert, so a killed run is safe to re-invoke (re-claims `FALSE` rows).
*(If step-isolation/crash-recovery is later wanted, add a `filtermatch_work` scratch table — not
needed for v1.)*

---

## 6. The pipeline (one run)

`python -m filtermatch run`: claim a batch (§4), then:

### Filtering (exclude cheaply, in cost order)
1. **Blacklist** — company, location, `remote_only` (gate on the tri-state `remote`, **not**
   `workplace_type` — the latter is NULL for all Glassdoor rows), `no_contract` (exclude only
   `employment_type ∈ {CONTRACT, TEMPORARY}`; `PERMANENT`/`FULL_TIME`/`PART_TIME` pass), salary
   floor on **disclosed** salaries only (`salary_disclosed`, which for Indeed includes `EXTRACTION`
   prose pay). Silent drop + `matched=FALSE` re-entry; counted. *(old §5 Step 1)*
2. **Field gates** — title relevance, industry, experience level, language (+ `langdetect`
   fallback on `description` when `language` is null), education (`education_requirements`). →
   `filtered_jobs('field_gate')`. *(old §5 Step 2)*
3. **Dedup (§6.3 — reworked)** — company+location+JD key; **records each drop** to
   `filtered_jobs('dedup')`. *(reworked from old §5 Step 3)*
4. **CPU extraction** — YOE, salary, visa, required/nice-to-have skills (CPU-only). Grow the alias
   vocabulary. `jd_incomplete`/error → `filtered_jobs('cpu_gate')`. *(old §5 Step 4)*
5. **CPU gates** — YOE, salary (2nd check), visa → `filtered_jobs('cpu_gate')`. *(old §5 Step 5)*
6. **LLM extraction** *(gpt-4o-mini; skipped in `--cpu-only`)* — YOE, salary (3rd), visa,
   education, `standardized_jd` (~150 words). One call/job, `Semaphore(8)`, static-first prompt.
   *(old §5 Step 6)*
7. **LLM gates** — re-run YOE/salary/visa/education → `filtered_jobs('llm_gate')`. *(old §5 Step 7)*

### Matching (score survivors)
8. **CPU coverage** — `required_coverage`, `missing_required`, `preferred_coverage`. `==1.00 →
   matched(cpu_perfect)`; `<0.50 → filtered_jobs('coverage')`; `0.50–0.99 → LLM band`. *(old §6.1)*
9. **LLM matching** *(gpt-4o-mini; skipped in `--cpu-only`)* — binary verdict on `standardized_jd`
   + gap; `yes → matched(llm)` + reason; `no → filtered_jobs('llm_reject')`. *(old §6.2)*

### Finalize
10. Upsert matched → `matched_jobs`; apply blacklist `matched=FALSE` re-entry to the per-source
    rows; run summary to stdout/log. The claim (Step 0) already marked processed rows
    `matched=TRUE`. *(old §7, adapted — the "cycle" is a `run_id`, no `auto_scrape_cycles` row.)*

One transaction per step; LLM calls outside transactions, written in a short transaction after
`gather` (old §9, I14).

### 6.3 Dedup — company + location + JD (decision #4)

Pure JD-text dedup is wrong: the same role posted in **Toronto and Vancouver** yields identical
JDs but is **two real openings**. So the identity is a **cluster key**, not JD alone:

```
dedup_key ≈ (canonical_company, canonical_location_region, jd_similarity)
```

- **Collapse (true duplicate):** same `canonical_company` **AND** same location-region (or both
  remote) **AND** near-identical JD — regardless of `source_site`. Targets: the same posting
  **cross-listed** on LinkedIn+Indeed+Glassdoor, and **re-posts** (same job, new URL after expiry).
- **Keep both (not a duplicate):** same company + same JD but **different city/region**.

Mechanics: hash-exact (SHA-256 of stripped JD) then cosine TF-IDF (ported from `dedup/service.py`),
**scoped within a `(company, location-region)` bucket** — jobs in different buckets are never
compared. Corpus = prior `scraped_jobs` (already processed) + current `matched_jobs`; the current
batch's own rows excluded from their own comparison.

Guards:
- **Bias toward keeping.** A false keep shows one extra card; a false drop hides a job. On any
  ambiguity (borderline similarity, uncertain company/location match), **keep**.
- **Within-site exact dupes are already gone** — ingest dedups on `job_url` (`ON CONFLICT`), so
  this step only chases cross-site cross-posts and re-posts, a narrow, safe target.
- **Every drop is recorded** (#3): `filtered_jobs('dedup', 'cross_post'|'repost', detail=
  {kept_scraped_job_id, similarity, match_kind})`. The kept row is the earliest `scrape_time`.

Open item **DEDUP-LOC**: how coarse is "location-region" — exact `location_text`, city, or
province/state? Recommend **city-level normalization** (so "Toronto, ON" == "Toronto" but ≠
"Vancouver"), with remote treated as its own bucket. Confirm at implementation.

---

## 7. Profile input (entered on the JHA frontend — RESOLVED)

**Source (`PROFILE-SRC`, resolved 2026-07-17): the user enters the profile on the JHA frontend.** A
**Profile** page (alongside Config) collects the fields below; the JHA backend validates and
persists them to a JHA-owned `profile` table (one active row) in the shared Postgres. This service
reads the active `profile` row at run start (same `DATABASE_URL`, so it stays portable local ↔ AWS
with no file plumbing). A `PROFILE_PATH` JSON file remains a supported override for CI/headless
runs. Building the page + endpoint + table is prerequisite **JHA-C** (§1).

The service consumes one validated object — the `profile` row deserializes to exactly this shape,
which serves both the CPU gates and the LLM prompt:

```jsonc
// profile.json
{
  "skills": ["python","postgresql","fastapi","react","aws"],   // canonical → CPU coverage
  "years_experience": 4,                                        // YOE gate
  "titles": ["backend engineer","full stack developer"],       // title relevance + LLM
  "education": { "degree": "bachelor", "field": "computer science" },
  "preferences": {                                             // blacklist / field gates
    "salary_min": 90000, "salary_currency": "CAD",
    "locations": ["Toronto","Remote"], "remote_only": false,
    "no_contract": true, "needs_sponsorship": false,
    "allowed_languages": ["en"], "blacklist_companies": ["Acme Staffing"]
  },
  "resume_text": "Full plain-text resume … LLM matching context (put FIRST in the prompt)"
}
```

Validated on load (both when the frontend saves it and when the service reads it); fail fast if
malformed. The frontend is the origin of record; the service treats the `profile` row as read-only.

---

## 8. Config (this service owns it)

| Key | Default | Used by |
|---|---|---|
| `DATABASE_URL` · `OPENAI_API_KEY` | — | DB / LLM |
| `MATCHING_MODEL` | `gpt-4o-mini` | LLM calls |
| `cpu_binary_threshold` | `0.50` | LLM-band floor |
| `cpu_strong_threshold` | `0.85` | CPU-only "matched" |
| `dedup_fuzzy_threshold` | `0.85` | cosine dedup |
| `dedup_location_granularity` | `city` | dedup bucket (DEDUP-LOC) |
| `llm_concurrency` | `8` | Semaphore |
| `batch_limit` | `500` | rows per run |
| profile preferences | from the JHA `profile` row (frontend-entered; `PROFILE_PATH` file override) | blacklist/field/CPU gates |

`--cpu-only` skips Steps 6, 7, 9; matched = coverage `==1.00` or `>= cpu_strong_threshold`.

---

## 9. Cost optimization (unchanged — old §8)

C1 cheap gates before LLM · C2 the LLM band only · C3 `standardized_jd` compression · C4
prefix-cache by static-first ordering · C5 skills stay CPU · C6 one call/job now, batch later ·
C7 no extraction cache.

---

## 10. Testing

`smoke_test_filtering.py` (blacklist incl. disclosed-salary skip; field gates incl. langdetect;
**dedup incl. multi-region keep + cross-post collapse + drop recorded**; CPU extraction + gates;
LLM extraction/gates mocked), `smoke_test_matching.py` (coverage banding; LLM verdict routing
mocked), `smoke_test_finalize.py` (upsert + re-eval delete; `matched` claim/re-entry; expiry
sweep). LLM always mocked. One manual `--cpu-only` end-to-end run reconciling counts (`claimed =
blacklisted + deduped + Σfiltered + matched`).

---

## 11. Open questions

| # | Question | Lean |
|---|---|---|
| ~~PROFILE-SRC~~ | ~~Where does the profile come from?~~ | ✅ **RESOLVED** — entered on the JHA frontend, persisted to a `profile` table (JHA-C, §7) |
| DEDUP-LOC | Location granularity for the dedup bucket (exact / city / province)? | City-level; remote its own bucket |
| RESULTS-UI | JHA frontend shows `matched_jobs`, or its own UI later? | Later; `matched_jobs` is queryable now. Note the frontend is already gaining a Profile page (JHA-C), so a results view is a natural sibling. |
| RE-ENTRY-WRITE | This service writes `matched=FALSE` back to JHA per-source tables for blacklist re-entry — acceptable, or keep re-entry service-local? | Confirm; it's the one place the service writes JHA-owned data. Cleaner once **JHA-B** lands and the per-source `matched` is no longer touched by JHA itself. |
| SCHEDULING | Add scheduled/continuous later? | Deferred |
| GATE-RULES | Exact allowed/blocked lists for industry / experience-level / title | Small config/profile-driven lists at implementation |

---

*Supersedes `step3-filter-matching-design.md` for the current codebase. That file remains the
authority for algorithm-level detail (banding math, cost principles, crash recovery); this file
re-targets integration, storage, packaging, dedup identity, and the profile format to today's
`scraped_jobs`-based JHA and a standalone local/AWS service. Prerequisite JHA changes: JHA-A
(extend projection — ✅ shipped), JHA-B (retire auto-claim — ⛔ still required), JHA-C (profile
input page — 🆕 new) — see `jha-prereq-cmds.md` (JHA-A/B) and §1/§7 (JHA-C).*
