# Implementation Plan: Search-Only Frontend Redesign

**Branch**: `007-frontend-redesign` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-frontend-redesign/spec.md`

## Summary

Replace the frontend with a **fresh Vite + React + TypeScript SPA** built in a new folder (`web/`) and cut over from the old one (`frontend/`) in one step. The new app exposes exactly four routes over a horizontal top nav, each bound to exactly one backend surface, and is held to a real quality gate: `tsc --noEmit` over 100% of the source, `typescript-eslint`, and a thin Vitest suite over the pure logic where the API's real traits bite.

**This is now a frontend-only feature.** The backend read capability the spec added as scope (FR-048–FR-052) shipped in **feature 008** — `GET /jobs` already returns canonical merged rows (`source_site`, `title`, `company`, `location_text`, `description`, `posted_at`, `remote`, `salary_min/max/currency/period`, `dismissed`) in a `{items, total, limit, offset}` envelope, with `GET /jobs/{id}` for detail. No backend change, no migration, and no smoke-test change is in scope. CORS already admits any `http://localhost:<port>`, so the new dev server needs no backend edit either.

The rewrite converges four coexisting styling systems (2,845 lines of CSS modules, global CSS, 52 inline `style={{}}` objects, and a Tailwind island) onto **one Tailwind token set**, collapses two duplicated data-access layers plus one ad-hoc WebSocket env read into **one typed client**, and deletes the cosmetic Next.js App Router graft. The existing `components/auto-scrape/*` set is the quality bar for **component decomposition** — ~100 lines/file, container/presenter split, named exports, real empty states — and is explicitly *not* the bar for data fetching, which is its weakest part and is replaced by TanStack Query.

## Technical Context

**Language/Version**: TypeScript 5.7, `strict: true`, target ES2022. Zero `.js`/`.jsx` in `src/` — the gate is meaningless if source can opt out.

**Primary Dependencies**: React 18.3, react-router-dom 6.26 (**data router** — `createBrowserRouter`, required for `useBlocker`/FR-020), `@tanstack/react-query` 5, Tailwind CSS 3.4, Vite 8. Dev: `typescript-eslint`, `eslint-plugin-react-hooks`, Vitest.

**Storage**: N/A — no client-side persistence. All state is server state plus ephemeral form/UI state.

**Testing**: `tsc --noEmit` + `eslint .` (both blocking) + Vitest over pure logic only (salary formatting, tri-state `remote`, error normalization, heartbeat grading). No component/DOM tests. Backend smoke suite is untouched and unaffected.

**Target Platform**: Chrome desktop-first; 360px narrow-viewport floor (SC-012). Single trusted operator, self-hosted.

**Project Type**: Web frontend (SPA) against the existing FastAPI backend. No SSR, no RSC, no Next.js.

**Performance Goals**: First meaningful content < 2s (SC-013); live run state reflected < 10s (SC-009); a 10,000-event debug trace expands without blocking input > 1s (SC-010).

**Constraints**: Bearer token is baked in at build time (`VITE_AUTH_TOKEN`) — unchanged from as-built, no login introduced. Four backend surfaces only. `GET /extension/pending`, `/extension/pending-scan`, `/extension/pending-stop` are **read-once mailboxes** and must never be called (FR-030). Backend returns **four incompatible error shapes** that must be normalized before FR-016 can be satisfied.

**Scale/Scope**: 4 routes, 1 nav, ~7 shared primitives, 3 source sites, ~12,235 lines deleted and replaced by a substantially smaller typed tree.

**Unknowns**: None. Three open decisions were resolved before Phase 0 (see [research.md](./research.md) R1, R10, R18): TanStack Query for server state; build in `web/` and land at `frontend/`; Vitest for pure logic only.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates derived from `.specify/memory/constitution.md` v1.1.0.

