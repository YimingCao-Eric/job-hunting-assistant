# Feature Specification: Retire the Vestigial Post-Scrape Matched-Claim

**Feature Branch**: `jha-retire-matched-autoclaim`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Retire the vestigial post-scrape matched-claim. Since dedup and matching were removed in the search-only split, the post-scrape orchestrator's Phase 2 (claim_unmatched_rows in backend/auto_scrape/matching_claim.py, called from run_post_scrape_phase in backend/auto_scrape/post_scrape_orchestrator.py) flips scraped_jobs and the per-source matched flag FALSE->TRUE for a consumer that no longer exists. A future standalone filtering/matching service needs matched to stay FALSE after a scrape so that it can claim rows itself. Remove the Phase-2 auto-claim call from the post-scrape orchestrator so that after a scrape and post-scrape run, matched remains FALSE. Keep the matched column on scraped_jobs and the per-source tables (the downstream service uses it as its processed marker). Acceptance: after a scan and post-scrape run, matched is still FALSE on the new rows; auto-expiration (Phase 1) and every other flow are unchanged; the smoke suite still reflects reality. Describe behavior and outcomes."

## Context: What Exists Today

*(Per Constitution Principle I — As-Built Fidelity. This is the current, verified behavior, not intent.)*

A scrape cycle reaches `scrape_complete`, and the post-scrape orchestrator claims it and runs two phases before finalizing it as `post_scrape_complete`:

- **Phase 1 — auto-expiration**: deletes rows older than their configured shelf life, from the three per-source tables and from the canonical table. Records what it deleted on the cycle.
- **Phase 2 — matched-claim**: flips the `matched` flag from FALSE to TRUE on every unclaimed row in all three per-source tables, and on every unclaimed canonical row. Records per-site counts on the cycle as `match_results.claim_summary`, which the cycle history view renders as "N claimed".

Phase 2 was built to hand rows to the dedup and matching pipelines. **Those pipelines were deleted in the search-only split.** Nothing consumes the claim. The flag is written on every row and then read by nothing: no listing, no filter, no report, and no export depends on `matched` having any particular value. It is presently a write-only flag whose only writer is Phase 2 and whose only reader is Phase 2's own `WHERE matched = FALSE` predicate.

The consequence is not merely dead work. A future standalone filtering/matching service is designed to own this flag as its own processed-marker, claiming rows with `WHERE matched = FALSE`. Because Phase 2 pre-claims every row at the end of every cycle, that service would find **zero** rows to process. Phase 2 is the one hard blocker for it.

## Clarifications

### Session 2026-07-16

- Q: Remove the claim's implementation module entirely, or keep it as an unused helper for the downstream service to copy? → A: Remove it entirely. Its only production caller is the call being retired; git history preserves it for the downstream service to port, which is already the established precedent for the dedup/matching code deleted in the search-only split.
- Q: Retire the claim's dedicated smoke test, or repurpose it? → A: Repurpose it. It is renamed in purpose from "the automatic claim works" to "no automatic claim occurs, and the flag's invariants still hold" — asserting jobs stay unclaimed after a post-scrape run, while retaining its still-valid checks that the canonical and per-source claim states agree and that the flag's storage contract is intact. Those two checks are unaffected by this change and must not be lost.
- Q: When is the retired-claim marker recorded on a cycle — only on successful completion, or in the retired phase's old position so that failed cycles carry it too? → A: Only on successful completion, recorded as part of finalizing the cycle. The marker asserts that a completed cycle performed no automatic claim, which is only meaningful for a cycle that completed. A cycle that fails before finishing records no marker, which regresses nothing (see Edge Cases).

### Session 2026-07-16 (later) — refinement to the Q3 shape

- **Refined**: the marker's recorded shape is `{"claim_summary": null, "claim_retired": true}` — the claim-counts key **retained and explicitly empty**, not dropped. The original Q3 answer implied dropping it entirely (`{"claim_retired": true}`). Retaining it is strictly better and the reason is worth keeping: an absent key cannot be distinguished from a truncated or partially-written record, whereas a present-but-empty key states "no counts were produced" positively. It also **narrows the forward-compatibility deviation** from "removed a key" to "changed a key's value type", since the rule's prohibition is on removing (see FR-015). Reader precedence is unaffected: an empty counts value is falsy, so the historical-counts branch still takes precedence for old cycles.

### ⚠️ Considered and rejected — do not re-derive

