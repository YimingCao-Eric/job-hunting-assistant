# Splitting JHA to "Search-Only" + Rebuilding the Frontend — a Claude Code Guide

**Goal 1** — Remove **all dedup and matching** code (backend + database), leaving only the
**Step-1 search** system: scraping/ingest, config, jobs storage, search logs, and the
auto-scrape orchestrator.
**Goal 2** — Rebuild the frontend from scratch (the old one is disorganized), keeping only
four pages: **Config** (`/`), **Jobs** (`/jobs`), **Logs** (`/logs`), **Auto-Scrape**
(`/dashboard/auto-scrape`).

You'll do this with **Claude Code**, driven by the **as-built specs** you already produced
(`specs/001`–`005`). Those specs are the map: `003-dedup-pipeline` and `004-matching-pipeline`
tell you exactly what to remove and what depends on it; `002` (jobs), `005` (scrape
orchestrator), and `001` (post-scrape) tell you what must keep working.

**Running services (for verification / Chrome inspection):** backend
`http://localhost:8000`, frontend `http://localhost:5173`, Postgres (internal), Redis `6379`.

---

## Part 0 — Prep & safety (do this first)

### 0.1 Commit and push everything (specs + trimmed backlogs + code)
```powershell
cd "D:\cym\work\workSpace\New folder (2)\job-hunting-assistant"
git add -A
git commit -m "Checkpoint: as-built specs + per-module backlogs before search-only split"
git push        # if a remote is configured; otherwise set one up first
```

### 0.2 Create the working branch that holds all current content
```powershell
git checkout -b split/search-only
```
All the removal and redesign work happens here. `main` stays as the full, working system —
so the "split" is non-destructive: if anything goes wrong you still have the complete project
on `main`.

### 0.3 Capture a green baseline
Before removing anything, confirm the current system is healthy so you can tell later what
*your* changes broke versus what was already off:
```powershell
docker compose up --build -d
curl http://localhost:8000/health
docker compose exec backend python smoke_test_auto_scrape.py
```
Note which smoke tests pass now. After the split, the **search-related** ones must still pass.

> **Two goals, two rounds.** Do **Goal 1 (backend split)** completely and verify it, then do
> **Goal 2 (frontend rebuild)**. Because you're rebuilding the frontend anyway, you do **not**
> need to surgically edit the old dedup/matching *pages* — you simply won't rebuild them in
> Goal 2. Goal 1 is therefore mostly a **backend + database** job.

---

## Part 1 — Goal 1: Remove dedup & matching (backend + DB)

### 1.1 The keep / remove inventory (grounded in the code)

**KEEP — the Step-1 search system**

| Area | Keep |
|---|---|
| Routers | `config.py`, `jobs.py` (ingest + listing, pruned), `extension.py`, `run_log_ws.py`, `auto_scrape.py`, `admin_cleanup.py` |
| Packages | `auto_scrape/` (Phase 1 auto-expiration; Phase 2 matched-claim → see decision D2) |
| Models | `scraped_job`, `extension_run_log`, `extension_state`, `auto_scrape_config`, `auto_scrape_cycle`, `auto_scrape_state`, `site_session_state` |
| Schemas | `config`, `extension`, `run_log`, `scraped_job` (pruned), `auto_scrape`, `debug_log` |
| Core | `config`, `config_file`, `database`, `auth`, `trace`, `system_settings`, `redis_client`, `auto_scrape_lifecycle`, `auto_scrape_validation` |
| Tests | `smoke_test_auto_scrape.py`, `smoke_test_auto_expiration.py` |

**REMOVE — dedup + matching**

| Area | Remove |
|---|---|
| Packages | `backend/dedup/`, `backend/matching/`, `backend/profile/` (resume parsing feeds matching) |
| Routers | `dedup.py`, `matching.py`, `profile.py`, `skills.py`, `job_reports.py` |
| Models | `dedup_report`, `dedup_task`, `match_report`, `job_report`, `skill_candidate` |
| Schemas | `dedup`, `match_report`, `profile`, `job_report`, `skill_candidate` |
| Core | `dedup_task_cleanup.py`, `profile_file.py` |
| Tests/scripts | `smoke_test_matched_claim.py` (if you drop Phase 2), `scripts/verify_matched_column.py` |
| Config fields | `llm`, `dedup_mode` (in `config.json` / `schemas/config.py`) |
| Wiring | in `main.py`: unregister the removed routers, drop the `dedup_task_cleanup` startup hook, remove the post-scrape dedup/matching phase calls |

