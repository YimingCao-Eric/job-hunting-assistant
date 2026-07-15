# Specification Quality Checklist: Unified Scraped Jobs Table with Dual-Write Ingest

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-15
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**Status: all 16 items pass (re-validated after clarify session, 2026-07-15). 16/16 → 16/16, no state changes.**

### Iteration 1 — one failure

Three [NEEDS CLARIFICATION] markers, all scope-level decisions with no safe default:
auto-expiration's effect on unified rows; whether frontend adaptation to canonical
field names is in scope; and the fate of the retired surfaces (skipped listing,
dismiss, ingest skip_reason).

### Iteration 2 — resolved

User answered Q1: B, Q2: A, Q3: A. Folded in as:

- **Q1 → FR-023/FR-024**: dismissal state retained on the unified row (the sole
  survivor of the dedup-era columns, because it records a user decision); the
  skipped-postings listing and the ingest skip-reason branch are removed. Added
  FR-026 for administrative cleanup, which also reads the retired store's columns.
- **Q2 → FR-021**: backend emits canonical field names; frontend adaptation belongs
  to spec 007. Added a **Scope boundary** note to User Story 1 — the story completes
  at the listing's response, not the rendered page.
- **Q3 → FR-027**: unified rows are removed when their per-source row expires.
  Added a smoke-test requirement (now FR-032 after renumbering) and SC-008 (zero orphans).

### Consistency repairs made during iteration 2

Both were introduced by the answers themselves, and would have shipped a spec that
contradicted its own scope:

- **User Story 1 and SC-001 promised a rendered Jobs page**, which Q2's backend-only
  scope does not deliver. Reframed to the listing's response; the page becomes correct
  under 007.
- **SC-009 assumed dismissed postings are hidden by default**, which no requirement
  stated. FR-019 now specifies the default exclusion, recorded in Assumptions as a
  deliberate behavior change (the retired listing defaulted on *skip*, not dismissal).

### Clarify session — 2026-07-15

Nine decisions recorded under `## Clarifications`. Six were supplied by the user and
confirmed against the spec; five of those six (Indeed company precedence, Glassdoor
remote derivation, posted_at transforms, drop-and-recreate, job_url uniqueness) already
matched existing requirements and were recorded without change. The sixth (dual-write
atomicity) sharpened FR-007/FR-008 to state one transaction, no deferred merge step, and
no transiently-visible half-write.

Three further ambiguities surfaced by the coverage scan and answered A/A/A:

- **`matched` drift → FR-028, FR-033, SC-010.** A live contradiction: `matched` was
  copied at ingest (always false), but `claim_unmatched_rows` flips it on per-source
  rows only, so the unified copy could never be correct. Claiming now writes both rows.
- **Pay-period vocabulary → FR-015, FR-015a, SC-004.** FR-015 required "one shared
  vocabulary" but never defined it; the mapping doc exemplifies only annual and hourly
  while the sites also emit monthly/weekly/daily. Fixed at five values, amounts stored
  as quoted, no annualization.
- **Raw payload → FR-005a.** The spec was silent by omission rather than by decision.
  Omitted from the unified store; reachable via the per-source back-reference.

**Consistency repair**: FR-012 and the first assumption both said the mapping doc wins
on disagreement, which would have overruled all three answers above. Both now scope the
doc's authority to per-site lineage and transforms, and name the three deliberate
departures.

### Analyze pass — 2026-07-15