**The naive constitutional reading. Two independent readings have already defaulted to it; do not make it a third.**

The tempting conclusion is that retiring the auto-claim falsifies **four** constitutional sites and needs a **MAJOR** amendment redefining data-model invariants. **It does not.** Verified against the clause text, word for word:

- **The permitted-mutation clauses name no performer.** They state the claim-flip is a *permitted* mutation — never that the post-scrape run performs it, never that anything must. Removing the only current performer leaves a **permitted-but-unperformed** mutation, which satisfies the clause unchanged. The invariant is not broken by the claim's absence; it is *waiting for* the downstream service. **Do not amend it.**
- **The smoke-suite clause pins a filename, not a behavior.** The repurposed test keeps its filename, so the list stays accurate. That clause already permits deliberate, declared updates when behavior intentionally changes — which is exactly this case. **Do not amend it.**

**Exactly one site is falsified**: the module-layout parenthetical describing the post-scrape package as containing the claim. That is a factual correction — **PATCH**, not MAJOR (no principle removed, renamed, or redefined; nothing added or materially expanded).

**Why this matters, not just bookkeeping.** A MAJOR amendment would be larger and riskier than the code change it accompanies, and would **loosen invariants that are currently doing useful work**. Their actor-neutrality is precisely what lets the claim obligation transfer to the downstream service for free (FR-013b) — hardcoding an actor into the clause would destroy the property that makes the handoff cost nothing. See FR-013 through FR-013d.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Freshly scraped jobs stay available for downstream processing (Priority: P1)

The operator runs a scan. Jobs are ingested, the post-scrape run completes, and the newly scraped jobs remain **unclaimed** — available for a downstream filtering/matching service to pick up and process on its own schedule.

**Why this priority**: This is the entire feature. It is the single blocking prerequisite for the downstream service; nothing else in this spec matters if this does not hold.

**Independent Test**: Run a scan end-to-end, wait for the cycle to reach `post_scrape_complete`, then inspect the claim state of the newly ingested jobs. Every new job reports unclaimed. Delivers the value on its own: the downstream service now has a non-empty work queue after every cycle.

**Acceptance Scenarios**:

1. **Given** a scan that ingests new jobs from one or more sources, **When** the post-scrape run for that cycle finishes and the cycle reports complete, **Then** every newly ingested job — canonical and per-source alike — reports **unclaimed**.
2. **Given** jobs that are already unclaimed and were ingested by an earlier cycle, **When** a later post-scrape run completes, **Then** those jobs are still unclaimed — no cycle claims rows it did not ingest, and no cycle claims rows at all.
3. **Given** a job that some other actor has already claimed (e.g. a downstream service marked it processed), **When** a post-scrape run completes, **Then** that job's claim is untouched — post-scrape neither claims nor un-claims anything.
4. **Given** a completed post-scrape run, **When** the operator inspects the claim state across the canonical table and its per-source origin, **Then** the two agree for every job, as they always have.

---

### User Story 2 - Everything else about a scrape behaves exactly as before (Priority: P1)

The operator's day-to-day experience of scanning, browsing, and expiring jobs is indistinguishable from before this change, apart from the retirement of the claim itself.

**Why this priority**: Equal to P1 above and inseparable from it. Retiring the claim is only correct if it is *surgical* (Constitution Principle III). A regression in auto-expiration or the job listing would be a strictly worse outcome than leaving the vestigial claim in place.

**Independent Test**: Exercise auto-expiration and the job listing before and after the change and compare outcomes; run the existing smoke suite. Both behave identically.

**Acceptance Scenarios**:

1. **Given** jobs that have passed their configured shelf life, **When** a post-scrape run executes, **Then** they are expired and removed exactly as before — same rows, same counts, same record of what was deleted on the cycle.
2. **Given** a completed post-scrape run, **When** the operator views the job listing, **Then** the same jobs appear, in the same order, with the same fields, as they would have before this change.
3. **Given** a post-scrape run, **When** it completes, **Then** it still transitions the cycle to complete, still records its completion time, and still recovers from failure the same way — the retirement removes a phase, not the orchestration around it.
4. **Given** a scan, ingest, or dismissal action, **When** the operator performs it, **Then** it behaves exactly as before; none of these paths ever depended on the claim.

---

### User Story 3 - The cycle history tells the truth about what ran (Priority: P2)

