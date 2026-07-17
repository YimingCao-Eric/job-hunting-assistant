# Implementation Plan: Retire the Vestigial Post-Scrape Matched-Claim

**Branch**: `jha-retire-matched-autoclaim` | **Date**: 2026-07-16 (re-run against updated spec) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-retire-matched-autoclaim/spec.md`

## Summary

Delete the post-scrape run's second phase so the flow becomes **expire → finalize**. The claim it performed served dedup/matching, both deleted in the search-only split; it now pre-claims every row and starves the future filtering/matching service, which is designed to claim rows itself. The `matched` column stays everywhere — only its automatic writer goes away.

The behavior change is four lines in one function. The work around it is larger and more delicate: one constitutional correction, a repurposed smoke test, a rewritten end-to-end assertion, a frontend render path that must serve two data shapes, and a bounded documentation sweep.

**Approach**: remove the call and its module; fold the retired-claim marker into the existing finalize write (one DB write where there were two); repurpose the claim's smoke test to pin the inverse behavior *and* the handoff contract the downstream service will rely on; correct the eight documents this falsifies.

## Technical Context

**Language/Version**: Python 3.11 (backend, `python:3.11-slim`), TypeScript/React (frontend)

**Primary Dependencies**: FastAPI 0.115.0, SQLAlchemy[asyncio] 2.0.35, asyncpg 0.29.0, Alembic 1.13.3, Pydantic 2.9.2

**Storage**: PostgreSQL. **No schema change** — the `matched` column, its type, NOT NULL constraint, and FALSE default all stay. **No migration.** Head stays at 031.

**Testing**: `smoke_test_*.py` scripts run in-container (`docker compose exec backend python smoke_test_<name>.py`). No pytest suite exists. Per Constitution Principle II the smoke suite is the authoritative behavioral contract.

**Target Platform**: Linux container (Docker Compose: backend, postgres, redis)

**Project Type**: Web service (FastAPI backend + React frontend) with a Chrome MV3 extension as the scraper

**Performance Goals**: Unchanged. This removes work (a blanket four-table UPDATE per cycle) and one DB write per cycle. No path gets slower.

**Constraints**: Surgical, behavior-preserving except for the one named change (Principle III). Backend image has **no source mount** — every code change requires `docker compose up -d --build backend` or it is silently ignored.

**Scale/Scope**: ~5 source files touched, 1 deleted, 8 documents corrected. No unknowns — all NEEDS CLARIFICATION resolved in `/speckit-clarify` and the checklist's governance/as-built/handoff blocks.

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-evaluated post-Phase 1. Both passes below.*

| Principle | Verdict | Basis |
|---|---|---|
| **I. As-Built Fidelity** (NON-NEGOTIABLE) | **PASS** | Spec's Context section describes the pre-change system accurately. FR-012 enumerates a closed set of 8 documents this falsifies; FR-012a makes the authoritative post-scrape account coherent rather than merely stripped. The retired-claim marker exists precisely so no cycle reports a phase that did not run. |
| **II. Smoke Tests Are the Behavioral Contract** (NON-NEGOTIABLE) | **PASS** | FR-011 names the behavior change and both invalidated assertion sites, satisfying the clause's specific test. The suite is repointed, never weakened: `smoke_test_matched_claim.py` keeps its filename (so the Principle II list stays accurate) and gains a stronger end-to-end assertion than it had. |
| **III. Surgical, Behavior-Preserving Change** | **PASS with one declared deviation** | Production behavior change is confined to `run_post_scrape_phase`. Deviation: FR-012a absorbs pre-existing documentation debt inside the section being rewritten. Justified in Complexity Tracking. |
| **IV. Migration & Schema Discipline** | **PASS (N/A)** | No schema change, therefore no migration. Nothing in the Alembic chain is touched. The one multi-table write being removed does not affect the atomicity of any remaining write. |
| **V. Data-Model Invariants** | **PASS, unamended** | Verified word-for-word: both permitted-mutation clauses are **actor-agnostic** — they permit the claim-flip without requiring it or naming a performer. A permitted-but-unperformed mutation does not violate them (FR-013a). The canonical/per-source agreement invariant stays in force and holds trivially after this change (FR-013b). |
| **VI. Async Background Execution** | **PASS** | Orchestration, heartbeat, session-per-task, and `asyncio.create_task` usage all untouched. Removing a phase removes one `AsyncSessionLocal()` block; every remaining block keeps its own fresh session. |
| **VII. Auth Boundary & Forward-Compatible Outputs** | **NARROW VIOLATION — declared** | Auth boundary untouched. `match_results` is an aggregate JSONB output: `claim_retired` is **added** (additive, compliant) and `claim_summary` is **retained as `null`** rather than removed — so the clause's prohibition on *removing* keys is **not** breached. The residual deviation is the key's value-type change alone. Unavoidable; justified in Complexity Tracking. |

**Amendment required**: exactly one — the Additional Constraints → Module layout parenthetical describing `auto_scrape/` as "(post-scrape pipeline: expiration, **claim**, orchestration)" becomes false. **PATCH** class (1.1.0 → 1.1.1): no principle removed, renamed, or redefined; no section added; a factual clarification. Template propagation is a **verified no-op** — no Spec Kit template, script, or command file references the claim, the flag, or the phase structure (FR-013d).

**Post-Phase 1 re-evaluation** (re-run 2026-07-16 against the updated spec): still passing, with the Principle VII verdict **improved** rather than merely re-affirmed. The design introduced no new gate concerns — no new module, table, index, route, or dependency.

Three requirements landed after this plan was first written and were folded in on re-run:

- **FR-004c** (re-entry deferred) — invalidated three artifact statements that asserted the claim is globally irreversible. Corrected in `data-model.md`, `contracts/cycle-output.md`, and §2's test table; §6 and a new Risks row now guard against re-introducing the assertion in code.
- **FR-016** (rollback) — new Rollback section below.
- **FR-017** (boundary manifest) — the source tree is now explicitly its file-level projection, with the manifest authoritative.

The shape refinement to `{"claim_summary": null, "claim_retired": true}` **narrowed the Principle VII violation**: retaining the key means the clause's prohibition on *removing* keys is no longer breached, leaving only a value-type change. The gate verdict moves from "violation" to "narrow violation", still declared.

## Project Structure

### Documentation (this feature)

```text
specs/010-retire-matched-autoclaim/
├── spec.md              # Feature specification (27 FRs, 11 SCs)
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── cycle-output.md  # Phase 1 output — match_results shape contract
├── checklists/
│   ├── requirements.md  # Spec quality (16/16)
│   └── retirement.md    # Domain checklist (18/30 worked)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

