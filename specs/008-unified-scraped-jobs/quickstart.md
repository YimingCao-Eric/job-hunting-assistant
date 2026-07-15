# Quickstart: Validating Unified `scraped_jobs`

**Feature**: 008-unified-scraped-jobs | **Date**: 2026-07-15

How to prove this feature works end-to-end. Design details live in [`data-model.md`](./data-model.md),
[`research.md`](./research.md), and [`contracts/api-surface-delta.md`](./contracts/api-surface-delta.md).

---

## Prerequisites

**Run everything through Docker.** The host Python interpreter is broken
(`ModuleNotFoundError: No module named 'encodings'` — misconfigured `PYTHONHOME`). Do not
invoke `python` / `alembic` / `pytest` directly on the host; a failure there tells you nothing
about the code.

**⚠️ The backend has no source volume mount — rebuild the image after every code change.**
`docker-compose.yml` mounts only `./data:/app/data`; code is baked in at build time. Editing a
host file changes nothing in the running container, and this fails **silently**: `alembic
upgrade head` against a stale image prints `029 (head)` and exits 0, exactly as if your
migration didn't exist. Always:

```bash
docker compose up -d --build backend
```

**Verified environment facts** (2026-07-15): DB service is **`postgres`** (not `db`);
credentials are **`jha` / `jha` / `jha`**; migrations run automatically at container startup
(`run_migrations`, `backend/main.py:16`), so a rebuild applies them.

Also needed: a valid bearer token, and one `extension_run_logs` row to satisfy the
`scan_run_id` FK.

---

## 1. Migration applies and the backend boots (FR-029, SC-006)

```bash
docker compose exec -T backend alembic current   # expect 029 before
docker compose up -d --build backend             # rebuild → startup applies 030
docker compose exec -T backend alembic current   # expect 030
```

A clean boot is itself the check:

```bash
docker compose logs --tail=50 backend   # expect "Running upgrade 029 -> 030" then
                                        # "Application startup complete", no tracebacks
curl -s localhost:8000/health           # expect 200 {"status":"ok","db":"ok"}
```

**Expected schema** — 22 columns and exactly three indexes, no more (CC-12, R5):

```bash
docker compose exec -T postgres psql -U jha -d jha -c '\d scraped_jobs'
```

Confirm: `scraped_jobs_pkey`, `scraped_jobs_job_url_key`, `ix_scraped_jobs_scan_run_id`.
**If `ix_scraped_jobs_source` or `ix_scraped_jobs_posted_at` exist, the migration followed the
mapping doc's illustrative DDL instead of CC-12 — that is a defect.**

Confirm absent: `source_raw`, `source_table`, and every dedup/matching column.

> `alembic downgrade 029` raises `NotImplementedError` by design (R11). This migration is
> one-way. Recovery is revert + restore, not downgrade.

---

## 2. The smoke suite (FR-030, FR-031, SC-007)

```bash
docker compose exec -T backend python smoke_test_scraped_jobs_merge.py   # NEW
docker compose exec -T backend python smoke_test_auto_expiration.py      # extended (FR-032)
docker compose exec -T backend python smoke_test_matched_claim.py        # extended (FR-033)
docker compose exec -T backend python smoke_test_auto_scrape.py          # migrated off legacy shape
```

All four must pass. The last three had to change — see "Intentional test changes" below.

---

## 3. Dual-write, end to end (US2, SC-002)

Ingest one posting per site, then assert the pair exists and agrees.

```bash
curl -X POST localhost:8000/jobs/ingest -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d @fixtures/linkedin_sample.json
```

**Expected**: `200`, `already_exists: false`, `id` = the **per-source** row id (R13).

```sql
-- one canonical row per per-source row, agreeing on the copied fields
SELECT s.source_site, s.title, s.company, s.posted_at, s.salary_period,
       s.source_row_id = l.id           AS row_ref_ok,
       s.scrape_time  = l.scrape_time   AS scrape_time_identical  -- must be TRUE (R2)
  FROM scraped_jobs s JOIN linkedin_jobs l ON l.id = s.source_row_id
 WHERE s.source_site = 'linkedin';
```

`scrape_time_identical` **must** be `true` — expiration symmetry depends on it (R3).

**Atomicity (FR-008)** — the scenario that actually matters. Force the canonical insert to fail
(e.g. temporarily make `title` `NOT NULL` in a scratch DB, or ingest with a `scan_run_id` that
violates the FK) and confirm **no per-source row survives**:

