# Phase 0 Research: Search-Only Frontend Redesign

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

All findings below were verified against live code (`backend/routers/*`, `backend/schemas/*`, `frontend/src/*`), not against docs or the spec's prose. Where docs and code disagree, **code wins** (Principle I). File:line references are to the state of the tree at branch `007-frontend-redesign`.

**No NEEDS CLARIFICATION items remain.** R1, R10, and R18 were open decisions resolved by the user before Phase 0.

---

## R1. Server-state management

**Decision**: **TanStack Query v5**, one `QueryClient` at the root. One query key per backend read; mutations invalidate the keys they affect.

**Rationale**: Four of the spec's cross-cutting state requirements are this library's default behavior, and hand-writing them is where the current code fails:

| Requirement | Mechanism |
|---|---|
| FR-012 — loading state, never an empty state before first result | `isPending` distinguishes "never resolved" from "resolved empty". The current code's `if (!state) return <div>Loading…</div>` cannot make that distinction. |
| FR-014 — failed request → stated error + retry, input preserved | `isError` + `refetch()` per query. `retry` with backoff. |
| FR-015 — background refresh must not replace rendered content | `placeholderData: keepPreviousData`. This is the single hardest requirement to hand-roll and the one the current code most visibly breaks. |
| FR-026 / FR-047 — live updates without operator action | `refetchInterval`, gated by `refetchIntervalInBackground: false`. |
| FR-016 — surface the backend's specific reason | Typed `error` per query, carrying the normalized `ApiError` (R2). |

