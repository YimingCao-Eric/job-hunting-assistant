# Using GitHub Spec Kit on JHA — Document, Standardize & Build the SDD Spec Baseline

**Project:** Job Hunting Assistant (JHA) — Chrome extension + FastAPI backend + React UI.
**Goal of this round:** use Spec-Driven Development (SDD) with Claude Code to
**understand the existing code, standardize it, and produce a specification baseline that
future SDD development builds on** — while capturing optimization opportunities found along
the way. **No code changes this round** (your functionality is already tested; we protect
it). **Agent:** Claude Code. **Platform:** Windows / PowerShell. **You:** new to SDD.

---

## What you're producing (three deliverables)

This round is documentation and analysis, not building. By the end you have:

1. **A constitution = your coding standards.** The single, authoritative statement of JHA's
   conventions (naming, module structure, error handling, migration discipline, test
   patterns). This is the "standardize it" artifact — future work is measured against it.
2. **An as-built specification baseline.** One spec per module describing *what the code
   actually does today*. This is the input that future `/speckit-plan` and
   `/speckit-implement` will consume — real SDD needs this baseline to exist.
3. **A prioritized optimization / standardization backlog.** Every deviation from the
   standards, inconsistency, doc-vs-code drift, missing test, or known limitation you find
   while documenting — recorded, categorized, and ranked. Nothing is implemented now; this
   is the to-do list for later rounds.

> Why standardization surfaces optimizations: the act of writing down "what this module
> does" and "what our standard is" forces every gap between them into the open. That gap
> list *is* your optimization backlog.

---

## Part 1 — Orientation & prerequisites

### 1.1 What "standardize" means here (and the safety rule)

Standardizing = making conventions **explicit** (in the constitution) and noting where the
code **doesn't yet follow them** (in the backlog). This round you only *document* those
gaps. When you later act on them, changes must be **behavior-preserving and guarded by the
existing smoke tests** — never a rewrite. Your tested functionality is the contract; the
specs and standards describe it, they don't redefine it.

### 1.2 The existing tests are your behavioral contract

JHA already has `smoke_test_auto_scrape.py`, `smoke_test_matched_claim.py`,
`smoke_test_auto_expiration.py`, etc. Treat these as the ground-truth statement of intended
behavior: an as-built spec should **agree** with them. Where a spec and a test disagree,
you've found something important (a doc error, or an untested/ambiguous behavior) — that's a
backlog item.

### 1.3 The module list (work order)

Start with one module, produce all three deliverables for it, then repeat. Suggested order,
easiest/most-central first:

1. **Post-scrape orchestrator** — `backend/auto_scrape/post_scrape_orchestrator.py`,
   `auto_expiration.py` (LIVE, documented, self-contained; `matching_claim.py` was a second
   such module until feature 010 retired the claim and deleted it). *Worked
   example below.*
2. **Ingest router** — `backend/routers/jobs.py` (the `*_COLS` contract, per-source routing).
3. **Dedup service** — `backend/dedup/service.py`.
4. **Matching pipeline** — `backend/matching/pipeline.py` and friends.
5. Extension orchestrator and React UI as needed.

After a few modules, you consolidate them into a **system-level spec index** and a **master
standards + backlog** (Step 10).

### 1.4 Safety rules (they become your constitution)

- **No code changes this round.** Output is Markdown only.
- One documentation branch is enough (e.g. `docs/spec-baseline`) since nothing ships.
- When implementation *does* start later: one change per branch, Alembic migration per
  schema change (head is `029`), atomic writes, CC-1 respected, and every change re-runs the
  existing smoke tests.

### 1.5 Prerequisites

Python 3.11+, Docker, Git, `uv` (`0.11.28`), Claude Code signed in. Design docs already in
`docs/` (`current-workflow.md`, `current-schemas.md`, `jha-onboarding.md`).

---

## Part 2 — The tools, mapped to your three deliverables

