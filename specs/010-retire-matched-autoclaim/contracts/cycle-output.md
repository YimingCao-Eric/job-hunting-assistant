# Contract: Cycle Output & the Claim Handoff

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Date**: 2026-07-16

Two contracts change or become load-bearing here. Neither is an HTTP surface change — no route is added, removed, or altered.

---

## Contract 1 — `match_results` on a scrape cycle

**Surface**: `auto_scrape_cycles.match_results` (JSONB, nullable), exposed via `GET /admin/auto-scrape/cycles` and consumed by `CycleHistory.tsx`.

**Producer**: `run_post_scrape_phase`. **Consumers**: the cycle history view; `smoke_test_auto_scrape.py` Phase 4c.

### Shapes

Readers must tolerate **three** shapes. This is the whole contract — a reader handling only one will break.

| # | Shape | Produced by | Meaning |
|---|---|---|---|
| 1 | `{"claim_summary": {"linkedin": N, "indeed": N, "glassdoor": N}}` | Cycles completed **before** this change | Historical record. **Never rewritten** (FR-008). |
| 2 | `{"claim_summary": null, "claim_retired": true}` | Cycles completed **after** this change | The run completed and performed no automatic claim (FR-007). |
| 3 | `null` | Cycles that **failed** before finalizing, at any time | No claim indication (FR-007a). Also the pre-change shape for cycles that failed during Phase 1. |

### Rules

- **Shape 2 MUST retain `claim_summary` as an explicit `null`** — present, empty, never dropped and never zeroed. `null` means **"no counts were produced"**, which a reader must never conflate with `{"linkedin": 0, ...}` meaning "the phase ran and claimed nothing" (FR-007, Principle I). Retaining the key is what lets a reader distinguish a retired phase from a truncated record; dropping it would make those two indistinguishable.
- **Shape 1 MUST remain readable forever.** Historical cycles are records; no back-fill, no rewrite (FR-008).
- **Precedence is fixed**: check `claim_summary` for a **truthy** value **first**, then `claim_retired`, then fall back. `null` is falsy, so shape 2 correctly falls through to the marker branch while shape 1's counts object takes precedence. Reversing the order makes historical cycles render as "claim retired" — a false statement about a cycle that really did claim rows.

### Reader (`CycleHistory.tsx`)

```tsx
const mr = c.match_results
const claims = mr?.claim_summary as Record<string, number> | undefined
if (claims) return <span>{Object.values(claims).reduce((a, b) => a + b, 0)} claimed</span>  // shape 1
if (mr?.claim_retired) return <span>claim retired</span>                                     // shape 2
return <span>{c.notes ? c.notes : '—'}</span>                                                // shape 3
```

### Declared deviation — narrow

Principle VII requires additive evolution: "producers add rather than repurpose or remove existing keys."

- **`claim_retired` is added** — squarely additive, no deviation.
- **`claim_summary` is retained, not removed** — so the prohibition on *removing* keys is not breached.
- The residual deviation is the **value-type change alone** (counts object → `null`), which is the narrowest form this could take. Declared in the plan's Complexity Tracking.

Unavoidable: the strictly additive alternative is a deleted phase reporting zeroed counts forever, violating the NON-NEGOTIABLE fidelity principle. The clause's *purpose* — older data stays readable, readers version independently — is preserved exactly: shape 1 is still readable, and the retained key is itself the discriminator the reader uses.

### Unchanged in the same payload

`cleanup_results` (`{"deleted_per_table": {...}, "shelf_life_days": N}`), `dedup_task_id` (null), `status`, `completed_at`, `scans_*`, `run_log_ids`, `notes`. `schemas/auto_scrape.py` needs no edit — `match_results` is already `Optional[dict[str, Any]]`.

---

## Contract 2 — The `matched` claim handoff

**Surface**: the `matched` column on `scraped_jobs` and the three per-source tables.

**Producer after this change**: nothing in this system. **Intended consumer**: the future standalone filtering/matching service.

This contract has no code in this repository — it is the reason the feature exists, so it is specified here and pinned executably by `smoke_test_matched_claim.py`.

### Guarantees this system provides

| Guarantee | Detail |
|---|---|
| Unclaimed at ingest | Every newly ingested job has `matched = FALSE`, on both the canonical row and its per-source origin. Supplied by the DB default; the projection deliberately omits the column. |
| **Stays** unclaimed | No post-scrape run, and no other flow, flips it. After a cycle completes, that cycle's new rows are still `FALSE` (FR-001, FR-002). |
| Never un-claimed | Nothing in this system sets it back to `FALSE`. |
| Column contract stable | `BOOLEAN NOT NULL DEFAULT FALSE` on all four tables. No schema change (FR-003). |
| Agreement holds | A job's canonical claim state and its per-source origin's always agree (FR-013b). |
| Expiration is claim-blind | Auto-expiration deletes purely by `scrape_time`, regardless of claim state — a claimed row gets no reprieve, an unclaimed row no protection. |

### Obligations on a claimer

| Obligation | Source |
|---|---|
| A **claim** is `FALSE → TRUE`, once per row | Constitution V (CC-1) |
| Flip the canonical row **and** its per-source origin **together, in one transaction** | Constitution V (agreement clause) + IV (atomic multi-table writes) |
| Claim with `WHERE matched = FALSE` | Idempotence — re-running claims nothing already claimed |

**These are not new rules.** They are the existing invariants, which are actor-agnostic and therefore bind whoever performs the flip. That is why this handoff needs no constitutional amendment (FR-013a/b).

### ⚠️ Open question — NOT settled by this contract

**Whether a claimer may reset a claimed row back to `FALSE` is out of scope here (FR-004c).** This contract neither permits nor forbids it, and must not be cited as forbidding it.

The downstream service's design **plans** exactly that — `matched = FALSE` re-entry for blacklisted jobs — and tracks it as its open `RE-ENTRY-WRITE` question. What this specification guarantees is only about **our** behavior: this system never sets the flag to claimed and never reverses a claim, so a claimer can trust that an unclaimed row is genuinely unworked and that its own claim will not be undone by us.

**Flagged, not resolved**: CC-1 permits `false → true` and "**no other in-place updates**". A re-entry write is `true → false` and would therefore need its own governance decision. That belongs to whoever answers `RE-ENTRY-WRITE` — this feature must not pre-empt it in either direction.

### The backlog boundary — a hard contract

**Ship time of this change is the line.**

- Every row existing **before** it: already `matched = TRUE` (claimed by the outgoing phase). **Invisible to a claimer, permanently.**
- Every row ingested **after** it: `matched = FALSE`. **Visible.**

A downstream service wanting the pre-existing corpus **cannot obtain it by claiming** and must arrange for it deliberately (FR-004b). This is not an oversight — see research D7.

### Verification without the consumer

The consumer does not exist, so SC-002 is verified by measuring **the state it will find**, not by running it: after a real scan, query for unclaimed jobs and confirm the cycle's new rows are returned where today zero would be.

```sql
-- Scope to the fresh scan. A global GROUP BY will show mostly `t` (the pre-existing
-- claimed backlog) and look like failure — see the plan's Risks table.
SELECT matched, count(*) FROM scraped_jobs
WHERE scan_run_id = '<the-scan-run-id>' GROUP BY matched;
-- Expected: matched=f for every row. No `t` row.
```
