# Phase 0 Research: Retire the Vestigial Post-Scrape Matched-Claim

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-16

**Status**: No NEEDS CLARIFICATION remain. Every unknown was resolved by direct inspection of the code and the constitution, not by inference. This document records the decisions and — more usefully — the ones that turned out to be wrong on first reading.

## D1 — Disposition of the claim module

**Decision**: Delete `backend/auto_scrape/matching_claim.py` outright.

**Rationale**: Its only production caller is the line being removed. Git history preserves it for the downstream service to port — the established precedent, since the entire `dedup/`, `matching/`, and `profile/` packages were recovered-from-history rather than kept as dead code in the search-only split. Its docstring is also self-justifying in a way that has already rotted: it defends the canonical flip by citing "a future matching run would re-claim them," a pipeline deleted in that same split. Keeping it means keeping a stale rationale nothing exercises.

**Alternatives considered**:
- *Keep as an unused helper for the downstream service to copy* — rejected. Dead code in the constitution's sanctioned module layout, with a docstring needing correction anyway, and no exercise to keep it honest. The service's claim semantics are already specified independently in `filter-matching-service-design.md`, so the helper is not what unblocks anyone.
- *Keep but relabel as a reference artifact* — rejected. Still dead code, still needs the docstring fixed, and invents a category the layout has no room for.

## D2 — Disposition of the claim's smoke test

**Decision**: Repurpose `smoke_test_matched_claim.py`, keeping its filename. Its identity shifts from "the automatic claim works" to "no automatic claim occurs, and the flag's invariants still hold."

**Rationale**: Principle II names the file as an authoritative behavioral contract and prohibits "editing a test until it passes." Repurposing is the opposite of that prohibition: the behavior genuinely changed, this spec names the change deliberately, and the test keeps guarding the same invariant from the other side. Decisively, **the file is not wholly about the claim** — its canonical-vs-per-source agreement check and its pre-flight schema guard test invariants this change does not touch. Deleting the file would have silently dropped that coverage, which is how a suite gets quietly weakened.

The filename stays because Principle II pins tests **by filename**: keeping it means the Principle II list stays accurate with no amendment (see D5), and renaming would be a Principle III drive-by. The name still describes its subject — the matched claim — which is exactly what it now asserts does not happen automatically.

**Alternatives considered**:
- *Delete it* — rejected. Drops the agreement and schema coverage; de-names a constitutionally-pinned file for no gain.
- *Split it* — migrate surviving checks elsewhere, delete the rest. Rejected: cleanest conceptually, largest diff, and Principle III does not license bigger diffs.

## D3 — Where the retired-claim marker is written

**Decision**: Only on successful completion, folded into the existing finalize write. Failed cycles record no marker.

**Rationale**: The marker asserts "this cycle completed without an auto-claim," which is only meaningful for a cycle that completed. Stamping it on a cycle that died during expiration would assert something about a phase that never got the chance to be skipped. Collapses two DB writes into one (Principle III).

**Why this is safe — the non-obvious part**: `hasPartialResults` in `CycleHistory.tsx` ORs four signals for failed cycles, one being `match_results !== null`. Losing it looks like a regression. It is not: expiration always writes a non-null `cleanup_results` dict *before* anything could write `match_results`, so `cleanup_results !== null` is already true whenever `match_results !== null`. **The disjunct can never be the deciding signal.** Verified by reading both the orchestrator's write order and `auto_expiration.py`'s return value. This is why `hasPartialResults` is left UNCHANGED.

**Alternatives considered**:
- *Write it in Phase 2's old slot* — rejected. Preserves write ordering that nothing depends on, and keeps a vestigial write step shaped like the phase being deleted.

## D4 — The `match_results` shape (Principle VII collision)

**Decision**: `{"claim_summary": null, "claim_retired": true}` — the counts key **retained and explicitly empty**, with the marker added alongside. Declared as a narrow deviation in the plan's Complexity Tracking.

**Refined after first drafting** (see spec Clarifications). The initial answer dropped the counts key entirely (`{"claim_retired": true}`). Retaining it as `null` is better on two counts: an absent key cannot be distinguished from a truncated or partially-written record, whereas a present-but-empty key states "no counts were produced" positively; and it **narrows the Principle VII deviation** from "removed a key" — which the clause explicitly prohibits — to "changed a key's value type", since the addition of `claim_retired` is itself purely additive. Reader precedence is unaffected: `null` is falsy, so the historical-counts branch still wins for old cycles.

**Rationale**: Three options existed and each violates something:

| Option | Violates |
|---|---|
| Drop `match_results` entirely (null) | Principle VII (removes a key); `CycleHistory` silently renders `—` |
| Keep `claim_summary`, always zeros | **Principle I (NON-NEGOTIABLE)** — a deleted phase files truthful-looking reports forever |
| Explicit retired marker | Principle VII (repurposes a key) |

Principle I is NON-NEGOTIABLE and outranks a forward-compat convention. The convention's *purpose* — "stored aggregates and their readers version independently without breaking older data" — is preserved anyway: historical cycles keep their counts (FR-008) and the render path serves both shapes. So the letter is broken and the spirit is kept, which is the right trade when they conflict.

## D5 — Scope of the constitutional amendment ⚠️ **first reading was wrong**

**Decision**: **One** correction — the Additional Constraints → Module layout parenthetical. **PATCH** class (1.1.0 → 1.1.1).

**Rationale, and the correction**: The spec originally asserted (FR-013) that the constitution "names the automatic claim-flip as a sanctioned mutation and names the claim's smoke test as a non-negotiable contract," concluding both needed amending — a MAJOR-class redefinition. **Reading the clauses word-for-word rather than from summary broke this on both counts:**

