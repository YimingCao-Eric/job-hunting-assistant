# JHA — Project Summary & Work Log

*Written 2026-07-16. A plain-language overview of what the Job Hunting Assistant does, its
current architecture after the search-only rebuild, and the spec-driven work that got it here.*

---

## 1. What the project does

**Job Hunting Assistant (JHA)** collects job postings from the major Canadian job boards into
one searchable local database, so you can review them in one place instead of tab-hopping.

It has three parts:

- **Chrome extension (Manifest V3)** — the scraper. It opens LinkedIn, Indeed Canada, and
  Glassdoor Canada, reads each job from the page/API, and posts it to the backend. It can run a
  one-off **Scan** or an unattended **auto-scrape** loop (sites × keywords on a schedule).
- **FastAPI backend** — the store and the brain. It ingests scraped jobs into PostgreSQL,
  serves them back over a REST API, and runs the post-scrape housekeeping (auto-expiration of
  old rows, etc.). Optional Redis wakes the post-scrape step promptly.
- **React (Vite) web UI** — the console. Four pages: **Config** (what to search for), **Jobs**
  (browse/filter scraped jobs), **Logs** (scan run history + debug traces), and **Auto-Scrape**
  (the unattended orchestrator's controls and health).

**Scope note:** JHA *used to* also de-duplicate and AI-match jobs against your resume. That half
was intentionally removed in this round of work (see §3) — the project is now **search-only**:
scrape → store → browse. Dedup and matching can be reintroduced later as new features on top of
the clean data layer we built.

---

## 2. Current architecture (after the rebuild)

```
extension/     Chrome MV3 scraper — LinkedIn / Indeed CA / Glassdoor CA
               content scripts read the page, the service worker posts to the backend

backend/       FastAPI + async SQLAlchemy + Alembic + PostgreSQL (+ optional Redis)
  routers/     config, jobs (ingest + listing), extension, run-log websocket,
               admin/auto-scrape, admin cleanup   ← dedup/matching/profile/skills REMOVED
  auto_scrape/ post-scrape orchestrator: Phase 1 auto-expiration, Phase 2 matched-claim
  core/        config, database, auth, trace, system_settings, redis, auto-scrape lifecycle

frontend/      NEW Vite + React + TypeScript app (rebuilt from scratch this round)
               Tailwind, TanStack Query, 4 pages, DOMPurify-sanitized job descriptions

docker-compose.yml   backend :8000 · frontend :5173 · Postgres 16 · Redis 7
```

### The data model (the important part)

Each scrape writes to **two places at once** (an atomic dual-write):

1. **Per-source tables** — `linkedin_jobs` (39 cols), `indeed_jobs` (45), `glassdoor_jobs` (48).
   These stay faithful to each site's own field shape (the raw, append-only record).
2. **`scraped_jobs`** — a **unified, canonical** table that merges all three sites into one
   shape (`source_site`, `title`, `company`, `location_text`, `description`, `posted_at`,
   `salary_*`, `remote`, `dismissed`, …). This is what `GET /jobs` reads and what the Jobs page
   renders. It's also the substrate a future matching feature will consume — feature 009 added
   five **filter columns** (`employment_type`, `workplace_type`, `language`,
   `education_requirements`, `salary_disclosed`) so that service can read this table alone.

The per-site → canonical field mapping (which source column each canonical field comes from, per
site, with transforms) is documented in **`docs/live-per-source-schemas.md`**.

Key invariants: schema changes go through Alembic (head **031**); per-source tables are
append-only except a one-way `matched` flag and shelf-life expiration; the `matched` claim and
auto-expiration keep the per-source row and its canonical twin **in sync** (claim flips both;
expiring one deletes the other). Salaries are stored exactly as quoted (never annualized) and
periods normalized to `HOURLY/DAILY/WEEKLY/MONTHLY/ANNUAL`; dates normalized to `timestamptz`. The
filter columns follow the same tri-state discipline (NULL = "site didn't say", never "no"):
`employment_type` is a seven-token set (incl. `PERMANENT`), `workplace_type` is REMOTE/HYBRID/ONSITE
(LinkedIn+Indeed only — Glassdoor NULL pending a scraper fix), and `salary_disclosed` is tri-state
provenance.

---

## 3. What we did this round (the work log)

This whole effort was a hands-on run through **Spec-Driven Development (SDD)** using **GitHub
Spec Kit** and Claude Code — starting from never having used it, and ending with a shipped
rebuild. The loop each time: **constitution → specify → clarify → plan → tasks → analyze →
implement**, with the existing `smoke_test_*.py` suite as the behavioral contract.

### Phase A — Learn SDD and document the existing system
- Installed Spec Kit (`specify init`, agent = Claude, script = py) and learned the workflow.
- Wrote a **constitution** (`.specify/memory/constitution.md`) codifying JHA's real coding
  standards — Alembic discipline, append-only tables, atomic writes, async/fresh-session,
  auth boundary, smoke tests as the contract, surgical change.
- Produced **as-built specs** documenting the existing code as it actually behaved, module by
  module, each with an optimization backlog:
  - `specs/001` post-scrape orchestrator · `specs/002` jobs ingest/listing ·
    `specs/003` dedup pipeline · `specs/004` matching pipeline · `specs/005` scrape orchestrator.

### Phase B — Split to search-only (`specs/006-search-only-backend`)
- Removed **all dedup and matching** from the backend: the `dedup/`, `matching/`, `profile/`
  packages; the dedup/matching/profile/skills/job_reports routers, models, and schemas; the
  `llm`/`dedup_mode` config fields; the post-scan sync-dedup trigger and the post-scrape
  Phase 4–6 stubs.
- Verified boot, `/health`, and the search/auto-scrape smoke tests stayed green. Zero
  functional regression to scraping.

### Phase C — Fix Glassdoor scraping (`007-glassdoor-jd-cors-fix`)
- Diagnosed from a DevTools log: every Glassdoor job-detail fetch was CORS-blocked because the
  extension fetched from a locale subdomain (`fr.glassdoor.ca`) while the page was on
  `www.glassdoor.ca`. Fixed `extension/content/glassdoor/fetch_jd.js` to pin the URL to the
  page's own origin (same-origin → no CORS). Glassdoor scraping went from 0 rows to working.

### Phase D — Unified `scraped_jobs` (`specs/008-unified-scraped-jobs`)
- The problem: real scrapes wrote only to per-source tables, but `GET /jobs` read the empty
  legacy `scraped_jobs` — so the Jobs page had no data ("J1 dual-store" gap).
- Redesigned `scraped_jobs` as the **unified merged table** (Alembic migration 030), made
  ingest **dual-write** atomically, rewrote `GET /jobs` to read canonical fields, and added
  **lifecycle symmetry** (matched claim-sync + expire-both). Salary-vocabulary validated against
  every distinct token in 939 live rows. Verified end-to-end by a real scan: **737 jobs**
  (LinkedIn 606 / Indeed 63 / Glassdoor 68) now flow into `scraped_jobs`.

### Phase E — Rebuild the frontend (`specs/007-frontend-redesign`)
- Rebuilt the disorganized old UI (mixed JS/TS, three styling systems, dead pages) as a clean
  **Vite + React + TypeScript** app: one styling system (Tailwind), **TanStack Query** for
  server state, a top-nav shell, and four pages reading the canonical API.
- Enforced correctness structurally: a real `tsc` + ESLint gate, an ESLint rule banning the
  consume-and-commit `/extension/pending*` routes, a four-shape backend-error normalizer, and
  **135 unit tests** on the trap-prone pure logic (tri-state `remote`, salary formatting, error
  normalization). Job descriptions render through **DOMPurify** (formatting kept, XSS stripped).
- Cut over cleanly: built in `web/`, then `git mv web frontend` so `docker-compose.yml` needed
  **zero edits**. New app serves on `:5173`.

### Phase F — Extend the canonical projection for matching (`specs/009-canonical-filter-columns`, "JHA-A")
- Added five nullable **filter columns** to `scraped_jobs` (Alembic migration **031**, off 030) —
  `employment_type`, `workplace_type`, `language`, `education_requirements`, `salary_disclosed` —
  populated per-site at dual-write time, so a future filtering/matching service reads this one
  table with no per-source joins. Per-source tables and `GET /jobs` untouched (byte-identical).
- Ran the SDD loop with a **live 3-site warning review** (FR-005d) that resolved three vocabulary
  gaps against real data rather than guesses: LinkedIn `workplace_type` comes from its **URN enum**
  (`fs_workplaceType:1/2/3` → ONSITE/REMOTE/HYBRID — the original label-based fixture was fiction);
  Indeed **"Permanent" → new `PERMANENT` token** (vocabulary now seven, a tenure axis, not hours);
  Indeed salary source **"EXTRACTION" → `salary_disclosed=TRUE`** (employer-authored JD prose).
- Caught a stale-data trap: `ON CONFLICT DO NOTHING` means canonical rows are never recomputed, so
  pre-fix rows keep their NULLs until they age out — "LinkedIn workplace = 0" looked like a
  regression but was proven correct by replaying stored payloads (REMOTE 180 / HYBRID 123 /
  ONSITE 76). Truncate + rescan to refresh immediately.

---

## 4. Where things stand

- **Search-only backend**: shipped and merged to `main`. All four smoke tests green.
- **Unified `scraped_jobs`**: shipped and merged; a real scan proved 737 jobs flow through.
- **Frontend rebuild**: complete (94/94 tasks, 135 tests). The `web/ → frontend/` cutover is
  **staged/committed locally** and being merged to `main`.
- **Canonical filter columns (feature 009 / "JHA-A")**: shipped (migration 031, 48/48 tasks). A
  live 3-site scan verified population per site; the projection is correct on every observed token.
- **Backend files touched by the frontend work**: zero.

### Next: the standalone filtering/matching service
The removed dedup+matching half returns as a **separate** on-demand service that reads only
`scraped_jobs` and writes its own `filtered_jobs`/`matched_jobs` — designed in
`filter-matching-service-design.md`. Two JHA prerequisites remain before it's built: **JHA-B**
(retire the vestigial post-scrape matched-claim so `matched` stays FALSE for the service to claim —
still pending; the auto-claim in `auto_scrape/post_scrape_orchestrator.py` still flips it) and
**JHA-C** (a frontend **Profile** page + `profile` table, since the user enters their profile on
the frontend). Playbooks for JHA-A/B are in `jha-prereq-cmds.md`.

### Known follow-ups (deliberately deferred)
- **Two manual checks** the tooling couldn't automate: quickstart **S1.6** (360px responsive
  layout) and **S6.9** (the unsaved-changes guard firing) — need a human in a real browser.
