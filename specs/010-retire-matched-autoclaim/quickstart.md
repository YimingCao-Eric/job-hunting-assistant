# Quickstart: Validating the Retired Matched-Claim

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-07-16

How to prove this feature works end to end. Runnable steps only — implementation belongs in `tasks.md`.

## Prerequisites

- Docker Compose stack (`backend`, `postgres`, `redis`).
- **Host `python` is broken** in this environment (`ModuleNotFoundError: encodings`). Run everything Python through the container. Never `python smoke_test_*.py` on the host.
- At least one row in `extension_run_logs` — the smoke fixtures need it for an FK. Tests `[SKIP]` without it, which is **not** a pass.

## ⚠️ Step 0 — Rebuild. Not optional.

The backend image has **no source mount**. Code edits are silently ignored until the image is rebuilt — a green suite against stale code is the failure mode this step exists to prevent.

```powershell
docker compose up -d --build backend
Start-Sleep -Seconds 10
docker compose exec backend python -c "print('backend up')"
```

## Step 1 — The claim module is gone

```powershell
docker compose exec backend python -c "import auto_scrape.matching_claim" 2>&1 | Select-String "ModuleNotFoundError"
```

**Expected**: a `ModuleNotFoundError`. Anything else means the module survived or something still imports it.

```powershell
docker compose exec backend python -c "import auto_scrape.post_scrape_orchestrator; print('orchestrator imports clean')"
```

**Expected**: `orchestrator imports clean` — proves no dangling import (FR-013 / D1).

## Step 2 — The repurposed smoke test

```powershell
docker compose exec backend python smoke_test_matched_claim.py
```

**Expected**: all `[OK]`, zero `[SKIP]`, exit 0. Specifically:

- `[OK]` post-scrape leaves rows unclaimed — **the FR-001 / SC-001 proof**
- `[OK]` an external claimer keeps canonical and per-source in agreement — SC-008 + the FR-004a handoff contract
- `[OK]` idempotence of the one-way claim pattern — FR-004a
- No assertion that the automatic claim occurs (FR-011)

A `[SKIP]` on the fixture setup is **not** a pass — it means the FK precondition was missing and nothing was verified.

## Step 3 — The end-to-end suite

```powershell
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_auto_expiration.py
docker compose exec backend python smoke_test_scraped_jobs_merge.py
```

**Expected**: all pass. Specifically:

- Phase 4c asserts `match_results == {"claim_summary": null, "claim_retired": true}` — the counts key **present and null**, not absent and not zeroed.
- `cleanup_results` assertions pass **unchanged** — auto-expiration is untouched (FR-005, SC-003).
- `smoke_test_scraped_jobs_merge` still asserts `matched is False` at ingest — unchanged, because ingest never wrote it (FR-003).

**⚠️ Check for the skip.** Phase 4c is guarded by `if c0 is not None and c0.get("status") == "post_scrape_complete"` with an `[OK] [SKIP]` else-branch. If you see:

```text
[OK] [SKIP] Phase 4c no post_scrape_complete row for Phase 4b cycle
```

the new assertions **did not run** and the green suite proves nothing about this feature. Pre-existing weakness (out of scope, Principle III) — but you must confirm the line is absent.

## Step 4 — The real proof: a live scan

The one that matters. Run a real scan, let post-scrape complete, then check the claim state **of that scan's rows**.

```powershell
# After a scan completes and its cycle reaches post_scrape_complete:
docker compose exec postgres psql -U jha -d jha -c "SELECT id, status, match_results, cleanup_results FROM auto_scrape_cycles ORDER BY created_at DESC LIMIT 1;"
```

**Expected**: `status = post_scrape_complete`, `match_results = {"claim_summary": null, "claim_retired": true}`, `cleanup_results` populated as always.

```powershell
# Scope to the fresh scan's run id -- NOT a global count.
docker compose exec postgres psql -U jha -d jha -c "SELECT matched, count(*) FROM scraped_jobs WHERE scan_run_id = '<scan-run-id>' GROUP BY matched;"
```

**Expected**: `f | <N>` and **no `t` row**. This is SC-001 and SC-002: the downstream service now has a non-empty work queue where it previously had zero.

> **Do not run a global `SELECT matched, count(*) FROM scraped_jobs GROUP BY matched`.** Every row that existed before this shipped is already `matched = t` (FR-004b — the backlog is deliberately not back-filled). A global count shows mostly `t` and looks like failure. Scope to the fresh scan.

Confirm agreement holds (SC-008):

```powershell
docker compose exec postgres psql -U jha -d jha -c "SELECT count(*) AS disagreements FROM scraped_jobs s JOIN linkedin_jobs l ON l.id = s.source_row_id WHERE s.matched <> l.matched;"
```

**Expected**: `0`.

## Step 5 — The frontend serves both shapes

Open the auto-scrape cycle history. Both must hold at once:

| Cycle | Expected "Results" |
|---|---|
| Completed **after** this change | `claim retired` |
| Completed **before** this change | its original `N claimed` — **unchanged** (FR-008, SC-007) |

**The failure mode to look for**: historical cycles rendering `claim retired`, or new cycles rendering `—`. Both mean the precedence in [contracts/cycle-output.md](./contracts/cycle-output.md) is inverted — check `claim_summary` first, `claim_retired` second.

## Step 6 — Nothing else moved

```powershell
docker compose exec backend python scripts/verify_matched_column.py
```

**Expected**: exit 0 — the column contract is intact on all three per-source tables (FR-003).

Then confirm by eye: `GET /jobs` returns the same jobs in the same order with the same fields (SC-004), and each job still carries a `matched` field — now varying rather than uniformly `true`.

## Step 7 — Documentation & governance

- Constitution: version reads `1.1.1`; the module-layout parenthetical no longer lists "claim"; SYNC IMPACT REPORT records the PATCH bump.
- `docs/current-workflow.md`: the post-scrape account reads coherently as **scrape → expire → finalize**, with no references to stages that do not exist (SC-011, FR-012a).
- The other in-scope docs (FR-012) carry no statement contradicting shipped behavior (SC-010).
- `filter-matching-service-design.md`: JHA-B reads **shipped**, not "⛔ STILL REQUIRED — blocker" (FR-012d).

## Done when

| Criterion | Check |
|---|---|
| SC-001 | Step 4 — 100% of the fresh scan's rows unclaimed |
| SC-002 | Step 4 — the unclaimed query returns them all |
| SC-003 / SC-004 | Step 3, Step 6 — expiration and listing identical |
| SC-005 | Steps 2–3 — full suite green, no assertion describes retired behavior, **no `[SKIP]`** |
| SC-006 | Step 4 — no claim count on new cycles |
| SC-007 | Step 5 — historical cycles unchanged |
| SC-008 | Step 4 — zero disagreements |
| SC-009 | Step 4 — one phase of work; scan completes as always |
| SC-010 / SC-011 | Step 7 |
