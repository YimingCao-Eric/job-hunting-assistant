<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR. No principle removed, renamed, or redefined — all seven still
  hold and keep their numbering. The bump covers materially expanded guidance: a new
  Data-Model Invariant governing the unified `scraped_jobs` table (Principle V), and a
  reframing of the operating mode from documentation-and-standardization to active
  spec-driven feature development (intro + Development Workflow). Existing rules are
  narrowed in scope only where the codebase itself changed (deleted packages).

Modified principles: none renamed. Content changes:
  I. As-Built Fidelity — scope clarified: governs how specs describe EXISTING behavior.
     New-feature specs describe intended behavior; the rule is that they must not
     misdescribe what is already there. Previously assumed every spec was as-built.
  V. Data-Model Invariants — expanded. Per-source invariants unchanged (CC-1). Added
     the unified `scraped_jobs` invariant and restated CC-10/CC-11 as a rule about
     WHERE normalized data lives (the derived row), not WHEN it is computed.
  VI. Async Background Execution — rationale only: dropped the deleted sync-dedup
     example. The principle's rule is unchanged.

Added sections:
  - Principle V → "The unified `scraped_jobs` table (derived)" subsection

Removed sections: none

Amended (non-principle):
  - Intro: "This round adds no features" → active spec-driven development.
  - Additional Constraints → Module layout: removed deleted packages `dedup/`,
    `matching/`, `profile/`; list now matches the live tree (verified 2026-07-15).
  - Development Workflow: documentation-and-standardization mode → spec-first mode.
  - Governance → Runtime guidance: added `docs/live-per-source-schemas.md`; removed
    `docs/current-schemas.md` (file no longer exists — verified 2026-07-15).

Templates requiring updates:
  ✅ .specify/templates/plan-template.md — Constitution Check derives gates from this
     file ("[Gates determined based on constitution file]"); no hardcoded principle
     references. No edit required.
  ✅ .specify/templates/spec-template.md — no principle-driven mandatory sections
     added or removed. (Its "user profile API" example text is a generic placeholder,
     unrelated to the deleted `profile/` package.) No edit required.
  ✅ .specify/templates/tasks-template.md — no new principle-driven task categories.
     No edit required.
  ✅ .claude/skills/speckit-*/ — generic constitution references only; no
     agent-specific names to reconcile. No edit required.

Follow-up TODOs:
  - `backend/README.md` still references sync-dedup, which no longer exists. Outside
    this file's scope; flagged for a docs pass under Principle I.
  - `docs/live-per-source-schemas.md` cross-references `docs/current-schemas.md`, which
    has been deleted. Same docs pass.

RATIFICATION_DATE unchanged (2026-07-14). LAST_AMENDED_DATE set to 2026-07-15.
-->

# JHA (Job Hunting Assistant) Constitution

JHA is a FastAPI (async SQLAlchemy) + Alembic + PostgreSQL/Redis backend, a Chrome (MV3)
extension scraper, and a React UI. Spec Kit was adopted here to document and standardize the
code that already existed; that baseline is now established, and JHA has moved into **active
spec-driven feature development**. The search-only split has shipped — the `dedup/`,
`matching/`, and `profile/` packages are gone and the backend scrapes, ingests, and lists —
and the unified `scraped_jobs` work is in progress.

Features are now built **spec-first, surgically, and guarded by smoke tests**: behavior is
specified before it is implemented, changes stay as small as the goal allows, and the smoke
suite is what proves a change did what it claimed. Every principle below is enforceable and
testable against the codebase.

## Core Principles

### I. As-Built Fidelity (NON-NEGOTIABLE)

Specifications MUST describe the system truthfully. Where a spec describes behavior that
already exists, it MUST describe what the code actually does today — its real control flow,
data shapes, and outputs — including known limitations, bugs, stubs, and inconsistent naming.
A spec MUST NOT present an idealized account of existing code as current reality.

- New-feature specs describe *intended* behavior; that is their purpose and is not a
  violation. The rule binds their account of the surrounding system: the problem being
  solved, the current behavior being changed, and the constraints being worked within MUST
  be accurate.
- When code and intent disagree, the spec MUST document the code's behavior and flag the
  discrepancy explicitly (e.g. "known limitation", "stub", "inconsistent naming"), rather
  than silently describing the intended behavior.
- Stubbed or no-op stages MUST be labeled as stubs, not as working features.
- Documentation that points at deleted modules, tables, or files is a fidelity defect and
  MUST be corrected when discovered, not left to rot.