The operator opens the cycle history and sees an honest account of a completed cycle: expiration results as always, and — where the row previously read "N claimed" — an explicit indication that the claim phase is retired. No cycle reports having claimed jobs it did not claim.

**Why this priority**: P2 because it is reporting, not mechanism — the downstream unblocking in Story 1 holds regardless. It is not lower than P2 because a cycle that silently reports "0 claimed" would be a fidelity defect (Constitution Principle I): a phase that no longer exists must not keep filing reports.

**Independent Test**: Complete a cycle and view its history entry. The results reflect a retired claim rather than a claim count.

**Acceptance Scenarios**:

1. **Given** a cycle completed after this change, **When** the operator views its history entry, **Then** its results indicate the claim is retired, and no per-site claim counts are shown.
2. **Given** a cycle completed **before** this change, **When** the operator views its history entry, **Then** it still renders its historical claim counts — old cycles are historical records and are not rewritten or broken.
3. **Given** any completed cycle, **When** the operator views its history entry, **Then** expiration results are shown exactly as before.

---

### Edge Cases

- **A cycle that ingests nothing.** An empty scan still completes, still expires, and still reports a retired claim. There are no rows to leave unclaimed and nothing special happens.
- **Concurrent cycles.** Two post-scrape runs overlapping no longer contend over the claim at all — removing the phase removes the contention rather than resolving it.
- **Crash mid-run.** The known crash window where rows could be claimed with no record of the claim (rows flipped in one transaction, the summary recorded in a separate one) **ceases to exist**, because nothing flips them. This retires an outstanding defect rather than working around it. A crash between expiration and finalization behaves as it does today.
- **A cycle that fails partway through.** It records no claim indication (FR-007a). Its "failed after producing results" disclaimer is unaffected: that disclaimer is driven by several independent signals, and the claim results were never able to be the deciding one — the claim only ever ran *after* expiration had already recorded its own results, so expiration's record was always present first whenever claim results were. Removing the claim therefore cannot cost a failed cycle its disclaimer. **This redundancy holds only while expiration records its results before anything records claim results.** A future change that recorded claim-related results without expiration results having been recorded first would break it, and would need to re-examine the disclaimer's signals.
- **Rows already claimed before this change ships.** Every row currently in the tables is already claimed TRUE by the outgoing Phase 2. Retiring the claim does not un-claim them; from the downstream service's perspective the existing corpus reads as already-processed and only newly scraped rows appear as work. This is a deliberate boundary — see Assumptions.
- **The downstream service does not exist yet.** After this ships and before that service is built, `matched` has a writer of nobody and a reader of nobody: it stays FALSE on all new rows indefinitely. This is the intended resting state, not a bug.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: **No process in this system flips a job's claim state after a scrape.** A job remains unclaimed until an **external claimer** sets it. After a post-scrape run completes, every job's claim state MUST be exactly what it was when the run started. This requirement constrains **this system only** — it does not forbid, restrict, or govern the external claimer's writes, which FR-004 covers.
- **FR-002**: Newly ingested jobs MUST report **unclaimed** after their cycle's post-scrape run completes, on both the canonical record and its per-source origin.
- **FR-003**: The system MUST retain the claim flag on both the canonical and per-source records, with its current unclaimed-by-default behavior at ingest. No schema change.
- **FR-004**: The claim flag MUST remain writable by an external processor, so a downstream service can claim rows itself. Retiring the automatic claim MUST NOT retire the concept of claiming.
- **FR-004a**: The flag's semantics after retirement MUST be specified precisely enough for an external processor to rely on, since this feature exists to serve one. **Stated as this system's guarantees, not as global law:**
  - **This system never sets the flag to claimed**, and never reverses a claim. That is a guarantee about *our* behavior — the basis on which a claimer can trust that an unclaimed row is genuinely unworked and that its own claim will not be undone by us.
  - **A claimer MUST flip the canonical record and its per-source origin together, in a single transaction**, so the two never disagree. This is not a new rule: it is the existing agreement invariant combined with the existing requirement that multi-table writes be atomic.
  - **The claim is one-way from this system's perspective**: we observe rows moving unclaimed → claimed, once per row, and never move them back.
  - Nothing in this system claims rows after this change, so the first claimer will be that external processor.
