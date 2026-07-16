# Contract: Backend Surface Bindings

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

The frontend's external interface is the set of backend routes it calls. This contract fixes that set: **each of the four pages binds to exactly one backend surface**, and no route outside this document may be called.

Verified against live routers, not docs. All paths are absolute (routers mount with no extra prefix beyond those shown).

---

## The binding table

| Route | Page | Backend surface | Requirements |
|---|---|---|---|
| `/` | `ConfigPage` | `/config` | FR-017 – FR-021 |
| `/jobs` | `JobsPage` | `/jobs` (+ `/extension/*` for scan control) | FR-022 – FR-030 |
| `/logs` | `LogsPage` | `/extension/run-log` | FR-031 – FR-036 |
| `/dashboard/auto-scrape` | `AutoScrapePage` | `/admin/auto-scrape/*` | FR-037 – FR-047 |
| `*` | `NotFoundPage` | none | FR-005 |

**SC-002 is a property of this table**: every route listed below exists in the live backend. The old frontend has four pages calling deleted capabilities (`/profile`, `/skills/*`, `/match/*`, `/dedup/*`, `/jobs/skipped`, `/jobs/reports*`). None appear here.

---

## Global rules

**Auth** — every request carries `Authorization: Bearer <VITE_AUTH_TOKEN>`. The backend compares by **exact string equality** against the hardcoded literal `"Bearer dev-token"` (`core/auth.py:1-7`); there is no server-side env var for it. Every route below requires it. `/health` is the only exempt HTTP route and is not called.

**One fetch site** — `lib/api/client.ts` owns the only `fetch()` call in `src/` (FR-010). Enforced by an ESLint rule; a second access layer is a lint failure, not a review comment. This is the mechanism against the status quo (`api.js` + `lib/api/autoScrape.ts` + an ad-hoc env read in `JobsPage.jsx:202-221` for the WebSocket).

**One error type** — every non-2xx is normalized to `ApiError` inside the client, before it escapes. See [error-model.md](./error-model.md).

**No runtime validation** — responses are cast, not parsed. Added backend keys must pass through (Constitution Principle VII).

**Base URL** — `VITE_API_URL`, default `http://localhost:8000`. `NEXT_PUBLIC_API_BASE` is **not** read: Vite only exposes `VITE_*` on `import.meta.env`, so the old fallback at `autoScrape.ts:15` was always `undefined`. Dead code, deleted.

**CORS** — `allow_origin_regex` admits any `http://localhost:<port>` or `http://127.0.0.1:<port>` (`main.py:97-108`). The dev port needs no backend change. **Not** admitted: LAN IPs, `https://localhost`, `http://0.0.0.0`. As-built; unchanged.

---

## FORBIDDEN ROUTES

**These three `GET`s mutate and commit. Calling any of them once breaks the scraper silently.**

| Route | What one call does |
|---|---|
| `GET /extension/pending-scan` | Sets `scan_requested = false`, **nulls** `scan_website`/`scan_all`/`scan_all_position`/`scan_all_total` (`routers/extension.py:170-209`) |
| `GET /extension/pending-stop` | Sets `stop_requested = false` (`:249-262`) |
| `GET /extension/pending` | Both, in one transaction; clears `stop_requested` **unconditionally** and the scan fields **even when `scan_pending` was false** (`:265-318`) |

They are read-once mailboxes for the extension. A frontend poll **steals the extension's instruction and the scan never runs** — no error, no log, nothing to debug. FR-030 prohibits them.

**The safe substitute for all three**: `GET /extension/state`, which exposes `scan_requested` and `stop_requested` without consuming them.

**Enforcement**: an ESLint `no-restricted-syntax` rule fails the build on the literal strings `/extension/pending`, `/extension/pending-scan`, `/extension/pending-stop`. The gate, not vigilance, is what holds this.

**Also never called** (each for a stated reason):

| Route | Why not |
|---|---|
| `PUT /admin/auto-scrape/state` | Whole-object replacement; a partial write silently destroys unsent keys (`routers/auto_scrape.py:132`). **FR-046 is satisfied by not having the capability.** Use the mutator endpoints. |
| `PUT /jobs/{id}` | The only job write (`dismissed`). No requirement asks for it. Not binding it keeps Constitution Principle V vacuously satisfied (FR-052). |
| `PUT /extension/run-log/{id}` | The extension's channel; it is what fires the WS broadcast. |
| `PUT /admin/auto-scrape/sessions/{site}` | The extension's probe-reporting channel. FR-043 needs `POST /reset-session/{site}` only. |
| `POST /jobs/ingest`, `POST /extension/run-log/start`, `/heartbeat`, `/cycle`, `/wake-orchestrator`, `/cleanup-orphan-cycles` | Extension/service-worker surfaces. |
| `GET /health` | Nothing needs it. |

