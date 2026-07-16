# Quickstart: Search-Only Frontend Redesign

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

Runnable validation for the four pages. Every scenario maps to a Success Criterion or an FR and is verifiable by an operator in a browser.

---

## Prerequisites

**Backend** — unchanged by this feature. Bring the existing stack up:

```bash
docker compose up -d backend postgres redis
curl -s http://localhost:8000/health          # the one unauthenticated route
```

Sanity-check the surface the new Jobs page depends on (delivered by feature 008, not by this work):

```bash
curl -s -H "Authorization: Bearer dev-token" "http://localhost:8000/jobs?limit=1" | head -c 400
# expect: {"items":[…],"total":N,"limit":1,"offset":0}
```

No backend rebuild is needed. This feature touches **zero** backend files — but note that if you *do* change backend source, the image has no source mount and must be rebuilt (`docker compose up -d --build backend`) or the edit is silently ignored.

**CORS** — no change required. `allow_origin_regex` admits any `http://localhost:<port>`, so both 5173 (old app, via compose) and 5174 (new app, during the build) work as-is. LAN IPs and `https://localhost` are **not** admitted — reach the dev server via `localhost`, not a LAN address.

**Frontend** — during the build the new app lives at `web/` and runs on **5174** so the old app on 5173 stays available for reference:

```bash
cd web
npm install
cp .env.example .env        # VITE_API_URL=http://localhost:8000 ; VITE_AUTH_TOKEN=dev-token
npm run dev                 # http://localhost:5174
```

**Data** — several scenarios need real scraped rows and run logs. If `GET /jobs` returns `total: 0`, trigger a scan from the Jobs page and let the Chrome extension collect it. Without the extension running, S5 (bounded wait) is directly testable and S4 is not.

---

## The gate

The gate is the feature's headline deliverable (N2) — the old app had none, which is how a non-compiling type file shipped.

```bash
cd web
npm run verify        # = typecheck && lint && test
```

| Command | Passes when |
|---|---|
| `npm run typecheck` | `tsc --noEmit` is clean over **100%** of `src/`. |
| `npm run lint` | `eslint .` clean over `**/*.{ts,tsx}` with `typescript-eslint` + `react-hooks`. |
| `npm run test` | Vitest green: `lib/format/salary.ts`, `lib/format/remote.ts`, `lib/format/heartbeat.ts`, `lib/api/errors.ts`. |
| `npm run build` | `vite build` succeeds — the old repo never exercised a production build anywhere. |

**Gate assertions** (these are what make it real, not decorative):

```bash
# 1. Zero JS in src/ — the gate is vacuous if source can opt out.
#    (The old tsconfig was strict AND noEmit, yet checked ~700 of 12,235 lines,
#     because the source was .jsx and allowJs was off.)
find web/src -name '*.js' -o -name '*.jsx' | wc -l      # expect 0

# 2. tsc actually runs. Break a type on purpose; `npm run typecheck` must fail.
#    Regression target: types/autoScrape.ts shipped a TS2300 duplicate
#    (consecutive_precheck_failures, declared at lines 18 AND 24) undetected.

# 3. ESLint actually covers TS. The old flat config scoped to files: ['**/*.{js,jsx}']
#    with no TS parser installed at all.
npx eslint --print-config src/pages/JobsPage.tsx | grep -c typescript-eslint   # expect > 0

# 4. One fetch site (FR-010).
grep -rn 'fetch(' web/src --include=*.ts --include=*.tsx | grep -v 'lib/api/client.ts'   # expect no output

# 5. The forbidden routes are absent (FR-030) — see S13.
grep -rn 'extension/pending' web/src        # expect no output
```

---

## Scenario S1 — Shell, navigation, and the removed pages

**Covers**: FR-001–FR-006, SC-001, SC-003, SC-012