- **FR-004b**: The already-claimed backlog MUST be stated as a **contract the downstream service can code against**, not merely as a deferred decision: every row that exists at the moment this ships is already claimed and will therefore be invisible to a claimer, and every row ingested afterward will be unclaimed and visible. The boundary is the ship time of this change. A downstream service that wants the pre-existing corpus MUST arrange for it deliberately; it cannot obtain it by claiming.
- **FR-004c**: **Whether an external claimer may reset a claimed row back to unclaimed is explicitly OUT OF SCOPE.** This specification neither permits nor forbids it, and MUST NOT be read as doing either. The question is owned by the downstream service's design, which tracks it as an open item (its `RE-ENTRY-WRITE` question) because that service plans to reset the flag for blacklist re-entry. Deferring is deliberate: an absolute "never reversed" here would silently forbid, by our spec, behavior our own consumer already plans.
  **Consequence to flag, not to resolve**: the governing data-model invariant permits exactly one direction (unclaimed → claimed) and "no other in-place updates". A re-entry write would therefore need its own governance decision. That decision belongs to whoever answers `RE-ENTRY-WRITE`, not to this feature, and this feature MUST NOT pre-empt it in either direction.
- **FR-005**: Auto-expiration MUST be unchanged in every observable respect: which rows it expires, how many, what it records, and when it runs.
- **FR-006**: The post-scrape run MUST still transition a claimed cycle to complete, record completion time, and handle and record failures exactly as it does today.
- **FR-007**: A cycle that **completes successfully** after this change MUST record an explicit indication that the claim phase is retired, recorded as part of finalizing the cycle. It MUST NOT record claim counts — including zeroed counts — for a phase that did not run. The claim-counts key MUST be **retained and explicitly empty** rather than dropped: its presence-with-no-value states "this cycle produced no claim counts" positively, where an absent key would leave a reader unable to distinguish a retired phase from a truncated record. Concretely, the recorded shape is `{"claim_summary": null, "claim_retired": true}`. Readers MUST treat an empty claim-counts value as "no counts", never as "zero counts".
- **FR-007a**: A cycle that **fails** before finishing MUST record no claim indication at all. Its other partial results MUST still be preserved and surfaced exactly as they are today, so a cycle that failed after expiring rows is still identifiable as having produced real results.
- **FR-008**: Cycles completed **before** this change MUST continue to display their historical claim counts. Historical records are not rewritten.
- **FR-009**: The cycle history view MUST render the retired-claim indication legibly, without falling back to an empty or placeholder value.
- **FR-010**: Every other flow — scan, ingest, job listing, dismissal, admin cleanup — MUST be unchanged. None of them read the claim flag today, and this change MUST NOT introduce a dependency on it.
- **FR-011**: The smoke suite MUST reflect the new reality: it MUST assert that a post-scrape run leaves jobs unclaimed, and MUST NOT assert that the automatic claim occurs. Any smoke assertion that pins the retired behavior MUST be updated as a named, deliberate consequence of this spec — never edited merely to make a run pass (Constitution Principle II). **The behavior change being named is**: the post-scrape run no longer claims rows, so jobs stay unclaimed after a cycle, and a completed cycle reports a retired claim instead of per-site claim counts. **The assertions this invalidates are**: the claim's dedicated smoke test, which asserts the flip occurs and its counts are returned; and the end-to-end suite's post-scrape check, which requires a completed cycle to carry per-site claim counts under an exact-match key set. Both MUST be updated to assert the new behavior, and their update is authorized by this requirement.
- **FR-011a**: The smoke coverage that guards invariants **unaffected** by this change MUST be retained, not discarded alongside the retired behavior. Specifically: that a job's claim state and its per-source origin's claim state always agree, that the flag's storage contract (present, non-nullable, unclaimed-by-default) is intact on every table, and that jobs are unclaimed at ingest.
- **FR-012**: Documentation that **this change makes false** MUST be corrected. The affected set is enumerated and closed — the work is bounded to these documents, verified by an exhaustive survey:
  - The three documents the constitution designates as authoritative for current as-built behavior and for live schemas. These are the highest-priority corrections: a reader is directed to them *because* they are supposed to be true.
  - The project's top-level summary, the root and backend READMEs, and the Spec Kit tutorial, each of which describes the retired phase or the deleted module as live.
  - The constitution's own description of the post-scrape package's contents (FR-013).