| Deliverable | Spec Kit command(s) | Fit |
|---|---|---|
| **Standards (constitution)** | `/speckit-constitution` | **Strong, native.** This is what Spec Kit does best. Re-runnable to amend as you discover conventions. |
| **As-built spec baseline** | `/speckit-specify` (as-built framing) + `/speckit-clarify` (verify vs code) | **Repurposed but worth it** — the spec template leans "feature," but the baseline it produces is exactly what future SDD needs, kept in `specs/`. |
| **Optimization/standardization backlog** | `/speckit-converge`, `/speckit-analyze` | **Strong for brownfield.** `converge` assesses existing code and appends work; `analyze` finds inconsistencies. |

**Honest tooling note.** Spec Kit is sufficient for all three, but its center of gravity is
forward building. The *constitution* and *backlog* pieces are native strengths; the *as-built
documentation* is a repurposing that works because Claude Code does the reading. You are **not
missing a tool** — you're using Spec Kit for its structure and Claude Code for the analysis.
`/speckit-implement`, `/speckit-plan`, `/speckit-tasks` are **not used this round** — they're
for the later implementation rounds.

---

## Part 3 — Step by step

Steps 1–3 in **PowerShell**; every `/speckit-*` step in **Claude Code** opened in the repo.

### Step 1 — Initialize Spec Kit
```powershell
cd "D:\cym\work\workSpace\New folder (2)\job-hunting-assistant"
uvx --from git+https://github.com/github/spec-kit.git specify init .
```
Answer **y** to merge; choose **claude**, then **py**.
**Deliverable:** `.specify/` + `.claude/skills/`. Add `.claude/` and `.env` to `.gitignore`.

### Step 2 — One documentation branch
```powershell
git checkout -b docs/spec-baseline
```
No code ships this round, so a single docs branch holds the constitution, specs, and backlog.

### Step 3 — Open Claude Code
```powershell
claude
```
Confirm `/speckit-*` commands are available.

### Step 4 — Constitution = your coding standards (deliverable #1)
Draft your standards now; you'll refine them as you read the code (the constitution is
versioned and re-runnable).
```
/speckit-constitution JHA is an existing FastAPI (async SQLAlchemy) + Alembic + Postgres/Redis backend with a Chrome extension scraper and a React UI, whose core functionality is already tested. Spec Kit is being used to DOCUMENT and STANDARDIZE the existing code and to build a specification baseline for future SDD; no new features this round. Capture these as the project's standards. Data & migrations: every schema change is a new Alembic migration chained off the current head, never editing old ones; per-source tables (linkedin_jobs, indeed_jobs, glassdoor_jobs) are append-only except flipping matched false→true once per row and auto-expiration DELETE by shelf_life (CC-1); multi-table writes are atomic; UUID PKs default gen_random_uuid(); snake_case columns; salary/nested normalization is a merge-stage concern, not ingest (CC-10, CC-11); no speculative indexes beyond PK/unique/FK (CC-12). Code: long-running work runs as asyncio background tasks with a fresh DB session; all HTTP routes except /health require bearer auth; aggregate JSONB outputs stay forward-compatible. Process: an "as-built" spec must describe what the code truly does today including known limitations, never an idealized design; the existing smoke_test_*.py suite is the behavioral contract that specs must agree with; future changes must be surgical and behavior-preserving, guarded by those smoke tests. Also record naming, module-layout, and error-handling conventions you observe as standards.
```
**Deliverable:** `.specify/memory/constitution.md` — your standards document.
**Review:** it reads like a standards charter, not a feature list.

### Step 5 — Reverse-spec the first module (deliverable #2, part 1)
Have the agent read the real files and write an as-built spec.
```
/speckit-specify Produce an AS-BUILT specification documenting the CURRENT behavior of the backend post-scrape orchestrator Phases 1 and 2, exactly as implemented. Read first: backend/auto_scrape/post_scrape_orchestrator.py, backend/auto_scrape/auto_expiration.py, backend/auto_scrape/matching_claim.py, plus docs/current-workflow.md section 5 and docs/current-schemas.md, and the existing smoke_test_auto_expiration.py and smoke_test_matched_claim.py as the behavioral contract. Describe triggers, the atomic status transition, Phase 1 auto-expiration (tables, shelf_life_days from system_settings, cleanup_results written to auto_scrape_cycles), Phase 2 matched-claim (atomic matched=false→true across all three tables, claim_results vs claim_summary, what is persisted vs discarded), and the final cycle write. Capture invariants and known limitations (e.g. the crash window between Phase 2 and the final write). Document existing behavior only; propose no changes.
```
**Deliverable:** `specs/…/spec.md` — the module's as-built baseline.