Marked **UNCHANGED** / **CHANGED** / **DELETED** per the request. Everything not listed is UNCHANGED.

```text
backend/
├── auto_scrape/
│   ├── post_scrape_orchestrator.py   # CHANGED — drop Phase-2 call + import; fold
│   │                                 #   marker into finalize write; fix docstring
│   ├── matching_claim.py             # DELETED — sole production caller is the
│   │                                 #   line being removed
│   └── auto_expiration.py            # UNCHANGED
├── smoke_test_matched_claim.py       # CHANGED — repurposed, filename kept
├── smoke_test_auto_scrape.py         # CHANGED — Phase 4c assertion rewritten
├── smoke_test_auto_expiration.py     # UNCHANGED
├── smoke_test_scraped_jobs_merge.py  # UNCHANGED — asserts matched=false at
│                                     #   ingest, which stays true
├── models/
│   ├── scraped_job.py                # UNCHANGED — matched column stays
│   └── auto_scrape_cycle.py          # UNCHANGED — match_results is JSONB
├── schemas/
│   ├── scraped_job.py                # UNCHANGED — matched stays exposed
│   └── auto_scrape.py                # UNCHANGED — match_results is dict[str, Any]
├── routers/                          # UNCHANGED — all six
├── core/scraped_job_projection.py    # UNCHANGED — matched omitted at ingest by design
├── scripts/verify_matched_column.py  # UNCHANGED — column stays; script stays valid
└── alembic/                          # UNCHANGED — no migration; head stays 031

frontend/
├── src/components/auto-scrape/
│   └── CycleHistory.tsx              # CHANGED — render marker; keep historical
│                                     #   counts working (FR-008)
└── src/types/autoScrape.ts           # UNCHANGED — already Record<string, unknown>

.specify/memory/constitution.md       # CHANGED — 1 parenthetical; 1.1.0 → 1.1.1

docs/current-workflow.md              # CHANGED — post-scrape section rewritten (FR-012a)
docs/jha-onboarding.md                # CHANGED — phase structure + §30 retired banner
docs/live-per-source-schemas.md       # CHANGED — claim as lifecycle-symmetry mechanism
PROJECT-SUMMARY.md                    # CHANGED — phase list, sync mechanism, JHA-B status
README.md                             # CHANGED — smoke test description only
backend/README.md                     # CHANGED — smoke test description only
SPEC-KIT-TUTORIAL.md                  # CHANGED — matching_claim.py "LIVE" claim
filter-matching-service-design.md     # CHANGED — JHA-B blocker → shipped (FR-012d)
jha-prereq-cmds.md                    # CHANGED — JHA-B status (FR-012d)

specs/00{1,2,6,7,8}-*/                # UNCHANGED — historical records (FR-012c)
SPLIT-SEARCH-ONLY-GUIDE.md            # UNCHANGED — historical record (FR-012c)
step3-filter-matching-design.md       # UNCHANGED — already superseded (FR-012b)
extension/                            # UNCHANGED — writes matched=false at ingest, still correct
```

