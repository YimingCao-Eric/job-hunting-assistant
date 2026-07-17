# Specification Quality Checklist: Retire the Vestigial Post-Scrape Matched-Claim

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

## Validation Notes

**Iteration 1 findings, all addressed in the spec as written:**

1. *Implementation details leaked into user-facing sections.* The feature description is stated in code terms (module paths, `claim_unmatched_rows`, `matched=TRUE`). Those are confined to the **Input** and **Context: What Exists Today** sections, where Constitution Principle I requires an accurate as-built account. Stories, requirements, and success criteria are written in behavioral terms ("claim state", "unclaimed", "post-scrape run") and name no module, column, or query.

2. *Success criteria technology-agnostic.* SC-001 through SC-010 measure observable outcomes (percentages of rows, zero-difference comparisons, counts of phases). SC-002 references a downstream processor's query only as an outcome ("finds all, where today it finds zero"), not as an implementation.

3. *Scope boundary made explicit.* Two boundaries were initially ambiguous and are now recorded in Assumptions with rationale: the existing already-claimed corpus is **not** back-filled, and the disposition of the claim module / its dedicated smoke test is deferred to `/speckit-clarify` per the project playbook.

**Resolved in clarification (Session 2026-07-16):** the module/test disposition, deferred at spec time to `/speckit-clarify` per the project playbook, is now settled — the claim module is removed outright, and its smoke test is repurposed to assert the inverse behavior while retaining its still-valid invariant checks (FR-011a). The retired-claim marker's write timing was also settled (FR-007/FR-007a). No open decisions remain.

**As-built verification performed during clarification (Principle I):** an adversarial pass attempted to disprove "nothing depends on the automatic claim," checking the job listing, auto-expiration, admin cleanup, and cycle finalization, plus indexes, views, triggers, constraints, raw SQL, frontend components, and export paths. Result: no read path depends on the flag's value; the claim's *cycle-summary output* has exactly two consumers in the history view, one of which is provably inert. Both findings are now recorded in Assumptions and Edge Cases rather than left as untested claims. Two corrections were made to the spec as a result: the "only consumer" assumption was inaccurate (two call sites, not one), and the failed-cycle case was previously unaddressed (now FR-007a).

**Constitutional consequences surfaced during validation** (carried into the spec as FR-011/FR-012/FR-013 rather than left for the plan to discover):

- *Principle II* names `smoke_test_matched_claim.py` as an authoritative behavioral contract. This spec retires the behavior it pins, so the test change is named here as a deliberate consequence — satisfying the principle's requirement that intentional smoke-test changes be identified in the spec that causes them.
- *Principle V* names the claim-flip as a sanctioned mutation on both table classes. Retiring the automatic claim requires an amendment (FR-013), not just a code deletion.
- *Principle VII* forbids removing existing keys from aggregate outputs. The resolved decision — an explicit retired marker replacing the claim counts — was taken to the user, who chose it over both dropping the key and reporting fake zeros.
- *Principle I* — pre-existing fidelity defects were found in the runtime docs (they still describe removed phases as stubs). FR-012 requires correcting the post-scrape account.

**Status**: All items pass. Ready for `/speckit-clarify`.