```sql
SELECT count(*) FROM linkedin_jobs WHERE job_url = '<the url>';  -- expect 0
SELECT count(*) FROM scraped_jobs  WHERE job_url = '<the url>';  -- expect 0
```

A per-source row surviving a failed canonical write means the two writes are not sharing a
transaction — the core defect this feature must not ship.

**Re-scrape is a no-op (FR-010)** — POST the identical body again:

```sql
SELECT count(*) FROM scraped_jobs WHERE job_url = '<the url>';   -- still exactly 1
```

Response: `already_exists: true`.

---

## 4. Per-site projection (US3, FR-030)

For each site, confirm the canonical fields hold what the mapping doc designates. The
transforms worth eyeballing, because each is a place a silent error hides:

```sql
SELECT source_site, salary_period, posted_at, remote, company FROM scraped_jobs;
```

| Check | Expected |
|---|---|
| `posted_at` (LinkedIn/Indeed) | a real date, not 1970 — a 1970 value means ms/s confusion (R8) |
| `posted_at` (Glassdoor) | midnight **UTC** on `date_posted` |
| `salary_period` | one of `HOURLY`/`DAILY`/`WEEKLY`/`MONTHLY`/`ANNUAL`, or NULL |
| `remote` (Glassdoor) | `true` when `remote_work_types` non-empty; **NULL**, never `false`, when absent |
| `company` (Indeed) | mosaic `company`; graphql `employer_name` only as fallback |

**⚠ Must check on the first real scan** — R7's period vocabulary is inferred, not observed:

```bash
docker compose logs backend | grep projection_unknown_salary_period
```

**Any hit means a site emits a token the map misses** and those postings have a NULL period.
Add the token to the map. An empty grep is the only evidence FR-015 is actually satisfied.

```bash
docker compose logs backend | grep projection_bad_posted_at   # expect none
```

---

## 5. `GET /jobs` returns real data (US1, SC-001, SC-003)

```bash
curl -s "localhost:8000/jobs?limit=50" -H "Authorization: Bearer $TOKEN" | jq '.items[0]'
```

**Expected**: canonical field names — `source_site`, `title`, `location_text`, `description`,
`posted_at`, `scrape_time`. **Not** `website` / `job_title` / `location`.

```bash
# per-site filtering (FR-019)
curl -s "localhost:8000/jobs?source_site=glassdoor" -H "Authorization: Bearer $TOKEN" | jq '.total'
# ?website=... is gone — expect it to be ignored, not to filter
```

**Cross-site ordering (SC-004)** — the payoff of `posted_at` normalization:

```sql
SELECT source_site, posted_at FROM scraped_jobs
 WHERE posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 20;
```

All three sites must interleave sensibly. Clustering by site suggests a per-site scale error.

**Auth (FR-022)**: `curl -s localhost:8000/jobs` with no token → **401**.

> The **frontend Jobs page stays broken** until spec 007 adapts to these names (FR-021). That is
> expected, not a regression — it shows an empty list today. Verify at the API, not the UI.

---

## 6. Dismissal (FR-023, FR-019, SC-009)

```bash
curl -X PUT localhost:8000/jobs/$CANONICAL_ID -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"dismissed": true}'

curl -s "localhost:8000/jobs" -H "Authorization: Bearer $TOKEN" | jq '.items[].id'
# expect $CANONICAL_ID ABSENT — dismissed is excluded by default (behavior change, FR-019)

curl -s "localhost:8000/jobs?dismissed=true" -H "Authorization: Bearer $TOKEN" | jq '.total'
# expect it to reappear
```

Note `$CANONICAL_ID` comes from `GET /jobs`, **not** from the ingest response (R13).

Re-scrape the same URL and confirm `dismissed` survives (it is not overwritten — FR-010).

---

## 7. Lifecycle symmetry (FR-027, FR-028, SC-008, SC-010)

**Zero orphans after expiration (SC-008)** — the query that proves R3:

```sql
SELECT count(*) FROM scraped_jobs s
 WHERE NOT EXISTS (SELECT 1 FROM linkedin_jobs  WHERE id = s.source_row_id)
   AND NOT EXISTS (SELECT 1 FROM indeed_jobs    WHERE id = s.source_row_id)
   AND NOT EXISTS (SELECT 1 FROM glassdoor_jobs WHERE id = s.source_row_id);
-- expect 0
```

Run it after `run_auto_expiration`. Non-zero means the fourth DELETE's predicate is not
matching the per-source ones — most likely `scrape_time` was defaulted rather than copied (R2).

**Claim agreement (SC-010)**:

