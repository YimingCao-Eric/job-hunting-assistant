# Phase 1 Data Model: Retire the Vestigial Post-Scrape Matched-Claim

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-16

## Schema delta: none

**No column added, dropped, altered, or renamed. No migration. Alembic head stays at 031.**

This section exists to make that explicit, because "retire the matched-claim" reads like a schema change and is not one. Only the *writer* goes away.

| Object | Status |
|---|---|
| `linkedin_jobs.matched`, `indeed_jobs.matched`, `glassdoor_jobs.matched` | **UNCHANGED** — `BOOLEAN NOT NULL DEFAULT FALSE` (migration 028) |
| `scraped_jobs.matched` | **UNCHANGED** — `BOOLEAN NOT NULL DEFAULT FALSE` (migration 030) |
| `auto_scrape_cycles.match_results` | **UNCHANGED** — `JSONB NULL`. Its *contents* change; see [contracts/cycle-output.md](./contracts/cycle-output.md) |
| Indexes / views / triggers / constraints on `matched` | **None exist** — verified across all 31 migrations |

## Entity: Job record (`scraped_jobs` + its per-source origin)

### The `matched` flag — what changes is the writer, not the field

| Aspect | Before | After |
|---|---|---|
| Value at ingest | `FALSE` (DB default; deliberately omitted from the projection's column list) | **UNCHANGED** |
| Who flips it `FALSE → TRUE` | The post-scrape run's Phase 2, on every unclaimed row, every cycle | **Nobody.** Reserved for an external processor |
| Value after a post-scrape run | `TRUE` on every row | **`FALSE`** — the entire point (FR-001, FR-002) |
| Who reads it | Nobody, except Phase 2's own `WHERE matched = FALSE` | Nobody in this system; the downstream service will |
| Reversed by this system? | No — this system never un-claims | **UNCHANGED** — still never. Whether an *external* claimer may reset a row to unclaimed is **out of scope** (FR-004c) — see the note below |
| Exposed in the API? | Yes (`ScrapedJobRead.matched`) | **UNCHANGED** — still exposed, now meaningfully varying rather than uniformly `TRUE` |
| Writable by the user? | No (`JobUpdate` exposes only `dismissed`) | **UNCHANGED** |

### State transitions

```text
BEFORE:
  ingest ──> matched=FALSE ──[post-scrape Phase 2, automatic]──> matched=TRUE ──> (nothing reads it)

AFTER:
  ingest ──> matched=FALSE ──[external processor, on its own schedule]──> matched=TRUE
                    │                                                          │
                    └── post-scrape runs and does NOT touch this ──────────────┘
                                                                    (auto-expiration may DELETE at any point)
```

The transition itself is unchanged — same direction, same once-per-row, same terminal state. Only its trigger moves out of this system.

> **Out of scope (FR-004c)**: the diagram shows no `TRUE → FALSE` edge because **this system** has none and never did. It must **not** be read as forbidding one. The downstream service's design plans a `matched = FALSE` re-entry for blacklisted jobs and tracks it as its open `RE-ENTRY-WRITE` question. Flagged for whoever answers it, and deliberately not resolved here: CC-1 permits `false → true` and "no other in-place updates", so a re-entry edge would need its own governance decision.

### Invariants — all preserved, none amended

| Invariant | Source | After this change |
|---|---|---|
| Per-source rows are append-only, with exactly two permitted mutations: the claim-flip and expiration `DELETE` (**CC-1**) | Constitution V | **Holds.** The clause is actor-agnostic — it *permits* the flip without requiring it or naming a performer. A permitted-but-unperformed mutation satisfies it. |
| `scraped_jobs` permits exactly three mutations: the claim-flip (in sync with its per-source row), `dismissed`, expiration `DELETE` | Constitution V | **Holds**, same reasoning. |
| The canonical and per-source claim states **never disagree** | Constitution V | **Holds trivially** — nothing flips either side, so both stay `FALSE`. When the external processor claims, the clause plus Principle IV's atomic-multi-table-write rule already oblige it to flip both together. No new governance (FR-013b). |
| A canonical row never outlives its per-source row | Constitution V | **UNCHANGED** — expiration deletes from all four tables; untouched by this feature. |
| Atomic dual-write at ingest | Constitution V | **UNCHANGED**. |

**The subtle point**: today `matching_claim.py` is what *enforces* the agreement invariant, flipping both sides in one transaction. After deletion, nothing enforces it — but nothing can violate it either, because nothing writes. The obligation transfers to the first future writer, where the existing rules already bind it. The invariant is not weakened; it is dormant.

## Entity: Scrape cycle (`auto_scrape_cycles`)

| Field | Status |
|---|---|
| `status`, `completed_at`, `phase_heartbeat_at`, `error_message` | **UNCHANGED** — transitions, heartbeat, and failure recording all identical |
| `cleanup_results` | **UNCHANGED** — `{"deleted_per_table": {...}, "shelf_life_days": N}` |
| `match_results` | **Contents change.** `{"claim_summary": {...}}` → `{"claim_summary": null, "claim_retired": true}` on new completed cycles; `NULL` on failed cycles; historical cycles keep their existing counts untouched. The counts key is retained-and-null, never dropped — see [contracts/cycle-output.md](./contracts/cycle-output.md) |
| `dedup_task_id` | **UNCHANGED** — still null (no-op dedup) |

### Post-scrape run — the phase structure

```text
BEFORE: claim cycle ──> Phase 1: expire ──> Phase 2: claim ──> finalize
                             │                    │                │
                        write cleanup_results  write match_results  write status+completed_at
                                                                    (3 writes)

AFTER:  claim cycle ──> Phase 1: expire ──> finalize
                             │                  │
                        write cleanup_results   write status+completed_at+match_results
                                                (2 writes)
```

### Two defects retired for free

1. **The crash window is gone.** Previously `matched=TRUE` committed in its own transaction while `claim_summary` persisted in a *separate* one. A crash between them left rows permanently claimed with no record — and because the claim filtered `WHERE matched = FALSE`, they could never be re-claimed. Recovery was manual. Nothing flips them now, so the window does not exist. Not worked around: removed.
2. **A blanket four-table UPDATE per cycle is gone**, along with one DB write per cycle. Pure saving; no path gets slower.

## Cross-entity read paths — verified unaffected

| Path | Reads `matched`? | Status |
|---|---|---|
| `GET /jobs` listing (filter, sort, count, pagination) | **No** — filters on `dismissed`, `source_site`, `scan_run_id`, `posted_at`, `scrape_time`; orders by `scrape_time DESC` | UNCHANGED |
| `GET /jobs` response body | Yes — `ScrapedJobRead.matched` is serialized | UNCHANGED (field stays; value now varies) |
| Frontend components | **No** — `matched` appears only in the type declaration; no component branches on it | UNCHANGED |
| Auto-expiration | **No** — purely `scrape_time`-based across all four tables | UNCHANGED |
| Admin cleanup | **No** — apparent hits are the substring `mismatched` in a retired counter | UNCHANGED |
| Ingest / dual-write projection | Writes nothing — DB default supplies `FALSE` | UNCHANGED |
| Cycle finalization / recovery | **No** — never reads the flag or the claim's output | UNCHANGED |

**Disproof condition**: a single read path branching on the flag's value invalidates this table and requires FR-010 to be re-examined.