| Principle | Verdict | Basis |
|---|---|---|
| **I. As-Built Fidelity** (NON-NEGOTIABLE) | ✅ PASS | This plan is built on a route-by-route read of the live routers and schemas, not on the spec's prose or the docs. [research.md](./research.md) records the backend warts the frontend must absorb rather than fix: four error shapes, no per-site count endpoint, `date_from`/`date_to` midnight truncation, non-deterministic pagination, destructive pending-command GETs, mailbox scan triggering, and Glassdoor never emitting `remote: false`. Three doc/code discrepancies found are named in R19 with **code winning**. The spec's own FR-048–FR-052 framing is corrected here: that capability now exists (feature 008), so describing it as missing would itself be a fidelity defect. |
| **II. Smoke Tests Are the Behavioral Contract** (NON-NEGOTIABLE) | ✅ PASS | No backend behavior changes, so **no smoke test changes** — `smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`, `smoke_test_matched_claim.py` are untouched and must still pass unmodified. The spec's Dependencies note that the new read capability "should acquire smoke-test coverage of its own"; that obligation belonged to feature 008 and is discharged there, not re-opened here. Frontend Vitest tests are additive and are not a substitute for, or an amendment to, the smoke contract. |
| **III. Surgical, Behavior-Preserving Change** | ⚠️ DEVIATION — justified | A full frontend rewrite is neither surgical nor behavior-preserving. It is explicitly spec-backed: the constitution permits exactly this "until an explicit, spec-backed decision says otherwise", and spec 007 is that decision. Recorded in Complexity Tracking below. Crucially the deviation is **contained to `web/` + `frontend/`** — no backend file, migration, or smoke test is touched by this feature. |
| **IV. Migration & Schema Discipline** | ✅ PASS — N/A | No schema change, no Alembic migration, no index. Feature 008 owns the `scraped_jobs` table and its migration chain. |
| **V. Data-Model Invariants** | ✅ PASS | The frontend is **read-only** over both the per-source tables and canonical `scraped_jobs`. It never writes a job row: the only writable canonical field is `dismissed` (via `PUT /jobs/{id}`), and no spec requirement asks for a dismiss control, so the app does not call it. CC-1 (append-only + claim-and-flag + shelf-life) and the derived-row rules are untouched. FR-052 is satisfied vacuously. |
| **VI. Async Background Execution** | ✅ PASS — N/A | Backend concern. No background task, session, or `asyncio` surface is introduced. |
| **VII. Auth Boundary & Forward-Compatible Outputs** | ✅ PASS | Every request carries `Authorization: Bearer <token>` through the single shared client; `/health` is not called. **Forward-compatibility is a live constraint here**: the app performs **no runtime schema validation** — no Zod, no strict parsing — so added backend keys pass through harmlessly. TS interfaces are compile-time only and are deliberately non-exhaustive (`DebugEvent` carries `extra="allow"` server-side; the trace panel renders unknown fields rather than breaking, per FR/Edge-case "trace event carries unexpected extra fields"). |
| **Constraint: stack boundaries — "the React UI triggers and displays, it does not own business logic"** | ✅ PASS, with a fix | Formatting (`remote` tri-state, salary period, heartbeat age) is display, which is the UI's job. The **current** code violates this by hardcoding orchestrator business rules client-side with drifting fallbacks (`ConfigEditor.tsx:33-37`: `?? 10`, `?? 30`, `?? 12`, and a magic `~{n*4} min` estimate) while `GET /config/limits` is fetched and its `valid_sites` ignored. The new Auto-Scrape page reads limits and site lists **from the server** (FR-044). |
| **Constraint: naming / no drive-by renames** | ✅ PASS | Backend field names are consumed verbatim — `job_url` (not `url`), `include_debug_log` (not `include_trace`), `scrape_time`, `location_text`, `POST /shutdown` for stop-and-exit. The known `scrape_run_id`/`scan_run_id`/`runId` inconsistency is documented in [data-model.md](./data-model.md), not renamed. |