```sql
SELECT count(*) FROM scraped_jobs s JOIN linkedin_jobs l ON l.id = s.source_row_id
 WHERE s.matched <> l.matched;   -- expect 0; repeat for indeed_jobs, glassdoor_jobs
```

---

## 8. Per-source tables unchanged (FR-009, SC-005)

```bash
docker compose exec -T postgres psql -U jha -d jha -c '\d linkedin_jobs'  # 39 columns
docker compose exec -T postgres psql -U jha -d jha -c '\d indeed_jobs'    # 45 columns
docker compose exec -T postgres psql -U jha -d jha -c '\d glassdoor_jobs' # 48 columns
```

Counts must match `docs/live-per-source-schemas.md` exactly. Migration `030` must not touch
these tables.

---

## Intentional test changes (Principle II)

These are declared, not discovered. Their **existing per-source assertions do not change** —
the unified assertions are additive.

| Test | Change | Why |
|---|---|---|
| `smoke_test_scraped_jobs_merge.py` | **NEW** — 18 assertions | FR-030, FR-031 |
| `smoke_test_auto_expiration.py` | + canonical row removed with its per-source row; + SC-008 orphan count | FR-032 |
| `smoke_test_matched_claim.py` | + claim reaches canonical row; + SC-010 disagreement count | FR-033 |
| `smoke_test_auto_scrape.py` | legacy `ScrapedJob(...)` fixtures **deleted** (not ported); `admin_cleanup` assertion now checks the response keeps all five keys with retired counters at 0; `deleted_per_table` allowlist gains `scraped_jobs` | legacy shape gone; sweeps retired (R10, D2); expiration now covers the canonical table (FR-027) |

Two of those deserve their reasoning recorded, because both look like a test bent to pass:

- **The `admin_cleanup` fixtures were deleted, not rebuilt.** Rebuilding them against the
  unified model would assert nothing — the sweeps they fed are retired, so nothing would
  delete them. The replacement asserts what consumers actually depend on: the endpoint keeps
  every response key and the retired counters read 0.
- **The `deleted_per_table` allowlist changed** because it asserted *only* the three
  per-source tables, and FR-027 deliberately adds a fourth. A positive assertion that
  `scraped_jobs` **is** present was added alongside — its absence would mean canonical rows
  outlive their sources, which is the bug the allowlist edit could otherwise have masked.

Editing a test until it passes is a Principle II violation. Each change above traces to a
requirement.

---

## Definition of done

**All verified 2026-07-15** against the running stack, not from memory.

- [x] `alembic current` = 030; backend boots; `/health` 200 (FR-029) — `030 (head)`, HTTP 200
- [x] `\d scraped_jobs` shows **exactly three** indexes; no `source_raw` (R5, FR-005a) — 3 indexes; `source_raw`/`source_table` column count 0
- [x] All four smoke tests pass (FR-030–FR-033, SC-007) — 4/4, 63 assertions, checked by exit code
- [x] Dual-write verified per site; `scrape_time` identical across each pair (SC-002, R2) — `s.scrape_time = p.scrape_time` true for all three sites
- [x] Forced canonical failure leaves **no** per-source row (FR-008) — fault-injected via a CHECK only the canonical INSERT can violate; both counts 0
- [x] `grep projection_unknown_salary_period` is **empty** after a real scan (FR-015, R7) — **verified differently, and more strongly.** No new scan was run; instead the normalizer was run over **every distinct period token in the 939 live per-source rows**: `YEARLY`→ANNUAL (114), `HOURLY`→HOURLY (112), `ANNUAL`→ANNUAL (53), `WEEKLY`→WEEKLY (1), `''`→None. **Zero postings would lose their period.** That covers every token the sites have actually emitted, which one scan would not. The only live warning is the smoke suite's deliberate `FORTNIGHTLY` case. `projection_bad_posted_at`: 0
- [x] `GET /jobs` returns canonical names across all three sites (FR-021, SC-001, SC-003) — `source_site`/`title`/`location_text`/`posted_at`/`scrape_time`; 200 (was 500)
- [x] Orphan count 0; claim disagreement count 0 (SC-008, SC-010) — both 0
- [x] Per-source column counts still 39 / 45 / 48 (FR-009, SC-005) — unchanged
- [x] `GET /jobs` unauthenticated → 401 (FR-022) — 401

**Still open, outside this feature**: the frontend Jobs page remains broken until spec 007
adapts to the canonical field names (FR-021, accepted); removing `recordSkip` from the
extension would let the `skip_reason` no-op branch and the legacy `ScrapedJobIngest` fields go.