| # | Do | Expect |
|---|---|---|
| 1 | Open `/` | Config renders. A horizontal top nav is at the top with exactly four items: Config, Jobs, Logs, Auto-Scrape. **No side rail** — content spans the full width. |
| 2 | Click each nav item | `/`, `/jobs`, `/logs`, `/dashboard/auto-scrape`. Current destination unambiguous. **Any page reaches any other in one click** (SC-003). |
| 3 | Walk every reachable path | **Zero** dedup, matching, skills, or profile surfaces — no page, nav entry, tab, badge, or control (SC-001, FR-004). |
| 4 | Visit `/profile`, `/skills`, `/matching`, `/dedup`, `/search-report`, `/dedup/passed`, `/dedup/removed` | Each lands on "page removed" **naming the four available pages**. **Not a redirect** — a redirect would misrepresent removed functionality as relocated (FR-005). |
| 5 | Visit `/nonsense` | Same not-found state (FR-005). |
| 6 | Resize to **360px**; visit all four | No horizontal scrolling of the page body anywhere. Tables scroll **within their own container** (SC-012, FR-006). |
| 7 | DevTools → Network, on every page | Zero requests to `/profile`, `/skills/*`, `/match/*`, `/dedup/*`, `/jobs/skipped`, `/jobs/reports*` (SC-002). |

---

## Scenario S2 — Jobs: the canonical fields and the API's real traits

**Covers**: FR-022, FR-023, N7, and the three traits that motivated this round

