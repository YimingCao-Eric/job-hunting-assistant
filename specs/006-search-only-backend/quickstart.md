# Quickstart / Validation Guide: Search-Only Backend

How to prove the reduction is correct. This validates outcomes, not implementation. Run from
`backend/` with the project's normal env (DB reachable at the configured `DATABASE_URL`, bearer
token configured). Prefer the existing Docker/compose workflow used for the smoke tests.

## Prerequisites

- Postgres at Alembic head `029` (no new migration in this feature).
- At least one `extension_run_logs` row exists (the matched-claim / expiration smoke tests SKIP
  without one for the FK).
- Bearer token available for authenticated route checks.

## 1. Boot & health (FR-016, SC-001)

- Start the backend the normal way (compose up / `uvicorn main:app`).
- Expect: process starts with **no** `ImportError`/`ModuleNotFoundError` and no traceback
  referencing `dedup`, `matching`, `profile`, `skills`, `job_report`, or `dedup_task_cleanup`.
- `GET /health` → `200 {"status": "ok", "db": "ok"}`.

**Fail signal**: any import error at boot = a kept module still references a deleted one (revisit
the top-down unwiring order in [plan.md](./plan.md#execution-order-dependency-safe)).

## 2. Removed endpoints are gone (SC-003, US2 AC4)

- Enumerate served routes (e.g. inspect `app.routes`, or hit representative paths).
- Expect: **no** `/jobs/dedup*`, `/jobs/match*`, `/match/*`, `/dedup/*`, `/profile*`, `/skills*`,
  `/jobs/reports*`, `/jobs/{id}/report` routes. A request to any → `404`.
- Expect present: `/jobs`, `/jobs/ingest`, `/config`, `/extension/*`, `/admin/auto-scrape/*`,
  `/admin/...cleanup...`, `/health`.

## 3. Search path still works (US2, FR-009/FR-010)

- `POST /jobs/ingest` for each path — skip-reason, per-source (linkedin/indeed/glassdoor),
  legacy — and confirm the same `{id, already_exists, content_duplicate, skip_reason}` outcomes
  and table targeting as spec 002 (ingest-time URL + content-hash dedup retained).
- `GET /jobs` with `dedup_status` (`unset`/`passed`/`removed`/`all`), `website`, date, and
  pagination filters — confirm the same row sets and `{items, total, limit, offset}` envelope.
- Confirm a returned job carries **none** of the pruned dedup/match fields and **no** `has_report`
  key (see [contracts/api-surface-delta.md](./contracts/api-surface-delta.md)).

## 4. Config surface (FR-006, FR-011, SC-006)

- `GET /config` → response has no `llm` / `dedup_mode` keys; all other fields present.
- With a config file on disk that still contains `llm` / `dedup_mode`: the backend loads it
  without error (keys ignored); a subsequent `PUT /config` write drops them.

## 5. Auto-scrape + post-scrape (US3, FR-004/FR-005/FR-013/FR-014)

- `PUT /extension/run-log/{id}` → `completed`: confirm **no** sync-dedup background task is
  scheduled (no dedup task row created; no dedup log line).
- Drive a cycle from `scrape_complete` (Redis wake or the 1-minute poll) and confirm it reaches
  `post_scrape_complete` with `cleanup_results` set and `match_results == {"claim_summary": {...}}`
  — with no dedup/matching phase side effects.

## 6. Smoke tests (acceptance — FR-016, SC-002; Constitution Principle II)

Run all three; the first two are the stated acceptance gates, the third confirms retained Phase 2:

```bash
python smoke_test_auto_scrape.py        # acceptance gate — must pass unchanged
python smoke_test_auto_expiration.py    # acceptance gate — must pass unchanged
python smoke_test_matched_claim.py      # retained (D2=keep) — should pass unchanged
```

Expected: `smoke_test_auto_scrape.py` and `smoke_test_auto_expiration.py` pass unchanged;
`smoke_test_matched_claim.py` still passes (claim flips `matched` false→true; `matched` column
present). If any depends on an `extension_run_logs` row and none exists, it SKIPs (not a failure).

## Definition of done

- [ ] Backend boots; `GET /health` = ok (no removed-module imports).
- [ ] No dedup/matching/profile/skills/issue-report routes served.
- [ ] `POST /jobs/ingest` + `GET /jobs` behave as spec 002; responses carry no pruned fields.
- [ ] `/config` has no `llm`/`dedup_mode`; legacy config still loads.
- [ ] Run-log completion schedules no sync-dedup; post-scrape reaches `post_scrape_complete` via
      Phase 1 + Phase 2 only.
- [ ] `smoke_test_auto_scrape.py` + `smoke_test_auto_expiration.py` pass unchanged;
      `smoke_test_matched_claim.py` still passes.