**PRUNE (edit, don't delete)**

- `routers/jobs.py` — the `GET /jobs`, `GET /jobs/{id}`, `PUT /jobs/{id}` responses currently
  surface dedup/match fields (`skip_reason`, `dedup_*`, `match_*`, `has_report`). Strip those
  from the read path and the `scraped_job` response schema. (See spec `002` items **J1**,
  **J10** for exactly where the two stores and dedup fields entangle.)
- `routers/extension.py` — remove the **post-scan sync-dedup** branch (the `dedup_mode == "sync"`
  path that enqueues dedup on run-log completion). (Spec `005` item **S6** documents this.)
- `backend/auto_scrape/post_scrape_orchestrator.py` — remove the calls to the Phase 4–6 stubs
  (`_run_dedup_for_cycle`, `_run_matching_for_cycle`, `_compute_match_results`). Keep Phase 1
  (auto-expiration). (Spec `001`/`current-workflow.md` §5.)

### 1.2 Decision points (settle these in the spec/clarify step)

- **D1 — Database: drop or leave the dead tables/columns?**
  *Recommended:* add a new Alembic migration (`030_search_only_drops`, chained off `029`) that
  DROPs `dedup_reports`, `dedup_tasks`, `match_reports`, `job_reports`, `skill_candidates`, and
  the dedup/matching **columns** on `scraped_jobs` (`skip_reason`, `dedup_original_job_id`,
  `dedup_similarity_score`, `matched_at`, `embedding`, `match_score`, `match_report_id`,
  `removal_stage`, plus the matching columns from migrations 014/015/017). *Safe alternative:*
  leave the tables/columns in place and just remove the code — less clean, zero migration risk.
  Have Claude Code derive the **exact** column list from the models + migrations, not by hand.
- **D2 — Keep or remove the Phase-2 "matched-claim"?** Its only consumer (matching) is gone.
  *Recommended:* remove Phase 2 and the `matched` column (migration 028) since it's now
  vestigial — but only if nothing else reads `matched`. *Safe alternative:* keep it (harmless
  flag) to minimize change. If you keep it, keep `smoke_test_matched_claim.py`.
- **D3 — Collapse the dual store?** Spec `002` **J1** notes per-source rows are largely
  write-only vs the legacy `scraped_jobs`. Deciding whether search-only reads from per-source
  tables or from `scraped_jobs` is a real design choice — **treat it as its own follow-up**,
  not part of the pure removal, or you'll balloon the scope.

### 1.3 Do it with Claude Code (SDD change round)

This is a *change*, so unlike the documentation round you now use `plan → tasks → implement`.
Open Claude Code on the `split/search-only` branch and, ideally, make a feature branch per the
Spec Kit convention:
```powershell
git checkout -b 030-search-only-backend
```

**Specify the target system:**
```
/speckit-specify Reduce the JHA backend to a SEARCH-ONLY system by removing all dedup and matching functionality, keeping scraping/ingest, config, jobs storage, search run-logs, and the auto-scrape orchestrator. Use the as-built specs as the map: specs/003-dedup-pipeline and specs/004-matching-pipeline define what is being removed and its dependencies; specs/002-jobs-ingest-listing, 005-scrape-orchestrator, and 001-post-scrape-phases-1-2 define what must keep working. In scope: delete the dedup, matching, and profile packages; remove the dedup/matching/profile/skills/job_reports routers, models, and schemas; prune dedup/match fields from the jobs read path and scraped_job schema; remove the post-scan sync-dedup trigger and the post-scrape Phase 4–6 stub calls; drop the llm and dedup_mode config fields; unregister removed routers and the dedup_task_cleanup startup hook in main.py. Acceptance: the backend boots, /health is ok, and smoke_test_auto_scrape.py and smoke_test_auto_expiration.py still pass. Describe behavior/outcomes, not implementation.
```

**Clarify the decisions (D1–D3 above):**
```
/speckit-clarify Resolve: (1) do we drop the dead DB tables/columns via a new Alembic migration 030, or leave them; (2) do we remove the Phase-2 matched-claim and the matched column, or keep them as a harmless flag; (3) is collapsing the dual store (per-source vs scraped_jobs) in scope now or deferred. For each, pick the lower-risk option unless there's a clear reason.
```

**Checklist, then plan (file-level, dependency-aware):**
```
/speckit-checklist
```
```
/speckit-plan Follow the constitution. Plan the removal in dependency order so the backend never imports a deleted module: (1) unregister routers and startup hooks in main.py and remove the post-scrape dedup/matching phase calls; (2) delete the dedup/matching/profile packages and the dedup/matching/profile/skills/job_reports routers/models/schemas; (3) prune dedup/match fields from routers/jobs.py and schemas/scraped_job.py; (4) remove the llm/dedup_mode config fields and any references; (5) if D1=drop, add Alembic migration 030 chained off 029 dropping the dead tables and scraped_jobs columns — derive the exact list from the models and migrations 011/014/015/017/018/019/022/028, never by hand. Keep Phase-1 auto-expiration and the scrape/auto-scrape paths untouched. Update smoke tests: keep the search ones, remove matched-claim/verify_matched_column per D2. Mark UNCHANGED vs NEW/DELETED in the plan.
```

**Tasks → analyze → implement in phases:**
```
/speckit-tasks
```
```
/speckit-analyze
```
Implement in the dependency order from the plan, verifying between slices:
```
/speckit-implement Phase A: main.py wiring only — unregister removed routers, drop dedup_task_cleanup startup, remove post-scrape Phase 4–6 calls. Backend must still boot with the old modules present but unused. Stop after /health is ok.
```
```
/speckit-implement Phase B: delete the dedup, matching, and profile packages and the dedup/matching/profile/skills/job_reports routers, models, and schemas. Fix every resulting import error. Stop after the backend boots.
```
```
/speckit-implement Phase C: prune dedup/match fields from routers/jobs.py and schemas/scraped_job.py, and remove the llm/dedup_mode config fields and references.
```
```
/speckit-implement Phase D: if D1=drop, add Alembic migration 030 dropping the dead tables and scraped_jobs dedup/match columns; update the smoke tests per D2.
```

### 1.4 Verify Goal 1
```powershell
docker compose up --build -d
docker compose exec backend alembic upgrade head
curl http://localhost:8000/health
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_auto_expiration.py
python -c "import compileall,sys; sys.exit(0 if compileall.compile_dir('backend', quiet=1) else 1)"
```
Green means: backend boots, migration applies, no dangling imports, and the search/auto-scrape
smoke tests still pass. Commit, then merge `030-search-only-backend` into `split/search-only`.

---

## Part 2 — Goal 2: Rebuild the frontend

The current `frontend/src` is a mix of old `.jsx` pages (`ConfigPage`, `JobsPage`, `LogsPage`,
plus the to-be-removed `DedupPage`, `MatchingPage`, `ProfilePage`, `SkillsPage`) and a newer
`.tsx` auto-scrape dashboard — that inconsistency is the "disorganized" you want to fix. Rather
than edit the old tree, **build a fresh, consistent frontend** with only the four pages.

### 2.1 The four pages and the endpoints they need

Ground the new UI in the (now reduced) backend API:

| Page | Route | Backend endpoints |
|---|---|---|
| **Config** | `/` | `GET /config`, `PUT /config` (minus the removed `llm`/`dedup_mode` fields) |
| **Jobs** | `/jobs` | `GET /jobs`, `GET /jobs/{id}`, `PUT /jobs/{id}` (dismiss), `POST /extension/trigger-scan`, `POST /extension/trigger-stop`, `WS /ws/run-log` (live progress) |
| **Logs** | `/logs` | `GET /extension/run-log` (+ `debug_log` traces) — search runs only; the dedup/matching report tabs are gone |
| **Auto-Scrape** | `/dashboard/auto-scrape` | `/admin/auto-scrape/*` (state, config, cycles, sessions, enable/pause/shutdown) |

> Tip: with the app running you can confirm each page's real API calls via Chrome DevTools'
> Network tab, or ask me to inspect the running UI at `http://localhost:5173` with the browser
> tools so the redesign spec captures the exact current behavior before you change it.

### 2.2 Decisions to make before building (settle in clarify)

- **Language/stack:** unify on **TypeScript + Vite + React** (the auto-scrape dashboard is
  already `.tsx`) rather than the mixed JS/TS today.
- **Styling:** pick one system (e.g. CSS Modules as today, or Tailwind, or a component library)
  and apply it consistently — a big part of "less disorganized."
- **Structure:** one convention for `pages/`, `components/`, `lib/api/`, `hooks/`, `types/`.
- **Fresh dir vs in-place:** cleanest is a new `frontend2/` (or a fresh `frontend/` after
  archiving the old one) so the redesign isn't tangled with the old files.

### 2.3 Do it with Claude Code (SDD, greenfield-style)
```powershell
git checkout split/search-only
git checkout -b 031-frontend-redesign
```

**Specify the new frontend:**
```
/speckit-specify Design a new, clean, consistent frontend for the search-only JHA with exactly four pages: Config (/), Jobs (/jobs), Logs (/logs), and Auto-Scrape (/dashboard/auto-scrape). The old frontend is being replaced because it is inconsistent (mixed JS/TS, ad-hoc styling). Describe each page's purpose, information architecture, key user flows, and states (loading/empty/error), and the shared navigation. Config edits search settings; Jobs lists scraped jobs with filters and a scan trigger plus live run progress; Logs shows search run-logs with expandable debug traces; Auto-Scrape is the orchestrator console (enable/pause/stop, cycles, session health). No dedup, matching, skills, or profile UI. Focus on behavior, IA, and UX — not the tech stack.
```

**Clarify (stack/styling/structure from 2.2):**
```
/speckit-clarify Resolve: TypeScript throughout? Which styling system (CSS Modules / Tailwind / component library)? Directory conventions for pages/components/lib/api/hooks/types? Build fresh in a new folder or replace in place? A shared design language (spacing, color, typography, nav layout)?
```

**Checklist → plan → tasks → analyze → implement page by page:**
```
/speckit-checklist
```
```
/speckit-plan Use React + Vite + TypeScript. Reuse the working auto-scrape dashboard components (src/components/auto-scrape/*, src/lib/api/autoScrape.ts, src/types/autoScrape.ts) as the quality bar. Define a single API client layer (src/lib/api/*) typed against the reduced backend, a shared layout with sidebar nav for the four routes, one styling system, and shared UI primitives (button, table, badge, spinner, page title). Lay out Config, Jobs (with the WS run-log hook), Logs (run-log + debug trace panel), and Auto-Scrape. Do not port the old dedup/matching components.
```
```
/speckit-tasks
```
```
/speckit-analyze
```
```
/speckit-implement Phase 1: scaffold the new frontend (Vite+TS), shared layout + sidebar for the four routes, API client, and styling system. Verify it runs against the live backend and Config loads/saves.
```
```
/speckit-implement Phase 2: Jobs page — list/filter, job detail, dismiss, scan trigger, and live WS run-log progress.
```
```
/speckit-implement Phase 3: Logs page — search run-logs with expandable debug traces.
```
```
/speckit-implement Phase 4: Auto-Scrape console — reuse/refresh the existing dashboard components under the new layout.
```

### 2.4 Verify Goal 2
```powershell
cd frontend   # or the new frontend dir
npm install
npm run dev
```
With the backend on `:8000`, click through all four pages: Config saves; Jobs lists, filters,
triggers a scan and shows live progress; Logs shows runs + traces; Auto-Scrape controls the
orchestrator. Then remove the old frontend files (or archive the old `frontend/`). Commit and
merge `031-frontend-redesign` into `split/search-only`.

---

## How the specs feed this work (why the earlier round pays off now)

- `003-dedup-pipeline` + `004-matching-pipeline` — the exact list of files, tables, routes, and
  cross-module hooks to remove (and the entanglements: J1 dual store, matched-claim, config
  fields, sync-dedup trigger).
- `002-jobs-ingest-listing` — which `/jobs` behavior and fields are search-only vs
  matching/dedup, so you prune the read path correctly.
- `005-scrape-orchestrator` + `001-post-scrape-phases-1-2` — the scrape/auto-scrape/Phase-1
  behavior that must remain green, and the smoke tests that prove it.

## Sequencing recap

1. **Part 0** — push, branch `split/search-only`, green baseline.
2. **Goal 1 (backend split)** on `030-search-only-backend` → verify → merge.
3. **Goal 2 (frontend rebuild)** on `031-frontend-redesign` → verify → merge.
4. Keep the `optimization-backlog.md` items for later — they don't block the split, and the
   front-end runs fine today.

**Docs:** https://github.github.com/spec-kit/ · **JHA specs:** `specs/001`–`005`,
`docs/current-workflow.md`, `docs/current-schemas.md`.