### Step 6 — Validate the spec against the code (deliverable #2, part 2)
```
/speckit-clarify Verify this as-built spec against the actual source and the smoke tests. Flag any statement that does not match backend/auto_scrape/*.py, list anything the spec omitted (error handling, transaction boundaries, partial-failure behavior), and note any place where the spec and the smoke tests imply different behavior.
```
**Deliverable:** a corrected, trustworthy as-built spec. Reviewing this is how you *understand
the design*.

### Step 7 — Standardization + optimization pass (deliverable #3)
```
/speckit-converge Compare Phases 1–2 as documented in the as-built spec against the constitution (our standards) and the code. Produce a STANDARDIZATION & OPTIMIZATION BACKLOG of existing-code items only — no new features. Include: deviations from the standards (naming, structure, error handling, transaction/atomicity, migration or CC-rule adherence), doc-vs-code drift, duplicated or dead code, missing/weak tests, observability gaps, and known limitations (e.g. the Phase 2 crash window §15.2). For each item give: category, description, impact, risk of fixing, and rough effort. Do not implement anything.
```
Then, optionally, a consistency cross-check:
```
/speckit-analyze
```
**Deliverable:** a backlog (save it to `docs/optimization-backlog.md` so it persists across
modules).
**Do not implement.** Just record and rank.

### Step 8 — Record decisions, then repeat per module
Skim the backlog and tag each item priority High/Med/Low and type (standardize-naming,
refactor-duplication, add-test, fix-limitation, perf). Then repeat **Steps 5–7** for the next
module in §1.3 (ingest router, dedup, matching…), appending to the same backlog file.

### Step 9 — Consolidate into the SDD baseline
After a few modules:
```
/speckit-specify Produce a SYSTEM-LEVEL as-built overview that indexes the per-module specs written so far, summarizes how the modules connect (scrape → per-source tables → post-scrape phases → dedup/matching), and links each module spec. This is the top of the specification baseline future SDD work will plan against. Documentation only.
```
Optionally amend the standards you discovered:
```
/speckit-constitution Amend the constitution to add the naming, module-layout, and error-handling conventions confirmed while documenting the modules. Keep it a standards charter.
```
**Deliverables:** a system-level spec index + a finalized standards constitution + a ranked
backlog. Commit them on the `docs/spec-baseline` branch — this is your SDD foundation.

### Step 10 — (Next round, deferred) turn a backlog item into a change
Not now, but this is where SDD goes forward: pick one High-priority, low-risk backlog item,
branch `fix/…`, run `/speckit-specify` (the change) → `clarify` → `plan` → `tasks` →
`analyze` → `implement`, and verify with `alembic upgrade head` plus the existing smoke tests
so tested behavior is provably preserved. The baseline you built this round is exactly what
makes that safe and fast.

---

## Cheat-sheet

| Purpose | Command | Deliverable |
|---|---|---|
| Setup | `uvx --from git+…/spec-kit.git specify init .` | `.specify/`, `.claude/` |
| Docs branch | `git checkout -b docs/spec-baseline` | Branch |
| **Standards** | `/speckit-constitution …` | `constitution.md` (standards) |
| **As-built spec** | `/speckit-specify Produce an AS-BUILT spec …` | per-module `spec.md` |
| Verify vs code | `/speckit-clarify Verify … against source + tests` | Corrected spec |
| **Backlog** | `/speckit-converge …` (+ `/speckit-analyze`) | `docs/optimization-backlog.md` |
| Consolidate | `/speckit-specify` system overview + amend constitution | Spec index + standards |
| *(Later)* implement | `/speckit-plan` → `tasks` → `implement` + smoke tests | Behavior-preserving change |

**Not used this round:** `/speckit-plan`, `/speckit-tasks`, `/speckit-implement` (those are
for later implementation rounds).

**Docs:** https://github.github.com/spec-kit/ · **Repo:** https://github.com/github/spec-kit
**JHA references:** `docs/current-workflow.md`, `docs/current-schemas.md`, `docs/jha-onboarding.md`
