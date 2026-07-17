# Quickstart: Validating the Canonical Filter Columns

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](./plan.md) | **Data model**: [data-model.md](./data-model.md)

How to prove this feature works end to end. Run top to bottom; each step gates the next.

---

## ⚠️ Read this first: the rebuild trap

**The `backend` service has no source mount.** `docker-compose.yml` mounts only `./data:/app/data`,
so code is baked into the image at build time. **Editing a file on the host changes nothing in the
running container until you rebuild.**

This fails *silently*. On 2026-07-15 migration `030` was invisible to `alembic upgrade head` inside
the container — it printed `029 (head)` and exited 0, exactly as if the file didn't exist. Nothing
errored. The natural next move is to debug a migration that is in fact correct.

After **every** backend edit:

```bash
docker compose up -d --build backend
```

Migrations run automatically at container startup (`run_migrations`, `backend/main.py:16`), so the
rebuild also applies `031`; an explicit `alembic upgrade head` is usually redundant.

**If a change appears to have no effect, suspect a stale image before suspecting the code.**

> Host `python` is broken (`ModuleNotFoundError: No module named 'encodings'`). Run **all** Python —
> smoke tests, Alembic, throwaway scripts — inside the container. Do not try to fix the host
> interpreter.

## Prerequisites

- Docker Compose stack up; DB service is **`postgres`** (not `db`), credentials `jha` / `jha` / `jha`
- Migrations applied through **`031`**
- API reachable at `http://localhost:8000` (override with `SMOKE_BASE_URL`)
- A valid bearer token — every route except `/health` requires auth (Principle VII)

---

## Step 1 — Migration applied, shape correct

```bash
docker compose exec -T postgres psql -U jha -d jha -c '\d scraped_jobs'
```

**Expect**:
- **27 columns** (22 + 5). The new ones: `employment_type varchar(16)`, `workplace_type varchar(16)`,
  `language varchar(8)`, `education_requirements text`, `salary_disclosed boolean`
- All five **nullable**, **no defaults** — a default would manufacture the third state FR-002 forbids
- **Exactly three indexes**: `scraped_jobs_pkey`, `scraped_jobs_job_url_key`,
  `ix_scraped_jobs_scan_run_id` — **no new index** (CC-12)

Confirm the chain (must report `031`, chained off `030`, with `030` unedited):

```bash
docker compose exec -T backend alembic current
docker compose exec -T backend alembic history | head -3
```

## Step 2 — Existing behavior is intact (run before anything else)

The regression gate. If any of this fails, stop.

```bash
docker compose exec -T backend python smoke_test_auto_scrape.py
docker compose exec -T backend python smoke_test_matched_claim.py
docker compose exec -T backend python smoke_test_auto_expiration.py
```

**Expect**: all pass **unedited** (FR-022). These three are untouched by this feature.

> Note: Constitution §II lists only these three, but **four** smoke tests exist —
> `smoke_test_scraped_jobs_merge.py` (added by 008) is missing from that list. The authoritative
> suite is the four files on disk. See plan.md → Fidelity defects.

**`GET /jobs` must be byte-identical** (FR-018). If you captured a baseline in Step 0, diff it:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8000/jobs?limit=5" > /tmp/jobs_after.json
diff /tmp/jobs_before.json /tmp/jobs_after.json && echo "IDENTICAL"
```

**If no baseline exists** (as happened here — `031` shipped before anyone captured one), the diff is
unavailable but FR-018 is still closable, by a **stronger** argument than a diff:

```bash
# 1. The response shape is defined by an explicitly-listed Pydantic model. If it is
#    untouched, no field can have appeared. (Empty output = untouched.)
git diff --stat HEAD -- backend/schemas/scraped_job.py backend/routers/jobs.py