`/speckit-analyze` found 1 CRITICAL + 2 HIGH + 2 MEDIUM across spec/plan/tasks. All fixed;
checklist still 16/16 (the spec amendments below narrow requirements, they don't loosen them).

- **C1 (CRITICAL, tasks.md)** — `backend/schemas/__init__.py` re-exports `ScrapedJobDetail`,
  which T015 deletes, and no task touched that file → `ImportError` at boot, breaking FR-029
  and blocking every task after T007. Added **T015a**. (`models/__init__.py` and
  `alembic/env.py` verified safe — they import only `ScrapedJob`, whose name survives.)
- **F2 (HIGH, spec.md)** — **FR-024 amended**: "MUST NOT accept or record" → "MUST NOT
  *record*; MUST still accept and no-op". The original was written before the live
  `recordSkip` caller was known; it contradicted approved deviation D1, so an implementer
  reading only the spec would have 400'd.
- **F3 (MEDIUM, spec.md)** — **FR-026 amended** to state the real reason the empty-core and
  short-JD sweeps retire: not "the condition can no longer arise" (it can), but that no
  compliant remedy exists — deleting the unified row alone breaks SC-002's 1:1
  correspondence, and deleting the per-source row is not a permitted mutation (CC-1).
- **F1 (HIGH, tasks.md)** — T020 verified SC-004 (`posted_at` ordering) a phase before T024
  implements it; the check would have been vacuous, not passing. Moved to new **T026a**.
- **F4/F6 (MEDIUM/LOW, tasks.md)** — Phase 4 checkpoint claimed "MVP complete, SC-001
  satisfied" while five canonical values were still `None`. Now scoped to SC-001 only, with
  SC-003/SC-004 explicitly deferred to Phase 5.
- **F5 (MEDIUM, tasks.md)** — FR-011 had no verifying task while T011 edits the adjacent
  branch. Folded two 400 assertions into T013.

Propagated to `contracts/api-surface-delta.md` and `plan.md` so no artifact still argues
against the amended FR-024. Task count 34 → 36 (T015a, T026a).

### Post-implementation analyze pass — 2026-07-15

Ran after all implementation. 0 CRITICAL, 2 HIGH, 3 MEDIUM, 2 LOW. Applied H1, H2, M1, L1.

- **H1 (HIGH) — the feature's new files were never `git add`ed.** Reported as "the mapping doc
  is untracked"; on inspection it was **worse than reported**: migration `030`, the projection
  module, and the merge smoke test were untracked too, none gitignored. A fresh clone would
  have had no migration, so the table would not exist. All four staged.
- **H2 (HIGH) — T034 was unchecked and quickstart's 10 DoD boxes unticked**, while the prior
  session report claimed "all 36 tasks are now `[X]`". The substance had been done; the
  tracking had not. Re-verified all 10 live and ticked them with evidence.
- **M1 (MEDIUM) — Principle I defect in a file this feature modified**:
  `schemas/scraped_job.py` pointed at `docs/scrape-fields-*.md`, all deleted. Comment now
  points at the `build_*_params` extractors and the live mapping doc, and states plainly that
  the legacy fields are ignored.
- **L1 (LOW) — contract omitted two behaviors found during implementation**: `/jobs/skipped`
  returns 422 (not 404), and salary fields are plain-notation JSON *strings*. Both added for
  the 007 handoff, along with the tri-state `remote` and never-annualized salary caveats.

**Not applied** — M2 folded into H2 (the vocabulary check was met by a stronger method and is
recorded as such, not ticked silently). M3 is pre-existing and out of scope: `backend/README.md`
and `docs/current-workflow.md` still point at deleted docs, and `current-workflow.md` is named
in the constitution's runtime guidance — worth a follow-up docs pass.

**Verified against git, not annotations**: plan.md's file map is exact, including all six
"never touched" claims (`extension/`, `frontend/`, `core/database.py`, `main.py`,
`scheduler.py`, `post_scrape_orchestrator.py`).

### Carried into planning

Not spec defects — decisions the Constitution Check gate must settle:

- **CC-12 vs. the mapping doc's illustrative indexes** on `source_site` and `posted_at`:
  speculative without demonstrated need. Justify or drop (Assumptions).
- ~~**CC-10/CC-11 vs. normalizing inside the ingest request**~~ — **resolved** by
  constitution v1.1.0 (2026-07-15). Principle V now states that CC-10/CC-11 govern where
  normalized data lives (the derived row), not when it is computed, so the ingest-time
  merge is compliant. No longer a Constitution Check gate item.
- **Three spec decisions extend the authoritative mapping doc** (FR-005a raw payload,
  FR-015 period vocabulary, FR-023 dismissal). All should be written back into
  `docs/live-per-source-schemas.md` so it stays the single source of truth.
- **FR-026 leaves administrative cleanup's fate open** ("operate on canonical fields, or
  be retired"). Deferred deliberately — it depends on whether the conditions it screened
  for can still arise under the redesigned store, which the plan will determine.

### Authoring notes

- Table and column names appear only where they name existing artifacts the reader must
  locate (per-source stores, the mapping doc). Canonical fields are described by meaning
  ("pay period", "posting date"), not by column name or type — the mapping doc carries
  the physical shape.
- Success criteria avoid response-time and throughput metrics, which this feature does
  not target; they measure population, correctness, and non-regression instead.
