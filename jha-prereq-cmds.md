# JHA prerequisite changes — Claude Code + Spec Kit commands

Two small features had to land in **this repo (JHA)** before the standalone filtering/matching
service (`filter-matching-service-design.md`) could be built. **Both are now shipped:**

- **JHA-A** — Extend the canonical `scraped_jobs` projection (add the columns the matcher needs).
  ✅ **SHIPPED** — feature 009, Alembic **031**.
- **JHA-B** — Retire the vestigial post-scrape matched-claim (so `matched` stays `FALSE` until the
  matcher claims it). ✅ **SHIPPED** — feature 010. The auto-claim is gone from
  `run_post_scrape_phase`, `auto_scrape/matching_claim.py` is deleted, and the constitution's
  module-layout note was corrected (PATCH, 1.1.0 → 1.1.1).

A third prerequisite emerged from the frontend-source decision and is **still needed**:

- **JHA-C** — Profile input page on the frontend (+ a JHA-owned `profile` table). 🆕 No playbook
  written yet.

The command sequences below are **retained as worked examples** of the full SDD loop, not as
to-dos. Base everything on `main`; Spec Kit is already initialized here.

> Reminder for every phase: this is a **backend change** — respect the constitution (new Alembic
> migration per schema change, atomic dual-write, snake_case, no speculative indexes, smoke tests
> as the contract, surgical/behavior-preserving). Verify with `docker compose up -d --build backend`
> (never plain `up -d` — the image bakes code in), and give the backend ~10s before hitting it.

---

## Feature JHA-A — Extend the canonical `scraped_jobs` projection

Adds `employment_type`, `language`, `education_requirements`, `salary_disclosed`, `workplace_type`
to `scraped_jobs`, populated per-site at dual-write time. Migration **031** (chained off 030).

### 1. Branch

```powershell
cd "D:\cym\work\workSpace\New folder (2)\job-hunting-assistant"
git checkout main
git checkout -b 031-scraped-jobs-matching-columns
claude
```

### 2. Specify

```
/speckit-specify Extend the canonical scraped_jobs projection (feature 008) so a future filtering/matching service can read ONLY scraped_jobs without joining the per-source tables. Add five nullable canonical columns to scraped_jobs: employment_type, workplace_type, language, education_requirements, and salary_disclosed (boolean). Populate each from the per-source row at dual-write time, normalized to a canonical form per site, mirroring how feature 008 already transforms salary_period and remote. Per-site sources (verify against docs/live-per-source-schemas.md): employment_type from linkedin formatted_employment_status / indeed job_types / glassdoor job_type or employment_type; workplace_type from linkedin workplace_types_labels / indeed remote_location / glassdoor remote_work_types; language from indeed language else NULL; education_requirements from glassdoor education_labels or experience_requirements_description else NULL; salary_disclosed derived from linkedin salary_provided_by_employer, indeed salary_snippet_source (employer vs site-estimate), glassdoor salary_source. NULL where a site does not provide the field. Acceptance: after a scan, scraped_jobs carries the five new columns populated per site (or NULL), existing GET /jobs and ingest behavior is unchanged, and all existing smoke tests still pass. Do NOT build the separate service. Describe behavior and outcomes, not implementation.
```

### 3. Clarify (settle the per-site canonicalization)

```
/speckit-clarify Resolve: (1) the canonical employment_type vocabulary (e.g. FULL_TIME/PART_TIME/CONTRACT/TEMPORARY/INTERNSHIP) and each site's raw→canonical mapping; (2) canonical workplace_type set (ONSITE/HYBRID/REMOTE) and whether it just refines the existing remote boolean; (3) the exact salary_disclosed rule per site (what counts as employer-disclosed vs a site estimate); (4) education_requirements storage form (free text vs a normalized credential); (5) NULL as the canonical "site doesn't provide it" value for each column.
```

### 4. Checklist → Plan → Tasks → Analyze

```
/speckit-checklist
```
```
/speckit-plan Follow the constitution. Add Alembic migration 031 chained off 030 adding the five nullable columns to scraped_jobs (snake_case, only the columns — no speculative indexes per CC-12). Extend the per-site projection mapper in core/scraped_job_projection.py to populate the new columns from the per-source params (the params dict the *_COLS builders produce), mirroring the existing salary_period/remote transforms, and update CANONICAL_COLS / INSERT_SCRAPED_JOB in the ingest so they're written in the same atomic dual-write. Update the merged-table section of docs/live-per-source-schemas.md with the new column→per-site mapping and transforms. Extend smoke_test_scraped_jobs_merge.py to assert each new column populates for the right sites and is NULL otherwise. Keep the per-source tables and GET /jobs untouched. Mark UNCHANGED vs NEW.
```
```
/speckit-tasks
```
```
/speckit-analyze
```

### 5. Implement + verify

```
/speckit-implement Phase 1: the Alembic 031 migration (add the five columns) plus the projection-mapper changes with unit coverage. Stop after alembic upgrade head and the mapper tests pass.
```
```
/speckit-implement Phase 2: wire the new columns into the atomic dual-write and extend smoke_test_scraped_jobs_merge.py.
```
```powershell
docker compose up -d --build backend
Start-Sleep -Seconds 10
docker compose exec backend alembic upgrade head
docker compose exec backend python smoke_test_scraped_jobs_merge.py
# run a real scan, then confirm the new columns populate per site:
docker compose exec postgres psql -U jha -d jha -c "SELECT source_site, count(employment_type) et, count(language) lang, count(education_requirements) edu, count(salary_disclosed) disc, count(workplace_type) wt FROM scraped_jobs GROUP BY source_site;"
```

### 6. Merge