**Rationale:** Plans are built against the model the spec supplies. A spec that flatters the
code is worse than no spec, because every downstream decision inherits the lie. This matters
more in feature work than it did during the baseline: a surgical change reasoned from a false
model is how behavior breaks silently.

### II. Smoke Tests Are the Behavioral Contract (NON-NEGOTIABLE)

The `smoke_test_*.py` suite (currently `backend/smoke_test_auto_expiration.py`,
`backend/smoke_test_auto_scrape.py`, `backend/smoke_test_matched_claim.py`) is the
authoritative definition of correct behavior. Any specification MUST agree with these tests;
where a spec and a smoke test conflict, the smoke test wins and the spec MUST be corrected.

- New behavior that is meant to be permanent MUST be captured by a smoke test.
- A change is not "done" until the relevant smoke tests pass — unchanged, or deliberately
  and reviewably updated when behavior intentionally changes.
- An intentional smoke-test change MUST be identified as such in the spec or plan that
  causes it, with the behavior change named. Editing a test until it passes is a violation.

**Rationale:** Executable contracts do not drift the way prose does. Anchoring specs to the
smoke suite keeps documentation honest; requiring intentional test changes to be declared
keeps the suite from being quietly weakened to accommodate a regression.

### III. Surgical, Behavior-Preserving Change

Changes MUST be surgical and behavior-preserving by default: the smallest edit that achieves
the goal, touching only what the task requires, guarded by the smoke tests.

- No opportunistic rewrites, no drive-by refactors, no reformatting of untouched code.
- Any intentional behavior change MUST be called out explicitly and reflected in both the
  spec and the corresponding smoke test in the same change.

**Rationale:** The system is validated end-to-end and in production use. Preserving observed
behavior is more valuable than local cleanliness until an explicit, spec-backed decision says
otherwise. Spec-first development does not license bigger diffs — it licenses *deliberate*
ones.

### IV. Migration & Schema Discipline

All schema evolution goes through Alembic under fixed rules:

- Every schema change is a **new** Alembic migration chained off the current head. Existing
  migrations are **never** edited or reordered.
- UUID primary keys default to `gen_random_uuid()`; all columns use `snake_case`.
- Multi-table writes MUST be atomic (a single transaction; all-or-nothing).
- No speculative indexes beyond primary-key, unique, and foreign-key indexes (**CC-12**);
  additional indexes require a demonstrated need, justified in the plan.

**Rationale:** An append-only migration chain is auditable and reproducible; forbidding
speculative indexes keeps write paths predictable and avoids unmeasured cost.

### V. Data-Model Invariants

Two classes of table exist and their invariants differ. Confusing them is a design error.