| # | Do | Expect |
|---|---|---|
| 1 | Open `/jobs` | Jobs listed **newest-scraped first** (`scrape_time DESC`), showing title, company, location, source site, posting date, scraped date (FR-022). |
| 2 | Network tab | `GET /jobs?limit=25` plus **three** `GET /jobs?source_site=<site>&limit=1` — 4 requests. The counts are client-derived from each `total`; **no facet endpoint exists** (R3). |
| 3 | Read each source filter | A per-site count is shown (FR-023). The three counts **sum to the unfiltered `total`** — both list and counts omit `dismissed`, so both get the `false` default (R15). |
| 4 | Select the LinkedIn filter | Only LinkedIn jobs; active filter visually unambiguous. |
| 5 | Set a scraped-date range | Combines with the source filter. Request carries **`scraped_from`/`scraped_to`** — **never `date_from`/`date_to`** (those filter `posted_at` against bare-date midnight and would drop nearly the whole end day). |
| 6 | Pick a range ending **today** | Jobs scraped **today** are included — `scraped_to` is whole-day inclusive. This is the assertion that proves the correct param pair is bound. |
| 7 | **Find a job with `remote: null`** (any non-remote Glassdoor job — Glassdoor **never** emits `false`) | Renders **"—"**, **never "On-site"** (R4, FR-051). ⚠️ *The single highest-value check on this page.* |
| 8 | Find a job with `remote: true` / `remote: false` | "Remote" / "On-site". |
| 9 | **Find a job with `salary_period: "HOURLY"` and `salary_min: "55"`** | Renders **`$55/hr`** — not `$55/yr`, not `$114,400`. **Never annualized** (R5). |
| 10 | Find an `ANNUAL` salary | Renders per-year. No `YEARLY` string appears anywhere — it is an input token mapped to `ANNUAL` at ingest and **never stored**. |
| 11 | Find a job with amounts but `salary_period: null` | Amounts render with **no period suffix** (legal: an unrecognized token yields a null period while retaining amounts). |
| 12 | Inspect the filter controls | **No `easy_apply` filter. No `dedup_status` filter.** Neither exists on the backend (N7, FR-004). |
| 13 | Find a job missing `description` or `company` (`company` may be `""` **or** `null` — R19 #2) | The row **still renders**; the field is marked absent, not blank (FR-051). |

---

## Scenario S3 — Jobs: detail

**Covers**: FR-024

| # | Do | Expect |
|---|---|---|
| 1 | Click a job | Detail opens with the **full description**, company, location, posting date. |
| 2 | Click the posting link | Opens `job_url` — the real posting. (The field is `job_url`, not `url`.) |
| 3 | Deep-link to a job, then reload | Renders correctly via `GET /jobs/{id}` using the **canonical** `id` — not `source_row_id`, which is a different id space. |

---

## Scenario S4 — Jobs: scan, live progress, stop

**Covers**: FR-025–FR-029, SC-004, SC-009, SC-011. **Requires the Chrome extension running.**

| # | Do | Expect |
|---|---|---|
| 1 | With no scan running, trigger a scan for one site | Page shows the scan starting; progress begins within **10s** of pickup (FR-025). |
| 2 | Watch during the run | **Pages scanned** and **jobs scraped** update **without a manual refresh** (FR-026). A state change is reflected within **10s** (SC-009). |
| 3 | Network + WS tabs | One WS to `/ws/run-log` **plus** a poll. Both write **one** cache entry — counts never double, display never flickers (R6). |
| 4 | DevTools → WS frames | Each message is a **full run-log object** (no `debug_log`). It is **assigned, not merged** — this is what makes the WS/poll race benign. |
| 5 | Kill the WS (offline toggle, or stop the backend briefly) | Progress **continues via the poll fallback**; the page does not stall (FR-026). Mandatory, not defensive: WS subscribers are an in-process `set()`, so with >1 uvicorn worker a client can miss updates entirely. |
| 6 | While a scan runs, trigger another | **Refuses** with "A scan is already running…" — the `scan_in_progress` 409. Not a silent failure (FR/AS-7, SC-011). |
| 7 | Trigger twice rapidly before pickup | `scan_pending` → "A scan request is already queued…" (retry 3s). |
| 8 | Stop a scan, then immediately trigger | `stop_cooldown` → "A scan just finished. Wait a moment…" (retry 5s). |
| 9 | Compare 6/7/8 | **Three distinct, actionable messages.** Zero generic failures, zero `[object Object]` (SC-011). |
| 10 | Click **Stop** during a run | **Confirmation first** (FR-011 — it fails *all* running run-logs). Then the run reports **stopped** — no permanently "running" indicator (FR-028). |
| 11 | Let a scan finish | The job list **refreshes** to include new jobs; the progress indicator resolves to a terminal state (FR-029). |
| 12 | Trigger "scan all sites" | Sites run in sequence (FR-025). |
| 13 | Fresh operator, no instruction | Can trigger a scan and see progress **within 1 minute** of first opening the app (SC-004). |
| 14 | A just-triggered run | May briefly show the literal **`(setup pending)`** for keyword/location. **Correct** — the backend substitutes it for a blank; it resolves on the next update. |

---

## Scenario S5 — Jobs: the bounded wait (extension NOT running)

**Covers**: FR-027

| # | Do | Expect |
|---|---|---|
| 1 | Stop the extension. Trigger a scan | The trigger **succeeds** (`{"ok": true, "scan_requested": true}` — it returns no run id and returns before any scan starts). |
| 2 | Wait ~60s | The page reports **"the scraper has not responded"** with a retry. It does **not** show "in progress" indefinitely (FR-027). |
| 3 | Note | The wait is a **display timeout only** — nothing cancels the trigger, because nothing can. The command sits in the mailbox until collected. Start the extension and it will still run. |

---

## Scenario S6 — Config

**Covers**: FR-017–FR-021, and the spec's Config edge cases

| # | Do | Expect |
|---|---|---|
| 1 | Open `/` | Current saved settings, grouped so **general** and **per-site** are distinguishable (FR-017). |
| 2 | Inspect every field | **No** `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold` (FR-018). |
| 3 | Edit a field | Form indicates **dirty**; Save available (FR-020). |
| 4 | Edit keyword and location, **without saving**, view the per-site preview | Preview reflects the **unsaved draft** (FR-019). Copy control works. |
| 5 | Save valid changes | Confirmation appears. **Reload → values persisted** (FR-020). |
| 6 | Inspect the `PUT /config` request body | Contains **only the form's fields**. The four dead fields are **absent** — that omission is what preserves them (`exclude_unset` merge, R11). |
| 7 | Verify preservation | Before/after: `curl -s -H "Authorization: Bearer dev-token" localhost:8000/config \| grep -o '"cpu_strong_threshold":[^,]*'` — **unchanged** across a save (FR-018). |
| 8 | Enter a value the backend rejects | The **specific** reason appears on the field; **entered values are preserved**; no partial save implied (FR-021). Exercises the shape-1 plain-string `detail` — the one a FastAPI-array assumption breaks on. |
| 9 | With unsaved changes, click another nav item | **Warned** before losing the edit (FR-020) — via `useBlocker`, which is why the app uses a data router. |
| 10 | Save, and inspect the response handling | The form re-seeds from the **`PUT` response body** (the merged server result), not from the local draft (FR/edge "Concurrent edit"). |
| 11 | **Malformed config**: put invalid JSON in `data/config.json` and reload | Reports **settings could not be read**. Does **not** present an empty form (which would overwrite the file on save). Exercises the unparseable-500 path. |

---

## Scenario S7 — Logs

**Covers**: FR-031–FR-036, SC-010

| # | Do | Expect |
|---|---|---|
| 1 | Open `/logs` | Runs newest-first with status, start time, duration, search keyword/location, and scraped/new/existing counts (FR-031). |
| 2 | **Network tab — the list request** | Carries **`include_debug_log=false`** (FR-035). ⚠️ *Without it, 10 runs × up to 10,000 events ship on page load.* |
| 3 | Filter by status | Only matching runs (FR-032). |
| 4 | Expand a run | Full counts + session error, **in place** — no navigation away (FR-033). There is no per-run GET; this is why. |
| 5 | View a failed run | **Error message and failure reason** shown alongside counts — never a bare "failed" (FR-031/032). |
| 6 | Expand a trace | Events in time order with **relative timestamp (`dt`)**, phase, level, page number. **Error-level events visually distinct** (FR-034). |
| 7 | Network on expand | The trace is fetched **only now**, per run, and cached — collapse/re-expand does **not** refetch (FR-035). |
| 8 | **Expand a run with ~10,000 events** (the ring maximum) | Page stays interactive; **no input blocked > 1s** (SC-010). Verify via a windowed list: DOM row count stays ~40, not 10,000. |
| 9 | Expand a run with no trace | Explicit **"no trace recorded"** — not an empty panel (FR-036). |
| 10 | A trace event with unexpected extra fields | **Still renders** (`DebugEvent` is `extra="allow"`; the panel never switches exhaustively). |
| 11 | No runs at all | Explicit empty state. |

---

## Scenario S8 — Auto-Scrape

**Covers**: FR-037–FR-047

| # | Do | Expect |
|---|---|---|
| 1 | Open `/dashboard/auto-scrape` | Enabled/paused, cycle phase, current cycle number, next-cycle time when scheduled (FR-037). Requests hit **`GET /state`** — there is no `/status` route. |
| 2 | Read heartbeat | Freshness **graded by age** (FR-038). |
| 3 | **Let the heartbeat go stale while `enabled: true`** | Presented as a **warning, visually distinct from a deliberate pause** (FR-038). ⚠️ *A stale heartbeat and a pause must never look the same — this is the check.* |
| 4 | Report a second extension instance (`count > 1`) | **Warned** — concurrent instances corrupt cycle accounting (FR-039). Errors on this call **surface**; they must not degrade to a fabricated `{count: 1}`. |
| 5 | Enable while paused | Enabled state reflected; consecutive-failure counters shown **cleared** — read from the response, not assumed (FR-037). |
| 6 | Pause while enabled | Paused state reflected (FR-040). |
| 7 | Request **stop-and-exit** | **Confirmation first** (FR-011). Then recorded as **pending**, explaining the extension acts **asynchronously** — not claiming an immediate stop (FR-040). Calls `POST /shutdown`. |
| 8 | Request a **test cycle** | Presented as a **request**, not a completed action (FR-040). |
| 9 | View cycle history | Newest-first: cycle **number** (`cycle_id`, not the uuid `id`), start time, status, scan attempted/succeeded/failed (FR-041). |
| 10 | View a failed cycle | **Failure reason** shown — never an unexplained "failed" (FR-041). |
| 11 | A cycle `failed` **with partial results** | Partial results **shown and labeled partial** — not hidden (FR-042). |
| 12 | View session health | Per-site probe status, consecutive failures, backoff; a **per-site reset** control (FR-043). |
| 13 | Reset a site session | **Confirmation first** (FR-011). Then status → **`unknown`**, counters cleared (FR-043). |
| 14 | Edit orchestrator settings | Validated against **`GET /config/limits`** — no hardcoded bounds (FR-044). The site list comes from `derived_limits.valid_sites`. |
| 15 | Set sites × keywords **≥ 15** (e.g. 3 sites × 5 keywords) | Saves with a **warning** from `warnings[]` on a **200** (FR-044 — warnings render on success, not only errors). |
| 16 | Set sites × keywords **> 30** | Rejected with a **field-level** error (shape 3 `field_errors`, 422). |
| 17 | Enter 11 keywords | `"max 10 keywords"` on the field. |
| 18 | Inspect every field | **No** `run_dedup_after_scrape`, `run_matching_after_dedup`, `run_apply_after_matching` (FR-045). Verify preserved across a save, as in S6/7. |
| 19 | **Network tab, across the whole session** | **Zero `PUT /admin/auto-scrape/state`** — a partial write there silently destroys unsent keys. FR-046 is satisfied by never calling it. |
| 20 | Let a background reaper fail a cycle | Reflected on the **next refresh**, no manual reload (FR-047). Poll-only — no push channel reaches this page. |

---

## Scenario S9 — Consistency (the reason the feature exists)

**Covers**: FR-007–FR-011, SC-005–SC-007

| # | Do | Expect |
|---|---|---|
| 1 | Compare loading states on all four pages | **No structural difference** — same placement, structure, tone (SC-005). Same `LoadingState` component. |
| 2 | Compare empty states | Same (SC-005). |
| 3 | Compare error states | Same (SC-005). |
| 4 | `grep -rn 'style={{' web/src \| wc -l` | **0**. (The old tree had 52 across 11 files.) |
| 5 | `find web/src -name '*.module.css' \| wc -l` | **0**. (The old tree had 2,845 lines across 10 modules.) |
| 6 | Search for color/spacing literals outside `components/ui/` and `tailwind.config.ts` | **None** (SC-006, FR-007). |
| 7 | Look at every destructive control (stop scan, stop-and-exit, reset session) | Distinguishable from non-destructive **without reading the label**, and **each requires confirmation** (SC-007, FR-011). |
| 8 | Trigger a background refetch on any page | Rendered content **is not replaced** by a loading state; it updates in place (FR-015). |

---

## Scenario S10 — Backend unreachable

**Covers**: FR-014, SC-008, and the shell's 401 state

**The composition rule under test** (contracts/ui-primitives.md §State components): **all** queries failing with a network error ⇒ **one page-level `ErrorState`**; a **subset** failing, or any **non-network** failure ⇒ **per-query** errors. Scenarios 1 and 5 are the two sides of that rule and must be checked together — passing one while failing the other is the defect.

| # | Do | Expect |
|---|---|---|
| 1 | `docker compose stop backend`. Visit all four pages | Each surfaces a **stated error naming the failure, with retry, within 10s**. **No infinite spinner. No misleading empty state** (SC-008, FR-014). |
| 1a | On Auto-Scrape specifically, with the backend still stopped | **Exactly ONE page-level error** — *not* five stacked "could not reach the backend" cards, one per failed query. All queries failed with `kind: 'network'`, which is one fact and gets one statement. |
| 2 | `docker compose start backend`, click Retry | The page recovers, and **every** failed query refetches — not just one (FR-014). |
| 3 | On Config: enter edits, then stop the backend and save | The error appears and **entered values are preserved** (FR-014). |
| 4 | Set `VITE_AUTH_TOKEN=wrong`, restart the dev server, visit each page | **One consistent "not authorized" state from the shell** — *not* four per-page variants. |
| 5 | With the backend **up**, fail **one** of Auto-Scrape's parallel calls (e.g. block `/cycles` in DevTools) | Only **that section** shows an error; `state` and `sessions` keep rendering. The whole page must **not** blank (FR-015 — the old page's specific bug: one transient 500 on `cycles` hid a healthy `state` until the next 5s tick). |
| 6 | Trigger a **non-network** failure on Auto-Scrape (save an out-of-range config value → 422) | **Per-field error on the field**, never a page-level `ErrorState` — even though a request failed. Specific reasons must survive; collapsing them into one page-level message destroys what FR-016 requires. |