- **FR-012a**: In the authoritative workflow document, the post-scrape **section MUST be made coherent end to end**, not merely stripped of the retired phase. That section additionally describes later pipeline stages as stubs when they were deleted in the search-only split; correcting only this change's lines would leave the authoritative account describing a run that expires rows and then does nothing, wrapped in a narrative about stages that do not exist. The post-scrape account MUST read correctly as: scrape, expire, finalize. This deliberately absorbs some pre-existing debt, justified because the section cannot be made truthful otherwise and Principle I obliges correction of what is discovered.
- **FR-012b**: Documentation that is **already false today**, outside the post-scrape account being rewritten, MUST NOT be corrected by this change. It is a pre-existing defect, is already self-declared in the affected documents and already tracked in the constitution's own outstanding-work record, and belongs to its own work item. This change MUST NOT absorb it (Principle III). This exclusion MUST be stated rather than left implicit, so the omission is legible as a decision instead of an oversight.
- **FR-012c**: Historical records MUST NOT be rewritten. The specifications, plans, and checklists of previously shipped features describe what was true when they shipped; they are records, not claims about the present. This is the same principle FR-008 applies to historical cycles. The specification for *this* change is likewise exempt: its account of the pre-change system is required to describe the claim as live (Principle I).
- **FR-012d**: Forward-looking documents that record this work as an outstanding blocker MUST have their **status** updated to reflect that it has shipped. This is a status correction, not a correctness fix — but leaving them asserting that the blocker is still required would be false the moment this lands, and one of them is the design document this feature exists to unblock.
- **FR-013**: The governing constitution MUST be corrected in exactly one place: its description of the post-scrape package's contents, which lists the claim as one of that package's responsibilities and becomes false once the claim is removed. This is a factual correction to an as-built description (Principle I), not a change to any principle.
- **FR-013a**: The data-model invariants governing permitted mutations MUST NOT be amended, and MUST be left exactly as they are. They permit the claim-flip without requiring it or naming who performs it; a permitted mutation that nothing currently performs does not violate them. Amending them would be an unnecessary governance change (Principle III).
- **FR-013b**: The requirement that the canonical and per-source claim states never disagree MUST remain in force and unamended. After this change the invariant holds trivially, since nothing flips either side. When an external processor later claims rows, that same invariant — combined with the existing requirement that multi-table writes be atomic — already obliges it to flip both together. No new governance is needed to record that obligation.
- **FR-013c**: The smoke suite's governing clause MUST NOT be amended. It designates the claim's smoke test as authoritative **by filename**, and that file survives with its name intact; the clause already permits deliberate, declared updates when behavior intentionally changes, which is exactly this case. The suite therefore accommodates this change natively.
- **FR-013d**: The requirement to propagate constitutional amendments to dependent Spec Kit templates and command files MUST be discharged as a verified no-op: no template or command file references the claim, the flag, or the post-scrape phase structure. This MUST be confirmed rather than assumed.
- **FR-014**: The constitutional correction, the behavior change, the spec, and the smoke-test change MUST land **in the same change**, as the governing rules require an intentional behavior change to be reflected in the spec and its smoke test together.
- **FR-015**: The change to the cycle's claim output is a **narrow, declared deviation** from the rule that aggregate stored outputs evolve additively — producers add keys rather than repurpose or remove them. It MUST be declared in the plan's complexity-tracking record rather than taken silently.
  **Scope of the deviation**: the claim-counts key is **retained**, not removed (FR-007) — so the rule's prohibition on *removing* keys is not breached. What changes is the key's value type: an object of counts becomes empty, and a new key is added alongside it. Adding the new key is squarely additive. The residual deviation is therefore the value-type change alone, which is the narrowest form this could take.
  **Why any deviation at all**: the strictly additive alternative — continuing to emit claim counts, necessarily zeroed — would have a retired phase filing truthful-looking reports forever, violating the non-negotiable as-built fidelity rule. Where the two collide, fidelity wins.
  **The rule's purpose is preserved intact**: stored aggregates and their readers version independently, and older data is not broken. Historical cycles keep their counts and remain readable (FR-008); readers distinguish the shapes by the counts value, which is exactly the discriminator the retained key provides.