- **The README is stale.** Top-level `README.md` still describes the old dedup/matching/profile/
  skills architecture *and* documents `scraped_jobs` columns that migration 030 deleted
  (`dedup_*`, `original_job_id`, `website`, `skip_reason`); it should be brought to the search-only
  + 031 reality. Its own docs pass (out of every feature's scope so far).
- **Glassdoor `workplace_type` is always NULL.** The scraper doesn't capture `remote_work_types`,
  so the projection correctly writes NULL for every Glassdoor row — a **scraper-layer** follow-up,
  its own feature. Downstream must gate remote on `remote`, not `workplace_type` (which would
  silently drop the whole Glassdoor corpus).
- **Constitution §II lists three smoke tests where four now exist.** Needs its own
  `/speckit-constitution` **PATCH (1.1.1)** with a version bump; also generalize the wording so it
  stops enumerating filenames and drifting.
- **Stale pre-fix canonical rows.** `ON CONFLICT DO NOTHING` never recomputes existing rows, so
  values added by a projection change only appear on newly-inserted rows; old rows self-heal within
  one shelf-life, or immediately via a truncate + rescan.
- **Pagination tiebreaker**: `GET /jobs` orders by `scrape_time DESC` with no tiebreaker, so page
  boundaries can drop/repeat a row on ties. One-line backend fix later: add `id` as a secondary
  sort key.

### Key reference docs
- `.specify/memory/constitution.md` — the coding standards.
- `docs/live-per-source-schemas.md` — live per-source schemas + the unified merged-table mapping
  (authoritative for the per-site → canonical field lineage, incl. the 031 filter columns).
- `specs/001`–`009` — the as-built and feature specs (spec, plan, tasks, research, contracts).
- `filter-matching-service-design.md` — design for the next, standalone filtering/matching service
  (reads `scraped_jobs`; JHA-A/B/C prerequisites). `jha-prereq-cmds.md` — JHA-A/B command playbooks.
- `docs/current-workflow.md`, `docs/current-schemas.md`, `docs/jha-onboarding.md` — older design
  docs (predate the split; verify against the live schema/README before trusting).

---

*Bottom line: JHA is now a focused **job-search aggregator** — a Chrome extension scrapes
LinkedIn, Indeed, and Glassdoor into one canonical Postgres table, a FastAPI backend serves it,
and a clean React console lets you configure searches, browse jobs, watch scan logs, and run the
unattended auto-scraper. The dedup/AI-matching layer was removed to make that core solid first,
and the whole change was done spec-first with tests and live-data verification at every step.*