**The per-source scrape tables (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`) — raw:**

- Rows are **append-only**, with exactly two permitted mutations: flipping `matched` from
  `false` → `true` once per row (claim-and-flag), and auto-expiration `DELETE` by
  `shelf_life` (**CC-1**). No other in-place updates.
- Rows are stored **source-shaped and unnormalized**. Ingest stores what the site sent,
  faithfully. These tables are the raw store of record.

**The unified `scraped_jobs` table — derived:**

- `scraped_jobs` is a **derived** table, not a raw one. It holds one canonical, site-agnostic
  row per posting, populated by **atomic dual-write at ingest**: the per-source row and its
  canonical row are written in one transaction, committing together or not at all. A
  canonical row never exists without its per-source row, and never lags it.
- Permitted mutations are exactly three: the `matched` claim-flip (which MUST stay in sync
  with the per-source row's claim — the two never disagree), a user-set `dismissed` flag, and
  auto-expiration `DELETE`. No other in-place updates.
- A canonical row MUST NOT outlive the per-source row it derives from.
- **Normalization lives here.** Salary vocabulary, date representation, and other
  nested/normalization concerns are resolved on the canonical row (**CC-10**, **CC-11**) and
  never on the per-source row. CC-10/CC-11 govern *where normalized data lives* — the derived
  row — not *when* it is computed; performing the merge inside the ingest transaction
  satisfies them, because the per-source row remains source-shaped either way.

**Rationale:** Treating the per-source tables as an immutable event log (plus a one-way claim
flag and TTL cleanup) makes reprocessing safe. The derived table exists to be *queried* —
comparable across sites, cheap to read — which is exactly why normalization belongs to it and
must never leak back onto the raw rows. Atomic dual-write is what lets the derived table be
trusted: a merge that can silently fall behind its source is a cache, and this is not a cache.

### VI. Async Background Execution

Long-running work MUST run as `asyncio` background tasks (via `asyncio.create_task`, not
request-scoped `BackgroundTask`) so it survives client disconnect, and each background task
MUST acquire its **own fresh DB session** rather than reusing a request's session.

**Rationale:** Scans and post-scrape orchestration outlive the originating HTTP request;
binding them to request lifecycle or a shared session causes cancelled work and
closed-session errors.

### VII. Auth Boundary & Forward-Compatible Outputs

- Every HTTP route except `/health` MUST require bearer authentication.
- Aggregate JSONB outputs MUST stay forward-compatible: consumers tolerate added fields, and
  producers add rather than repurpose or remove existing keys.

**Rationale:** A single unauthenticated health endpoint keeps the auth boundary trivial to
audit; additive JSONB evolution lets stored aggregates and their readers version
independently without breaking older data.

## Additional Constraints

Observed conventions that are standards for this codebase:

- **Module layout (backend):** feature-oriented packages under `backend/` — `models/`
  (SQLAlchemy tables), `schemas/` (Pydantic models), `routers/` (HTTP routes), `core/`
  (cross-cutting infrastructure), `auto_scrape/` (post-scrape pipeline: expiration, claim,
  orchestration), and `alembic/` (migrations). `main.py` is the app entrypoint;
  `scheduler.py` hosts scheduled work; one-off utilities live under `scripts/`. New code
  follows this layout; do not introduce parallel or catch-all modules. The `dedup/`,
  `matching/`, and `profile/` packages were removed by the search-only split — do not
  reintroduce them without a spec that says why.
- **Naming:** `snake_case` for Python identifiers and DB columns. Where existing names are
  inconsistent (e.g. `scrape_run_id` / `scan_run_id` / `runId` all denoting a run-log UUID),
  document the inconsistency in the spec (Principle I); do not rename as a drive-by change
  (Principle III).
- **Error handling:** HTTP routes return appropriate status codes with bearer auth enforced;
  background tasks catch, log, and record failures without corrupting run-log accounting
  (statuses `running` / `completed` / `failed`) — a long-running task must not be recorded as
  failed merely because it ran long.
- **Stack boundaries:** PostgreSQL is the system of record; Redis is cache/coordination; the
  Chrome MV3 extension performs all scraping (content scripts read the DOM, the service worker
  owns all backend calls); the React UI triggers and displays, it does not own business logic.

## Development Workflow

JHA operates in **spec-first feature development** under SDD:

1. Features begin as specs describing behavior and outcomes, not implementation. Specs are
   validated against the `smoke_test_*.py` suite (Principle II) and are truthful about
   existing behavior (Principle I) before planning starts.
2. Plans generated from these specs MUST pass the Constitution Check gate in
   `plan-template.md`; any deviation is recorded in that plan's Complexity Tracking table with
   justification. Speculative indexes (CC-12) and any claimed CC-10/CC-11 accommodation are
   settled at this gate, not during implementation.
3. Implementation is surgical and behavior-preserving (Principle III), lands with passing
   smoke tests, and includes a new Alembic migration for any schema change (Principle IV).
   Intentional smoke-test changes are declared, not discovered in review.
4. Reviews verify: as-built fidelity, smoke-test agreement, migration-chain integrity,
   data-model invariants (CC-1, CC-10, CC-11, CC-12) with the raw/derived distinction
   respected, the async/fresh-session rule, and the auth boundary.

## Governance

This constitution supersedes ad-hoc practice for JHA. It governs how specs are written and how
changes are made against the system.

- **Amendments** require a documented change to this file, a version bump per the policy below,
  and propagation to dependent Spec Kit templates (`plan-template.md`, `spec-template.md`,
  `tasks-template.md`) and command files where affected.
- **Versioning policy (semantic):** MAJOR for backward-incompatible governance or
  principle removals/redefinitions; MINOR for a new principle/section or materially expanded
  guidance; PATCH for clarifications and non-semantic refinements.
- **Compliance review:** every plan and PR verifies compliance with the principles above. The
  smoke-test suite is the final arbiter of behavior; complexity or deviation must be justified in
  the plan's Complexity Tracking table.
- **Runtime guidance:** for the current as-built behavior of the system, consult
  `docs/jha-onboarding.md` and `docs/current-workflow.md`. For live database schemas — the
  per-source tables and the canonical merged mapping — consult
  `docs/live-per-source-schemas.md`, which is authoritative over any older schema doc.

**Version**: 1.1.0 | **Ratified**: 2026-07-14 | **Last Amended**: 2026-07-15
