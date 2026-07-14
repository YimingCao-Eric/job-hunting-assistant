<!--
SYNC IMPACT REPORT
==================
Version change: (template / unversioned) → 1.0.0
Bump rationale: First concrete ratification. The prior file was the unfilled
  constitution-template.md placeholder; populating it with the project's real
  standards is the initial adoption, hence 1.0.0 (MAJOR baseline), not an
  amendment of an existing version.

Modified principles:
  [PRINCIPLE_1_NAME] → I. As-Built Fidelity (NON-NEGOTIABLE)
  [PRINCIPLE_2_NAME] → II. Smoke Tests Are the Behavioral Contract (NON-NEGOTIABLE)
  [PRINCIPLE_3_NAME] → III. Surgical, Behavior-Preserving Change
  [PRINCIPLE_4_NAME] → IV. Migration & Schema Discipline
  [PRINCIPLE_5_NAME] → V. Data-Model Invariants
  (added)           → VI. Async Background Execution
  (added)           → VII. Auth Boundary & Forward-Compatible Outputs

Added sections:
  - Additional Constraints (naming, module layout, error-handling conventions)
  - Development Workflow (SDD baseline process)

Removed sections: none (all template placeholders resolved)

Templates requiring updates:
  ✅ .specify/templates/plan-template.md — Constitution Check gate references
     generic "constitution file"; compatible, no edit required.
  ✅ .specify/templates/spec-template.md — no principle-driven mandatory
     sections added/removed; compatible, no edit required.
  ✅ .specify/templates/tasks-template.md — no new principle-driven task
     categories; compatible, no edit required.
  ✅ .claude/skills/speckit-*/ — command files use generic constitution
     references; no agent-specific names to reconcile.

Follow-up TODOs: none. RATIFICATION_DATE set to 2026-07-14 (adoption of this
  baseline); no earlier adoption date exists for this file.
-->

# JHA (Job Hunting Assistant) Constitution

JHA is an existing FastAPI (async SQLAlchemy) + Alembic + PostgreSQL/Redis backend, a
Chrome (MV3) extension scraper, and a React UI. Spec Kit is being adopted here to
**document and standardize the code that already exists** and to establish a specification
baseline for future spec-driven development (SDD). This round adds no features; it codifies
how the system already behaves and the rules that protect that behavior. Every principle
below is enforceable and testable against the current codebase.

## Core Principles

### I. As-Built Fidelity (NON-NEGOTIABLE)

Every specification produced under this constitution MUST describe what the code actually
does today — its real control flow, data shapes, and outputs — including known limitations,
bugs, stubs, and inconsistent naming. Specs MUST NOT describe an idealized or aspirational
design and present it as current reality.

- When code and intent disagree, the spec MUST document the code's behavior and flag the
  discrepancy explicitly (e.g. "known limitation", "stub", "inconsistent naming"), rather
  than silently describing the intended behavior.
- Stubbed or no-op stages (e.g. dedup/matching placeholders that return `None`/`{}`) MUST
  be labeled as stubs, not as working features.

**Rationale:** The purpose of this baseline is an accurate map of the running system. A spec
that flatters the code is worse than no spec, because future surgical changes will be planned
against a false model.

### II. Smoke Tests Are the Behavioral Contract (NON-NEGOTIABLE)

The existing `smoke_test_*.py` suite (currently `backend/smoke_test_auto_expiration.py`,
`backend/smoke_test_auto_scrape.py`, `backend/smoke_test_matched_claim.py`) is the
authoritative definition of correct behavior. Any specification MUST agree with these tests;
where a spec and a smoke test conflict, the smoke test wins and the spec MUST be corrected.

- New behavior that is meant to be permanent SHOULD be captured by a smoke test.
- A change is not "done" until the relevant smoke tests pass unchanged (or are deliberately,
  reviewably updated when behavior intentionally changes).

**Rationale:** Executable contracts do not drift the way prose does. Anchoring specs to the
smoke suite keeps the documentation honest over time.

### III. Surgical, Behavior-Preserving Change

Future changes MUST be surgical and behavior-preserving by default: the smallest edit that
achieves the goal, touching only what the task requires, guarded by the smoke tests.

