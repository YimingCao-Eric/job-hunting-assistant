# Retirement & Governance Checklist: Retire the Vestigial Post-Scrape Matched-Claim

**Purpose**: Formal requirements-quality gate before `/speckit-plan`. Tests whether the *requirements are written well enough to plan from* — not whether the implementation works.
**Created**: 2026-07-16
**Feature**: [spec.md](../spec.md)
**Depth**: Formal gate — unresolved items should block `/speckit-plan`
**Focus**: Retirement completeness · Governance & constitutional compliance · As-built fidelity · Downstream handoff contract

**Note**: This is a *removal* feature whose diff is small but whose blast radius touches a NON-NEGOTIABLE constitutional contract. Removal features fail by under-specifying the boundary between what goes and what stays — most items below probe that boundary.

## Requirement Completeness — Retirement Boundary

**Worked 2026-07-16. All six closed by FR-017's boundary manifest — a row-per-subject table stating GOES / STAYS / CHANGES SHAPE with an independently falsifiable check for each. Recording the Q1–Q3 decisions, not re-deciding them.**

- [x] CHK001 Is the boundary between "the automatic claim" (removed) and "the claim flag" (retained) unambiguous? [Clarity, Spec §FR-003/§FR-004]
      → **CLOSED.** FR-017 splits them into separate rows with opposite dispositions: the *call* and *module* GO; the *column* STAYS on all four tables, as does its payload exposure. No reading licenses removing the column.
- [x] CHK002 Are the invariants that must SURVIVE enumerated exhaustively rather than by example? [Completeness, Spec §FR-011a]
      → **CLOSED.** FR-017 enumerates them as checkable rows (agreement check, schema pre-flight, expiration results, the untouched flows), each traced to the FR/SC that owns it.
- [x] CHK003 Does the spec specify what "removed outright" applies to? [Ambiguity, Spec §Clarifications]
      → **CLOSED.** FR-017 separates the *module* (deleted; import now fails) from the *call* (removed; run does one phase). The prior wording left "removed outright" to be inferred.
- [x] CHK004 Are the *retained* smoke coverage requirements specific enough to distinguish repurposed / kept / deleted? [Completeness, Spec §FR-011/§FR-011a]
      → **CLOSED.** FR-017 breaks the test into four rows: the file STAYS (name kept), its agreement and schema checks STAY, its claim-mechanics assertions GO. Previously only the file-level decision was recorded.
- [x] CHK005 Does the spec cover the claim's orphaned output shape beyond the history view? [Gap, Spec §FR-007]
      → **CLOSED.** FR-007 now states the recorded shape; FR-017 covers both readers (history view and end-to-end suite). The stored schema needs no change — the field is already an untyped aggregate.
- [x] CHK006 Is there a requirement addressing whether the marker's key name and shape form a contract? [Gap, Spec §FR-007]
      → **CLOSED, and the shape was improved in the process.** FR-007 fixes the shape as a three-shape reader contract. The counts key is now **retained-and-empty** rather than dropped — see the Clarifications refinement. That change also narrowed the FR-015 deviation from "removed a key" to "changed a key's value type".

## Governance & Constitutional Compliance

**Worked 2026-07-16. All eight resolved — see Governance Findings below. The block's headline result: FR-013 as originally written was wrong, and the required amendment is roughly a tenth the size it claimed.**

- [x] CHK007 Does FR-013 specify the amendment's **substance** (what the restated invariant should say), or only that an amendment is necessary? [Gap, Spec §FR-013]
      → **FAILED as written; fixed.** FR-013 prescribed restating the permitted-mutations invariant. Reading the actual clause showed that restatement to be both unnecessary and wrong (CHK008). FR-013 now specifies the one correction's exact substance; FR-013a/b/c specify what must *not* change, which for a removal feature is the more load-bearing half.