---

## Scenario S11 — Performance

**Covers**: SC-010, SC-013

| # | Do | Expect |
|---|---|---|
| 1 | Load each of the four pages on a normal connection | First meaningful content **< 2s** (SC-013). |
| 2 | Expand a 10,000-event trace | No input blocked **> 1s** (SC-010). See S7/8. |
| 3 | Sit on Jobs for 60s, watch Network | Polling is bounded and does **not** grow. Auto-Scrape does **not** re-fetch `config`/`config/limits` every tick (they are `staleTime: Infinity`; the old page re-fetched 5 endpoints every 5s forever). |
| 4 | Switch to another browser tab for 30s | Background refetching is **paused** (`refetchIntervalInBackground: false`). |

---

## Scenario S12 — The quality-bar port (auto-scrape)

**Covers**: N9, and the "reuse as the quality bar" instruction

| # | Check | Expect |
|---|---|---|
| 1 | `components/auto-scrape/*` file sizes | ~100 lines each; container/presenter split; named exports — **the bar, preserved**. |
| 2 | `<div className="bg-white border rounded-lg p-6 shadow-sm">` | **Gone** — it was repeated verbatim in 5 files; now `<Card>`. |
| 3 | The `SessionHealth` 5-branch color ternary | **Gone** — now `<Badge tone={PROBE_TONE[status]}>`. |
| 4 | **Save fails on the auto-scrape config editor** (send an out-of-range value) | The error is **visible**. ⚠️ *The old `handleSave`/`handleReset` had `try/finally` with **no `catch`** — a failed save was completely silent.* |
| 5 | Hardcoded limit fallbacks (`?? 10`, `?? 30`, `?? 12`) and the `~{n*4} min` estimate | **Gone** — limits come from the server (stack-boundary constraint: the UI does not own business logic). |
| 6 | The 1s cosmetic clock + `<span className="sr-only">{tick}</span>` re-render hack | **Gone.** |
| 7 | `grep -rn 'NEXT_PUBLIC' web/src` | **No output** — dead under Vite (only `VITE_*` is exposed on `import.meta.env`), so the old fallback was always `undefined`. |
| 8 | `find web/src -path '*app/*' -name 'page.tsx'` | **No output** — the Next App Router graft is gone (N6). |
| 9 | `grep -rn 'use client' web/src` | **No output** — the four directives were no-ops with no `next` dep, no `layout.tsx`, no `next.config.*`. |

