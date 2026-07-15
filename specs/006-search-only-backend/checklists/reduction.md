# Reduction Scope Checklist: Search-Only Backend

**Purpose**: Requirements-quality gate for a subtractive (capability-removal) change — validates that the spec's *removal* and *retention* requirements are complete, unambiguous, consistent, and measurable before `/speckit-plan`.
**Created**: 2026-07-14
**Feature**: [spec.md](../spec.md)
**Depth**: Standard (reviewer gate) · **Focus**: Removal completeness, Retention/regression safety

## Removal Completeness (Are all "what disappears" requirements fully specified?)

- [ ] CHK001 - Is every removed surface enumerated (dedup/matching/profile packages; dedup/matching/profile/skills/job_reports routers, models, schemas) so no removed component is left implicit? [Completeness, Spec §FR-001–FR-003]
- [ ] CHK002 - Are the config fields to remove named individually (`llm`, `dedup_mode`) rather than referenced only as a group? [Completeness, Spec §FR-006]
- [ ] CHK003 - Is unregistering the dedup-task cleanup startup hook stated as a requirement distinct from router unregistration? [Completeness, Spec §FR-007]
- [ ] CHK004 - Are the exact fields to prune from the jobs read path and `scraped_job` schema enumerated, not summarized as "dedup/match fields"? [Clarity, Spec §FR-008]
- [ ] CHK005 - Is removing the post-scan sync-dedup trigger specified separately from removing the post-scrape Phase 4–6 stub calls? [Completeness, Spec §FR-004, §FR-005]
- [ ] CHK006 - Does the spec define the expected response when a client calls a now-removed endpoint (e.g., not-found), rather than leaving it unspecified? [Edge Case, Spec §Edge Cases]
- [ ] CHK007 - Are the removed models identified such that the orphaned status of their (retained) database tables is explicitly acknowledged? [Completeness, Spec §FR-006a, §Key Entities]

## Retention / Regression Safety (Are "must keep working" requirements clear and traceable?)

- [ ] CHK008 - Is each retained capability mapped to its source baseline spec (001/002/005) for traceability of unchanged behavior? [Traceability, Spec §FR-009–FR-014, §Overview]
- [ ] CHK009 - Is the distinction between ingest-time dedup (retained) and the dedup pipeline (removed) unambiguous, so ingest dedup is not accidentally removed? [Ambiguity, Spec §FR-009, §Assumptions]
- [ ] CHK010 - Does the spec state that listing/detail/update behavior is unchanged *except* for the pruned fields, with the pruned set explicitly bounded? [Consistency, Spec §FR-010, §FR-008]
- [ ] CHK011 - Are the retained config fields bounded well enough that "only `llm`/`dedup_mode` removed" is objectively verifiable? [Measurability, Spec §FR-011]
- [ ] CHK012 - Is the retention of Phase 2 matched-claim and the `matched` column stated as an explicit requirement, not only an assumption? [Completeness, Spec §FR-014, §Clarifications]
- [ ] CHK013 - Are the retained post-scrape outputs (`cleanup_results`, `match_results.claim_summary`, terminal `post_scrape_complete`) specified as unchanged? [Completeness, Spec §FR-005, §FR-014]
- [ ] CHK014 - Does the spec require run-log completion behavior to be otherwise unchanged aside from the removed sync-dedup trigger? [Clarity, Spec §FR-004, §FR-012]
- [ ] CHK015 - Is the health endpoint's unchanged behavior captured as an explicit retention requirement? [Completeness, Spec §FR-015]

## Requirement Consistency (Do removal and retention requirements align without conflict?)

- [ ] CHK016 - Do the removal set (FR-001–FR-008) and retention set (FR-009–FR-015) partition the surface without overlap or contradiction (notably `job_reports` removed vs jobs read path kept)? [Consistency, Spec §FR-003, §FR-010]
- [ ] CHK017 - Is the removal of the `has_report` indicator consistent between the removal requirements and the retained listing behavior? [Consistency, Spec §FR-008, §US2]
- [ ] CHK018 - Are domain terms used consistently ("dedup pipeline" vs "ingest-time dedup"; "matching pipeline" vs "matched-claim") so removals are not misapplied? [Consistency, Spec §FR-009, §FR-014]

## Scope Boundary & Deferred Decisions (Are in-scope vs deferred choices unambiguous?)

- [ ] CHK019 - Are the three resolved scope decisions (no migration; matched-claim kept; dual-store deferred) each recorded with an explicit in-scope/deferred verdict? [Completeness, Spec §Clarifications, §Assumptions]
- [ ] CHK020 - Does the spec explicitly bound out-of-scope work (destructive migration, dual-store collapse) so implementers do not infer it as included? [Coverage, Spec §FR-006a, §Assumptions]

## Acceptance Criteria Quality (Are success/done criteria measurable?)

- [ ] CHK021 - Are the acceptance gates (boots, health `ok`, the two named smoke tests pass) stated as objective pass/fail conditions? [Measurability, Spec §FR-016, §SC-001–SC-002]
- [ ] CHK022 - Is "boots with no unresolved import or registration referencing a removed module" defined verifiably rather than as a vague quality? [Measurability, Spec §SC-001, §US1]
- [ ] CHK023 - Does the spec specify how "zero removed endpoints served" is confirmed (e.g., route enumeration) as a measurable criterion? [Measurability, Spec §SC-003]
- [ ] CHK024 - Is the status of `smoke_test_matched_claim.py` (retained but not an acceptance gate) unambiguous, so it is clear which tests gate the change? [Clarity, Spec §Assumptions, §SC-002]

## Edge Case & Scenario Coverage

- [ ] CHK025 - Are requirements defined for loading a legacy config document that still contains the removed `llm`/`dedup_mode` keys (ignored, not rejected)? [Edge Case, Spec §FR-006, §Edge Cases]
- [ ] CHK026 - Is behavior specified for orphaned dedup/match data at rest having no effect on boot, health, listing, or auto-scrape/post-scrape flows? [Edge Case, Spec §Edge Cases, §FR-006a]

## Dependencies & Assumptions

- [ ] CHK027 - Are the key assumptions (no destructive migration; issue-report removal; deferred collapse) marked as validated decisions rather than open questions? [Assumption, Spec §Assumptions, §Clarifications]
- [ ] CHK028 - Is the dependency on the baseline specs (001/002/005 for retained behavior; 003/004 as the removal map) documented so reviewers can trace what stays unchanged? [Dependency, Spec §Overview]