**Structure Decision**: Existing web-service layout, unchanged. This feature adds no module and removes one. `auto_scrape/` keeps its sanctioned role (post-scrape pipeline) with one fewer responsibility — which is the single fact the constitution must be corrected to reflect.

**Conformance to the boundary manifest (FR-017)**: the tree above is the file-level projection of the spec's manifest. Every GOES row maps to a DELETED/CHANGED entry, every STAYS row to an UNCHANGED entry, and the CHANGES-SHAPE row to the orchestrator + both readers. The manifest is authoritative where the two ever disagree — it carries the falsifiable checks; this tree is only where the edits land.

## Implementation Approach

### 1. The behavior change — `post_scrape_orchestrator.py`

Remove the import and collapse the claim block into the finalize write:

```python
# Phase 1 — auto-expiration (UNCHANGED)
async with AsyncSessionLocal() as db:
    async with db.begin():
        expiration_results = await run_auto_expiration(db)
await _update_cycle(cycle_id, cleanup_results=expiration_results)

# Finalize — marker folded in (was: separate Phase-2 claim + separate match_results write)
await _update_cycle(
    cycle_id,
    status="post_scrape_complete",
    completed_at=datetime.now(timezone.utc),
    match_results={"claim_retired": True},
)
```

**Three cycle writes become two**: `cleanup_results`, then a single finalize write carrying status, completion time, and the marker. (The claim's own four-table UPDATE transaction disappears on top of that.) The heartbeat, failure path, status transition, and `process_pending_cycles` claim are all untouched. The module docstring must stop describing Phase 2.

Note the marker belongs **only** in the finalize write. That is what satisfies FR-007a — a cycle that fails before finalizing records no claim indication, while its expiration results survive independently. Moving it earlier would silently break that.

**This also retires a documented defect.** The crash window in `specs/001/optimization-backlog.md:66-74` — rows flipped in one transaction, their summary persisted in another, leaving rows permanently claimed with no record and unable to be re-claimed — ceases to exist because nothing flips them. Not worked around: gone.

### 2. The smoke test — repurposed, not weakened

`smoke_test_matched_claim.py` keeps its filename (FR-013c: Principle II pins filenames; renaming would be a Principle III drive-by).

| Existing test | Disposition |
|---|---|
| `_verify_required_columns` | **KEEP as-is** — pre-flight schema guard (FR-003, FR-011a). Deliberately *not* extended to `scraped_jobs`: FR-011a says retain, not expand (Principle III). |
| `test_basic_claim` | **REPLACE** with `test_post_scrape_leaves_rows_unclaimed` — the direct FR-001/SC-001 proof. |
| `test_claim_reaches_canonical_row` | **REWRITE** — drop the `claim_unmatched_rows` import; simulate the *external claimer* (flip both sides in one transaction via raw SQL) and assert agreement still holds. Keeps SC-008/CC-10 covered **and** pins the FR-004a handoff contract executably. |
| `test_idempotent_claim_scoped` | **KEEP as-is** — already pure raw SQL with no import of the deleted module. It documents the idempotent `WHERE matched = FALSE` claim pattern (FR-004a) an external claimer will use. It pins the *claim*'s shape only — it says nothing about re-entry, which FR-004c leaves open. |
| `test_atomic_three_table_claim` | **DELETE** — a `[SKIP]` stub for a three-table atomic claim that no longer exists. |

The new `test_post_scrape_leaves_rows_unclaimed`: insert unclaimed per-source + canonical fixtures, insert a cycle in `scrape_complete`, run the post-scrape phase for it, assert the fixtures are **still unclaimed** and the cycle carries `{"claim_summary": null, "claim_retired": true}`. This is a stronger assertion than the file previously carried — it exercises the orchestrator end to end, which nothing did before.

### 3. The end-to-end suite — `smoke_test_auto_scrape.py` Phase 4c

The `set(cs.keys()) != {"linkedin","indeed","glassdoor"}` exact-equality gate is the strictest assertion in the suite and fails loudly by design. Rewrite: `match_results` must be `{"claim_summary": null, "claim_retired": true}` — `claim_summary` **present and explicitly null** (not absent, not zeroed), `claim_retired` true. The `cleanup_results` and `dedup_task_id` blocks in the same function stay **UNCHANGED**.

**Known weakness, deliberately not fixed**: the whole Phase 4c block is guarded by `if c0 is not None and c0.get("status") == "post_scrape_complete"` with an `ok("[SKIP] ...")` else-branch — a green run does not prove these assertions ran. Pre-existing; out of scope (Principle III); recorded in Risks.

### 4. The frontend — `CycleHistory.tsx`

The render path must serve **two shapes**: historical cycles carry `claim_summary` (FR-008 — never rewritten), new cycles carry `claim_retired`. Order matters — check counts first so historical cycles keep rendering exactly as they do today:

```tsx
const mr = c.match_results
const claims = mr?.claim_summary as Record<string, number> | undefined
if (claims) return <span>{Object.values(claims).reduce((a, b) => a + b, 0)} claimed</span>
if (mr?.claim_retired) return <span>claim retired</span>
return <span>{c.notes ? c.notes : '—'}</span>
```

`hasPartialResults` is **UNCHANGED**. Its `match_results !== null` disjunct is provably redundant — expiration always writes `cleanup_results` before anything could write `match_results`, so it can never be the deciding signal. Touching it would be a drive-by.

### 5. Governance & documentation

Constitution: one parenthetical, `1.1.0 → 1.1.1`, plus its SYNC IMPACT REPORT header. Docs per the FR-012 enumeration.

### 6. What this plan must NOT do

FR-004c draws a line the implementation must respect. **Do not encode "the claim is irreversible" anywhere** — not in the smoke tests, not in a docstring, not in the contract. Our guarantee is only that *this system* never claims and never un-claims.

The downstream service's design **plans** a `matched = FALSE` re-entry for blacklisted jobs and tracks it as its open `RE-ENTRY-WRITE` question. An assertion or comment asserting irreversibility would forbid, by our code, behavior our own consumer intends — and would be cited later as settled precedent. Leave it open.

(Flagged and deliberately unresolved: CC-1 permits `false → true` and "no other in-place updates", so a re-entry write would need its own governance decision. Not ours to make.)

## Rollback (FR-016)

Stated before implementation, not discovered under pressure.

| Aspect | Contract |
|---|---|
| **Triggers** | The downstream service is shelved or delayed indefinitely, making an unclaimed corpus pointless; **or** retirement surfaces a consumer of the claim the as-built survey missed. |
| **Method** | Pure code revert: restore the claim call in `run_post_scrape_phase`, restore `matching_claim.py` from git, revert the `match_results` shape, revert the two smoke-test assertions. |
| **Migration** | **None, in either direction.** The column, type, constraint, and default never changed. This is the concrete payoff of the no-schema-change decision (FR-003). |
| **Data repair** | **None.** Rows left unclaimed during the window are claimed by the next post-scrape run automatically — the restored claim selects `WHERE matched = FALSE`, so it sweeps the backlog with no back-fill and no orphans. |
| **Composability** | **Safe even if the downstream service claimed rows during the window.** The restored claim only touches unclaimed rows, so it skips the service's work — no clobber, no double-claim. |
| **Total cost** | A code revert plus one cycle. No data loss, no manual repair, no coordination with the downstream service. |

Worth noting *why* this is cheap: it falls out of two earlier decisions. Had the spec back-filled the corpus (research D7) or touched the schema, rollback would need a reverse migration and a repair step.

## Complexity Tracking

> Two declared deviations. Both are principle-vs-principle collisions, not shortcuts.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Principle VII** — `match_results`'s `claim_summary` key changes value type (counts object → `null`) rather than evolving purely additively (FR-015) | A retired phase must not keep filing reports. The marker is what makes the cycle record truthful. | The only strictly additive alternative is emitting `claim_summary: {linkedin: 0, indeed: 0, glassdoor: 0}` forever — a phase that does not exist reporting that it did nothing. That violates Principle I, which is NON-NEGOTIABLE and outranks a forward-compat convention. **Note the deviation is narrow**: `claim_retired` is *added* (additive), and `claim_summary` is *retained* rather than removed, so the clause's prohibition on removing keys is not breached — only its value type changes. The clause's *purpose* is preserved: historical cycles keep their counts (FR-008), and the retained key is itself the discriminator the render path uses to serve both shapes. |
| **Principle III** — FR-012a absorbs pre-existing doc debt in `docs/current-workflow.md`'s post-scrape section (~136 stale lines beyond our ~60) | That section already describes deleted dedup/matching stages as live stubs. Removing only Phase 2 leaves the *constitution-authoritative* runtime doc showing "expire → nothing" wrapped in a narrative about stages that do not exist — arguably worse than before. | Correcting only our lines was the strictly minimal option and was explicitly considered and rejected by the user. Principle I obliges correcting fidelity defects "when discovered", and the section cannot be made truthful piecemeal. Bounded by locality: pre-existing rot **outside** this section (both READMEs, ~245 lines) stays excluded (FR-012b). |

## Risks

| Risk | Mitigation |
|---|---|
| **Backend image has no source mount** — code edits are silently ignored without a rebuild. Recorded in project memory as a known trap. | `docker compose up -d --build backend` before any smoke run. Non-negotiable step in quickstart. |
| **Phase 4c silently skips** when no cycle reaches `post_scrape_complete`, so a green suite may not prove the new assertion ran. | Confirm the `[SKIP]` line is *absent* from output — a pass that skipped is not a pass. Called out in quickstart. |
| The existing corpus stays claimed; only new rows are unclaimed. | Deliberate (FR-004b). Verify against rows from a **fresh** scan, not the whole table — a `SELECT matched, count(*) GROUP BY matched` over everything will show mostly `t` and look like failure. |
| Historical cycles' render path regresses to `—` if the marker branch is checked before the counts branch. | Order is specified above and asserted in quickstart step 5. |
| Docs sweep expands beyond its bound. | FR-012's set is closed and enumerated; FR-012b/c state the exclusions explicitly so an omission reads as a decision. |
| **Implementation re-derives the naive constitutional reading** — concluding 4 sites are falsified and a MAJOR amendment is needed. Two independent readings have already defaulted to this. | The spec's Clarifications carry a "considered and rejected" landmine note with the clause-level reasoning. **Read the clause, not a summary**: the permitted-mutation clauses name no performer; the smoke-suite clause pins the surviving filename. One site, PATCH. |
| **Implementation encodes irreversibility** in a test or docstring, silently foreclosing the downstream service's planned re-entry. | §6 above. FR-004c defers `RE-ENTRY-WRITE`; our guarantees are scoped to this system's behavior only. |

## Phase Outputs

- **Phase 0**: [research.md](./research.md) — decisions, rationale, rejected alternatives. Zero NEEDS CLARIFICATION remain.
- **Phase 1**: [data-model.md](./data-model.md), [contracts/cycle-output.md](./contracts/cycle-output.md), [quickstart.md](./quickstart.md)