---

## Surface 1 — Config (`/`) ↔ `/config`

### `GET /config` → `SearchConfigRead`
No params. Missing file → `{}` → all defaults. Malformed file → **500** `{"detail": "config.json is malformed: …"}` → FR/edge "Config storage is malformed": report that settings could not be read and **do not render an empty form** (an empty form would overwrite the file on save).

### `PUT /config` → `SearchConfigRead`
Body: `SearchConfigUpdate`, **partial** — `model_dump(exclude_unset=True)` merged over the file (`routers/config.py:43-55`). Response is the **full merged config**; re-seed the form from it, never from the local draft (FR/edge "Concurrent edit").

**Send only the fields the form owns.** The four dead fields (`dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold`) are never sent, which is exactly how FR-018 preserves them.

**Errors** — `422 {"detail": "<plain string>"}` (**shape 1**, not FastAPI's array):

| Condition | Message |
|---|---|
| `nth_bonus_weight` not float-coercible | `"nth_bonus_weight must be a number"` |
| `nth_bonus_weight` outside `[0.0, 1.0]` | `"nth_bonus_weight must be between 0.0 and 1.0"` |
| `cpu_strong_threshold` not in `(0.0, 1.0]` | `"cpu_strong_threshold must be between 0 and 1"` |
| `cpu_binary_threshold` not in `(0.0, strong)` | `"cpu_binary_threshold must be less than cpu_strong_threshold"` |

All four concern fields we never send, so we cannot trigger them — but a **pre-existing** malformed `config.json` makes every save fail, and `float(merged.get("cpu_strong_threshold", 0.85))` is **not** try/except-wrapped (`config.py:23-24`), so a non-numeric value on disk yields an **unhandled 500, not a 422**. FR-014's error path must degrade to a stated message when `detail` is unparseable.

Body type errors → **shape 2** (FastAPI's `[{loc, msg, type}]`) → `fieldErrors` (FR-021).

---

## Surface 2 — Jobs (`/jobs`) ↔ `/jobs`

### `GET /jobs` → `{items, total, limit, offset}`
Exact path is `/jobs` — **`/jobs/` 307-redirects**.

| Param | Bound? | Notes |
|---|---|---|
| `source_site` | ✅ | exact `==`; not enum-validated (bogus → 200 empty, not 422) |
| `scraped_from` / `scraped_to` | ✅ | FR-023's date range. `scraped_to` is **whole-day inclusive** (does the +1-day math) |
| `limit` / `offset` | ✅ | `limit`: default 25, `ge=1, le=500`. `0` → 422 |
| `date_from` / `date_to` | ❌ | Filter `posted_at` against bare-date midnight → `date_to=2026-07-15` **excludes nearly all of that day**. Broken; FR-023 needs scraped-date anyway |
| `dismissed` | ❌ | Omitted → `dismissed == false`, the wanted behavior. **No value returns both** |
| `scan_run_id` | ❌ | Exists; unused |
| `easy_apply`, `dedup_status`, `website`, `skip_reason` | ❌ | **Do not exist** — removed by 008 |

Ordering: `scrape_time DESC`, not configurable, **no tiebreaker** → offset pagination can drop/repeat rows on ties (batch ingest shares a `scrape_time`). Accepted.

`total` = count with filters, ignoring limit/offset.

### `GET /jobs/{id}` → `ScrapedJobRead`
Takes the **canonical** `id` (not `source_row_id`). Same shape as list items — no detail-only fields, so detail can render from the list row; bound for deep-link/refresh correctness. 404 `{"detail": "Job not found"}`. Non-UUID → 422.

### Per-site counts (FR-023) — no endpoint exists
Three parallel `GET /jobs?source_site=<site>&limit=1`, read `total` from each. `limit=1` because `0` is a 422. `source_site` is deliberately unindexed (cardinality 3, CC-12) so each is a sequential scan. Jobs' initial load is **4 requests**. The count calls must carry the **same `dismissed` state as the list** (all omit it) or the counts won't sum to `total`. R3.

### Scan control (`/extension/*`)

| Route | Contract |
|---|---|
| `POST /extension/trigger-scan` | Body `{website?, scan_all?, scan_all_position?, scan_all_total?}`, all optional. **Omitting the body clears all four fields** (`extension.py:156-160`) — always send an explicit body. Returns `{"ok": true, "scan_requested": true}` — **no run id**. `website` is unvalidated free text; send only the three real sites. |
| `POST /extension/trigger-stop` | No body → `{"ok": true}`. **Immediately marks ALL running run-logs `failed`** with `"Stopped by user"`, regardless of age (`:236-244`). FR-011 destructive → confirm first. |
| `GET /extension/state` | → `ExtensionStateRead`. The **non-destructive** read of `scan_requested`/`stop_requested`. `current_search_date`/`last_search_time` are **strings, not datetimes**. |

**Side effect to know**: `trigger-scan` first force-fails any `running` run-log older than **60 minutes** (`:122-136`) — the stuck-run reaper. This is why a run can go terminal with no user action (FR/edge "A run exceeds its time budget and the backend force-fails it").

**409 rejections (SC-011)** — **shape 4**, `{"detail": {reason, message, retry_after_ms}}`:

| `reason` | Meaning | `retry_after_ms` |
|---|---|---|
| `scan_pending` | `scan_requested` already true — extension hasn't collected the last command | 3000 |
| `stop_cooldown` | A run-log completed within the last 5s | 5000 |
| `scan_in_progress` | A run-log has `status="running"` | 5000 |

Each gets a distinct actionable message quoting the retry delay. Zero may surface as a generic failure.

**Trigger→run correlation is by recency only** (FR-027): the trigger returns no id and returns before any scan starts; the extension may never collect it. Poll `GET /extension/run-log?limit=1&include_debug_log=false`; first run with `started_at` after the trigger instant is the run; **60s bounded wait**, then the "scraper has not responded" state. R7.

### Live progress — `WS /ws/run-log`

| Aspect | Contract |
|---|---|
| Path | `/ws/run-log` (no prefix) |
| Auth | **Subprotocol, not header/query**: `new WebSocket(url, ["bearer", token])`. Server requires `subprotocols[0] === "bearer"`, `[1] === token`; accepts with `subprotocol: "bearer"` |
| Token | `DEV_WS_TOKEN = "dev-token"`, hardcoded at `run_log_ws.py:15` — a **second constant**, independent of `core/auth.py`. Preserved as-is per the spec's Assumptions |
| Rejection | **close code 1008**, no HTTP status. Inspect it: stop retrying on 1008, back off on anything else |
| Payload | A full `RunLogRead` with `exclude={"debug_log"}`, one JSON object per message. No event type, no envelope. **Assign, never merge additively** |
| Trigger | Fires **only** from `PUT /extension/run-log/{id}` (`extension.py:413`). Nothing else pushes |
| Fan-out | In-process `set()`, **not Redis** → with >1 uvicorn worker, a client on worker A misses worker B's updates. **This is why the poll fallback is mandatory** |
| Client→server | Server loops on `receive_text()` and discards it; reads only to detect disconnect |

---

## Surface 3 — Logs (`/logs`) ↔ `/extension/run-log`

### `GET /extension/run-log` → `RunLogRead[]`
**A bare array. No envelope, no total count** — so no "page N of M". Page by `limit`/`offset`; stop on a short page.

| Param | Default | Limits |
|---|---|---|
| `limit` | 10 | `ge=1, le=200` |
| `offset` | 0 | `ge=0` |
| `status` | — | free string, exact `==`, no enum (FR-032) |
| `include_debug_log` | **`true`** | the trace opt-out |

Ordering: `started_at DESC`, no tiebreaker.

**FR-035 binding**: the list **always** sends `include_debug_log=false`. Traces are a **10,000-event** ring returned inline and **included by default** — a default list of 10 runs can carry 100,000 events.

**The opt-out's honest limit**: it does not skip the DB read. The handler fetches rows then nulls the field in Python (`:433-437`). The payload shrinks (which is what FR-035/SC-010 are about); backend work does not.

**The param is `include_debug_log`, not `include_trace`.** Consumed verbatim.

**There is no `GET /extension/run-log/{id}`.** This is why FR-033 is expand-in-place, not a detail route. One run's trace is fetched by a filtered list call, keyed and cached per run id so collapse/re-expand doesn't refetch.

`debug_log` is `{"events": [...]}` — an **object wrapping** the array. `DebugEvent` is `extra="allow"`; render unknown keys rather than breaking (FR/edge).

---

## Surface 4 — Auto-Scrape (`/dashboard/auto-scrape`) ↔ `/admin/auto-scrape/*`

**There is no `/status` route** — the status surface is `GET /state`.

| Route | Bound | Contract |
|---|---|---|
| `GET /state` | ✅ | → `AutoScrapeStateRead`. FR-037/038. **500** `{"detail": "auto_scrape_state missing"}` if the singleton is absent |
| `PUT /state` | ❌ | **FORBIDDEN** — whole-object replace (FR-046) |
| `GET /instances` | ✅ | → `{instances: [...], count}`. `count > 1` → warn (FR-039). Errors surface — do **not** copy the old silent degrade to `{count: 1, instances: []}` |
| `GET /config` | ✅ | → `{config, updated_at}`. **500** if the singleton row is absent |
| `PUT /config` | ✅ | → `{config, warnings, next_cycle_estimated_at}`. **Shallow** merge — top-level keys replaced wholesale, arrays **not** merged element-wise (`_merge_config`, `:72-77`). Editing `keywords` means sending the complete array. FR-044 |
| `GET /config/limits` | ✅ | → `{limits: {field: {min, max, recommended}}, derived_limits: {...}}`. **The source of truth for validation** (FR-044) |
| `POST /config/reset` | ✅ | → `ConfigRead` (the full envelope — note `PUT /config` returns `ConfigUpdateResponse` instead; the asymmetry is as-built) |
| `GET /cycles` | ✅ | → **bare array**. `limit` default 10, `ge=1, le=100`, **no `offset`** → cannot page past 100. `started_at DESC`. FR-041 |
| `POST /enable` | ✅ | → `AutoScrapeStateRead`. Zeroes every `consecutive_*` key, sets `enabled: true`, `config_change_pending: false` (`:377-392`) — this is FR-037's "counters shown as cleared", from the response, not assumed |
| `POST /pause` | ✅ | → `AutoScrapeStateRead`. Sets `enabled: false`, `config_change_pending: false` |
| `POST /shutdown` | ✅ | **This is "stop-and-exit"**. Sets `exit_requested: true`. FR-011 destructive → confirm. FR-040: present as a **pending request**, not a completed stop |
| `POST /test-cycle` | ✅ | Sets `test_cycle_pending: true`. FR-040: a request, not an action |
| `POST /reset-counters` | ✅ | Zeroes `consecutive_*`-prefixed keys only |
| `POST /reset-session/{site}` | ✅ | → `SiteSessionStateRead`. Sets `consecutive_failures=0`, `notified_user=false`, `backoff_multiplier=1.0`, `last_probe_status='unknown'`. FR-011 destructive → confirm. FR-043 |
| `GET /sessions` | ✅ | → **bare array** of `SiteSessionStateRead`. `site` is the PK; **there is no `id` field**. FR-043 |
| `PUT /sessions/{site}` | ❌ | The extension's probe channel |
| `POST /restart-cycle` | ❌ | No requirement |
| `POST /heartbeat`, `/wake-orchestrator`, `/cycle`, `PUT /cycle/{id}`, `/cleanup-orphan-cycles` | ❌ | Service-worker surfaces |

**Published limits** (`GET /config/limits`) — bind to these; **never hardcode**:

| Field | min | max | recommended |
|---|---|---|---|
| `min_cycle_interval_minutes` | 1 | 1440 | 1 |
| `inter_scan_delay_seconds` | 5 | 600 | 30 |
| `scan_timeout_minutes` | 3 | 30 | 8 |
| `max_consecutive_precheck_failures` | 1 | 100 | 3 |
| `max_consecutive_dead_session_cycles` | 1 | 1000 | 24 |

`derived_limits`: `max_keywords: 10`, `max_scans_per_cycle_hard: 30`, `max_scans_per_cycle_warn: 15`, `valid_sites: ["glassdoor","indeed","linkedin"]`.

**`valid_sites` is nested inside `derived_limits`** in the response even though `get_limits()` returns it as a sibling — bind to the response, not the function.

**`scans_per_cycle` is a synthetic field key**, not a config field: `sites × keywords > 30` → a `field_errors` entry (422); `>= 15` → a **warning in `warnings[]` on a 200**. FR-044 requires rendering warnings on success, not just errors.

**Validation errors** → **shape 3**: `422 {"detail": {"field_errors": {"<field>": "<msg>"}}}` (`:220`). Rules: non-int in a LIMITS field → `"must be an integer"`; out of range → `"must be between {lo} and {hi}"`; `enabled_sites` empty/not a list → `"must be a non-empty list"`; unknown site → `"invalid sites: [...]; must be from [...]"`; `keywords` empty → `"must be a non-empty list"`, >10 → `"max 10 keywords"`, blank entry → `"all keywords must be non-empty strings"`.

**FR-045 dead fields** — `run_dedup_after_scrape`, `run_matching_after_dedup`, `run_apply_after_matching`: hidden, and **never sent**. Same `exclude_unset` mechanism as FR-018 (R11/R17).

**Poll-only.** No push channel reaches this page — the WS broadcast fires only from `PUT /extension/run-log/{id}`. FR-047's externally-driven changes (reapers, extension activity) arrive via `refetchInterval` alone.

**Sharp edge, absorbed not fixed**: both session routes use `scalar_one()`, not `scalar_one_or_none()` — a missing row → `NoResultFound` → **500**, not 404. Rows are seeded by migration 023.