**Post-Phase-1 re-evaluation**: Re-checked after design. No new violations. The Phase 1 design introduces no backend call outside the four surfaces, no write to any job row, and no runtime validation that could reject forward-compatible additions. Principle III's deviation is unchanged in scope and remains the only entry in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/007-frontend-redesign/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output — 19 decisions, incl. the as-built traps
├── data-model.md        # Phase 1 output — frontend view models
├── quickstart.md        # Phase 1 output — runnable validation scenarios
├── contracts/           # Phase 1 output
│   ├── backend-bindings.md   # route ↔ page binding; the forbidden routes
│   ├── error-model.md        # the four shapes → one normalized error
│   └── ui-primitives.md      # shared primitive prop contracts
├── checklists/
│   └── requirements.md  # (pre-existing)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

Built at `web/`, landing at `frontend/` on cutover (R10). One directory convention, flat, no route-colocation, no `app/`.

```text
web/                              # NEW — becomes frontend/ at cutover
├── index.html
├── package.json                  # scripts: dev, build, lint, typecheck, test, verify
├── tsconfig.json                 # strict; NO allowJs/checkJs — src is 100% TS
├── tsconfig.node.json            # covers vite.config.ts / eslint.config.ts
├── vite.config.ts
├── tailwind.config.ts            # the single token set lives here (theme.extend)
├── postcss.config.js
├── eslint.config.js              # flat config; typescript-eslint; lints .ts/.tsx
├── Dockerfile
├── .env.example                  # VITE_API_URL, VITE_AUTH_TOKEN  (no NEXT_PUBLIC_*)
└── src/
    ├── main.tsx                  # RouterProvider + QueryClientProvider
    ├── App.tsx                   # shell: <TopNav /> + <Outlet />
    ├── router.tsx                # createBrowserRouter — data router (FR-020 useBlocker)
    ├── index.css                 # @tailwind base/components/utilities + CSS vars
    ├── vite-env.d.ts
    ├── pages/                    # one file per route, thin containers
    │   ├── ConfigPage.tsx        # /                      ↔ /config
    │   ├── JobsPage.tsx          # /jobs                  ↔ /jobs
    │   ├── LogsPage.tsx          # /logs                  ↔ /extension/run-log
    │   ├── AutoScrapePage.tsx    # /dashboard/auto-scrape ↔ /admin/auto-scrape/*
    │   └── NotFoundPage.tsx      # * and every legacy URL (FR-005)
    ├── components/
    │   ├── ui/                   # the shared primitives (FR-008) — the ONLY styling source
    │   │   ├── Button.tsx        #   variant: primary | secondary | destructive (FR-011)
    │   │   ├── Table.tsx
    │   │   ├── Badge.tsx         #   tone: neutral | success | warning | danger
    │   │   ├── Spinner.tsx
    │   │   ├── PageTitle.tsx
    │   │   ├── Card.tsx
    │   │   ├── ConfirmDialog.tsx #   FR-011 confirmation
    │   │   └── states/           # FR-009/012/013/014 — identical across all four pages
    │   │       ├── LoadingState.tsx
    │   │       ├── EmptyState.tsx      # distinguishes no-data vs no-match (FR-013)
    │   │       └── ErrorState.tsx      # states failure + retry (FR-014)
    │   ├── layout/
    │   │   └── TopNav.tsx        # renders NAV_ITEMS; horizontal (FR-002)
    │   ├── config/               # ConfigForm, SearchPreview
    │   ├── jobs/                 # JobsTable, JobDetail, SourceFilter, DateRangeFilter, Pagination, ScanControls, RunProgress
    │   ├── logs/                 # RunList, RunDetail, DebugTracePanel
    │   └── auto-scrape/          # StatusHeader, CurrentCycle, CycleHistory, SessionHealth, ConfigEditor
    ├── lib/
    │   ├── api/                  # the ONE access layer (FR-010)
    │   │   ├── client.ts         # fetch + bearer + normalizeError; the only fetch() in src/
    │   │   ├── errors.ts         # four shapes → ApiError (see contracts/error-model.md)
    │   │   ├── config.ts         # /config
    │   │   ├── jobs.ts           # /jobs
    │   │   ├── runLog.ts         # /extension/run-log  (Foundational — US1 and US4 both need it)
    │   │   ├── scan.ts           # /extension/state, trigger-scan, trigger-stop
    │   │   └── autoScrape.ts     # /admin/auto-scrape/*
    │   ├── format/               # pure, unit-tested (Vitest)
    │   │   ├── salary.ts         # plain-notation strings; NEVER annualize
    │   │   ├── remote.ts         # tri-state; null is NOT "On-site"
    │   │   ├── datetime.ts
    │   │   └── heartbeat.ts      # age grading (FR-038)
    │   ├── tokens/
    │   │   └── semantics.ts      # status → tone maps; never an inline ternary (R9)
    │   └── nav.ts                # NAV_ITEMS — the single source of pages (FR-003)
    ├── hooks/
    │   ├── useJobs.ts / useSourceCounts.ts / useRunLog.ts / useConfig.ts / useAutoScrape.ts
    │   ├── useRunProgress.ts     # WS + poll fallback reconciliation (R6)
    │   ├── useScanTrigger.ts     # trigger + recency correlation + 60s bounded wait (R7)
    │   ├── useRunTrace.ts        # per-run trace, fetched only on expand (FR-035)
    │   └── useUnsavedGuard.ts    # wraps useBlocker (FR-020)
    └── types/                    # hand-written, mirrors backend schemas
        ├── job.ts  ├── config.ts  ├── runLog.ts  └── autoScrape.ts
```

