# Specification Quality Checklist: Canonical Filter Columns on `scraped_jobs`

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-16
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

## Constitution Alignment (JHA v1.1.0)

- [x] **I. As-Built Fidelity** — the "Context: what exists today" section describes shipped 008
      behavior accurately (verified against `docs/live-per-source-schemas.md` and
      `backend/core/scraped_job_projection.py`). The `experience_requirements_description` collision
      is surfaced explicitly rather than silently designed around.
- [x] **II. Smoke Tests** — FR-022 requires the suite to pass unchanged; no intentional test change
      is declared, because this feature changes no asserted behavior.
- [x] **III. Surgical Change** — strictly additive (FR-020); per-source tables untouched (FR-016).
- [x] **IV. Migration & Schema Discipline** — new columns imply a new migration chained off head;
      no speculative indexes (CC-12) per Assumptions.
- [x] **V. Data-Model Invariants** — normalization lands on the derived row only (FR-016, CC-10/11);
      atomic dual-write preserved (FR-015, FR-017); lifecycle symmetry preserved (FR-021).

## Validation Notes

**Iteration 1 (2026-07-16)** — All items passed except the [NEEDS CLARIFICATION] gate. Three
markers raised (multi-value shape, Indeed "not remote", education fallback collision).

**Iteration 2 (2026-07-16)** — All three questions answered (Q1=B set-valued, Q2=B, Q3=B). Folded
in; all items passed. Superseded by iteration 3.

**Iteration 3 (2026-07-16)** — **All items pass.** User revised Q1 from B to **A**: `employment_type`
and `workplace_type` are **single-valued, one token by fixed precedence**. Q2 and Q3 unchanged.

| Ref | Resolution | Recorded in |
|---|---|---|
| FR-008 | **Single token by fixed precedence** — secondary values discarded | FR-004, FR-006, FR-008, FR-008a/b/c; Decisions #1 |
| FR-009 | **`ONSITE`** for Indeed "not remote", accepting hybrid mislabelling | FR-009; Decisions #2 |
| FR-012 | **Keep the fallback**, accepting duplication with `experience_level` | FR-012, FR-012a; Decisions #3 |

Consistency edits applied when reverting to single-valued (iteration 3):

- **FR-008a now pins the precedence orders**, which A requires and B did not: `FULL_TIME` ›
  `PART_TIME` › `CONTRACT` › `TEMPORARY` › `INTERNSHIP` › `VOLUNTEER` (decreasing commitment), and
  `REMOTE` › `HYBRID` › `ONSITE` (decreasing location freedom). Discarding data demands a
  principled, documented rule — otherwise "which value won" becomes an implementation accident.
- **FR-008c added** to state the accepted cost plainly: discarded arrangements are unrecoverable
  from the canonical row and survive only on the per-source row.
- **FR-008b / FR-013 reconciled**: an unrecognized token is *skipped*, never selected; a recognized
  value still wins; NULL only when nothing stated was recognized.
- **SC-003a inverted** — it previously asserted "no stated arrangement is lost", which A makes
  false. It now tests determinism (reversed payload order yields the same token) instead.
- Acceptance scenarios, edge cases, Key Entities, and Assumptions restated for single-valued
  columns; set notation (`{TOKEN}`) removed throughout.

Carried forward from iteration 2 (unaffected by the Q1 revision):

- FR-009a: `workplace_type` overlaps the shipped `remote` column and the two **can disagree** on
  Glassdoor hybrid-only rows. Surfaced, not resolved — correcting `remote` is shipped behavior and
  outside scope (Principle III).

**Open risk carried into planning (not a blocker)**: decisions #1, #2, and #3 each trade precision
or recall for filter simplicity and coverage. They compound on `workplace_type` — precedence
favours `REMOTE` while Indeed asserts `ONSITE` where it cannot see hybrid, making `HYBRID` the
least reliable token in the vocabulary. Recorded in the spec's Decisions section; all three are
reversible without touching shipped columns.

Spec is ready for `/speckit-plan`.

**Iteration 4 (2026-07-16, `/speckit-clarify`)** — **21/21 → 21/21 items passing.** No checkbox
changed state; five clarifications tightened requirements that already passed. Recorded under
`## Clarifications` → `### Session 2026-07-16`.

| Q | Resolution | Recorded in |
|---|---|---|
| 1 | `Other`/`OTHER` employment status → NULL, **no warning** (recognized-but-unmappable, a third value class) | FR-008d, FR-005a |
| 2 | Unrecognized salary-source token → NULL + warn, **never false** | FR-010a/b/c |
| 3 | `language` → bare lowercase base code (`en-US` → `en`) | FR-011, FR-011a/b |
| 4 | LinkedIn labels win for `workplace_type`; `remote` unchanged; warn on contradiction | FR-009b, FR-009c |
| 5 | Multiple education labels → join all, source order, `"; "` separator | FR-012b, FR-012c |

Also added, resolving the request's topics (1) and (3) directly:

- **FR-005a** — the per-site raw→canonical mapping tables for all three attributes, matched on a
  normalized token (uppercase, spaces/hyphens → underscore).
- **FR-005b/c/d** — the mappings are **reasoned, not observed**: exactly one live source value is
  attested anywhere in the repo (Glassdoor `remoteWorkTypes: ["REMOTE"]`). Six plausible tokens
  (`PERMANENT`, `FREELANCE`, `PER_DIEM`, `APPRENTICESHIP`, `COMMISSION`, `NEW_GRAD`) are
  deliberately left unrecognized rather than guessed — a wrong guess writes a wrong token no
  warning ever surfaces. FR-005d makes reviewing the first scan's warnings a required step.
- **SC-008/SC-009** — the mapping must be confirmed against a real scan, and normal postings
  (including `Other`) must emit **zero** warnings, keeping warnings meaningful.

Topics (2), (4), and (5) of the request needed no question — already resolved in the spec
(FR-009a/c, FR-012, FR-002 respectively).

**Note on process**: `.specify/scripts/` is empty — `check_prerequisites.py` does not exist in this
project, so path resolution came from `.specify/feature.json` instead. Worth fixing or removing the
script reference from the speckit skills if this recurs.