- [x] CHK008 Are the specific constitutional clauses requiring amendment identified individually, so the plan can act on them without re-deriving them? [Traceability, Spec §FR-013]
      → **FAILED as written; fixed, and the answer inverted.** Enumerating the clauses revealed that **three of the four alleged amendments are not needed at all**. Both permitted-mutation clauses are **actor-agnostic** — they permit the claim-flip without naming who performs it or requiring that anyone does. A permitted mutation is not a required one, so nothing that currently performs no flip violates them. Only the Additional Constraints → Module layout parenthetical, which lists the claim as a post-scrape package responsibility, becomes factually false. That is the entire amendment.
- [x] CHK009 Is the amendment's **version-bump class** determinable from the spec? [Gap, Spec §FR-013]
      → **FAILED as written; fixed, and my earlier MAJOR call was wrong.** Given CHK008, no principle is removed or redefined, so MAJOR does not apply; no principle or section is added and no guidance materially expands, so MINOR does not apply. Correcting a factual parenthetical is **PATCH** ("clarifications and non-semantic refinements"). Recorded in Dependencies as clarification-class.
- [x] CHK010 Does any requirement cover the constitution's own **propagation obligation**? [Gap, Spec §FR-013]
      → **FAILED as written; fixed.** The obligation was entirely unaddressed. Now FR-013d — and discharged as a **verified** no-op: no Spec Kit template, script, or command file references the claim, the flag, or the phase structure. Confirmed by search, not assumed.
- [x] CHK011 Is the smoke-test change *deliberate and named* per Principle II's specific test? [Completeness, Spec §FR-011]
      → **PARTIAL as written; strengthened.** FR-011 declared the change deliberate but named the behavior only loosely. Principle II demands the behavior change be *named*. FR-011 now names both the behavior change and the two specific assertion sites it invalidates, which is what makes the edits authorized rather than a "test edited until it passes" violation.
- [x] CHK012 Does the spec resolve the ordering dependency between the amendment and the code change? [Gap, Spec §FR-013, §Dependencies]
      → **FAILED as written; fixed.** Unspecified. Principle III settles it: an intentional behavior change must be reflected in the spec and its smoke test **in the same change**. Now FR-014, extended to cover the constitutional correction too.
- [x] CHK013 Are the requirements consistent with Principle VII's forward-compatibility rule, given FR-007 replaces a key rather than adding? [Conflict, Spec §FR-007]
      → **CONFIRMED CONFLICT; now declared instead of silent.** This is a real deviation from the letter of the rule, not a false alarm. It is unavoidable: the only additive alternative is emitting zeroed counts for a phase that never ran, which violates the NON-NEGOTIABLE fidelity principle. Chose the fidelity principle over the additive-evolution convention, and the rule's stated *purpose* (older data stays readable, readers version independently) is preserved via FR-008. Now FR-015, flagged for the plan's complexity-tracking record per the governance clause requiring deviations be justified there.
- [x] CHK014 Is there a requirement covering whether Principle II's list of authoritative smoke tests must be updated if the test changes identity/purpose? [Gap, Spec §FR-011/§FR-013]
      → **RESOLVED — no update needed.** The clause pins its tests **by filename**, and the repurposed file keeps its name (renaming it would be a drive-by change Principle III forbids, and the name still describes its subject). Now FR-013c. Worth noting the clause anticipated this case: it already permits "deliberately and reviewably updated" tests when behavior intentionally changes.

## As-Built Fidelity — Documentation Scope

**Worked 2026-07-16. All six resolved. Bounded by an exhaustive survey: 32 markdown files reference this behavior; they sort into four buckets, and only 8 files are in scope.**

- [x] CHK015 Is the **set of documents** requiring correction enumerated, or left as an open-ended category? [Gap, Spec §FR-012]
      → **FAILED as written; fixed.** "Documentation describing the post-scrape phases" was unbounded — a plan could not size it, and the honest answer turned out to be 32 files across four buckets. FR-012 now enumerates a **closed** in-scope set (8 files), with FR-012b/c/d stating what is excluded and why. Scope is now sizeable before work starts rather than discovered during it.
- [x] CHK016 Does FR-012's scope explicitly include the constitution-designated authoritative runtime docs? [Coverage, Spec §FR-012]
      → **FAILED as written; fixed.** They were not called out at all. All three are now named first and prioritized, on the reasoning that a reader is directed to them *precisely because* they are supposed to be true — staleness there is the most costly kind.