```powershell
git add -A
git commit -m "Extend canonical scraped_jobs projection for matching (employment_type, workplace_type, language, education, salary_disclosed)"
git checkout main
git merge 031-scraped-jobs-matching-columns
git push origin main
```

---

## Feature JHA-B — Retire the vestigial post-scrape matched-claim

> ✅ **SHIPPED — feature 010** (`specs/010-retire-matched-autoclaim/`). Retained below as a worked
> example of the SDD loop; do not re-run. **What actually shipped differed from the plan sketched
> here in two ways worth knowing:**
>
> 1. **The clarify step resolved to a hybrid**, not either option this playbook offered:
>    `matching_claim.py` was **deleted**, and `smoke_test_matched_claim.py` was **kept** under its
>    own filename, repurposed to assert the inverse (rows stay unclaimed) while retaining its
>    canonical/per-source agreement and column-contract checks. Keeping the filename is why
>    Principle II needed no amendment — it pins tests by filename.
> 2. **The constitutional amendment was one line, PATCH — not four sites and MAJOR.** Principle V's
>    permitted-mutation clauses name no performer, so a permitted-but-unperformed mutation
>    satisfies them unchanged. Only the module-layout parenthetical was falsified.

Stops the post-scrape orchestrator auto-flipping `matched` (its consumer, matching, is gone), so
the future service owns the claim.

### 1. Branch

```powershell
git checkout main
git checkout -b jha-retire-matched-autoclaim
claude
```

### 2. Specify

```
/speckit-specify Retire the vestigial post-scrape matched-claim. Since dedup and matching were removed in the search-only split, the post-scrape orchestrator's Phase 2 (claim_unmatched_rows in backend/auto_scrape/matching_claim.py, called from run_post_scrape_phase in backend/auto_scrape/post_scrape_orchestrator.py) flips scraped_jobs and the per-source matched flag FALSE->TRUE for a consumer that no longer exists. A future standalone filtering/matching service needs matched to stay FALSE after a scrape so that it can claim rows itself. Remove the Phase-2 auto-claim call from the post-scrape orchestrator so that after a scrape and post-scrape run, matched remains FALSE. Keep the matched column on scraped_jobs and the per-source tables (the downstream service uses it as its processed marker). Acceptance: after a scan and post-scrape run, matched is still FALSE on the new rows; auto-expiration (Phase 1) and every other flow are unchanged; the smoke suite still reflects reality. Describe behavior and outcomes.
```

### 3. Clarify

```
/speckit-clarify Resolve: (1) remove matching_claim.py entirely, or keep claim_unmatched_rows as an unused helper for the downstream service to copy; (2) update smoke_test_matched_claim.py to assert the auto-claim no longer runs, or remove that smoke test since the behavior it pinned is retired (Principle II — a passing test for retired behavior shouldn't be deleted lightly, so prefer updating it to assert matched stays FALSE); (3) as-built check per Principle I: confirm nothing else depends on matched being auto-flipped — GET /jobs listing, auto-expiration, admin cleanup, the orchestrator's final cycle write — so removing the auto-claim regresses nothing.
```

### 4. Checklist → Plan → Tasks → Analyze

```
/speckit-checklist
```
```
/speckit-plan Follow the constitution. Remove the Phase-2 matched-claim call from run_post_scrape_phase in post_scrape_orchestrator.py so the post-scrape flow is Phase 1 auto-expiration -> finalize, with no auto-claim. Keep the matched column everywhere. Per the clarify decision, either delete matching_claim.py + smoke_test_matched_claim.py or keep the helper and repoint the smoke test to assert matched stays FALSE after a post-scrape run. Leave auto-expiration, GET /jobs, and the scrape/auto-scrape paths untouched. No schema change (matched column stays), so no migration. Mark UNCHANGED vs NEW/DELETED.
```
```
/speckit-tasks
```
```
/speckit-analyze
```

### 5. Implement + verify

```
/speckit-implement Implement the plan: remove the Phase-2 auto-claim, handle matching_claim.py/smoke_test_matched_claim.py per the clarify decision, and update the affected smoke tests. Stop after the backend boots and the smoke suite is green.
```
```powershell
docker compose up -d --build backend
Start-Sleep -Seconds 10
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_auto_expiration.py
# run a real scan + let post-scrape run, then confirm matched stays FALSE:
docker compose exec postgres psql -U jha -d jha -c "SELECT matched, count(*) FROM scraped_jobs GROUP BY matched;"
```
Expect the new rows to be `matched = f` (false) — proof the auto-claim is retired and the
downstream service will have unclaimed rows to process.

### 6. Merge

```powershell
git add -A
git commit -m "Retire vestigial post-scrape matched-claim; downstream service owns the claim"
git checkout main
git merge jha-retire-matched-autoclaim
git push origin main
```

---

## After both land

- `scraped_jobs` carries the five extra canonical columns (JHA-A) and stays `matched = FALSE`
  after scrapes (JHA-B).
- The standalone **filter-matcher** service can then be built to read only `scraped_jobs`, claim
  via the `matched` flag, and write its own `filtered_jobs` / `matched_jobs` — exactly as
  `filter-matching-service-design.md` specifies.
- Update `README.md` / `docs/live-per-source-schemas.md` if not already done in JHA-A, and note in
  `PROJECT-SUMMARY.md` that these two prerequisites shipped.

> One decision to confirm before the service is built (design §11 `RE-ENTRY-WRITE`): the matcher's
> blacklist re-entry writes `matched = FALSE` back onto JHA's per-source tables. That's the only
> place a separate project writes JHA-owned data — decide whether that's acceptable or whether
> re-entry should be tracked service-locally instead.
