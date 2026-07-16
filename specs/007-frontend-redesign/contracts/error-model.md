# Contract: Error Model

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

**The backend returns four incompatible `detail` types.** Normalizing them is a precondition for FR-016 ("surface that specific reason rather than a generic failure"), FR-021, FR-044, and SC-011 ("zero rejections surface as a generic failure").

**Normalization happens in exactly one place**: `lib/api/errors.ts`, applied by `lib/api/client.ts` before any error escapes the access layer. No page, hook, or component parses a response body. `lib/api/errors.ts` is unit-tested against all four shapes (R18).

---

## The four wire shapes

| # | Shape | Emitted by | Real example |
|---|---|---|---|
| **1** | `{"detail": "<string>"}` | `/config` 422 (`routers/config.py:10-34`); **all** 401s (`core/auth.py:6`); **all** 404s | `{"detail": "nth_bonus_weight must be between 0.0 and 1.0"}` |
| **2** | `{"detail": [{loc, msg, type}, …]}` | FastAPI body/param validation, any route | `{"detail": [{"loc": ["body", "limit"], "msg": "…", "type": "…"}]}` |
| **3** | `{"detail": {"field_errors": {"<field>": "<msg>"}}}` | `PUT /admin/auto-scrape/config` 422 (`routers/auto_scrape.py:220`) | `{"detail": {"field_errors": {"keywords": "max 10 keywords"}}}` |
| **4** | `{"detail": {reason, message, retry_after_ms}}` | `POST /extension/trigger-scan` 409 (`routers/extension.py:86-149`) | `{"detail": {"reason": "scan_pending", "message": "…", "retry_after_ms": 3000}}` |

**The trap that motivates this contract**: shape 1 is **not** FastAPI's usual 422. The obvious handler — assume `detail` is an array of `{loc, msg}` — is the one most likely to be written, and it breaks on **every** `/config` validation error, which is precisely FR-021's path. The equally obvious `String(detail)` breaks the other way: shapes 3 and 4 stringify to **`"[object Object]"`**, which is the archetypal "generic failure" SC-011 forbids.

So: **`detail` must be discriminated by runtime type before it is read.** Both naive approaches fail, in opposite directions.

---

## The normalized type

```ts
export interface ApiError extends Error {
  status: number;                              // HTTP status; 0 for network/abort
  kind: 'network' | 'unauthorized' | 'not_found'
      | 'validation' | 'conflict' | 'server' | 'unknown';
  message: string;                             // ALWAYS human-readable. Never "[object Object]".
  fieldErrors?: Record<string, string>;        // shapes 2 and 3
  reason?: 'scan_pending' | 'stop_cooldown' | 'scan_in_progress';  // shape 4
  retryAfterMs?: number;                       // shape 4
}
```

`message` is the load-bearing invariant: **it is always safe to render**. Every branch below, including the fallbacks, produces a sentence a human can act on.

---

## Normalization rules

Applied in order. `detail` is discriminated by runtime type — never assumed.

| # | Condition | Result |
|---|---|---|
| 1 | `fetch` rejects (network down, DNS, CORS) | `{status: 0, kind: 'network', message: "Could not reach the backend at <base>."}` → FR/edge "Backend unreachable" |
| 2 | `AbortError` | Not an error. Swallowed — a cancelled request is not a failure. |
| 3 | `status === 401` | `{kind: 'unauthorized', message: "The configured credential was rejected."}` → handled **once in the shell**, not per page |
| 4 | `status === 404` | `{kind: 'not_found'}`, `message` = the shape-1 string |
| 5 | `status === 409` **and** `detail` is an object with a `reason` key | **shape 4** → `{kind: 'conflict', reason, message: detail.message, retryAfterMs: detail.retry_after_ms}` |
| 6 | `detail` is an object with a `field_errors` key | **shape 3** → `{kind: 'validation', fieldErrors: detail.field_errors, message: <count summary>}` |
| 7 | `detail` is an **array** | **shape 2** → `{kind: 'validation', fieldErrors: <keyed by last loc segment>, message: <first msg>}` |
| 8 | `detail` is a **string** | **shape 1** → `{kind: status === 422 ? 'validation' : 'server', message: detail}` |
| 9 | `status >= 500`, `detail` unparseable or absent | `{kind: 'server', message: "The backend failed to handle this request (HTTP <status>)."}` |
| 10 | anything else | `{kind: 'unknown', message: "Unexpected response from the backend (HTTP <status>)."}` |