**Structure Decision**: Single flat SPA under `web/src/`, one directory per concern (`pages/`, `components/`, `lib/api/`, `lib/format/`, `hooks/`, `types/`), replacing the old tree's three competing conventions (react-router `pages/*.jsx`, the Next graft at `src/app/(dashboard)/auto-scrape/page.tsx`, and the TS island at `components/auto-scrape/`). `components/ui/` is the sole owner of visual treatment; no page may declare a color or spacing value (SC-006). `lib/api/client.ts` is the sole owner of `fetch` — enforced by an ESLint `no-restricted-globals`/`no-restricted-syntax` rule so a second access layer cannot re-emerge (FR-010).

## Scope Delta

### Requirements: UNCHANGED vs NEW vs DELETED

| Requirements | Status | Notes |
|---|---|---|
| **FR-001 – FR-047** (shell & nav, consistency, state handling, Config, Jobs, Logs, Auto-Scrape) | **UNCHANGED** | All frontend. All in scope, all delivered by this plan. |
| **FR-048 – FR-052** (per-source scrape read capability) | **DELETED from scope** | **Already implemented by feature 008.** Not re-planned, not re-built. Evidence below. |
| Spec §Overview claim: *"real scrape output is written to per-source storage that has no read capability"* | **DELETED (stale)** | True when 007 was drafted; false as of 008. Per Principle I this correction is recorded here rather than left to mislead downstream work. |
| Spec §Dependencies: *"User Story 1 cannot deliver its stated value until FR-048–FR-052 exist"* | **DELETED (resolved)** | The dependency is discharged. User Story 1 is unblocked. |

**FR-048–FR-052 discharge evidence** (verified against live code, not docs):

| FR | Requirement | Delivered by 008 |
|---|---|---|
| FR-048 | Read capability over per-source scrape record, all three sites | `GET /jobs` over canonical `scraped_jobs`, populated by atomic dual-write at ingest (`backend/routers/jobs.py:850`) |
| FR-049 | One common projection: title, company, location, description, URL, posting date, scraped date, source site | `ScrapedJobRead` (`backend/schemas/scraped_job.py:43-95`) — plus `remote`, salary, `apply_url`, `experience_level`, `industry` |
| FR-050 | Newest-scraped-first, filter by site + scraped-date range, per-site counts, pagination, single-job detail | `scrape_time DESC`; `source_site`, `scraped_from`/`scraped_to`; `limit`/`offset` + `total`; `GET /jobs/{id}`. **Per-site counts are the one gap** — no facet endpoint; satisfied client-side (R3) |
| FR-051 | Missing projected field returned explicitly absent, not omitted | Nullable columns serialize as `null`, never dropped |
| FR-052 | Read capability must not mutate scrape records | `GET` handlers are read-only; this frontend additionally never calls `PUT /jobs/{id}` |