- [x] CHK017 Is SC-010's "zero contradicting statements" scoped to a **verifiable surface**? [Measurability, Spec §SC-010]
      → **FAILED as written; fixed.** As written it quantified over the whole repository and was unfalsifiable — no one could ever demonstrate zero. Now scoped to the closed FR-012 set and verified by re-reading it. SC-011 added for FR-012a's coherence outcome.
- [x] CHK018 Does the spec distinguish defects **caused by this change** from **pre-existing** ones discovered nearby? [Conflict, Spec §FR-012]
      → **CONFIRMED CONFLICT; resolved deliberately, and not uniformly.** Principle I ("correct when discovered") genuinely collides with Principle III ("no drive-by"). Resolved by *locality*: pre-existing rot is excluded (FR-012b) **except** inside the post-scrape section being rewritten, where Principle I wins because the section cannot be made truthful otherwise (FR-012a — user decision). The exclusion is stated explicitly so the omission reads as a decision, not an oversight.
- [x] CHK019 Are the spec's as-built claims stated **falsifiably**? [Clarity, Spec §Assumptions]
      → **FAILED as written; fixed.** The claim asserted a conclusion without its evidence, so a reviewer could only trust it. It now names the **surface searched**, the **result**, and an explicit **disproof condition**. The related legacy-column confusion is now named and excluded.
- [x] CHK020 Is the redundancy claim stated with its supporting condition? [Clarity, Spec §Edge Cases]
      → **FAILED as written; fixed.** The reasoning was given but its load-bearing precondition was implicit — a future change could silently invalidate it. The condition (expiration records results before anything records claim results) and the consequence of breaking it are now stated.

## Downstream Handoff Contract

**Worked 2026-07-16. All four resolved.**

- [x] CHK021 Is SC-002 objectively verifiable given its consumer does not exist? [Measurability, Spec §SC-002]
      → **FAILED as written; fixed.** The headline success criterion was framed around "a downstream processor" — a system that cannot be run, making the feature's central claim unverifiable at ship time. Reframed to measure **the state that service will find**: run the unclaimed-jobs query directly after a real scan. Same outcome, verifiable today, no dependency on unbuilt software.
- [x] CHK022 Are the flag's **ownership semantics after retirement** defined? [Clarity, Spec §FR-004]
      → **FAILED as written; fixed.** FR-004 said only that the flag stays "writable by an external processor" — silent on directionality, reversibility, and atomicity, which is not enough to build against. FR-004a now specifies: one-way, once per row, never reversed, both sides flipped in one transaction. Notably this invents nothing — it restates obligations the existing invariants already impose.
- [x] CHK023 Is the already-claimed backlog boundary stated as a **contract**? [Assumption, Spec §Assumptions]
      → **FAILED as written; fixed.** It existed only as rationale for deferring a decision. FR-004b restates it as a codeable contract: ship time is the boundary; everything before is invisible to a claimer, everything after is visible; the backlog cannot be obtained by claiming.
- [x] CHK024 Does the spec specify whether the agreement invariant becomes the downstream service's obligation, and where that is recorded? [Gap, Spec §FR-011a, §FR-013]
      → **RESOLVED — no new governance needed.** Already covered by FR-013b and FR-004a. The invariant stays in force and unamended; combined with the existing atomic-multi-table-write rule, it already binds whoever performs the flip. This is the clearest illustration of the CHK008 finding: the invariants are actor-agnostic *by design*, so they transfer to a new actor with no amendment at all.

## Scenario & Edge Case Coverage

- [x] CHK025 Are requirements defined for the recovery/rollback path? [Gap, Coverage, Spec §Assumptions]
      → **FAILED as written; fixed.** No rollback requirement existed at all. Now **FR-016**, stated as a codeable contract: triggers (service shelved, or a missed consumer surfaces), method (**pure code revert, no migration in either direction** — the schema never changed, which is the payoff of FR-003), data state (rows left unclaimed are swept up by the next post-scrape run automatically, since the restored claim selects on unclaimed rows), and composability (**safe even if the downstream service already claimed rows** — the restored claim skips them, so it cannot clobber or double-claim). Rollback cost is a revert plus one cycle: no data loss, no repair, no coordination. Worth noting this contract is cheap *because* of earlier decisions — had the spec back-filled the corpus (D7) or touched the schema, rollback would need a reverse migration.