# 2. Prove it empirically against rows that DO carry the new columns in the database.
docker compose exec -T backend python -c "
import httpx
NEW = ['employment_type','workplace_type','language','education_requirements','salary_disclosed']
h = {'Authorization': 'Bearer dev-token'}
items = httpx.get('http://localhost:8000/jobs?limit=50', headers=h, timeout=10).json()['items']
leaked = sorted({f for it in items for f in NEW if f in it})
print('rows scanned:', len(items), '| new columns leaked:', leaked or 'NONE')
print('fields per item:', len(items[0]))"
```

**Expect**: `git diff` empty; `leaked: NONE`; **22 fields** per item.

*Verified 2026-07-17*: `schemas/scraped_job.py` and `routers/jobs.py` untouched; **518 rows** had
`employment_type` populated in the database; `GET /jobs/{id}` and `GET /jobs?limit=50` both returned
**22 fields** with **zero** of the five leaking. This is better evidence than a before/after diff
would have been: it shows rows whose canonical columns are *populated* being served without them,
which a diff over pre-`031` data could not have demonstrated.

**Why it holds**: `ScrapedJobRead` (`schemas/scraped_job.py:43`) is an explicit field list, and it
was deliberately **not** extended. The five columns exist in the table and on the ORM model but
reach no response. That omission is load-bearing — "completing" the schema would break FR-018
without touching a single requirement.

**SC-007 — same number of DB statements per posting.** Satisfied **by construction**:
`routers/jobs.py` is untouched (see the `git diff` above), so the ingest path executes exactly the
statements it did before — one per-source `INSERT`, one canonical `INSERT`. The five attributes are
computed in memory from the params dict the ingest already holds; `INSERT_SCRAPED_JOB` gained five
bind parameters, not a round trip. Zero added queries, reads, or round trips. This is a *structural*
claim, checkable exactly — not a timing target needing a benchmark harness this project does not
have.

## Step 3 — The projection contract

```bash
docker compose exec -T backend python smoke_test_scraped_jobs_merge.py
```

**Expect**: all pass, including the added assertions. Every edit here is **additive** — if a
*pre-existing* assertion fails, that is a real regression, not a test that needs updating
(Principle II).

Covers: per-site population and NULL-where-not-supplied (US1/US2/US3); `Other` → NULL with **no
warning**; precedence on a multi-tagged posting; determinism under reversed payload order
(SC-003a); unrecognized salary source → NULL **not** false (FR-010b); multi-label education join
(FR-012b).

## Step 4 — Real scan, real data

Run a scan through the extension covering **all three sites**, then:

```bash
docker compose exec -T postgres psql -U jha -d jha -c "
SELECT source_site,
       count(*)                                        AS rows,
       count(employment_type)                          AS employment,
       count(workplace_type)                           AS workplace,
       count(language)                                 AS language,
       count(education_requirements)                   AS education,
       count(salary_disclosed)                         AS salary_disclosed
FROM scraped_jobs
WHERE scrape_time > now() - interval '1 hour'
GROUP BY source_site ORDER BY source_site;"
```

**Expect** (SC-004 — coverage is uneven *by design*):

| | linkedin | indeed | glassdoor |
|---|---|---|---|
| `language` | **0** | > 0 | **0** |
| `education` | **0** | **0** | ≥ 0 |
| `employment` | ≥ 0 | ≥ 0 | ≥ 0 |
| `workplace` | > 0 | > 0 | **0** ← expected; see below |
| `salary_disclosed` | ≥ 0 | > 0 | ≥ 0 |

A non-zero `language` on a LinkedIn row, or `education` on an Indeed row, is a projection bug.

**Glassdoor `workplace` = 0 is expected, not a regression** (FR-005f, SC-002a): the scraper returns
`remote_work_types` empty, so there is nothing to map and NULL is the truthful output. The mapping
is correct and needs no change once the extension supplies the field. **Glassdoor `workplace` > 0
means the scraper gap is fixed** — good news, and worth updating FR-005f/SC-002a for.

**LinkedIn `workplace` = 0** means one of two very different things. Check which **before** raising
an alarm:

1. **Stale rows (expected until the next scan).** Canonical rows are projected once, at ingest, and
   **never recomputed** — re-scrape is `ON CONFLICT (job_url) DO NOTHING`. Every row ingested before
   the 2026-07-17 URN fix therefore keeps its pre-fix NULL *even though the per-source row carries a
   perfectly good URN*. This is FR-023's no-backfill decision playing out, and it self-heals within
   one shelf-life as rows expire and are re-scraped fresh.
2. **A real regression** — the enum mapping broke again. Check for `projection_bad_value_shape` in
   Step 5.

**Tell them apart by replaying the stored payloads through today's projection** — no scan needed,
and it reads nothing but the raw rows:

```bash
docker compose exec -T backend python -c "
import asyncio
from collections import Counter
from sqlalchemy import text
from core.database import AsyncSessionLocal
from core.scraped_job_projection import normalize_workplace_type
async def main():
    async with AsyncSessionLocal() as db:
        vals = (await db.execute(text('SELECT workplace_types_labels FROM linkedin_jobs'))).scalars().all()
        await db.commit()
    print(Counter(normalize_workplace_type(v, site='linkedin') for v in vals))