- **The permitted-mutation clauses are actor-agnostic.** Principle V says rows have "exactly two permitted mutations: flipping `matched` from `false` → `true` once per row (claim-and-flag), and auto-expiration `DELETE`." It never says *post-scrape* performs the flip, and never says anything must. Removing the only current performer leaves a **permitted-but-unperformed** mutation, which the clause allows unchanged. The invariant is not broken by the claim's absence — it is *waiting for* the downstream service.
- **Principle II pins filenames, not behaviors.** The repurposed test keeps its name, so the list stays accurate. The clause already contains the escape hatch for exactly this case: tests "deliberately and reviewably updated when behavior intentionally changes."

What genuinely breaks: the module-layout parenthetical calls `auto_scrape/` "(post-scrape pipeline: expiration, **claim**, orchestration)". Once the module is deleted, that is false. Correcting a factual parenthetical is **PATCH** — no principle removed or redefined (rules out MAJOR), nothing added or materially expanded (rules out MINOR).

**Why this matters**: a MAJOR amendment redefining data-model invariants would have been larger and riskier than the code change it accompanied, and would have **loosened invariants currently doing useful work** — the actor-neutrality is precisely what lets the claim obligation transfer to the downstream service for free (see D6). Principle III applies to governance as much as to code.

**Corroboration**: an independent survey agent, working without this analysis, reproduced the naive reading and flagged 4 constitutional sites as becoming false. Two independent readings defaulting to the same error is evidence the naive reading is the tempting one, and worth stating loudly enough that implementation does not re-derive it a third time.

## D6 — Who owns the agreement invariant after retirement

**Decision**: Nothing new is needed. The invariant stays in force, unamended.

**Rationale**: After this change it holds trivially — nothing flips either side. When the downstream service claims rows, Principle V's agreement clause ("the two never disagree") combined with Principle IV's "multi-table writes MUST be atomic" already obliges it to flip both together. Both rules are actor-agnostic, so they bind the new actor with no governance change at all. This is D5's finding paying off: had we hardcoded "owned by an external processor" into the clause, we would have destroyed the neutrality that makes this free.

## D7 — The already-claimed backlog

**Decision**: Leave it. Do not back-fill existing rows to unclaimed. State the boundary as a contract (FR-004b).

**Rationale**: Every row currently in the database is claimed `TRUE` by the outgoing phase. A blanket un-claim is a data migration with its own risk, serving a consumer that does not exist yet. Whoever builds that service is best placed to decide whether the historical corpus should be processed at all. Ship time is the boundary: everything before is invisible to a claimer, everything after is visible.

**Alternatives considered**: *Back-fill to FALSE* — rejected as speculative work for an absent consumer, and it would force the future service to process a large historical corpus it may not want.

## D8 — Documentation scope

**Decision**: Correct the 8 documents this change falsifies; exclude pre-existing rot, historical records, and (except for status) forward-looking docs.

**Rationale**: An exhaustive survey found 32 markdown files referencing this behavior, sorting into four buckets:

| Bucket | Files | Disposition |
|---|---|---|
| Becomes false (this change falsifies it) | 8 | **In scope** — FR-012 |
| Already stale today | 7 | Excluded — FR-012b |
| Historical records (shipped features' specs) | 20 | Excluded — FR-012c |
| Forward-looking (records this as pending) | 3 | Status update — FR-012d |

**The Principle I / III collision, resolved by locality**: Principle I says fidelity defects "MUST be corrected when discovered"; Principle III forbids drive-by fixes. Both apply to ~245 lines of pre-existing rot sitting beside our work. Excluded everywhere **except** inside the post-scrape section being rewritten (FR-012a), where the section cannot be made truthful piecemeal — removing only Phase 2 would leave the authoritative runtime doc showing "expire → nothing" wrapped in a narrative about deleted stages. Absorbing that debt is a deliberate, user-approved choice; Principle III licenses *deliberate* diffs, not bigger ones.

## D9 — As-built verification (the "regresses nothing" claim)

**Decision**: The claim survives on every named suspect, but the blanket wording was false and is now stated falsifiably.

**Rationale**: An adversarial pass tried to disprove "nothing depends on the automatic claim":

- **`GET /jobs`** — `conditions` built from `dismissed`, `source_site`, `scan_run_id`, `posted_at`, `scrape_time`. The only `matched` in the 965-line file is a comment. No filter, sort, join, count, or response branch. **Clean.**
- **auto-expiration** — `DELETE FROM {table} WHERE scrape_time < NOW() - make_interval(days => :d)` across all four tables. Purely time-based; its docstring says "regardless of `matched`". **Clean.**
- **admin cleanup** — every apparent hit is the substring **`mismatched`** in a retired counter hardcoded to `0`. **Clean.**
- **orchestrator finalize** — `claim_results` is discarded except for `len()`. Status transition, heartbeat, stale-cycle claim, and failure path never read the flag. **Clean.**
- **Indexes/views/triggers/constraints** — none involve the flag, across all 31 migrations. A uniformly-unclaimed corpus changes **no query plan**. The feared unbounded-growth partial index (`WHERE matched = false`) **does not exist**.

**What disproved the blanket claim**: `CycleHistory.tsx` consumes the claim's *cycle-summary output* in two places, not one — the counts cell and `hasPartialResults`. The second is inert (D3). The accurate framing, now in the spec: *nothing reads the flag's **value**; two things read the phase's **output**.*

**Distinguished throughout**: `matched_at` is a **different**, already-dead legacy column (dropped by migration 030). Docs referencing it — including a `GET /jobs/match/extracted-count` route that no longer exists — are pre-existing defects excluded by FR-012b.