- [ ] CHK026 Are the requirements for a cycle failing at each distinct point (during expiration, between expiration and finalization) complete, or only for the aggregate "fails partway"? [Coverage, Spec §FR-007a, §Edge Cases]
- [ ] CHK027 Is the pre-existing/post-change corpus split addressed as a **user-facing** concern (an operator sees a mix of claimed and unclaimed jobs with no explanation), or only as a data concern? [Gap, Coverage, Spec §Assumptions]

## Consistency & Traceability

- [x] CHK028 Do FR-001 and FR-004 align without conflict, given both describe the same flag under different actors? [Consistency, Spec §FR-001/§FR-004]
      → **CLOSED — and the real conflict was elsewhere, in FR-004a.** Reading both verbatim: FR-001 was already actor-scoped ("The post-scrape run MUST NOT change...") and never contradicted FR-004. Rewritten anyway to scope the actor **broadly and explicitly** ("no process in this system"; the external claimer is expressly out of its reach) — it now says what it means instead of relying on a reader noticing the subject.
      **The genuine collision was FR-004a's "not reversible — there is no un-claim"**, stated as a global law. The downstream service's design **plans to reset the flag for blacklist re-entry** (it is in its verdict table, its flow, and its finalize step) and flags `RE-ENTRY-WRITE` as an open question. FR-004a would have forbidden, by our spec, behavior our own consumer already intends. Fixed by scoping every "never" to **this system's guarantees** and adding **FR-004c** to defer the question explicitly, neither permitting nor forbidding.
      **Finding surfaced, deliberately not resolved**: the governing invariant permits exactly one direction and "no other in-place updates", so a re-entry write would need its own governance decision. That belongs to whoever answers `RE-ENTRY-WRITE`. FR-004c flags it and pre-empts nothing — had we shipped the absolute wording, that decision would have been silently foreclosed by a spec that had no business making it.
- [ ] CHK029 Is terminology consistent across the spec — "claim state", "claim flag", "matched", "unclaimed", "processed marker" — or do synonyms invite divergent readings? [Consistency]
- [ ] CHK030 Does every success criterion trace to at least one functional requirement, and vice versa, with no orphans on either side? [Traceability, Spec §Requirements/§Success Criteria]

## Governance Findings (CHK007–CHK014, worked 2026-07-16)

**The amendment is one parenthetical, PATCH-class — not the multi-principle rewrite FR-013 described.**

The block's value was almost entirely in *disproving* my own spec. FR-013 asserted the constitution "names the automatic claim-flip as a sanctioned mutation and names the claim's smoke test as a non-negotiable contract," and concluded both needed amending. Reading the clauses word-for-word instead of from summary showed the inference was wrong on both counts:

- **The permitted-mutation clauses never name an actor.** They say the claim-flip is one of the permitted mutations — not that the post-scrape run performs it, and not that anything must. Removing the only current performer leaves a permitted-but-unperformed mutation, which the clause allows without alteration. The invariant is *waiting for* the downstream service, not broken by its absence.
- **The smoke-suite clause pins filenames, not behaviors.** The repurposed test keeps its filename, so the list stays accurate. The clause also already contains the escape hatch for exactly this situation — deliberate, declared updates when behavior intentionally changes.

What survives as genuinely required: the module-layout parenthetical describing the post-scrape package as "expiration, **claim**, orchestration" becomes false when the claim module is deleted. Correcting it is PATCH-class.

**Why this matters beyond bookkeeping.** A MAJOR-class amendment redefining data-model invariants would have been a far larger and riskier change than the code edit it accompanied — and it would have weakened the constitution for no reason, loosening invariants that are currently doing useful work guarding the downstream service's future claim. Principle III's minimal-diff rule applies to governance as much as to code.