**What it replaces**: 1 WebSocket + ~8 independent `setInterval` timers across 3 pages. `JobsPage.jsx` alone runs four (`:326` run-log+state poll, `:336-341` jobs re-fetch while scanning, `:361` progress animation, plus `useScanGrace`'s 15s window and a 5s anti-flicker debounce) — and **the WS and the poller both `setLastRun`, so they race**. `auto-scrape/page.tsx:55` fires **5 requests every 5s forever** with no visibility gating and no backoff, re-fetching `config` and `config/limits` — effectively static — on every tick.

**Alternatives considered**: A hand-rolled `useQuery`-style hook (zero new deps, ~150 LOC). Rejected: FR-012/014/015 become code we own and must get right, and the existing auto-scrape hook is the cautionary tale — a single transient 500 on any of its 5 parallel calls blanks the whole page until the next tick (`page.tsx:59-65`), with no retry button. SWR was not evaluated separately; it solves the same problem with a smaller API but weaker mutation/invalidation ergonomics, which Config and Auto-Scrape both need.

**Consequence**: `refetchInterval` for Jobs' run-log poll is set to **3s** and Auto-Scrape's to **5s**, both well inside SC-009's 10s budget. `config` and `config/limits` get `staleTime: Infinity` — they change only via our own mutations, which invalidate them explicitly.

---

## R2. Error normalization — the backend returns four incompatible shapes

**Decision**: One `ApiError` class produced by `lib/api/errors.ts`, applied inside `lib/api/client.ts`. Every non-2xx response is normalized before it escapes the access layer. Full contract: [contracts/error-model.md](./contracts/error-model.md).

**Rationale**: FR-016 ("surface that specific reason rather than a generic failure") and SC-011 ("each of the three distinct scan-rejection reasons produces a distinct, actionable message; zero rejections surface as a generic failure") are impossible without this, because `detail` is four different types depending on the route:

| # | Shape | Emitted by | Example |
|---|---|---|---|
| 1 | `{"detail": "<string>"}` | `/config` 422 (`routers/config.py:10-34`), all 401s (`core/auth.py:6`), all 404s | `{"detail": "nth_bonus_weight must be between 0.0 and 1.0"}` |
| 2 | `{"detail": [{loc, msg, type}, …]}` | FastAPI body/param validation, everywhere | standard Pydantic array |
| 3 | `{"detail": {"field_errors": {"<field>": "<msg>"}}}` | `PUT /admin/auto-scrape/config` 422 (`routers/auto_scrape.py:220`) | `{"detail": {"field_errors": {"keywords": "max 10 keywords"}}}` |
| 4 | `{"detail": {reason, message, retry_after_ms}}` | `POST /extension/trigger-scan` 409 (`routers/extension.py:86-149`) | `{"detail": {"reason": "scan_pending", "message": "…", "retry_after_ms": 3000}}` |

**The trap**: shape 1 is **not** FastAPI's usual 422. A generic handler that assumes `detail` is an array (shape 2) — the obvious thing to write — will break on every `/config` validation error, which is precisely the FR-021 path ("on a rejected save, show the field-specific reason").

**Alternatives considered**: Per-page error parsing (status quo — `api.js` does 409 handling in `triggerScan` only, and several methods never check `.ok` at all). Rejected by FR-010. Fixing the backend to emit one shape was rejected as out of scope — this is frontend-only, and Principle I says absorb as-built behavior rather than idealize it.

---

## R3. Per-site counts — no facet endpoint exists

**Decision**: Issue **three parallel `GET /jobs?source_site=<site>&limit=1` requests** and read `total` from each envelope. One `useSourceCounts` hook, `staleTime` shared with the jobs list, invalidated on the same events.

**Rationale**: FR-023 requires "filtering by source site (with per-site counts)". The backend has **no** `/jobs/count`, no facet, no aggregate — confirmed by reading the full `/jobs` router. Reading `total` from a `limit=1` envelope is the only available mechanism. `limit=1` (not `limit=0`) because `Query(25, ge=1, le=500)` rejects `0` with a 422.

**Cost, stated plainly**: Jobs' initial load is **4 requests** (1 list + 3 counts). `source_site` is deliberately **not indexed** — `docs/live-per-source-schemas.md:307-309` records that the index was skipped on cardinality-3 grounds, consistent with CC-12 — so each count is a sequential scan. Acceptable at current row counts; this is the first thing to revisit if Jobs gets slow, and the fix would be a backend facet endpoint in a future feature, not an index added here.

**Interaction with the `dismissed` default (R15)**: the count requests must send **the same `dismissed` state as the list query** or the counts will not sum to the list's `total`. Since neither sends `dismissed`, both get the `dismissed == false` default, and they agree.

**Alternatives considered**: Dropping the counts (violates FR-023). Deriving counts client-side from the loaded page (wrong — that counts the current page of ≤500, not the corpus). Adding a backend facet endpoint (out of scope for a frontend-only feature).

---

## R4. `remote` is tri-state and `null` must never render "On-site"

**Decision**: `lib/format/remote.ts` maps `boolean | null` over exactly three outputs, unit-tested:

| Value | Renders |
|---|---|
| `true` | `Remote` |
| `false` | `On-site` |
| `null` | `—` (with a "not stated" title attribute) — **never** "On-site" |

**Rationale**: The column is `boolean | null` (`schemas/scraped_job.py`), and `null` means *the site did not say*, which is not the same claim as *this job is on-site*. The failure mode is a plain `remote ? "Remote" : "On-site"` — correct-looking, and wrong for every `null`.

**Why this is not hypothetical**: **Glassdoor never emits `false`.** The projection is `True if p.get("remote_work_types") else None` (`core/scraped_job_projection.py:245`) — so every Glassdoor job is `true` or `null`, and a naive ternary would label *every non-remote Glassdoor job* "On-site" on no evidence at all. This is also the direct mechanism for FR-051/FR-013: an absent field must stay distinguishable from a known-negative one.

---

## R5. Salaries are plain-notation strings and are never annualized

**Decision**: `lib/format/salary.ts`. Parse with `Number()`, format the amount, and **always render the period as given**. Never convert between periods. Unit-tested.

**Rationale**: Two real traits, both easy to get wrong:

1. **They are JSON strings, not numbers.** The DB type is `NUMERIC` → Python `Decimal`; a `field_serializer` (`schemas/scraped_job.py:85-95`) does `format(v, "f")` specifically because asyncpg hands back `Decimal('1.2E+5')` for `120000` and a naive `str()` would put **`"1.2E+5"` on the wire**. So the guarantee is: plain decimal notation, always — `"120000"`, `"55"`.
2. **Amounts are never annualized.** An `HOURLY` `"55"` is **$55/hr**, not $55/yr and not $114,400/yr. The period vocabulary is `HOURLY | DAILY | WEEKLY | MONTHLY | ANNUAL | null`.

**The `YEARLY` trap**: `YEARLY` is an accepted *input* token that ingest maps to `ANNUAL` (`scraped_job_projection.py:56-63`). **`YEARLY` is never a stored value** and must not appear in the frontend's `SalaryPeriod` union — a UI that switches on `"YEARLY"` has a branch that can never execute, and one (`ANNUAL`) it will silently miss.

**Rendering rules**: min-only → `From $55/hr`; max-only → `Up to $80/hr`; both → `$55–$80/hr`; neither → `—`. A `null` period with amounts present renders the amounts with no period suffix (an unrecognized input token yields `period: null` while retaining amounts — `projection.py:56-63`). `salary_currency` is `varchar(3)` and nullable; absent currency renders the bare number with no symbol rather than assuming USD.

---

## R6. Live run progress — one WebSocket plus a poll fallback, reconciled

**Decision**: `useRunProgress` owns both channels and writes **one** TanStack Query cache entry. The WebSocket updates the cache via `setQueryData`; the poll is a `refetchInterval: 3000` query on the same key. Last-write-wins on the same run id; the WS never appends or increments.

**Rationale**: The spec's Assumption "Live progress has one push channel plus polling… a poll fallback is required for the case where the channel drops" is accurate, and the current implementation is the anti-pattern: the WS handler and the poller both call `setLastRun` in `JobsPage.jsx`, racing, with `useScanGrace` and a 5s debounce bolted on to hide the resulting flicker.

**As-built facts the hook must honor**:
- **Path**: `/ws/run-log` (`routers/run_log_ws.py`, no prefix).
- **Auth is via subprotocol, not header or query token**: `new WebSocket(url, ["bearer", token])`. The server requires `subprotocols[0] === "bearer"` and `subprotocols[1] === token`, then accepts with `subprotocol: "bearer"`. Rejection is a **close with code 1008**, not an HTTP status — so failed auth is indistinguishable from a network drop unless the close code is inspected. The hook inspects it and stops retrying on 1008.
- **The WS token is a second hardcoded constant** — `DEV_WS_TOKEN = "dev-token"` at `run_log_ws.py:15`, independent of `core/auth.py`. Same literal, different file. Preserved as-is (the spec's Assumption: "The existing separate credential path for the live-progress channel is preserved").
- **Payload**: a full `RunLogRead` serialized with `exclude={"debug_log"}`, one JSON object per message — no event-type field, no envelope. So a WS message is a complete row and is **assigned, never merged additively**. This is what makes last-write-wins safe and satisfies the "does not duplicate counts" edge case.
- **Broadcast fires from exactly one place**: `PUT /extension/run-log/{log_id}` (`routers/extension.py:413`). Nothing else pushes — not ingest, not cycle updates, not auto-scrape state. So Auto-Scrape gets **no** push channel and is poll-only.
- **Subscribers live in an in-process `set()`** (`run_log_ws.py:13`), not Redis. With >1 uvicorn worker, a client on worker A misses updates written on worker B. **This is why the poll fallback is mandatory, not merely defensive.**
- The server loops on `receive_text()` and discards client messages; it reads only to detect disconnect. Client pings are harmless.

**Reconnect**: exponential backoff with jitter, capped, and abandoned on close code 1008. The current fixed `setTimeout(connect, 5000)` with no cap is replaced.

---

## R7. Scan triggering is a mailbox — correlation is by recency, and a bounded wait is mandatory

**Decision**: On `POST /extension/trigger-scan` success, start a **60-second** client-side timer. Poll `GET /extension/run-log?limit=1&include_debug_log=false`; the first run whose `started_at` is after the trigger instant is the run. If none appears before the timer expires, render the FR-027 state: "the scraper has not picked this up" with a retry.

**Rationale**: `POST /extension/trigger-scan` returns `{"ok": true, "scan_requested": true}` — **no run id**, and it returns before any scan starts. The extension collects the command on its own polling schedule, and **may never collect it at all** (extension not running). Nothing correlates a trigger to a run except recency.

**Ordering caveat**: `GET /extension/run-log` orders by `started_at DESC` with no tiebreaker, and `POST /run-log/start` substitutes the literal string `"(setup pending)"` for a blank keyword/location (`routers/extension.py:28-31`) — so a just-started run may briefly display that placeholder rather than the real search terms. Render it as-is; it is real backend behavior and resolves on the next update.

**Why 60s**: `trigger-scan` itself force-fails any `running` run-log older than **60 minutes** (`routers/extension.py:122-136`) — that is the backend's stuck-run reaper, not a pickup deadline, and is far too long for a UI wait. 60s is a UI-level bound chosen to be comfortably longer than the extension's poll interval while still bounded per FR-027. It is a display timeout only: it never cancels the trigger, because nothing can — the command stays in the mailbox until collected.

**The three 409 rejections** (SC-011) each carry `retry_after_ms` and get a distinct message:

| `reason` | Meaning | `retry_after_ms` |
|---|---|---|
| `scan_pending` | `state.scan_requested` is already true — the extension has not collected the last command | 3000 |
| `stop_cooldown` | A run-log completed within the last 5 seconds | 5000 |
| `scan_in_progress` | A run-log currently has `status="running"` | 5000 |

---

## R8. The pending-command endpoints are read-once mailboxes — never call them

**Decision**: Three routes are **forbidden**, enforced by an ESLint `no-restricted-syntax` rule that fails the build on the literal path strings, plus a comment at each call site's absence in `lib/api/runLog.ts`:

| Forbidden route | What a single GET does |
|---|---|
| `GET /extension/pending-scan` | Sets `scan_requested = false` and **nulls** `scan_website`, `scan_all`, `scan_all_position`, `scan_all_total` (`routers/extension.py:170-209`) |
| `GET /extension/pending-stop` | Sets `stop_requested = false` (`:249-262`) |
| `GET /extension/pending` | Both, in one transaction — and clears `stop_requested` **unconditionally**, plus the scan fields unconditionally **even when `scan_pending` was false** (`:265-318`) |

**Rationale**: FR-030, stated as a hard prohibition. These are `GET`s that mutate and commit. One poll steals the extension's instruction and **the scan silently never runs** — no error, no log, just a scan that doesn't happen. This is the single most dangerous mistake available in this codebase, and the danger is invisible: the endpoint looks like a read.

**The safe substitute**: `GET /extension/state` exposes `scan_requested` and `stop_requested` (plus `scan_website`, `scan_all`, `scan_all_position`, `scan_all_total`) **without consuming them**. Every read of pending-command state goes through it.

---

## R9. Design tokens

**Decision**: One token set in `tailwind.config.ts` under `theme.extend`, backed by CSS custom properties in `index.css`. `preflight` is **re-enabled**. No page or feature component may declare a raw color/spacing value; enforced by review against SC-006 and by `components/ui/` owning all visual treatment.

**Rationale**: FR-007 and SC-006 ("zero one-off color or spacing values outside the shared token set"). Today `theme.extend` is `{}`, so the auto-scrape island renders in raw Tailwind defaults while 2,845 lines of CSS modules carry an unrelated palette — the two systems share no color, spacing, or type scale. `preflight: false` exists **only** to stop Tailwind's reset breaking the CSS modules; once they are gone the containment measure is obsolete, and leaving it off would ship an un-normalized baseline.

**Token groups**: `color` (surface, border, text, and semantic `success`/`warning`/`danger`/`info`), `spacing` (inherit Tailwind's scale — it is already a token set; do not re-declare), `radius`, `fontFamily` (DM Sans, already loaded via `index.html`), `fontSize`, `shadow`.

**Semantic mapping is a token concern, not a component one.** The current `SessionHealth.tsx:37-45` inlines a 5-branch ternary of raw classes (`bg-green-500` / `bg-yellow-500` / `bg-red-500` / `bg-red-600` / `bg-gray-400`) — note it spends two near-identical reds on `captcha` vs `expired`. Probe status → semantic tone becomes a lookup map next to the token set, consumed by `<Badge tone={...}>`.

---

## R10. Folder strategy and cutover

**Decision**: Build at **`web/`**, alongside the untouched `frontend/`. The final task of the feature deletes `frontend/` and renames `web/` → `frontend/` in one commit (`git rm -r frontend && git mv web frontend`).

**Rationale**: Coexistence keeps the old app runnable for reference while the new one is built, and landing at `frontend/` means **zero deploy-wiring churn**: `docker-compose.yml` bind-mounts `./frontend/src` and `./frontend/index.html` and passes `VITE_API_URL`/`VITE_AUTH_TOKEN`; the Dockerfile context and README also point at `frontend/`. Repointing all of that and then living with a permanent rename in the diff buys nothing.

**During the build**: `web/` runs on port **5174** locally to avoid colliding with the compose-published `5173`. No backend change is needed for either port — CORS admits **any** `http://localhost:<port>` via `allow_origin_regex` (`main.py:97-108`). The compose `frontend` service keeps serving the old app until the cutover commit, after which it serves the new one with no compose edit.

**Cutover ordering**: the rename is last, after the gate is green, because it is the only irreversible-feeling step and it invalidates the old app as a reference.

**Caveat to carry into the cutover task**: the CORS regex is `^(?:chrome-extension://[a-zA-Z0-9]+|http://(?:localhost|127\.0\.0\.1):\d+)$` — LAN IPs and `https://localhost` are **not** matched. `vite.config` sets `host: true`, so reaching the dev server via a LAN IP will fail CORS. That is as-built and unchanged; it is a known limitation, not a regression to fix here.

---

## R11. Config's dead fields — hiding them preserves them, for free

**Decision**: Omit `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold` from the Config form **and from the `PUT /config` body**. Do not round-trip them.

**Rationale**: FR-018 requires hiding them "while preserving their stored values untouched across a save". `PUT /config` is a **partial merge** — `updates = body.model_dump(exclude_unset=True); existing.update(updates)` (`routers/config.py:43-55`) — so a field we never send is a field that is never touched. **Not sending is strictly safer than round-tripping**: round-tripping re-submits values through `_validate_scoring_config`, which can reject a file that was already on disk.

**Which fields are actually dead**: `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold`. Confirmed by grep — nothing in `backend/` reads them outside `config.py`'s own validator. `specs/006-search-only-backend/data-model.md:65-68` records that 006 removed only `dedup_mode` and `llm` and deliberately left these.

**Two live sharp edges to state and not trip over**:
1. Three of the four dead fields are **still validated on every write**; `dedup_fuzzy_threshold` is **not validated at all** (any int, any type, passes).
2. `float(merged.get("cpu_strong_threshold", 0.85))` (`config.py:23-24`) is **not** wrapped in try/except, unlike `nth_bonus_weight` (`:11-17`). A non-numeric value already sitting in `config.json` raises an unhandled `ValueError` → **500, not 422**. Since we never send these fields, we cannot cause this; but a pre-existing malformed file makes **every** save 500 with an unparseable error body. The FR-014 error path must degrade to a stated message rather than assume a parseable `detail`.

Two further keys, `fit_score_req_weight` and `fit_score_nth_weight`, are **scrubbed from the file on every write** (`config.py:49-50`) and are on neither schema. Not our concern — noted so the behavior isn't mistaken for data loss we caused.

---

## R12. Logs — trace opt-out, and the payload trap

**Decision**: The run list fetches with **`?include_debug_log=false`**. A run's trace is fetched only when expanded, via a **separate** `GET /extension/run-log?limit=1&…` scoped to that run.

**Rationale**: FR-035 ("MUST NOT fetch trace payloads for runs whose traces are not expanded"). Traces are a ring buffer of up to **10,000 events** (`settings.debug_log_ring_size`, `core/config.py:13`, env-overridable via `DEBUG_LOG_RING_SIZE`), returned **inline with each listed run and included by default**. A default list of 10 runs can therefore carry 100,000 events.

**The param is `include_debug_log`, not `include_trace`.** Consumed verbatim per the no-renames constraint.

**The trap, stated honestly**: `include_debug_log=false` does **not** skip the DB read. The handler fetches the rows and then nulls the field in Python (`routers/extension.py:433-437`). So the **payload** shrinks — which is what FR-035 and SC-010 are about — but backend work does not. This is a real limitation of the opt-out and is absorbed, not fixed.

**No per-run GET exists.** There is no `GET /extension/run-log/{id}`. This is why FR-033 is expand-in-place rather than a detail route, and why fetching one run's trace means a filtered list call. Trace-on-demand is keyed per run id and cached, so collapse/re-expand does not refetch.

---

## R13. Rendering a 10,000-event trace without blocking

**Decision**: Render the trace in a **windowed list** (fixed row height, `content-visibility: auto` on rows, render only the visible slice + overscan). No virtualization library.

**Rationale**: SC-010 caps input blocking at 1s with the ring at maximum. 10,000 DOM rows is well past that; a windowed list renders ~40. Fixed row height is available because a trace event's fields are fixed-width-ish (`dt`, `phase`, `level`, `page`).

**Forward-compatibility (Principle VII)**: `DebugEvent` is `model_config = ConfigDict(extra="allow")` (`schemas/debug_log.py:4-12`) — events legitimately carry keys the frontend does not know. The panel renders known columns and stringifies the rest into the expandable `data` cell; it never switches exhaustively on the event shape. This is the mechanism for the spec's "a trace event carries unexpected extra fields: it still renders" edge case.

**Shape note**: `debug_log` is `{"events": [...]}` — an **object wrapping** the array, not a bare array. `dt` is ms since run start (the display value); `t` is epoch ms.

---

## R14. Unsaved-changes guard requires a data router

**Decision**: `createBrowserRouter` + `<RouterProvider>`. `useUnsavedGuard` wraps `useBlocker` and renders a `<ConfirmDialog>`.

**Rationale**: FR-020 requires warning before navigation that would discard edits. `useBlocker` **only works under a data router** — `<BrowserRouter>` (what the old app uses at `main.jsx:13`) does not support it, and the hook throws. This is a structural choice that must be made at the root on day one; retrofitting it later means rewriting routing.

This is also the reason `router.tsx` is a separate module from `App.tsx`: the route objects, not JSX `<Routes>`, are the router's input.

---

## R15. The `dismissed` filter is tri-state and cannot return everything

**Decision**: Never send `dismissed`. Take the default.

**Rationale**: The param behaves as: omitted → **`dismissed == false`** (non-dismissed only); `true` → dismissed only; `false` → non-dismissed only (`routers/jobs.py:883-886`). **There is no value that returns both.** The default is the desired behavior — Jobs shows live jobs — and no spec requirement asks for a dismissed view or a dismiss control, so the tri-state never surfaces.

**Recorded because it is a trap for a future reader**: `dismissed=false` and omitting the param are identical, which makes the param look like a boolean filter with a `null` = "all" convention. It isn't. If a "show dismissed" toggle is ever wanted, "show all" is not reachable in one request and would need two.

---

## R16. Jobs pagination and date filtering

**Decision**: `limit`/`offset` pagination, page size **25** (the backend default). Scraped-date range binds **`scraped_from`/`scraped_to`**. **`date_from`/`date_to` are not used.**

**Rationale**:

- **Why not `date_from`/`date_to`**: they filter `posted_at`, which is `timestamptz`, against a bare `date`. So `date_to=2026-07-15` compiles to `posted_at <= 2026-07-15T00:00:00` and **excludes almost the entire named day** (`routers/jobs.py:893-895`). `scraped_from`/`scraped_to` do the +1-day math correctly and are inclusive of the whole end day (`:897-903`). FR-023 asks only for a **scraped-date** range, so the correct pair is also the required one and the broken pair is simply not bound. Left alone per Principle III.
- **Limits**: `limit` is `Query(25, ge=1, le=500)` — max 500, and `0` is a 422.
- **Ordering is `scrape_time DESC` with no tiebreaker and is not configurable** (`:875`). Since a batch ingest writes many rows inside one transaction, ties on `scrape_time` are common, so **offset pagination can drop or repeat a row across page boundaries**. Accepted and documented: fixing it needs a stable sort key (a backend change). At 25/page over the current corpus this is a rare cosmetic anomaly, not a correctness failure for the operator's task.
- `source_site` is **not enum-validated** server-side — `?source_site=bogus` returns **200 with an empty list**, not 422. The frontend's filter is a closed set of three, so this is unreachable from the UI; noted because it means a typo'd filter looks like "no jobs" rather than an error.

---

## R17. Auto-Scrape must never write orchestrator state wholesale

**Decision**: The page calls only the **server-side mutators** — `POST /enable`, `/pause`, `/shutdown`, `/test-cycle`, `/reset-counters`, `/reset-session/{site}` — and `PUT /admin/auto-scrape/config` for settings. It **never calls `PUT /admin/auto-scrape/state`**.

**Rationale**: FR-046 ("MUST NOT write orchestrator state in a way that discards state fields it does not manage"). `PUT /state` is a **whole-object replacement** (`row.state = body.state`, `routers/auto_scrape.py:132`) — it is the service worker's channel for pushing its full state, and any partial write from the frontend silently destroys every unsent key. The mutator endpoints exist precisely so a client can change one thing without owning the whole object. **FR-046 is satisfied by not having the capability**, which is stronger than satisfying it by careful merging.

**Naming, as-built** (consumed verbatim):

| Spec language | Actual route |
|---|---|
| "status" | `GET /admin/auto-scrape/state` — **there is no `/status`** |
| "stop-and-exit" | `POST /shutdown` (sets `exit_requested: true`) |
| "run test cycle" | `POST /test-cycle` (sets `test_cycle_pending: true`) |
| "reset a site session" | `POST /reset-session/{site}` — singular, while the update route is plural `PUT /sessions/{site}` |

**`PUT /admin/auto-scrape/config` is a shallow merge** — top-level keys are replaced wholesale, arrays are not merged element-wise (`_merge_config`, `:72-77`). So editing `keywords` means sending the complete new array. Same `exclude_unset` mechanism as `/config`, so FR-045's dead fields (`run_dedup_after_scrape`, `run_matching_after_dedup`, `run_apply_after_matching`) are preserved by omission, exactly as in R11.

**Validation limits come from the server** (FR-044). `GET /config/limits` returns `{limits: {field: {min, max, recommended}}, derived_limits: {max_keywords: 10, max_scans_per_cycle_hard: 30, max_scans_per_cycle_warn: 15, valid_sites: [...]}}`. Note `valid_sites` is nested **inside `derived_limits`** in the response even though `get_limits()` returns it as a sibling — bind to the response shape, not the function's. The current `ConfigEditor.tsx:33-37` hardcodes `?? 10`, `?? 30`, `?? 12` fallbacks that can silently drift from the server, hardcodes the site list at `:112` while `valid_sites` is fetched and unused, and shows a magic `~{scansPerCycle * 4} min` estimate with no backend basis. All three are dropped — this is the stack-boundary constraint ("the React UI … does not own business logic").

**`scans_per_cycle` is a synthetic field key**, not a config field: `len(sites) × len(keywords) > 30` → a `field_errors` entry; `>= 15` → a **warning** returned in `warnings[]` on a **200**, not an error. So `ConfigUpdateResponse.warnings` must be rendered on success (FR-044: "surfacing warnings and field-level errors before and after save").

**Poll-only**: no push channel reaches this page (R6 — broadcast fires only from `PUT /extension/run-log/{id}`), so FR-047's externally-driven changes arrive via `refetchInterval` alone.

---

## R18. Test strategy

**Decision**: `tsc --noEmit` + `eslint .` are **blocking gates**. Vitest covers **pure logic only**: `lib/format/salary.ts`, `lib/format/remote.ts`, `lib/format/heartbeat.ts`, `lib/api/errors.ts`. No component tests, no DOM tests, no mocked-fetch integration tests.

**Rationale**: The gate is the brief's stated requirement and the thing whose absence let a non-compiling type file ship. The Vitest layer is scoped to exactly the four modules where the API's real traits bite and where a regression is silent rather than loud: annualizing an `HOURLY` salary, rendering `null` remote as "On-site", mis-parsing one of the four error shapes, and mis-grading heartbeat age. These are pure functions — cheap to test, no rendering, no mocking, no test-runner sprawl.

**Explicitly not covered**: component rendering and page behavior. Those are validated by hand via [quickstart.md](./quickstart.md). This is a deliberate ceiling, not an oversight — the four pages' value is in states and wiring, which a jsdom test asserts poorly and a 90-second manual pass asserts well.

**Gate composition**: `npm run verify` = `typecheck && lint && test`. There is **no CI** in this repo (no `.github/`), so `verify` is the gate a human runs. Wiring CI is out of scope and would be its own feature.

**`tsconfig` must actually bite**: `strict: true`, and **`allowJs`/`checkJs` stay absent** — but that alone is what made the old gate vacuous, because the source was `.jsx` and thus invisible. The real enforcement is that `src/` contains **zero `.js`/`.jsx` files**, so nothing can opt out. `tsconfig.node.json` covers `vite.config.ts`/`eslint.config.ts`, which the old single-tsconfig setup left unchecked.

**ESLint must cover TS**: the old flat config scopes to `files: ['**/*.{js,jsx}']` with **no TS parser installed at all**, so the entire auto-scrape feature, the API layer, the types, and the Sidebar were never linted. New config: `typescript-eslint` + `eslint-plugin-react-hooks` over `**/*.{ts,tsx}`. `react-hooks` matters more than usual here given how effect-heavy the replaced code was.

**Known blockers to clear on day one**: `@types/react@^19` and `@types/react-dom@^19` are pinned against `react@^18.3` — a mismatch likely to produce JSX typing errors the moment `tsc` first runs. Pin types to v18 to match the runtime.

---

## R19. Doc/code discrepancies found (code wins)

Recorded per Principle I ("documentation that points at deleted modules… is a fidelity defect and MUST be corrected when discovered"). None of the three affects this frontend's design; all three are backend-doc defects observed while establishing ground truth, and are flagged for a docs pass rather than fixed here (out of scope, and Principle III forbids the drive-by).

| # | Doc claim | Code reality |
|---|---|---|
| 1 | `docs/live-per-source-schemas.md:234` — `matched` is "copied `false` at ingest" | Not in `CANONICAL_COLS` (`core/scraped_job_projection.py:155-175`); the **DB default** supplies `false` (`models/scraped_job.py:93-95`). Same result, different mechanism. The projection module's own comment at `:153-154` is correct; the mapping table above it is stale. |
| 2 | `docs/live-per-source-schemas.md:242` — Indeed `company` "coalesces mosaic then graphql" | Not a falsiness coalesce: `p.get("company") if p.get("company") is not None else p.get("employer_name")` (`projection.py:217`). An **empty-string** mosaic company wins over a populated graphql `employer_name`. Deliberate per the code comment at `:214-216`; the doc's "coalesce" is loose. **Frontend consequence: `company` can legitimately be `""`, not just `null`** — so the FR-051 "field absent" treatment must test emptiness, not just nullishness. |
| 3 | `specs/006-search-only-backend/data-model.md:65-68` — the matching-flavored config keys are left for "future cleanup if desired" | Still present **and still validated** on `PUT /config`. That is the R11 dead-field set. |

`specs/008-unified-scraped-jobs/contracts/api-surface-delta.md` was verified point-by-point against the code and is **accurate** — envelope, limits, ordering, the `dismissed` default, salary string encoding, tri-state `remote`, the 5-value period vocabulary, the two id spaces, and the `GET /jobs/skipped` → 422 note all check out.

**One deletion consequence worth carrying into Logs**: `GET /jobs/skipped` is gone, and that path now falls through to `GET /jobs/{job_id}`, failing UUID parse → **422, not 404**. The old `LogsPage.jsx` calls it, along with `/jobs/reports`, `/dedup/reports`, and `/match/reports` — all deleted. The new Logs page binds `/extension/run-log` **and nothing else** (SC-002).
