# JHA prerequisites for the filter-matcher service — status & record

> **Status (2026-07-17): the two backend prerequisites are SHIPPED.** This file was originally a
> pre-build playbook of Claude Code + Spec Kit commands for JHA-A and JHA-B; both are now done, so it
> is now a **record** of what landed. The authoritative artifacts are the feature specs
> (`specs/009-canonical-filter-columns`, `specs/010-retire-matched-autoclaim`). One prerequisite
> remains — **JHA-C** — and it has no playbook yet.

The standalone filtering/matching service (`docs/filter-matching-service-design.md`) reads the canonical
`scraped_jobs` table and claims rows via `matched`. Three JHA-side changes stand between the
search-only backend and that service:

## JHA-A — Extend the canonical `scraped_jobs` projection ✅ SHIPPED (feature 009)

Added five nullable **filter columns** to `scraped_jobs` so the service can read this one table with
no per-source joins: `employment_type`, `workplace_type`, `language`, `education_requirements`,
`salary_disclosed`. Alembic migration **031** (off 030); populated per-site at dual-write time by
`backend/core/scraped_job_projection.py`. A live 3-site warning review resolved the vocabulary
against real data:

- `employment_type` is a closed **seven**-token set incl. `PERMANENT` (a tenure axis, not hours).
- LinkedIn `workplace_type` comes from its URN enum (`fs_workplaceType:1/2/3` → ONSITE/REMOTE/HYBRID).
- Glassdoor `workplace_type` is always NULL (scraper doesn't supply `remote_work_types`).
- Indeed `salary_disclosed = TRUE` includes `EXTRACTION` (pay parsed from JD prose).

NULL always means "this site did not say." The five columns are deliberately **not** exposed by
`GET /jobs`. Full record: `specs/009-canonical-filter-columns/` and `docs/live-per-source-schemas.md`.

## JHA-B — Retire the vestigial post-scrape matched-claim ✅ SHIPPED (feature 010)

Removed the auto-claim from `run_post_scrape_phase` and **deleted** `auto_scrape/matching_claim.py`,
so `matched` now stays `FALSE` after a scrape for the service to claim. The post-scrape run is
auto-expiration → finalize; a completed cycle records
`match_results = {"claim_summary": null, "claim_retired": true}`. `smoke_test_matched_claim.py` was
repurposed to assert the inverse (rows stay unclaimed) while keeping its agreement/schema invariant
checks. Constitution → **1.1.1** (a one-line PATCH — the `auto_scrape/` module-layout parenthetical).

This was the one hard blocker: until it landed, the service's `WHERE matched = FALSE` claim would
have found zero rows after any post-scrape cycle. Verified on real data (truncate + scan → 113 rows
all `matched = FALSE`). Full record: `specs/010-retire-matched-autoclaim/`.

**Pre-010 backlog caveat:** rows ingested *before* the retirement are `matched = TRUE` and were not
back-filled — only post-010 rows are guaranteed unclaimed (spec 010 FR-004b).

## JHA-C — Profile input on the frontend 🆕 STILL NEEDED (no playbook yet)

The user enters their profile on the JHA frontend (`PROFILE-SRC` resolved): a **Profile** page
(alongside Config) writes a validated profile to a JHA-owned `profile` table (one active row) in the
shared Postgres; the service reads the active row at run start. See `docs/filter-matching-service-design.md`
§1/§7. **Not a blocker for starting the service** — a `PROFILE_PATH` JSON file works first; wire the
DB table later.

---

*When JHA-C is built, run it through the full SDD loop like 009/010. The service itself is a
separate repo with its own constitution — see `docs/filter-matching-service-design.md`.*