- **FR-016**: **Rollback MUST be possible as a pure code revert, and the contract for it is stated here** rather than discovered under pressure.
  - **Triggers**: the downstream service is shelved or delayed indefinitely, making an unclaimed corpus pointless; **or** retirement surfaces a consumer of the claim that the as-built survey missed.
  - **Method**: revert the code — restore the claim call in the post-scrape run, restore the claim module from version history, revert the cycle-output shape, and revert the two smoke-test assertions. **No migration, in either direction.** The column, its type, its constraint, and its default never changed, so there is nothing in the database to reverse. This is the practical payoff of the no-schema-change decision (FR-003).
  - **Data state after revert**: rows left unclaimed during the window are claimed by the **next** post-scrape run, automatically. The restored claim selects on unclaimed rows, so it sweeps up the backlog with no repair step, no back-fill, and no orphaned state.
  - **Composability**: safe **even if the downstream service claimed rows during the window**. The restored claim only touches unclaimed rows, so it skips anything already claimed and cannot clobber the service's work or double-claim.
  - **Cost of rollback is therefore a code revert plus one cycle.** No data loss, no manual repair, no coordination with the downstream service.
- **FR-017**: The **retirement boundary MUST be explicit and falsifiable** — what goes, what stays, and what changes shape. Each row below is independently checkable; a reader must not have to infer the boundary from prose.

  | Subject | Disposition | Falsifiable check |
  |---|---|---|
  | The claim's implementation module | **GOES** — deleted outright | Importing it raises a module-not-found error; nothing imports it |
  | The automatic claim call in the post-scrape run | **GOES** | The run performs one phase of work; jobs stay unclaimed (FR-001) |
  | The claim flag column, on the canonical table **and** all three per-source tables | **STAYS** — all four, unchanged | Column present, non-nullable, defaulting to unclaimed, on every one of the four tables (FR-003) |
  | The flag's exposure in the job payload | **STAYS** | Every job still carries the field; its value now varies rather than being uniformly claimed |
  | The claim's dedicated smoke test | **STAYS** — repurposed, filename kept | The file exists under its original name and asserts the inverse behavior (FR-011) |
  | — its canonical/per-source **agreement** check | **STAYS** | Still asserts the two never disagree (FR-011a, SC-008) |
  | — its **schema pre-flight** check | **STAYS** | Still fails loudly on column drift (FR-011a, FR-003) |
  | — its claim-mechanics assertions | **GO** | Nothing asserts the automatic claim occurs (FR-011) |
  | Expiration results on a cycle | **STAYS** — unchanged, and remains the partial-results signal for failed cycles | A cycle that failed after expiring is still identifiable as having produced real results (FR-007a) |
  | The cycle's claim output | **CHANGES SHAPE** — see FR-007 and the output contract | New completed cycles carry the retired marker and no counts; historical cycles unchanged (FR-008) |
  | The cycle history view and the end-to-end suite | **CHANGE** — updated to read the new shape | Both serve historical and new shapes correctly (FR-009, FR-011, SC-007) |
  | Auto-expiration, the job listing, ingest, dismissal, admin cleanup, the scrape paths | **STAY** — untouched | Identical observable behavior before and after (FR-005, FR-010, SC-003, SC-004) |
  | Database schema and the migration chain | **STAY** — no change, no migration | Migration head is unmoved (FR-003) |

### Key Entities

- **Job record (canonical and per-source)**: A scraped job. Carries a **claim state** — unclaimed at ingest, flippable once to claimed. After this change, only an external processor flips it. Canonical and per-source claim states must always agree.
- **Scrape cycle**: One scan-and-post-scrape run. Carries its status, timing, expiration results, and — where it previously carried claim counts — an indication that the claim is retired.
- **Post-scrape run**: The work performed on a cycle after scraping completes. Today: expire, claim, finalize. After this change: **expire, finalize**.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a scan and post-scrape run, **100%** of newly ingested jobs report unclaimed — zero exceptions across all three sources.
- **SC-002**: After a completed cycle, a query for unclaimed jobs returns **all** of that cycle's new jobs, where today it returns **zero**. This is the feature's reason for existing and its headline outcome. It is verified by **running that query directly** against the data after a real scan — the downstream service is not required to exist, because the criterion measures the *state the service will find*, not the service itself.
- **SC-003**: Auto-expiration expires exactly the same jobs, in the same numbers, before and after the change — **zero** difference.
- **SC-004**: The job listing returns identical results before and after the change for the same data — **zero** user-visible difference.
- **SC-005**: The full smoke suite passes, and **zero** of its assertions describe behavior that no longer exists.
- **SC-006**: **Zero** cycles completed after this change report a claim count.
- **SC-007**: Cycles completed before this change still display their historical claim counts — **100%** of historical entries render as they did.
- **SC-008**: The claim state of a job and its per-source origin agree in **100%** of cases, unchanged from today.
- **SC-009**: The post-scrape run performs **one** phase of work instead of two, and the operator observes no other change in how a scan completes.
- **SC-010**: **Zero** statements in the enumerated in-scope document set (FR-012) contradict the shipped behavior. Verified by re-reading that closed set — not by an open-ended search of the repository, which would make the criterion unfalsifiable. Documents excluded by FR-012b and FR-012c are outside this measurement by design.
- **SC-011**: The post-scrape account in the authoritative workflow document reads coherently end to end, describing the run as scrape, expire, finalize, with **zero** references to stages that do not exist (FR-012a).

