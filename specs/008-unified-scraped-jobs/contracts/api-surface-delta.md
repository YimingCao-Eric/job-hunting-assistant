# API Surface Delta: Unified `scraped_jobs`

**Feature**: 008-unified-scraped-jobs | **Date**: 2026-07-15

Every route below requires bearer auth (Constitution VII, FR-022). `/health` remains the sole
exception and is untouched.

Legend: **UNCHANGED** · **CHANGED** · **NEW** · **DELETED**

---

## `POST /jobs/ingest` — CHANGED (dual-write)

### Request — UNCHANGED

`ScrapedJobIngest` keeps its current shape. The extension needs no change.

Legacy fields (`job_title`, `company`, `location`, `job_description`, `apply_url`,
`easy_apply`, `post_datetime`, `search_filters`, `voyager_raw`, `original_job_id`) remain on
the model but are **ignored** on the per-source path, exactly as today. `skip_reason` is
retained solely for the no-op branch below.

### Response — UNCHANGED

`ScrapedJobIngestResponse{id, already_exists, content_duplicate, skip_reason}`.

`id` is the **per-source** row id (R13), not the canonical id. `content_duplicate` is always
`false` on the per-source path, as today.

> **Sharp edge**: `POST /jobs/ingest` returns per-source ids; `GET /jobs/{id}` accepts canonical
> ids. Two id spaces on one router. Nothing consumes them together today.

### Behavior

| Case | Before | After |
|---|---|---|
| Valid site + `source_raw` | per-source INSERT only | per-source INSERT **+ canonical INSERT**, one transaction |
| Same `job_url` again | per-source no-op, `already_exists: true` | both no-op, `already_exists: true` — **UNCHANGED** |
| Unknown site | 400 | 400 — **UNCHANGED** |
| Missing `scan_run_id` | 400 | 400 — **UNCHANGED** |
| Malformed `source_raw` | 400 | 400 — **UNCHANGED** |
| LinkedIn missing `jobPostingUrl` | 400 | 400 — **UNCHANGED** |
| Canonical write fails | n/a | **400/500, per-source row rolled back too** (FR-008) |
| `skip_reason` set | writes a legacy row | **200 no-op, writes nothing** (see below) |
| `source_raw is None` | writes a legacy row | **400 `source_raw required`** (FR-025) |

### `skip_reason` branch — 200 no-op (FR-024, as amended)

FR-024 requires ingest never to **record** a skip reason — it records nothing, so the
requirement is met. It deliberately still **accepts** the submission rather than 400ing,
because `recordSkip` (`extension/content/shared/messaging.js:102`) is a live caller firing on
every skipped card, and a 400 costs ~6s of retry backoff per skip (R9b). Returns:

```json
{ "id": "00000000-0000-0000-0000-000000000000",
  "already_exists": false, "content_duplicate": false, "skip_reason": "<echo>" }
```

**Approved 2026-07-15 (D1)**; FR-024 amended to match. The complete fix is removing
`recordSkip` from the extension, which the user scoped out of this feature.

---

## `GET /jobs` — CHANGED (reads canonical, renamed fields)

### Query parameters

| Param | Status | Notes |
|---|---|---|
| `source_site` | **NEW** (replaces `website`) | `linkedin` \| `indeed` \| `glassdoor` |
| `website` | **DELETED** | → `source_site` |
| `dismissed` | UNCHANGED | **default flips**: dismissed now excluded unless asked for (FR-019) |
| `scan_run_id` | UNCHANGED | |
| `date_from` / `date_to` | CHANGED | now filter `posted_at` (was `post_datetime`) |
| `scraped_from` / `scraped_to` | CHANGED | now filter `scrape_time` (was `created_at`) |
| `limit` / `offset` | UNCHANGED | `limit` 1–500, default 25 (FR-020) |
| `easy_apply` | **DELETED** | no canonical field; sites express it incompatibly (R12) |
| `dedup_status` | **DELETED** | `skip_reason` is gone (FR-024) |

**Default filter changes** from `skip_reason IS NULL` to `dismissed = false` (FR-019).
**Ordering changes** from `created_at DESC` to `scrape_time DESC`.

### Response — CHANGED

`JobsListResponse{items, total, limit, offset}` — envelope UNCHANGED. `items[]` is now
`ScrapedJobRead` with canonical fields:

| Was | Now |
|---|---|
| `website` | `source_site` |
| `job_title` | `title` |
| `location` | `location_text` |
| `job_description` | `description` |
| `post_datetime` | `posted_at` |
| `created_at` | `scrape_time` |
| `easy_apply`, `search_filters`, `raw_description_hash`, `ingest_source`, `original_job_id`, `skip_reason`, `updated_at` | **removed** |
| — | `source_row_id`, `site_job_id`, `remote`, `experience_level`, `industry`, `salary_min`, `salary_max`, `salary_currency`, `salary_period`, `matched` **(new)** |
| `id`, `company`, `job_url`, `apply_url`, `scan_run_id`, `dismissed` | unchanged |

**Breaks the current frontend.** Accepted: spec 007 owns adaptation (FR-021), and the page
returns an empty list today regardless.

### Field encodings 007 needs to know

- **`salary_min` / `salary_max` are JSON *strings* in plain decimal notation** — `"120000"`,
  `"55"` — never scientific, never JSON numbers. They are Postgres `NUMERIC`, and asyncpg
  decodes round values into a Decimal with a positive exponent (`120000` → `Decimal('1.2E+5')`),
  which Pydantic's default `str()` would emit as `"1.2E+5"` while a non-round `55` stayed
  `"55"` — two formats from one field. A serializer pins plain notation. Parse with
  `Number(...)`; do not assume a JSON number.
- **`remote` is tri-state**: `true` / `false` / **`null`**. `null` means the site did not say,
  which is not the same as "not remote" — do not render it as "On-site".
- **`salary_period`** is one of `HOURLY` / `DAILY` / `WEEKLY` / `MONTHLY` / `ANNUAL`, or `null`
  when the source token was unrecognized. Amounts are as quoted against that period and are
  **never annualized** — an `HOURLY` `"55"` is 55/hour, not a yearly figure.
- **`posted_at`** may be `null` (source had no date, or it was unparseable). `scrape_time`
  never is.

---

## `GET /jobs/{job_id}` — CHANGED

Takes a **canonical** `scraped_jobs.id`. Returns `ScrapedJobRead` (see above). 404 when absent
— UNCHANGED.

`ScrapedJobDetail` is **DELETED**: it existed only to add `voyager_raw`, which the canonical
row does not carry (FR-005a). Raw payloads are reachable via `source_row_id` → per-source row.

---

## `PUT /jobs/{job_id}` — UNCHANGED in contract

`JobUpdate{dismissed}` → `ScrapedJobRead`. Still the only mutable field (FR-023). Now writes
the canonical row. Response shape changes with `ScrapedJobRead` above.

---

## `GET /jobs/skipped` — DELETED

FR-024. Depended on `skip_reason`. No replacement.

**Observed status is `422`, not `404`.** With the route gone, the path now falls through to
`GET /jobs/{job_id}`, which tries to parse `"skipped"` as a UUID and fails validation. The
endpoint is gone either way; noted so nobody reads the 422 as a bug.

---

## `POST /admin/cleanup-invalid-entries` — CHANGED (job sweeps retired)

Route and response schema **UNCHANGED** (Principle VII: keys are not removed).

| Response key | Status |
|---|---|
| `deleted_jobs_empty_core` | **always 0** — retired (R10) |
| `deleted_jobs_empty_jd` | **always 0** — retired (R10) |
| `deleted_jobs_mismatched_website` | **always 0** — retired; condition can no longer arise |
| `marked_failed_run_logs` | UNCHANGED — still sweeps stale run logs |
| `marked_failed_dedup_tasks` | UNCHANGED — already always 0 |

Retired rather than adapted because deleting the canonical row alone breaks the 1:1 invariant,
and deleting the per-source row violates CC-1. Full derivation in R10. This follows the
`marked_failed_dedup_tasks` precedent already in the file.

---

## Unchanged surfaces

- `GET /health` — the only unauthenticated route
- All `/scan`, `/runs`, auto-scrape and scheduler routes — the user scoped these out
- `extension_run_logs` reads/writes

---

## Frontend consumers (spec 007's problem, listed for handoff)

| File | Breaks on |
|---|---|
| `frontend/src/api.js` | `website`/`easy_apply`/`dedup_status` params; field names |
| `frontend/src/components/JobCard.jsx` | `job_title`, `location`, `post_datetime` |
| `frontend/src/components/JobModal.jsx` | `job_description`, `voyager_raw` |
| `frontend/src/components/DedupSkipBadge.jsx` | `skip_reason` — **surface is gone** |
| `frontend/src/components/MatchSkipBadge.jsx` | matching fields — already dead post-006 |
| `frontend/src/pages/MatchingPage.jsx` | matching fields — already dead post-006 |