asyncio.run(main())"
```

If the replay yields tokens but the canonical column is NULL, the mapping is **fine** and the rows
are merely stale (case 1). If the replay also yields `None` across the board, the mapping is broken
(case 2).

*Measured 2026-07-17, immediately after the fix landed*: replay yielded `REMOTE 180, HYBRID 123,
ONSITE 76, None 88` — **379 of 467 rows would populate** — while the canonical column was `0`.
Textbook case 1. Same for Indeed `salary_disclosed` (replay: `True 22`, canonical: `0`) and one real
`PERMANENT` row. The resolutions are correct and verified against live payloads; the **data** just
predates them.

Cross-site consistency (SC-003) — one full-time remote posting per site should agree:

```bash
docker compose exec -T postgres psql -U jha -d jha -c "
SELECT source_site, employment_type, workplace_type, count(*)
FROM scraped_jobs
WHERE scrape_time > now() - interval '1 hour'
GROUP BY 1,2,3 ORDER BY 1,2;"
```

## Step 5 — The warning review ✅ DONE (2026-07-17) — re-run after any mapping change

**Completed against a live three-site scan; three findings closed (FR-005e).** The mappings shipped
*reasoned, not observed* — exactly one live source value was attested in the repo (Glassdoor
`remoteWorkTypes: ["REMOTE"]`) — and this review is what corrected them:

| Finding | Resolution |
|---|---|
| LinkedIn `workplace_types_labels` is a **URN map**, not labels — the original mapping assumed labels and **NULLed every LinkedIn row, silently** | Map enum codes `URN:LI:FS_WORKPLACETYPE:1/2/3` → `ONSITE`/`REMOTE`/`HYBRID` |
| Indeed sends `"Permanent"` as a job type | New token **`PERMANENT`**; vocabulary 6 → 7. Tenure axis, ranked below the hours tokens |
| Indeed `salary_snippet_source` = `"EXTRACTION"` for its **entire** salary population | → **`true`**. Employer-authored prose; Indeed estimated nothing, so the tri-state rule ruled `false` out |

The first finding is the argument for this whole step: it produced **no wrong value**, only a silent
absence, and would have shipped looking exactly like "LinkedIn doesn't report workplace type".

**Re-run this whenever the mapping, a site's payload, or the scraper changes:**

```bash
docker compose logs backend | grep -E "projection_(unknown_employment_type|unknown_workplace_type|unknown_salary_source|bad_language|bad_value_shape|workplace_remote_conflict)"
```

For **each distinct** raw value reported: either add it to the mapping (`FR-005a` table + the code)
or consciously leave it unmapped and record why. Then update `docs/live-per-source-schemas.md`.

Five tokens remain deliberately unmapped (FR-005c) — `FREELANCE`, `PER_DIEM`, `APPRENTICESHIP`,
`COMMISSION`, `NEW_GRAD`. If they appear, resolve them with real evidence rather than by argument.
(`PERMANENT` was on this list; the 2026-07-17 scan supplied the evidence and it now has its own
token. That is the process working, not an exception to it.)

**`projection_bad_value_shape` is the one to watch.** It fires when a source value cannot be read
*as text at all* — a jsonb object where a label was expected, a number, a nested list. It means the
site changed its payload **structure**, which nulls the column for every affected posting. This is
the class the LinkedIn URN bug belonged to, and the reason a silent skip was replaced with a warning.

**`projection_workplace_remote_conflict` is different** — it reports a LinkedIn upstream data
contradiction (FR-009b), not a vocabulary gap. It needs no mapping change; do not let it pollute the
review.

**SC-009 gate — warnings must be signal, not noise**: a scan of normally-behaving postings must emit
**zero** warnings for these five attributes. In particular, an `Other` employment status must produce
**no** warning (FR-008d). If normal postings warn, the classification is wrong.

> **Caveat** (checklist CHK037): if the scan returned no postings from a site, that site's mapping is
> still unverified. Note it; don't record a pass you didn't earn.

## Step 6 — Docs match reality (FR-009a)

```bash
grep -nE "employment_type|workplace_type|salary_disclosed|education_requirements" docs/live-per-source-schemas.md
```

**Expect** the merged-table section shows **27 columns**, the per-site mapping for all five, and —
required by FR-009a — the note that **`workplace_type` and `remote` can disagree**, so the future
service's authors find it before depending on `remote`.

---

## Done when

**Walked end to end 2026-07-17. All gates closed.**

- [X] `031` applied (`alembic current` → `031 (head)`); **27 columns**; 5 nullable with no defaults;
      **3 indexes** (Step 1)
- [X] Three untouched smoke tests pass **unedited** (Step 2)
- [X] **`GET /jobs` byte-identical** (Step 2, FR-018) — closed empirically. `schemas/scraped_job.py`
      and `routers/jobs.py` untouched per `git diff`; 518 rows with populated columns served across
      `/jobs/{id}` and `/jobs?limit=50` at **22 fields**, **zero** leakage
- [X] **SC-007** — same statement count per posting, by construction (`routers/jobs.py` untouched;
      five in-memory mappings, no added round trip)
- [X] Merge smoke test passes, including additive assertions (Step 3)
- [X] Real scan: per-site population matches the expected shape (Step 4) — **see the stale-rows
      caveat**: LinkedIn `workplace` reads 0 because those rows predate the URN fix and are never
      recomputed, not because the mapping is broken (replay proves 379/467 would populate)
- [X] **Warning review done**; three findings closed, five tokens consciously left unmapped (Step 5)
- [X] Zero warnings from normal postings, including `Other` (Step 5, SC-009)
- [X] `docs/live-per-source-schemas.md` updated, including the `remote` discrepancy (Step 6)

**Known and accepted at close:**

- **SC-002a** — `workplace_type` does not cover Glassdoor (scraper returns `remote_work_types`
  empty). Projection correct, mapping ready; scraper-layer follow-up.
- **Live rows predate the 2026-07-17 resolutions.** No backfill (FR-023), and re-scrape is a no-op,
  so LinkedIn `workplace_type`, Indeed `salary_disclosed`, and the `PERMANENT` token appear only on
  rows ingested from the next scan onward. Self-heals within one shelf-life.
- **Constitution §II lists three smoke tests; four exist.** `smoke_test_scraped_jobs_merge.py` is
  missing from the enumeration. Left alone deliberately — amending the constitution needs a version
  bump and template propagation, so it belongs in its own `/speckit-constitution` run, not this
  feature's diff.

## Known-good deviations — do not "fix" these

Each is a deliberate, spec-recorded decision. Seeing one and repairing it is how this feature regresses.

| Observation | Why it's correct |
|---|---|
| A Glassdoor hybrid-only row has `remote = true` **and** `workplace_type = HYBRID` | FR-009a — `remote` is shipped 008 behavior; not corrected here |
| An Indeed hybrid posting reads `ONSITE` | FR-009 — Indeed cannot express hybrid; accepted mislabel |
| `education_requirements` equals `experience_level` on some Glassdoor rows | FR-012a — accepted duplication from the fallback |
| A Full-time/Part-time posting reads only `FULL_TIME` | FR-008c — precedence discards the rest |
| A Glassdoor row has employer-shaped amounts but `salary_disclosed = false` | research.md R2 — `salary_source` and the amounts come from two payloads; inherited from 008 |
| Pre-`031` rows have NULL for all five | FR-023 — no backfill; self-heals within one shelf-life |
| **Every live Glassdoor row has `workplace_type = NULL`** | FR-005f / SC-002a — the scraper returns `remote_work_types` empty. **Not** a projection defect: NULL is the truthful answer for a field the row does not carry. The fix is scraper-layer, out of scope here |
| **An Indeed row reads `employment_type = PERMANENT` instead of `FULL_TIME`** | FR-004a — `PERMANENT` is tenure, not hours. The site stated permanence and *not* hours; `FULL_TIME` would assert something it never said. A posting stating both still reads `FULL_TIME` |
| **Every Indeed salary reads `salary_disclosed = true`** | FR-005e — Indeed's whole population is `EXTRACTION` (pay parsed from employer-authored prose). The column encodes provenance, not parse reliability |
| **LinkedIn `workplace_type` maps from `urn:li:fs_workplaceType:N`, not from labels** | FR-005e — LinkedIn sends no labels. The codes are locale-proof; mapping them is better than the labels this feature originally assumed |