**The one real conflict is now declared, not silent.** CHK013 confirmed a genuine collision between the additive-JSONB convention and the fidelity principle. It cannot be avoided, only chosen — and the choice belongs in the plan's complexity-tracking record (FR-015), which is where the governance clause says deviations get justified.

**Method note:** every finding here came from reading exact constitutional text; the earlier summary-level reading produced three wrong conclusions, including one of my own from the `/speckit-clarify` report. For a governance question, the summary is not a safe substitute for the clause.

## As-Built & Handoff Findings (CHK015–CHK024, worked 2026-07-16)

**FR-012 was unbounded; the true surface is 32 files, of which 8 are in scope.**

An exhaustive survey found every document referencing the phase structure, the claim, the module, or the cycle output. They sort into four buckets, and the sorting *is* the scope decision:

| Bucket | Files | Disposition |
|---|---|---|
| **Becomes false** — true today, this change falsifies it | 8 | **In scope** (FR-012) |
| **Already stale** — false today, pre-existing | 7 | **Excluded** (FR-012b) — separate work item |
| **Historical record** — shipped features' specs | 20 | **Excluded** (FR-012c) — records, not claims |
| **Forward-looking** — records this as a pending blocker | 3 | **Status update** (FR-012d) |

Three of the in-scope files are the ones the constitution designates authoritative for current behavior. Those are the corrections that matter most: readers are sent there *because* it is supposed to be true.

**The Principle I / Principle III collision is real, and the resolution is local, not uniform.** Principle I says fidelity defects "MUST be corrected when discovered"; Principle III forbids drive-by fixes. Both apply to ~245 lines of pre-existing rot sitting next to our work. Resolved by locality: excluded everywhere *except* inside the post-scrape section already being rewritten, where the section cannot be made truthful without also retiring the dead narrative around it. Absorbing that debt is a deliberate, spec-recorded choice (FR-012a), which is exactly what Principle III means by licensing *deliberate* diffs rather than bigger ones.

**Two of the spec's own claims were unfalsifiable, and that is a fidelity defect in its own right.** SC-010 quantified over the entire repository ("zero contradicting statements") — no one could ever demonstrate it. The "nothing reads the flag" assumption asserted a conclusion with no evidence and no disproof condition, asking reviewers to take it on trust. Both now state their surface and how to break them. A spec that cannot be proven wrong cannot be checked.

**The handoff block's headline: the feature's central success criterion could not be verified.** SC-002 was framed around a downstream processor that does not exist, making the reason-the-feature-exists untestable at ship time. Reframing it to measure *the state that service will find* — run the unclaimed-jobs query after a real scan — keeps the outcome identical and makes it verifiable today.

**CHK024 is the CHK008 finding paying off twice.** The agreement invariant transfers to a new actor with **no amendment**, because the invariants were written actor-agnostically. Had we accepted the naive reading and "restated the invariant so the claim-flip is owned by an external processor" (original FR-013), we would have hardcoded an actor into a clause whose actor-neutrality is precisely what makes the handoff free.

**Independent confirmation of the CHK008 finding.** The survey agent, working without the governance analysis, independently reproduced the naive reading — flagging Principle II and Principle V as becoming false (4 constitutional sites). Both are wrong for the reasons CHK008 established: II pins the surviving filename, V is actor-agnostic. The correct count is 1. That two independent readings both defaulted to the naive one is evidence the FR-013 correction was worth making, and worth stating explicitly enough that the plan does not re-derive the error a third time.

## Notes

- Check items off as completed: `[x]`
- This checklist tests **requirements quality**, not implementation. An item passes when the *spec* is clear, complete, and consistent on that point — not when code works.
- Items are ordered by risk within each category. The governance category carries the highest rework cost: a misclassified amendment or a missed propagation obligation surfaces only after the constitution is edited.
- Expected outcome: several items will legitimately fail. Failures are input to `/speckit-plan`, not a verdict on the spec — a spec that passed a 16/16 generic quality checklist can still under-specify a domain this checklist probes deliberately.
