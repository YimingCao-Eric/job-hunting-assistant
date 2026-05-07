# Step 1 — Schema design (per-source scrape tables)

Version note: amended 2026-05-06 for the **`matched`** mechanism and post-scrape orchestrator integration. Supersedes informal drafts; aligns with `matched-mechanism-codebase-changes-corrected.md`.

---

## §2 Compatibility contracts

### CC-1 — Ingest and persistence

**Primary rule:** Client extensions send **`POST /jobs/ingest`** with `website`, optional **`source_raw`**, optional **`scan_run_id`**, and legacy unified fields as needed. The backend routes writes to **`linkedin_jobs`**, **`indeed_jobs`**, or **`glassdoor_jobs`** using raw SQL **`INSERT … ON CONFLICT (job_url) DO NOTHING`** (see CC-7-style semantics in implementation docs).

**Carve-out A — ORM vs raw SQL:** Per-source tables are created and updated via Alembic **raw `op.execute(text(...))`** in places; there are **no** SQLAlchemy ORM models for these tables in the application layer. Application code must treat **`information_schema`** / migrations / `jobs.py` column lists as authoritative, not a duplicated ORM mirror.

**Carve-out B — LinkedIn `job_url` vs `job_posting_url`:** **`linkedin_jobs.job_url`** duplicates Voyager URL material also stored as **`job_posting_url`** until a dedicated migration moves uniqueness / **`ON CONFLICT`** to **`job_posting_url`**. Until then, ingest relies on **`UNIQUE(job_url)`** and **`ON CONFLICT (job_url)`**.

### CC-7 — Idempotent ingest

Returning **`id`** and **`already_exists`** after **`ON CONFLICT DO NOTHING`** is the contract for unified ingest; see `backend/routers/jobs.py`.

---

## §4 Common columns (all three per-source tables)

| Column | Type | Notes |
|--------|------|--------|
| `id` | UUID PK | `gen_random_uuid()` |
| `scan_run_id` | UUID FK | → `extension_run_logs(id)` |
| `job_url` | VARCHAR(2048) UNIQUE | Dedup key for ingest |
| `scrape_time` | TIMESTAMPTZ | Server default `NOW()`; drives auto-expiration |
| `source_raw` | JSONB | Nullable site payload |
| `matched` | BOOLEAN NOT NULL DEFAULT FALSE | **Post-scrape claim flag** — see §10.X and §15 |

Site-specific columns are defined in migration **`025_per_source_scrape_tables`** as amended by **`026_cycle5_drops`** and **`027_schema_reconciliation`**.

---

## §10.X Matching claim-and-flag pattern

After auto-expiration (global shelf life), the post-scrape orchestrator **claims** unmatched rows for downstream merge/dedup/matching:

1. **SQL:** For each of `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`:
   ```sql
   UPDATE <table> SET matched = TRUE
   WHERE matched = FALSE
   RETURNING id, job_url, scan_run_id, scrape_time;
   ```
2. **Transaction:** All three **`UPDATE`s** run in **one** database transaction (`async with db.begin():`) so the claim is atomic across sites.
3. **Semantics:** `matched = FALSE` means “not yet claimed by an orchestrator cycle for the new pipeline.” After claim, `matched = TRUE` means “claimed for this cycle’s batch” — **not** “JD matching completed” (see §15.4).
4. **Observability:** The orchestrator merges per-site counts into **`auto_scrape_cycles.match_results.claim_summary`** as `{"linkedin": N, "indeed": M, "glassdoor": K}` alongside future dedup/matching keys.

Phase 3 dedup/matching bodies may consume full returned rows later; until wired, helpers may return a narrow **`RETURNING`** list.

---

## §15 Known limitations

### §15.1 Initial backlog after adding `matched`

Migration **`028`** adds **`matched BOOLEAN NOT NULL DEFAULT FALSE`**. Existing rows become **`matched = FALSE`**, so the **first** orchestrator cycle after deploy may claim **all** historical rows unless operators **grandfather** them (production Step 3: `UPDATE … SET matched = TRUE` on each per-source table). See ship order in `matched-mechanism-codebase-changes-corrected.md`.

### §15.2 Orchestrator failure and `matched` semantics

- If the cycle **fails after** claim **`UPDATE`s** commit but **before** **`match_results`** is written, per-source rows may show **`matched = TRUE`** while **`cycle.match_results`** is still empty — acceptable per design; recovery is operational (inspect logs, possibly reset **`matched`** for affected rows).
- **Auto-expiration** deletes rows older than **`shelf_life_days`** **regardless of `matched`**. Rows that were **`matched = FALSE`** only because of a crash may still be deleted when aged out — recovery is manual **`UPDATE matched = FALSE`** on replacements if needed.

### §15.3 Global claim scope (current helper)

The **`claim_unmatched_rows`** helper claims **all** `matched = FALSE` rows in each table, **not** scoped to a single **`scan_run_id`** or cycle. When dedup/matching consume batches, filtering/scoping may tighten — document changes then.

### §15.4 Naming overlap with `scraped_jobs.matched_at`

The legacy **`scraped_jobs`** table has **`matched_at TIMESTAMPTZ`**, populated by the JD-extraction / CPU–LLM matching pipeline. The per-source tables use **`matched BOOLEAN`** with different semantics — **“claimed by the post-scrape orchestrator for matching,”** not **“matching successfully completed.”**

Do not conflate them:

- **`scraped_jobs.matched_at`** — legacy single-table pipeline completion.
- **`<per_source>.matched`** — orchestrator claim-and-flag in the per-source architecture.

When **`scraped_jobs`** is retired, **`matched_at`** goes with it. No rename is planned for either column.