---

## Scenario S13 — The forbidden routes ⚠️

**Covers**: FR-030. **The highest-consequence check in this document.**

| # | Do | Expect |
|---|---|---|
| 1 | `grep -rn 'extension/pending' web/src` | **No output.** |
| 2 | Exercise **all four pages**, every control, for 2 minutes with DevTools → Network open, filtered to `pending` | **Zero** requests to `/extension/pending`, `/extension/pending-scan`, `/extension/pending-stop`. |
| 3 | Confirm the substitute | Pending-command state is read via **`GET /extension/state`**, which does not consume it. |
| 4 | Confirm the gate holds it | Add a call to a forbidden path in a scratch file → **`npm run lint` fails** (`no-restricted-syntax`). Remove it. |

**Why this matters more than it looks**: these are `GET`s that mutate and commit. One poll **steals the extension's queued command and the scan silently never runs** — no error, no log, nothing to debug. The endpoint looks like a read. The lint rule, not vigilance, is what prevents this.

---

## Scenario S14 — Cutover

**Covers**: R10, N1. **Run last, after `npm run verify` and `npm run build` are green.**

| # | Do | Expect |
|---|---|---|
| 1 | `npm run verify && npm run build` in `web/` | Both green. **Do not proceed otherwise** — the rename removes the old app as a reference. |
| 2 | `git rm -r frontend && git mv web frontend` | One commit. |
| 3 | `git diff --stat -- docker-compose.yml` | **Empty.** Landing at `frontend/` means the bind-mounts (`./frontend/src`, `./frontend/index.html`) and `VITE_API_URL`/`VITE_AUTH_TOKEN` need no edit. |
| 4 | `docker compose up -d --build frontend` | Serves the **new** app on **5173**. |
| 5 | Re-run S1 against `http://localhost:5173` | All four pages work through compose. |
| 6 | `git diff --stat` — backend paths | **Zero** backend files, **zero** migrations, **zero** smoke tests touched. |
| 7 | `docker compose exec backend python -m pytest smoke_test_auto_expiration.py smoke_test_auto_scrape.py smoke_test_matched_claim.py` | **Pass, unmodified** (Constitution Principle II). Run in the container — the host `python` is broken. |

---

## Coverage map

| Success Criterion | Scenario |
|---|---|
| SC-001 four pages, zero removed surfaces | S1.3 |
| SC-002 zero calls to dead capabilities | S1.7 |
| SC-003 any page in one click | S1.2 |
| SC-004 scan + progress within 1 min, no instruction | S4.13 |
| SC-005 identical loading/empty/error | S9.1–3 |
| SC-006 zero one-off color/spacing | S9.4–6 |
| SC-007 destructive distinguishable + confirmed | S9.7 |
| SC-008 unreachable → stated error + retry < 10s | S10.1 |
| SC-009 live progress within 10s | S4.2 |
| SC-010 10k-event trace interactive | S7.8, S11.2 |
| SC-011 three distinct rejection reasons | S4.9 |
| SC-012 usable at 360px | S1.6 |
| SC-013 first content < 2s | S11.1 |

**Requirements**: FR-001–006 → S1 · FR-007–011 → S9 · FR-012–016 → S9.8, S10 · FR-017–021 → S6 · FR-022–030 → S2, S3, S4, S5, S13 · FR-031–036 → S7 · FR-037–047 → S8 · **FR-048–052 → out of scope, delivered by feature 008** (verified by the Prerequisites `curl`).