## Assumptions

- **The existing already-claimed corpus is left as-is.** Every row currently in the database was claimed TRUE by the outgoing Phase 2. This spec does **not** back-fill them to FALSE. Rationale: the downstream service does not exist yet, so there is no consumer to serve today; a blanket un-claim is a data migration with its own risk and belongs to whoever builds that service, who is best placed to decide whether the historical corpus should be processed at all. Only newly scraped rows are guaranteed unclaimed. If the downstream service later wants the backlog, that is a separate, deliberate decision.
- **No schema change, therefore no migration.** The claim column, its type, its NOT NULL constraint, and its FALSE default all stay exactly as they are. Only the writer goes away.
- **The claim flag stays exposed** wherever it is already surfaced. Consumers can already see it; this change makes its value meaningful rather than uniformly TRUE.
- **The retired-claim indication is a per-cycle marker**, not a configuration setting. There is no toggle to re-enable the automatic claim; retirement is permanent. Re-introducing an automatic claim would require its own spec.
- **The downstream filtering/matching service is out of scope.** This spec unblocks it and does not build, stub, or scaffold any part of it.
- **The claim's implementation is removed outright, not retained as a reference.** Resolved in clarification. The downstream service recovers the pattern from version history if it wants it — the same route already taken for the dedup and matching code deleted in the search-only split. No dead code is left behind in the post-scrape layout.
- **The cycle history view is the only consumer of a cycle's claim results**, verified as-built. It consumes them in two places: the results cell that renders "N claimed", and the partial-results disclaimer for failed cycles. Only the first is behaviorally live — the second reads the claim results as one of several interchangeable signals that can never be the deciding one (see Edge Cases). No other view, export, alert, or report reads them; no export or reporting path exists at all.
- **Nothing reads the claim flag's *value*.** Verified as-built, and stated here falsifiably so a reviewer can disprove it rather than trust it. **Surface searched**: every backend route module, the post-scrape package, the ingest/projection path, all Alembic migrations, all raw SQL containing the flag's name, the frontend's components and types, and any export or reporting path (none exists). **Result**: the only predicates on the flag anywhere are inside the claim being removed and its own smoke test; the job listing filters on other fields entirely; auto-expiration's delete is purely time-based; the admin cleanup's apparent matches are a different word containing the same substring. No index, view, trigger, constraint, or generated column involves the flag, so a uniformly-unclaimed corpus changes no query plan. **Disproof condition**: a single read path branching on the flag's value would invalidate this and require FR-010 to be re-examined.
- **The legacy timestamp column with a similar name is a different column** and is out of scope. Documentation referring to it describes a column dropped by an earlier migration — a pre-existing defect, excluded by FR-012b.

## Dependencies

- **Blocks**: the standalone filtering/matching service (recorded there as prerequisite **JHA-B**, its one hard blocker). That service claims rows itself with `WHERE matched = FALSE` and finds nothing until this ships.
- **Requires**: a single factual correction to the project constitution (FR-013) — its description of what the post-scrape package contains. Verified as-built during checklist review: this is the **only** governance change needed. The permitted-mutation invariants, the claim-state agreement invariant, and the smoke-suite clause all survive untouched (FR-013a/b/c), because none of them names the post-scrape run as the actor that performs the claim. The correction is a clarification-class change under the constitution's own versioning policy, not a principle redefinition. Template propagation is a verified no-op (FR-013d).
- **Declares one deviation**: replacing the per-cycle claim counts rather than adding alongside them (FR-015), to be justified in the plan's complexity-tracking record.
- **Relates to**: feature 009 (canonical filter columns), the sibling prerequisite **JHA-A**, already shipped. This feature is independent of it.