- No opportunistic rewrites, no drive-by refactors, no reformatting of untouched code.
- Any intentional behavior change MUST be called out explicitly and reflected in both the
  spec and the corresponding smoke test in the same change.

**Rationale:** The system is validated end-to-end and in production use. Preserving observed
behavior is more valuable than local cleanliness until an explicit, spec-backed decision says
otherwise.

### IV. Migration & Schema Discipline

All schema evolution goes through Alembic under fixed rules:

- Every schema change is a **new** Alembic migration chained off the current head. Existing
  migrations are **never** edited or reordered.
- UUID primary keys default to `gen_random_uuid()`; all columns use `snake_case`.
- Multi-table writes MUST be atomic (a single transaction; all-or-nothing).
- No speculative indexes beyond primary-key, unique, and foreign-key indexes (**CC-12**);
  additional indexes require a demonstrated need.

**Rationale:** An append-only migration chain is auditable and reproducible; forbidding
speculative indexes keeps write paths predictable and avoids unmeasured cost.

### V. Data-Model Invariants

The per-source scrape tables (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`) obey strict
invariants:

- Rows are **append-only**, with exactly two permitted mutations: flipping `matched` from
  `false` → `true` once per row (claim-and-flag), and auto-expiration `DELETE` by
  `shelf_life` (**CC-1**). No other in-place updates.
- Salary and other nested/normalization concerns are handled at the **merge stage**, not at
  ingest (**CC-10**, **CC-11**). Ingest stores source-shaped data faithfully.

**Rationale:** Treating ingest tables as an immutable event log (plus a one-way claim flag and
TTL cleanup) makes reprocessing safe and reasoning about state simple; deferring normalization
keeps ingest fast and source-faithful.

### VI. Async Background Execution

Long-running work MUST run as `asyncio` background tasks (via `asyncio.create_task`, not
request-scoped `BackgroundTask`) so it survives client disconnect, and each background task
MUST acquire its **own fresh DB session** rather than reusing a request's session.

**Rationale:** Scans, sync-dedup, and post-scrape orchestration outlive the originating HTTP
request; binding them to request lifecycle or a shared session causes cancelled work and
closed-session errors.

### VII. Auth Boundary & Forward-Compatible Outputs

- Every HTTP route except `/health` MUST require bearer authentication.
- Aggregate JSONB outputs MUST stay forward-compatible: consumers tolerate added fields, and
  producers add rather than repurpose or remove existing keys.

**Rationale:** A single unauthenticated health endpoint keeps the auth boundary trivial to
audit; additive JSONB evolution lets stored aggregates and their readers version
independently without breaking older data.

## Additional Constraints

Observed conventions that are now standards for this codebase:

- **Module layout (backend):** feature-oriented packages under `backend/` —
  `models/` (SQLAlchemy tables), `schemas/` (Pydantic models), `routers/` (HTTP routes),
  `core/` (cross-cutting infrastructure), and pipeline packages (`auto_scrape/`, `dedup/`,
  `matching/`, `profile/`). `main.py` is the app entrypoint; `scheduler.py` hosts scheduled
  work; one-off utilities live under `scripts/`. New code follows this layout; do not
  introduce parallel or catch-all modules.
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

This round operates in **documentation-and-standardization mode** under SDD:

1. Specs are authored as *as-built* descriptions (Principle I) and validated against the
   `smoke_test_*.py` suite (Principle II) before they are considered baseline-complete.
2. Plans generated from these specs MUST pass the Constitution Check gate in
   `plan-template.md`; any deviation is recorded in that plan's Complexity Tracking table with
   justification.
3. Implementation changes (future rounds) are surgical and behavior-preserving (Principle III),
   land with passing smoke tests, and include a new Alembic migration for any schema change
   (Principle IV).
4. Reviews verify: as-built fidelity, smoke-test agreement, migration-chain integrity, data-model
   invariants (CC-1, CC-10, CC-11, CC-12), the async/fresh-session rule, and the auth boundary.

## Governance

This constitution supersedes ad-hoc practice for JHA. It governs how specs are written and how
changes are made against the existing system.

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
  `docs/jha-onboarding.md`, `docs/current-workflow.md`, and `docs/current-schemas.md`.

**Version**: 1.0.0 | **Ratified**: 2026-07-14 | **Last Amended**: 2026-07-14