**Rule 9 is not defensive padding — it is a live path.** Three real 500s have unparseable or unhelpful bodies:
- Malformed `config.json` → `500 {"detail": "config.json is malformed: …"}` (shape 1, parseable, but a **500 not a 422**).
- A non-numeric `cpu_strong_threshold` already on disk → `float()` raises **outside** the try/except at `routers/config.py:23-24` → an unhandled `ValueError`, i.e. a bare 500 with no useful `detail`.
- A missing `site_session_states` row → `scalar_one()` raises `NoResultFound` → bare 500.

Rules 5/6 check for the **discriminating key**, not the status alone, because both are objects at 409/422 and only the key tells them apart.

---

## Consumption

| Consumer | Uses | Requirement |
|---|---|---|
| **Shell** | `kind === 'unauthorized'` | One consistent "not authorized" state for the whole app — *"rather than each page rendering its own empty or error variant"* |
| **`ErrorState`** | `message` + `retry()` | FR-014. The **only** error presentation in the app; identical on all four pages (FR-009/SC-005) |
| **`ConfigForm`** | `fieldErrors` | FR-021 — field-specific reason, **draft retained untouched** |
| **`ConfigEditor`** (auto-scrape) | `fieldErrors` | FR-044 — field-level errors from shape 3 |
| **`ScanControls`** | `reason` + `retryAfterMs` | SC-011 — three distinct messages, each quoting the retry delay |

### The three scan-rejection messages (SC-011)

Each must be distinct and actionable. A generic failure here is an SC-011 violation.

| `reason` | Message | Retry |
|---|---|---|
| `scan_pending` | "A scan request is already queued — the scraper hasn't picked it up yet." | 3s |
| `stop_cooldown` | "A scan just finished. Wait a moment before starting another." | 5s |
| `scan_in_progress` | "A scan is already running. Stop it first, or wait for it to finish." | 5s |

The third is the spec's Acceptance Scenario 7 ("the page refuses and explains why … instead of failing silently").

---

## What this contract forbids

| Forbidden | Why |
|---|---|
| `catch {}` with no handling | The current `ConfigEditor.handleSave`/`handleReset` are `try { … } finally { setBusy(false) }` with **no `catch`** — a failed save is **completely invisible**, surfacing only as an unhandled rejection. FR-016. |
| Fabricating a success value on error | `fetchAutoScrapeInstances` currently degrades to `{count: 1, instances: []}` on non-OK — i.e. it **invents the healthy answer**, defeating FR-039's whole point. |
| Not checking `response.ok` | Several `api.js` methods (`getConfig`, `getRunLogs`, `getExtensionState`, `getMatchStatus`, `runDedup`, `getDedupReports`, …) go straight to `.json()`, so a 500's error body is rendered as if it were data. |
| A page-level error that replaces the page | `auto-scrape/page.tsx:59-65` blanks the entire UI when **any one** of 5 parallel calls fails. Errors are **per query**; a failed `cycles` fetch must not hide a healthy `state`. FR-015. |
| `String(detail)` / template-interpolating `detail` | Yields **`"[object Object]"`** for shapes 3 and 4 — the exact generic failure SC-011 forbids. |
| Parsing an error body outside `lib/api/errors.ts` | FR-010, and it is how four inconsistent handlers grew last time. |