### NEW (from this planning round's brief; not in spec.md)

| # | Addition | Why |
|---|---|---|
| **N1** | Fresh Vite + React + TS app in `web/`, cut over from `frontend/` | Spec says "replace the frontend" without saying how. In-place migration would drag the four styling systems and two access layers through every intermediate commit. |
| **N2** | Real quality gate: `tsc --noEmit` over 100% of source + `typescript-eslint` | Today `tsc` **has never run** (no script), ESLint covers `.js/.jsx` **only**, and `allowJs` is off — so TS validates ~700 of 12,235 lines and nothing enforces even that. `types/autoScrape.ts` has shipped a hard TS2300 error (duplicate `consecutive_precheck_failures`, lines 18 and 24) undetected. |
| **N3** | One Tailwind token set in `theme.extend` | Direct mechanism for FR-007/SC-006. Today `theme.extend` is `{}` and `preflight: false` exists solely to stop Tailwind colliding with the CSS modules. |
| **N4** | Shared primitives: button, table, badge, spinner, page title, nav (+ card, confirm dialog, state components) | Direct mechanism for FR-008/FR-009/FR-011. |
| **N5** | One directory convention: `pages/`, `components/`, `lib/api/`, `hooks/`, `types/` | Replaces three competing conventions. |
| **N6** | Delete the Next.js App Router graft | `src/app/(dashboard)/auto-scrape/page.tsx` + 4 no-op `"use client"` directives, with no `next` dep, no `layout.tsx`, no `next.config.*`. Cosmetic — deletable with zero behavior change. |
| **N7** | Jobs binds canonical field names + the API's real traits | `remote` tri-state (`null` ≠ "On-site"), salaries as plain-notation strings never annualized, and no `easy_apply`/`dedup_status` filters. |
| **N8** | Vitest over pure logic only | Guards exactly the N7 traps against regression. No component/DOM tests. |
| **N9** | TanStack Query for server state | Resolves FR-012/014/015 structurally instead of by hand. Replaces 1 WebSocket + ~8 uncoordinated intervals across 3 pages, two of which race on the same state. |

### Files: UNCHANGED vs NEW vs DELETED

**UNCHANGED — nothing.** No file survives byte-for-byte. `components/auto-scrape/*`, `lib/api/autoScrape.ts`, and `types/autoScrape.ts` are **ported, not copied**: structure and decomposition are preserved (that is the quality bar); fetching, styling tokens, and types are rewritten. Called out explicitly so "reuse" is not misread as "move the files".

| Old file | Disposition | Detail |
|---|---|---|
| `components/auto-scrape/{StatusHeader,CurrentCycle,CycleHistory,SessionHealth,ConfigEditor}.tsx` | **PORTED** | Keep: container/presenter split, ~100 lines/file, named exports, per-component empty states, `unknown`-narrowed catches, the `wrap` HOF's `finally` re-enable. Fix: raw Tailwind → tokens; repeated card/button class strings → `<Card>`/`<Button>`; whole-page error gate → per-query `ErrorState`; **silent save failures** (`handleSave`/`handleReset` have `try/finally` with **no `catch`**) → surfaced errors; client-side limit fallbacks → server limits; hardcoded site list → `derived_limits.valid_sites`; drop the 1s cosmetic clock + `<span className="sr-only">{tick}</span>` re-render hack. |
| `lib/api/autoScrape.ts` | **PORTED** | Keep the typed `get<T>/post<T>/put<T>` generic shape. Fold into `lib/api/client.ts`; drop the dead `NEXT_PUBLIC_API_BASE` fallback (Vite only exposes `VITE_*`, so it is always `undefined`); add `AbortController` + normalized errors; stop `fetchAutoScrapeInstances` silently degrading to `{count: 1, instances: []}` on non-OK. |
| `types/autoScrape.ts` | **PORTED + FIXED** | Fix the TS2300 duplicate. Remove the `[key: string]: unknown` escape hatch on `AutoScrapeConfig.config` and the `Record<string, unknown>` write path that discards types, so `ConfigEditor` needs no casts. |
| `src/app/(dashboard)/auto-scrape/page.tsx` | **DELETED** | The graft (N6). Becomes `pages/AutoScrapePage.tsx`. |
| `src/api.js` (504 lines) | **DELETED** | Access layer #1. ~40 methods, untyped, inconsistent error handling — several methods (`getConfig`, `getRunLogs`, `getExtensionState`, …) never check `response.ok`. |
| `src/pages/{Profile,Skills,Matching,Dedup}Page.jsx` + their `.module.css` | **DELETED** | FR-004. Backing endpoints no longer exist. `DedupPage.module.css` (222 lines) is already dead — its page is a 5-line redirect. |
| `src/pages/{Config,Jobs,Logs}Page.jsx` + their `.module.css` | **DELETED** | Rewritten as TSX. 1,166 / 726 / 1,092 lines → decomposed. Note `JobsPage.module.css` (825 lines) is a de-facto shared stylesheet — imported by `LogsPage`, `MatchingPage`, `JobCard`, `JobModal`. |
| `src/components/{DedupSkipBadge,MatchBadge,MatchSkipBadge}.jsx` (+ modules) | **DELETED** | FR-004. |
| `src/components/{JobCard,JobModal,DebugTracePanel,PageTitle,Spinner}.jsx` | **DELETED** | Rebuilt on primitives. `PageTitle`/`Spinner` are entirely inline-styled; `Spinner` depends on a `@keyframes spin` declared in `index.css`. |
| `src/components/layout/Sidebar.tsx` | **DELETED** | TSX but consumes `App.css` globals (`"nav-link active"`). Replaced by `components/layout/TopNav.tsx` driven by `lib/nav.ts` (FR-002/FR-003). |
| `src/App.css`, `src/index.css` | **DELETED** | Global CSS. New `index.css` carries only Tailwind directives + token CSS vars. |
| `src/utils/{fitScoreDisplay,glassdoorUrl,location,runLog,time}.js` | **DELETED** | `fitScoreDisplay` is matching-only (FR-004). The rest are re-implemented as typed pure modules under `lib/format/`. |
| `src/hooks/useScanGrace.js` | **DELETED** | The 15s ref-based grace window exists to paper over WS/poll races; superseded by `useRunProgress` (R6). |
| `src/assets/hero.png` | **DELETED** | No importers. |
| `frontend/` (the whole directory) | **DELETED at cutover** | Replaced by `web/`, which is then renamed to `frontend/`. |
| `web/**` | **NEW** | The tree above. |
| `docker-compose.yml` | **UNCHANGED at cutover** | Bind-mounts `./frontend/src` + `./frontend/index.html` and passes `VITE_API_URL`/`VITE_AUTH_TOKEN`. Because `web/` lands **at** `frontend/` (R10), no compose edit is needed. During the build both apps coexist; `web/` is run on a different port locally. **No backend service, env var, or CORS entry changes.** |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Principle III** — full frontend rewrite rather than surgical, behavior-preserving change | Spec 007 is the explicit, spec-backed decision the constitution requires for exactly this case. The problem *is* the structure: four styling systems with no shared tokens, two access layers plus a third ad-hoc env read, three directory conventions, and four pages calling deleted endpoints. FR-007/008/010 mandate convergence onto one of each — which is a rewrite by definition. | **Incremental in-place migration** was rejected: converging tokens, primitives, the access layer, and the directory convention one page at a time means every intermediate commit carries *both* systems, and `preflight: false` must stay until the last CSS module dies — so the app is never in a consistent state and the gate (N2) cannot be turned on until the end anyway. **Keeping the old app and only fixing the four broken pages** was rejected: it satisfies FR-001/FR-004 but none of FR-007–FR-010, leaving the stated reason the feature exists unaddressed. Blast radius is contained: `web/` + `frontend/` only, zero backend files, zero migrations, zero smoke-test changes. |
