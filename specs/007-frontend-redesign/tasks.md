---
description: "Task list for feature implementation"
---

# Tasks: Search-Only Frontend Redesign

**Input**: Design documents from `/specs/007-frontend-redesign/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Test tasks ARE included, deliberately scoped. Per research R18 (user-confirmed), Vitest covers **pure logic only** — `lib/format/salary.ts`, `lib/format/remote.ts`, `lib/format/heartbeat.ts`, `lib/api/errors.ts`. No component tests, no DOM tests, no mocked-fetch integration tests. Page behavior is validated by hand via `quickstart.md`. These are not TDD-ordered against the whole feature; each test task sits immediately after the module it covers.

**Organization**: Grouped by user story. Story priorities come from spec.md: US1 Jobs (P1), US2 Auto-Scrape (P2), US3 Config (P3), US4 Logs (P4).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 / US4. Setup, Foundational, and Polish tasks have no story label.

## Path Conventions

Frontend-only feature. All paths are under `web/` (which becomes `frontend/` at cutover — T089). **Zero backend files are touched.** Per plan.md's Structure Decision.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold `web/` and stand up the quality gate before any source exists. The gate is the feature's headline deliverable (plan.md N2) — the old app had none, which is how a non-compiling type file shipped.

- [X] T001 Scaffold a fresh Vite + React + TypeScript app in `web/` (`npm create vite@latest web -- --template react-ts`), then delete the template's boilerplate (`src/App.css`, `src/assets/`, demo counter markup)
- [X] T002 Install dependencies in `web/package.json`: `react@^18.3`, `react-dom@^18.3`, `react-router-dom@^6.26`, `@tanstack/react-query@^5`; dev: `typescript@^5.7`, `vite@^8`, `@vitejs/plugin-react`, `tailwindcss@^3.4`, `postcss`, `autoprefixer`, `eslint@^9`, `typescript-eslint`, `eslint-plugin-react-hooks`, `vitest`. **Pin `@types/react` and `@types/react-dom` to `^18` to match the React 18 runtime** — the old app pinned v19 types against React 18.3, a mismatch that produces JSX typing errors the moment `tsc` first runs (research R18)
- [X] T003 [P] Write `web/tsconfig.json`: `strict: true`, `noEmit: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `jsx: react-jsx`, `moduleResolution: bundler`, path alias `@/* → ./src/*`. **Do not add `allowJs` or `checkJs`** — `src/` is 100% TypeScript, so nothing can opt out
- [X] T004 Write `web/tsconfig.node.json` covering `vite.config.ts` and `eslint.config.js`, so the build config is typechecked — the old single-tsconfig setup left it entirely unchecked. **Depends on T003 — not `[P]`: both tasks write `web/tsconfig.json`**. ⚠️ **Implemented without `references`, deliberately**: project references require the referenced project to set `composite: true` (TS6306), and `composite` forbids `noEmit` (TS6310) — a referenced project must be able to emit declarations. This is a **gate, not a build**; nothing may emit, so the two are incompatible (verified empirically on TS 5.7, both variants error). The goal is met instead by `typecheck` running both projects explicitly: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json`. Rationale recorded in `web/tsconfig.json`
- [X] T005 [P] Write `web/vite.config.ts`: react plugin, `@` alias, `server.port: 5174` (5173 stays occupied by the old app via docker-compose during the build — research R10), no proxy
- [X] T006 [P] Write `web/tailwind.config.ts` and `web/postcss.config.js`. **Leave `preflight` ENABLED** — the old config set `preflight: false` solely to stop Tailwind's reset colliding with the CSS modules, which no longer exist (research R9). `theme.extend` is filled in T020
- [X] T007 [P] Write `web/eslint.config.js` (flat): `typescript-eslint` + `eslint-plugin-react-hooks` over `**/*.{ts,tsx}`. **The old config scoped to `**/*.{js,jsx}` with no TS parser installed at all**, so the entire TS island was never linted
- [X] T008 Add two enforcement rules to `web/eslint.config.js`: (a) `no-restricted-syntax` banning `fetch(` outside `src/lib/api/client.ts` (FR-010 — prevents a second access layer re-emerging); (b) `no-restricted-syntax` banning the literal strings `/extension/pending`, `/extension/pending-scan`, `/extension/pending-stop` (FR-030 — see contracts/backend-bindings.md "FORBIDDEN ROUTES"). Depends on T007
- [X] T009 Configure Vitest in `web/vite.config.ts` (`test` block, `environment: 'node'` — no jsdom is needed for pure-logic tests). **Depends on T005 — not `[P]`: both tasks write `web/vite.config.ts`**
- [X] T010 [P] Write `web/.env.example` (`VITE_API_URL=http://localhost:8000`, `VITE_AUTH_TOKEN=dev-token`) and `web/src/vite-env.d.ts` typing `ImportMetaEnv`. **Do not declare `NEXT_PUBLIC_API_BASE`** — Vite only exposes `VITE_*` on `import.meta.env`, so the old fallback was always `undefined` (research R19, dead code)
- [X] T011 [P] Write `web/index.html` (DM Sans link, `#root`, `/src/main.tsx`) and `web/Dockerfile` (mirroring the existing `frontend/Dockerfile` shape)
- [X] T012 Add scripts to `web/package.json`: `dev`, `build` (`vite build`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `verify` (`npm run typecheck && npm run lint && npm run test`). Then prove the gate bites: introduce a deliberate type error and confirm `npm run typecheck` **fails**; introduce a `fetch(` outside the client and confirm `npm run lint` **fails**; revert both. Depends on T003, T008

**Checkpoint**: `npm run verify` runs and is green on an empty source tree; both enforcement rules demonstrably fail on violation.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared shell, tokens, primitives, and the single access layer. Every user story composes these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

**Note on scope**: `lib/api/runLog.ts` and `types/runLog.ts` live here rather than in a story phase because **two stories need them** (US1 polls run-logs for scan progress; US4 lists them) — placing them here keeps both stories independently buildable.

### Types

- [X] T013 [P] Create `web/src/types/job.ts` per data-model.md "Entity: Job": `Job`, `JobsPage`, `SourceSite`, `SalaryPeriod`, `JobFilters`, `SourceCounts`. **`SalaryPeriod` must NOT include `'YEARLY'`** — it is an input token mapped to `ANNUAL` at ingest and is never stored, so a `YEARLY` branch can never execute while `ANNUAL` is silently missed. `remote` is `boolean | null`. `salary_min`/`salary_max` are `string | null`, not numbers
- [X] T014 [P] Create `web/src/types/config.ts` per data-model.md "Entity: Search Configuration": `SearchConfig`, `SearchConfigUpdate`, `ConfigFormState`. **Deliberately omit** `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold` — the omission is the FR-018 mechanism
- [X] T015 [P] Create `web/src/types/runLog.ts` per data-model.md "Entity: Scan Run": `RunLog`, `RunStatus`, `DebugEvent`, `DebugLog`. **`RunLog.status` is typed `string`, not `RunStatus`** — it is a free-text column with no DB constraint and no Pydantic enum. `DebugEvent` **must carry an index signature** (`[key: string]: unknown`) — the server sets `extra="allow"` and the trace panel must render unknown keys. `DebugLog` is `{events: DebugEvent[]}`, an object wrapping the array
- [X] T016 [P] Create `web/src/types/autoScrape.ts` per data-model.md: `AutoScrapeStateRead`, `AutoScrapeState`, `Cycle`, `CycleStatus`, `SiteSession`, `ProbeStatus`, `HeartbeatGrade`, config/limits types. **Declare `consecutive_precheck_failures` exactly ONCE** — the old file declared it at both line 18 and line 24 (TS2300), a real error that shipped because `tsc` never ran. `AutoScrapeState` needs an index signature (free-form JSONB server-side). `cycle_phase` is `string`, not a union (unvalidated server-side)

### Access layer

- [X] T017 Create `web/src/lib/api/errors.ts` per contracts/error-model.md: the `ApiError` interface and `normalizeError()` implementing all 10 rules. **Discriminate `detail` by runtime type** — it is four incompatible shapes. Both obvious approaches fail: assuming FastAPI's `[{loc,msg}]` array breaks every `/config` error (shape 1 is a plain string), and `String(detail)` yields `"[object Object]"` for shapes 3 and 4 — the exact generic failure SC-011 forbids. `message` must ALWAYS be human-readable, including on the unparseable-500 fallback
- [X] T018 Create `web/src/lib/api/errors.test.ts` (Vitest): cover all four wire shapes with real payloads from contracts/error-model.md, plus network failure (`status: 0`), `AbortError` (swallowed, not an error), 401, 404, and the unparseable-500 fallback. **Assert no branch ever produces `"[object Object]"`**. Depends on T017
- [X] T019 Create `web/src/lib/api/client.ts` — **the only `fetch()` in `src/`** (FR-010, enforced by T008). Reads `VITE_API_URL`/`VITE_AUTH_TOKEN`, applies `Authorization: Bearer <token>` to every request, supports `AbortController`, and passes every non-2xx through `normalizeError()` before it escapes. Typed `get<T>/post<T>/put<T>` generics (the one shape worth porting from the old `lib/api/autoScrape.ts`). **No runtime schema validation** — responses are cast, not parsed, so added backend keys pass through (Constitution Principle VII). Depends on T017
- [X] T020 Create `web/src/lib/api/runLog.ts`: `listRunLogs({limit, offset, status, include_debug_log})` → `RunLog[]`. **The response is a bare array — no envelope, no total count.** The param is **`include_debug_log`**, not `include_trace`. Consumed by US1 (progress polling) and US4 (list + trace). Depends on T015, T019

### Tokens and shared format

- [X] T021 Fill `theme.extend` in `web/tailwind.config.ts` with the single token set per contracts/ui-primitives.md: `colors.surface/border/text/accent`, semantic `success/warning/danger/info`, `borderRadius`, `fontFamily.sans` (DM Sans), `fontSize`, `boxShadow`. **Do not re-declare `spacing`** — Tailwind's scale is already a token set; redefining it creates a second one. Write `web/src/index.css` with the `@tailwind` directives and token CSS custom properties. Depends on T006
- [X] T022 [P] Create `web/src/lib/tokens/semantics.ts`: `PROBE_TONE`, `RUN_TONE`, `CYCLE_TONE`, `HEARTBEAT_TONE` maps per contracts/ui-primitives.md. Status→tone lives here, **never as an inline ternary in a component** — this is what replaces the old `SessionHealth.tsx:37-45` 5-branch raw-class ternary. `RUN_TONE` falls back to `neutral` for unrecognized values (free-text column)
- [X] T023 [P] Create `web/src/lib/format/datetime.ts`: absolute and relative timestamp formatting, plus duration (`started_at` → `completed_at`). Pure, typed

### UI primitives

- [X] T024 [P] Create `web/src/components/ui/Button.tsx` per contracts/ui-primitives.md: `variant: 'primary' | 'secondary' | 'destructive'`, `size`, `busy`, `disabled`. `busy` implies `disabled` and re-enable is guaranteed in a `finally`. **`destructive` must be distinguishable without reading the label** (SC-007) — different fill, not just wording. **No `className` escape hatch**
- [X] T025 [P] Create `web/src/components/ui/Badge.tsx`: `tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'`. Callers pass `tone={PROBE_TONE[status]}`, never a raw color
- [X] T026 [P] Create `web/src/components/ui/Spinner.tsx`: `size`, `label` → `aria-label`. Self-contained animation — the old one depended on a `@keyframes spin` declared in a global stylesheet
- [X] T027 [P] Create `web/src/components/ui/PageTitle.tsx`: `title`, `actions`
- [X] T028 [P] Create `web/src/components/ui/Card.tsx`: `title`, `actions`, `children`. Replaces the `<div className="bg-white border rounded-lg p-6 shadow-sm">` string repeated verbatim across five old auto-scrape files
- [X] T029 [P] Create `web/src/components/ui/Table.tsx`: generic `Column<T>[]`, `rows`, `rowKey`, `onRowClick`, `emptyState`. **This component owns the 360px strategy** (FR-006/SC-012): the table scrolls within its own container and the page body never scrolls horizontally. Solving it here means solving it once instead of four times
- [X] T030 [P] Create `web/src/components/ui/ConfirmDialog.tsx`: `open`, `title`, `body`, `confirmLabel`, `tone`, `onConfirm`, `onCancel`. **Never `window.confirm`** — unstyleable and inconsistent with every other surface

### Shared state components

- [X] T031 [P] Create `web/src/components/ui/states/LoadingState.tsx`. Shown while `isPending` (never-resolved), never on background refetch (FR-012/FR-015)
- [X] T032 [P] Create `web/src/components/ui/states/EmptyState.tsx`: `kind: 'no-data' | 'no-match'`, `title`, `body`, `onClearFilters`. **Type-enforce that `kind="no-match"` requires `onClearFilters`** (FR-013) — a discriminated union, so a filtered-empty state without a clear control is a compile error, not a review comment
- [X] T033 Create `web/src/components/ui/states/ErrorState.tsx`: `error: ApiError`, `onRetry` — **`onRetry` non-optional** (FR-014), so a retry-less error state cannot be written. Renders `error.message`, which is always safe to render. **Implement the composition rule** (contracts/ui-primitives.md §State components, rule 5a): support both a page-level and a per-section presentation, discriminated by `kind === 'network'` — **all** of a page's queries failing with a network error ⇒ **one** page-level `ErrorState` whose retry refetches every failed query; a **subset** failing, or any **non-network** failure (422/409/404/500) ⇒ **per-query**, scoped to its section. Validation errors surface as `fieldErrors` on the field and never render an `ErrorState` at all. Depends on T017

### Shell and routing

- [X] T034 Create `web/src/lib/nav.ts` exporting `NAV_ITEMS` — the four entries per data-model.md "Cross-cutting: navigation". **This one array is the sole source of both the nav and the routes** (FR-003), so drift is structurally impossible. FR-001 becomes a property of its length; FR-004 a property of its contents
- [X] T035 Create `web/src/components/layout/TopNav.tsx` rendering `NAV_ITEMS`: horizontal, top, current destination unambiguous, **no side rail** — page content retains full viewport width (FR-002). Depends on T034
- [X] T036 [P] Create `web/src/pages/NotFoundPage.tsx`: the "page removed / not found" state **naming the four available pages** (FR-005). Serves every legacy URL (`/profile`, `/skills`, `/matching`, `/dedup`, `/search-report`, `/dedup/passed`, `/dedup/removed`) and any unknown URL. **No redirects** — the spec is explicit that a redirect would misrepresent removed functionality as relocated
- [X] T037 Create `web/src/router.tsx` using **`createBrowserRouter`** — a **data router is mandatory**, not stylistic: `useBlocker` (FR-020, T038) does not work under `<BrowserRouter>` and throws. Build routes from `NAV_ITEMS` with temporary stub page components, plus the `*` → `NotFoundPage` route. Depends on T034, T036
- [X] T038 Create `web/src/hooks/useUnsavedGuard.ts` wrapping `useBlocker` + `ConfirmDialog` (FR-020). Depends on T030, T037
- [X] T039 ⚠️ **PARTIAL** — Create `web/src/App.tsx`: the shell — `<TopNav />` + `<Outlet />` — and the **single app-wide "not authorized" state** for `kind === 'unauthorized'`, so 401 is handled once rather than as four per-page variants. Depends on T033, T035. **Done**: the shell itself (full-width, no side rail, FR-002) — built early so `npm run dev` serves something. **Remaining**: the 401 state, which needs `ApiError` (T017) and `ErrorState` (T033). A `TODO(T039)` marks the spot in `App.tsx`. Leave unchecked until the 401 state lands
- [X] T040 Create `web/src/main.tsx`: `QueryClientProvider` + `RouterProvider`. Configure the `QueryClient` defaults: `retry`, `refetchIntervalInBackground: false` (pause polling on hidden tabs), and `placeholderData: keepPreviousData` as the standing answer to FR-015. Depends on T037, T039
- [X] T041 Run `npm run verify` and `npm run dev`; confirm the shell renders, all four nav links route to stubs, legacy URLs land on NotFound, and the gate is green. Depends on T040

**Checkpoint**: Shell, nav, tokens, primitives, and the single access layer are in place. User stories can now proceed in parallel.

---

## Phase 3: User Story 1 - Browse scraped jobs and run a scan (Priority: P1) 🎯 MVP

**Goal**: The operator opens Jobs, filters by source site and scraped-date, opens a job to read its full description, clicks through to the live posting, triggers a scan, watches progress advance in real time, and stops a misbehaving scan.

**Independent Test**: With only this page and the shared shell built, open `/jobs`, filter the list, open a job, trigger a scan, watch progress to completion, and stop a scan mid-run — the complete "collect and review jobs" loop with no other page present. Full script: quickstart.md S2, S3, S4, S5, S13.

**Note**: This story reads the canonical `GET /jobs` delivered by **feature 008**. FR-048–FR-052 are out of scope (plan.md Scope Delta) — verify the surface with the quickstart.md Prerequisites `curl` before starting.

### Pure logic + tests for User Story 1

- [X] T042 [P] [US1] Create `web/src/lib/format/remote.ts`: map `boolean | null` → `'Remote' | 'On-site' | '—'`. **`null` must NEVER render "On-site"** (FR-051, research R4). `null` means the site did not say, which is not the claim that the job is on-site
- [X] T043 [P] [US1] Create `web/src/lib/format/remote.test.ts`: assert `true → 'Remote'`, `false → 'On-site'`, and **`null → '—'`**. This is not hypothetical: **Glassdoor never emits `false`** (`projection.py:245` returns `True` or `None`), so a naive `remote ? 'Remote' : 'On-site'` mislabels *every non-remote Glassdoor job* "On-site" on no evidence. Depends on T042
- [X] T044 [P] [US1] Create `web/src/lib/format/salary.ts` per research R5: parse the plain-notation **strings** with `Number()`, render min-only (`From $55/hr`), max-only (`Up to $80/hr`), both (`$55–$80/hr`), neither (`—`). **NEVER annualize or convert between periods.** A `null` period with amounts present renders amounts with no suffix. Absent currency renders the bare number — do not assume USD
- [X] T045 [P] [US1] Create `web/src/lib/format/salary.test.ts`: **assert `{salary_min: "55", salary_period: "HOURLY"}` renders `$55/hr` — not `$55/yr`, not `$114,400`**. Assert plain-notation parsing (`"120000"`, never `"1.2E+5"` — a backend `field_serializer` guarantees this precisely because asyncpg would otherwise emit scientific notation). Assert the null-period and null-currency paths. Depends on T044

### Implementation for User Story 1

- [X] T046 [US1] Create `web/src/lib/api/jobs.ts`: `listJobs(filters)` → `JobsPage`, `getJob(id)` → `Job`. **Bind `scraped_from`/`scraped_to`, NOT `date_from`/`date_to`** — the latter compare `posted_at` (a timestamptz) against bare-date midnight, so `date_to=2026-07-15` excludes nearly all of that day (research R16). **Never send `dismissed`** — omitted means `dismissed == false`, which is the wanted behavior, and no value returns both (R15). `getJob` takes the **canonical `id`**, not `source_row_id`. Depends on T013, T019
- [X] T047 [US1] Create `web/src/lib/api/scan.ts`: `triggerScan({website, scan_all, ...})`, `triggerStop()`, `getExtensionState()`. **Always send an explicit body to `trigger-scan`** — omitting it clears all four state fields server-side (`extension.py:156-160`). **`GET /extension/state` is the non-consuming read** of `scan_requested`/`stop_requested`; the `/extension/pending*` routes are forbidden (FR-030, enforced by T008). Depends on T019
- [X] T048 [P] [US1] Create `web/src/hooks/useJobs.ts`: TanStack Query over `listJobs`, `placeholderData: keepPreviousData` (FR-015), page size 25, `limit` capped at 500. Depends on T046
- [X] T049 [P] [US1] Create `web/src/hooks/useSourceCounts.ts`: **three parallel `listJobs({source_site, limit: 1})` reading `total`** — there is no facet endpoint (FR-023, research R3). `limit: 1` because `limit=0` is a 422. The count queries must carry the **same `dismissed` state as the list** (both omit it) or the counts won't sum to `total`. Depends on T046
- [X] T050 [US1] Create `web/src/hooks/useRunProgress.ts` per research R6: **one WebSocket plus a poll, writing ONE cache entry**. WS at `/ws/run-log`, authenticated via **subprotocol** `["bearer", token]` (not a header or query token) — the server requires `subprotocols[0] === "bearer"`. **Inspect the close code: 1008 means auth rejection — stop retrying**; anything else gets exponential backoff with jitter and a cap. WS payloads are a full `RunLog` minus `debug_log` and are **assigned, never merged additively** (this is what makes last-write-wins safe and prevents duplicated counts). The poll (`refetchInterval: 3000`, well inside SC-009's 10s) is **mandatory, not defensive**: WS subscribers are an in-process `set()`, so with >1 uvicorn worker a client misses updates entirely. Depends on T020, T047
- [X] T051 [US1] Create `web/src/hooks/useScanTrigger.ts` per research R7: mutation over `triggerScan`. **Correlation is by recency only** — the trigger returns no run id and returns before any scan starts. Poll `listRunLogs({limit: 1, include_debug_log: false})`; the first run with `started_at` after the trigger instant is the run. **Bounded 60s wait** (FR-027), then the "scraper has not responded" state — a display timeout only; nothing cancels the trigger because nothing can. Map the three 409 `reason` values to the three distinct messages in contracts/error-model.md, each quoting `retryAfterMs` (SC-011). Depends on T020, T047
- [X] T052 [P] [US1] Create `web/src/components/jobs/SourceFilter.tsx`: the three sites with per-site counts, active filter visually unambiguous. Closed set of three — `source_site` is not enum-validated server-side, so a typo would silently return 200-empty rather than an error. Depends on T025, T049
- [X] T053 [P] [US1] Create `web/src/components/jobs/DateRangeFilter.tsx`: scraped-date range, combinable with the source filter. `scraped_to` is whole-day inclusive server-side. Depends on T046
- [X] T053a [P] [US1] Create `web/src/components/jobs/Pagination.tsx`: prev/next controls plus a range display (`showing X–Y of {total}`), driven by `total`/`limit`/`offset` from the `GET /jobs` envelope. FR-023 requires pagination; `limit` is capped at 500 server-side and `limit=0` is a 422. Disable prev at `offset === 0` and next at `offset + limit >= total`. **Record R16's caveat in a comment**: `GET /jobs` orders by `scrape_time DESC` with **no tiebreaker**, and a batch ingest writes many rows inside one transaction sharing a `scrape_time` — so offset pagination can **drop or repeat a row across a page boundary** on ties. This is a rare cosmetic anomaly at 25/page, not a correctness failure for the operator's task, and it is **absorbed, not fixed, here**: the proper fix is a one-line backend change adding `id` as a secondary sort key, which is out of scope for a frontend-only feature and belongs to a later backend change. Depends on T046, T048
- [X] T054 [P] [US1] Create `web/src/components/jobs/JobsTable.tsx` on `<Table>`: title, company, location, source site, posting date, scraped date, remote, salary — newest-scraped first (FR-022). Uses `formatRemote` and `formatSalary`. **A row with a missing `description`/`company` still renders with the field marked absent** — and `company` may be `""` as well as `null` (research R19 #2), so test emptiness, not just nullishness. Both empty states (FR-013): `no-data` ("run a scan") vs `no-match` (+ clear filters). Depends on T029, T032, T042, T044
- [X] T055 [P] [US1] Create `web/src/components/jobs/JobDetail.tsx`: full description, company, location, posting date, and a working link to `job_url` (FR-024 — the field is `job_url`, not `url`). Renders from the list row (`description` is inline in the list response); `getJob` backs deep-link/reload. Depends on T028, T046
- [X] T056 [P] [US1] Create `web/src/components/jobs/RunProgress.tsx`: status, pages scanned, jobs scraped, updating without operator action (FR-026). Resolves to a terminal state (FR-028/029). Renders the bounded-wait state (FR-027) and the literal **`(setup pending)`** keyword/location as-is when present — that is real backend behavior for a just-started run and resolves on the next update. Depends on T025, T050
- [X] T057 [US1] Create `web/src/components/jobs/ScanControls.tsx`: per-site trigger + sequential "scan all" (FR-025), and a **Stop control gated by `ConfirmDialog`** (FR-011 — `trigger-stop` immediately marks *all* running run-logs failed). Renders the three distinct rejection messages (SC-011). Depends on T024, T030, T051
- [X] T058 [US1] Create `web/src/pages/JobsPage.tsx` composing the above; wire it into `router.tsx`, replacing the stub. Container/presenter split, ~100 lines — the stated quality bar. Refreshes the list when a run reaches a terminal state (FR-029). Depends on T037, T052, T053, T053a, T054–T057
- [X] T059 [US1] Validate US1 against quickstart.md S2, S3, S4, S5, and **S13 (forbidden routes)**. Run `npm run verify`. Confirm via DevTools: 4 requests on load (1 list + 3 counts), zero requests to `/extension/pending*`, and `scraped_from`/`scraped_to` on the wire — never `date_from`/`date_to`. Page forward and back and confirm `offset` advances by `limit` and the range display matches `total` (FR-023). Depends on T058

**Checkpoint**: US1 is fully functional and independently testable. **This is the MVP.** Note `/` (Config) is still a stub at this point — expected.

---

## Phase 4: User Story 2 - Operate the auto-scrape orchestrator (Priority: P2)

**Goal**: The operator sees whether unattended scraping is running, whether the extension is alive, and whether each site's session is good; enables/pauses the loop, runs a test cycle, reviews cycles, and resets an expired site session.

**Independent Test**: Open `/dashboard/auto-scrape`, confirm enabled/paused state and heartbeat freshness, enable and pause the loop, request a test cycle, read cycle history, and reset a site session. Full script: quickstart.md S8, S12.

**Note**: The old `components/auto-scrape/*` is the **quality bar for decomposition** — ~100 lines/file, container/presenter split, named exports, real per-component empty states. It is explicitly **not** the bar for fetching, error handling, or styling (plan.md Scope Delta marks these PORTED, not UNCHANGED).

### Pure logic + tests for User Story 2

- [X] T060 [P] [US2] Create `web/src/lib/format/heartbeat.ts`: `last_sw_heartbeat_at` → `HeartbeatGrade` (`fresh | aging | stale | never`) with age thresholds
- [X] T061 [P] [US2] Create `web/src/lib/format/heartbeat.test.ts`: assert each grade boundary and the `null` → `never` path. Depends on T060

### Implementation for User Story 2

- [X] T062 [US2] Create `web/src/lib/api/autoScrape.ts` binding **only** the routes marked ✅ in contracts/backend-bindings.md Surface 4: `GET /state`, `/instances`, `/config`, `/config/limits`, `/cycles`, `PUT /config`, `POST /config/reset`, `/enable`, `/pause`, `/shutdown`, `/test-cycle`, `/reset-counters`, `/reset-session/{site}`, `GET /sessions`. **`PUT /state` must NOT be bound** — it is a whole-object replace that silently destroys unsent keys; FR-046 is satisfied by not having the capability (research R17). Note the status surface is **`GET /state`** — there is no `/status` route. Normalize `next_cycle_at`'s polymorphic unscheduled sentinel (`0` | `"0"` | `null`). Depends on T016, T019
- [X] T063 [US2] Create `web/src/hooks/useAutoScrape.ts`: one query per surface (**not** one `Promise.all` — a failed `cycles` fetch must not blank a healthy `state`). `refetchInterval: 5000` on `state`/`cycles`/`sessions`; **`staleTime: Infinity` on `config` and `config/limits`** — they change only via our own mutations, which invalidate them (the old page re-fetched all five every 5s forever). `instances` on a 30s interval. **Errors surface** — do not copy the old silent degrade to `{count: 1, instances: []}`, which fabricates the healthy answer and defeats FR-039. **Apply the composition rule** (T033): expose an aggregate that reports whether **all** queries failed with `kind: 'network'` (→ the page renders ONE page-level `ErrorState`) versus a subset or non-network failure (→ per-section errors). This page has five queries and is the rule's hardest case — it is both the FR-015 anti-pattern's origin and the spec's "page-level error state" case, depending on how many failed. Poll-only: no push channel reaches this page. Depends on T033, T062
- [X] T064 [P] [US2] Create `web/src/components/auto-scrape/StatusHeader.tsx`: enabled/paused, cycle phase, cycle number, next-cycle time (FR-037); heartbeat graded by age (FR-038); multi-instance warning when `count > 1` (FR-039). **A stale heartbeat and a deliberate pause MUST NOT look the same** — `danger` vs `neutral` tone via `HEARTBEAT_TONE`; `enabled: true` + `stale` is the alarming combination. **Drop the old 1s cosmetic clock and its `<span className="sr-only">{tick}</span>` re-render hack.** Depends on T025, T028, T060, T063
- [X] T065 [P] [US2] Create `web/src/components/auto-scrape/CurrentCycle.tsx`: current cycle phase and counts; explicit "no active cycle" empty state. Depends on T028, T032, T063
- [X] T066 [P] [US2] Create `web/src/components/auto-scrape/CycleHistory.tsx` on `<Table>`: newest-first with **`cycle_id`** (the human-facing number, not the uuid `id`), start time, status, scan attempted/succeeded/failed (FR-041). **Failure reason shown — never a bare "failed"** (FR-041). **Partial results shown and labeled partial** when a cycle failed after producing some (FR-042) — not hidden. `dedup_task_id` is always null and is not displayed (FR-004). Explicit "no cycles yet" empty state. Depends on T022, T029, T032, T063
- [X] T067 [P] [US2] Create `web/src/components/auto-scrape/SessionHealth.tsx`: per-site probe status, consecutive failures, backoff, with a per-site reset gated by `ConfirmDialog` (FR-043, FR-011). **Use `<Badge tone={PROBE_TONE[s.last_probe_status]}>`** — this one line replaces the old 5-branch raw-class ternary. Re-read the reset response rather than assuming state (status → `unknown`, counters cleared). `site` is the primary key; there is no `id` field. Depends on T022, T025, T030, T063
- [X] T068 [US2] Create `web/src/components/auto-scrape/ConfigEditor.tsx`: **validate against `GET /config/limits`** (FR-044). **Delete the old hardcoded fallbacks** (`?? 10`, `?? 30`, `?? 12`) and the magic `~{n*4} min` estimate — the UI does not own business logic (constitution stack boundary). **Read the site list from `derived_limits.valid_sites`** (the old code fetched it and hardcoded the list anyway). `valid_sites` is nested **inside `derived_limits`** in the response. **Render `warnings[]` on a 200** — `sites × keywords >= 15` is a warning on success, `> 30` is a `field_errors` 422 (FR-044). **Every mutation must `catch` and surface the error** — the old `handleSave`/`handleReset` had `try/finally` with no `catch`, so a failed save was completely silent. **Hide and never send** `run_dedup_after_scrape`, `run_matching_after_dedup`, `run_apply_after_matching` (FR-045 — omission preserves them via `exclude_unset`). Editing `keywords` sends the complete array (shallow merge replaces top-level keys wholesale). Depends on T024, T033, T063
- [X] T069 [US2] Create `web/src/pages/AutoScrapePage.tsx` composing the above; wire into `router.tsx`, replacing the stub. Present enable/pause/stop-and-exit/test-cycle as **requests the extension acts on asynchronously**, not completed actions (FR-040); **stop-and-exit (`POST /shutdown`) gated by `ConfirmDialog`** (FR-011). Depends on T037, T064–T068
- [X] T070 [US2] Validate US2 against quickstart.md S8 and S12. Run `npm run verify`. Confirm via DevTools: **zero `PUT /admin/auto-scrape/state`** across the whole session (FR-046). Depends on T069

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Edit search settings (Priority: P3)

**Goal**: The operator changes what the scraper searches for, previews the per-site search URL, saves, and gets unambiguous confirmation or a clear rejection reason.

**Independent Test**: Open `/`, change a setting, save, reload, confirm it persisted; submit an invalid value and confirm the error is explained and the form is not silently reset. Full script: quickstart.md S6.

### Implementation for User Story 3

- [X] T071 [US3] Create `web/src/lib/api/config.ts`: `getConfig()`, `updateConfig(partial)`. **`PUT /config` is a partial merge** (`exclude_unset`) and returns the **full merged config**. **Send only the form's fields** — the four dead fields are never sent, which is precisely how FR-018 preserves them, and is strictly safer than round-tripping (which would re-submit them through `_validate_scoring_config` and could reject a file already on disk). Depends on T014, T019
- [X] T072 [US3] Create `web/src/hooks/useConfig.ts`: query + mutation. **On success, re-seed both `saved` and `draft` from the PUT response body** — the merged server result, never the local draft (spec's "Concurrent edit" edge case). On rejection, populate `fieldErrors` and **retain `draft` untouched** (FR-021). Depends on T071
- [X] T073 [P] [US3] Create `web/src/components/config/SearchPreview.tsx`: the per-site search preview, **rendered from `draft` (unsaved form state), not `saved`** (FR-019), with a copy control. Depends on T024, T072
- [X] T074 [P] [US3] Create `web/src/components/config/ConfigForm.tsx`: fields grouped into general vs per-site (LinkedIn / Indeed / Glassdoor) per data-model.md (FR-017). **Omit the four dead fields entirely** (FR-018). Dirty indicator + Save (FR-020). Field-level errors from `ApiError.fieldErrors` (FR-021) — note `/config` returns the **plain-string** `detail` shape, which is why the normalizer's runtime discrimination matters here. Depends on T024, T033, T038, T072
- [X] T075 [US3] Create `web/src/pages/ConfigPage.tsx` composing the above; wire into `router.tsx` at `/`, replacing the stub. **Malformed config (500) must report "settings could not be read" and NOT render an empty form** — an empty form would overwrite the file on save. Wire `useUnsavedGuard` for FR-020. Depends on T037, T073, T074
- [X] T076 [US3] Validate US3 against quickstart.md S6. Run `npm run verify`. Confirm the `PUT /config` body contains **only** the form's fields, and verify preservation via the S6.7 `curl` before/after. Depends on T075

**Checkpoint**: US1, US2, and US3 all work independently.

---

## Phase 6: User Story 4 - Inspect run logs and debug traces (Priority: P4)

**Goal**: The operator scans recent runs with outcome and counts, expands one for detail, and expands further into its debug trace to diagnose a failure.

**Independent Test**: Open `/logs`, read the run list, expand a run for counts and error, expand its trace to inspect events. Full script: quickstart.md S7.

### Implementation for User Story 4

- [X] T077 [US4] Create `web/src/hooks/useRunLog.ts`: list query over `listRunLogs`, **always with `include_debug_log: false`** (FR-035). Traces are a 10,000-event ring returned **inline and included by default** — a default list of 10 runs can carry 100,000 events. Page by `limit`/`offset` and stop on a short page: **the response is a bare array with no total count**, so no "page N of M" is possible. Status filter (FR-032). Depends on T020
- [X] T078 [US4] Create `web/src/hooks/useRunTrace.ts`: fetch one run's trace **only on expand**, via a filtered `listRunLogs` call — **there is no `GET /extension/run-log/{id}`**, which is exactly why FR-033 is expand-in-place rather than a detail route. Key and cache per run id so collapse/re-expand does not refetch (FR-035). Depends on T020
- [X] T079 [P] [US4] Create `web/src/components/logs/DebugTracePanel.tsx`: a **windowed list** (fixed row height, `content-visibility: auto`, render only the visible slice + overscan — no virtualization library) so a 10,000-event trace keeps the page interactive with no input blocked >1s (SC-010, research R13). Events in time order with **relative timestamp `dt`** (not `t`), phase, level, page number; **error-level events visually distinct** (FR-034). **Render unknown extra keys** rather than switching exhaustively — `DebugEvent` is `extra="allow"` server-side. Read events from `debug_log.events` (an object wrapping the array). Explicit **"no trace recorded"** state (FR-036) — not an empty panel. Depends on T022, T032, T078
- [X] T080 [P] [US4] Create `web/src/components/logs/RunDetail.tsx`: full counts, session error, and **error message + failure reason for failed runs** — never a bare "failed" (FR-033). Depends on T028, T077
- [X] T081 [US4] Create `web/src/components/logs/RunList.tsx` on `<Table>`: newest-first with status, start time, duration, search keyword/location, scraped/new/existing counts (FR-031). **Expand in place** (FR-033). Status tone via `RUN_TONE` with a `neutral` fallback — the column is free text. Both empty states (FR-013). Depends on T022, T029, T032, T077, T079, T080
- [X] T082 [US4] Create `web/src/pages/LogsPage.tsx` composing the above; wire into `router.tsx`, replacing the stub. **Binds `/extension/run-log` and nothing else** — the old page also called `/jobs/skipped`, `/jobs/reports`, `/dedup/reports`, and `/match/reports`, all now deleted (SC-002). Depends on T037, T081
- [X] T083 [US4] Validate US4 against quickstart.md S7. Run `npm run verify`. Confirm via DevTools that the list request carries `include_debug_log=false` and that expanding a ~10,000-event trace keeps the DOM row count at ~40. Depends on T082

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish, Cross-Cutting Concerns & Cutover

**Purpose**: Verify the cross-cutting criteria that no single story owns, then cut over.

- [X] T084 [P] Narrow-viewport pass at **360px** across all four pages (quickstart.md S1.6, SC-012, FR-006): no horizontal scrolling of the page body; tables scroll within their own containers
- [X] T085 [P] Consistency audit (quickstart.md S9, SC-005/006/007): compare loading/empty/error states across all four pages for structural identity; `grep -rn 'style={{' web/src | wc -l` → **0**; `find web/src -name '*.module.css' | wc -l` → **0**; no color/spacing literals outside `components/ui/` and `tailwind.config.ts`; every destructive control distinguishable without reading its label and gated by confirmation
- [X] T086 [P] Performance pass (quickstart.md S11, SC-010/013): first meaningful content <2s on all four pages; 10k-event trace keeps input unblocked; polling bounded and paused on hidden tabs; `config`/`config/limits` not re-fetched per tick
- [X] T087 [P] Legacy-cleanliness audit (quickstart.md S12.7–9): `grep -rn 'NEXT_PUBLIC' web/src` → none; `find web/src -path '*app/*' -name 'page.tsx'` → none; `grep -rn 'use client' web/src` → none
- [X] T088 [P] Write `web/README.md`: dev/build/verify commands, the `VITE_API_URL`/`VITE_AUTH_TOKEN` **build-time** baking caveat (the token ships in the bundle — unchanged from as-built), and the four route↔surface bindings
- [X] T089 Run the **full** quickstart.md end to end (S1–S13), including S10 (backend unreachable → stated error + retry within 10s on 100% of pages) and S13 (forbidden routes). Depends on T059, T070, T076, T083
- [X] T090 Confirm `npm run verify` **and** `npm run build` are both green in `web/`. The old repo never exercised a production build anywhere — its Dockerfile runs `npm run dev`. Depends on T089

### Cutover (run last — it removes the old app as a reference)

- [ ] T091 **CUTOVER**: `git rm -r frontend && git mv web frontend` in one commit (research R10). **Only proceed once T090 is green.** Update the port in `frontend/vite.config.ts` from 5174 back to **5173** to match the compose-published port
- [ ] T092 Confirm `git diff --stat -- docker-compose.yml` is **empty** — landing at `frontend/` means the bind-mounts (`./frontend/src`, `./frontend/index.html`) and `VITE_API_URL`/`VITE_AUTH_TOKEN` need no edit. Then `docker compose up -d --build frontend` and re-run quickstart.md S1 against `http://localhost:5173`. Depends on T091
- [ ] T093 Confirm the blast radius: `git diff --stat` against the merge base shows **zero backend files, zero migrations, zero smoke tests** touched (plan.md Complexity Tracking). Then run the smoke suite unmodified — `docker compose exec backend python -m pytest smoke_test_auto_expiration.py smoke_test_auto_scrape.py smoke_test_matched_claim.py` — and confirm it passes (Constitution Principle II). **Run inside the container**; the host `python` is broken. Depends on T092

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **User Stories (Phases 3–6)**: All depend on Foundational only. No story depends on another
- **Polish & Cutover (Phase 7)**: Depends on all four stories

### User Story Dependencies

- **US1 Jobs (P1)**: Starts after Phase 2. No dependencies on other stories. 🎯 MVP
- **US2 Auto-Scrape (P2)**: Starts after Phase 2. Independent of US1
- **US3 Config (P3)**: Starts after Phase 2. Independent
- **US4 Logs (P4)**: Starts after Phase 2. Independent — `lib/api/runLog.ts` is Foundational (T020) precisely so US4 does not depend on US1

**No cross-story file conflicts.** Each story owns its own `lib/api/*`, `hooks/*`, `components/<story>/*`, and page file. The only shared writes are `router.tsx` (each story replaces its own stub — a one-line change) and `tailwind.config.ts` (frozen after T021).

### Within Each User Story

Pure logic + its tests → API module → hooks → components → page → validate.

### Parallel Opportunities

- Phase 1: T003, T005–T007, T010–T011 in parallel. **T004 and T009 are NOT parallel** — T004 writes `tsconfig.json` (T003's file) and T009 writes `vite.config.ts` (T005's file)
- Phase 2: all four types (T013–T016) in parallel; all seven primitives (T024–T030) in parallel; `LoadingState`/`EmptyState` (T031–T032) in parallel
- **Once Phase 2 completes, all four stories can run in parallel** — this is the main staffing win
- Within US1: T042/T044 (formatters) in parallel; T048/T049 (hooks) in parallel; T052, T053, T053a, T054–T056 (components) in parallel
- Within US2: T064–T067 in parallel
- Phase 7: T084–T088 in parallel

---

## Parallel Example: Foundational Primitives

```bash
# All seven primitives are independent files with no interdependencies:
Task: "Create Button.tsx in web/src/components/ui/Button.tsx"
Task: "Create Badge.tsx in web/src/components/ui/Badge.tsx"
Task: "Create Spinner.tsx in web/src/components/ui/Spinner.tsx"
Task: "Create PageTitle.tsx in web/src/components/ui/PageTitle.tsx"
Task: "Create Card.tsx in web/src/components/ui/Card.tsx"
Task: "Create Table.tsx in web/src/components/ui/Table.tsx"
Task: "Create ConfirmDialog.tsx in web/src/components/ui/ConfirmDialog.tsx"
```

## Parallel Example: User Story 1

```bash
# Pure logic + tests together:
Task: "Create lib/format/remote.ts in web/src/lib/format/remote.ts"
Task: "Create lib/format/salary.ts in web/src/lib/format/salary.ts"

# Then components together, once hooks land:
Task: "Create SourceFilter.tsx in web/src/components/jobs/SourceFilter.tsx"
Task: "Create DateRangeFilter.tsx in web/src/components/jobs/DateRangeFilter.tsx"
Task: "Create Pagination.tsx in web/src/components/jobs/Pagination.tsx"
Task: "Create JobsTable.tsx in web/src/components/jobs/JobsTable.tsx"
Task: "Create JobDetail.tsx in web/src/components/jobs/JobDetail.tsx"
Task: "Create RunProgress.tsx in web/src/components/jobs/RunProgress.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (T001–T012)
2. Phase 2: Foundational (T013–T041) — **CRITICAL, blocks everything**
3. Phase 3: US1 Jobs (T042–T059, incl. T053a)
4. **STOP and VALIDATE**: quickstart.md S2, S3, S4, S5, S13
5. Demo — the complete collect-and-review loop works. `/` (Config), `/logs`, and `/dashboard/auto-scrape` are still stubs; the shell, nav, and NotFound are real

### Incremental Delivery

1. Setup + Foundational → shell renders, gate is green
2. + US1 Jobs → **MVP**, the product's core value
3. + US2 Auto-Scrape → unattended operation is observable
4. + US3 Config → the system is steerable by someone other than its author
5. + US4 Logs → post-hoc diagnosis
6. + Polish & Cutover → `web/` becomes `frontend/`

**Do not cut over early.** T091 deletes the old app; run it only when all four stories are green (T090), since the old app is the reference for behavior questions until then.

### Parallel Team Strategy

1. Team completes Setup + Foundational together (Phase 2 is the bottleneck — everything else forks from it)
2. Then: Dev A → US1 (largest, 19 tasks), Dev B → US2 (11), Dev C → US3 + US4 (13)
3. Stories integrate through `router.tsx` stub replacement only

---

## Notes

- **[P]** = different files, no dependency on an incomplete task
- **[Story]** label maps a task to its user story for traceability
- **T053a** is an insertion (analyze finding A1 — FR-023's pagination had no task). It is numbered `T053a` rather than renumbering T054–T093, which would have churned 40 tasks and ~20 dependency references for cosmetic ordering. It executes between T053 and T054
- **Phase 3 count**: 19 tasks (T042–T059, plus T053a)
- Commit after each task or logical group; run `npm run verify` before each commit
- **The three highest-consequence tasks**, each guarding a silent failure:
  - **T008** — the forbidden-route lint rule. `/extension/pending*` are `GET`s that mutate: one poll steals the extension's queued command and **the scan silently never runs**, with no error and nothing to debug. The endpoints look like reads. The gate, not vigilance, is what holds this
  - **T043** — `remote: null` must never render "On-site". Glassdoor never emits `false`, so the naive ternary is wrong for *every* non-remote Glassdoor job
  - **T045** — an `HOURLY` `"55"` is `$55/hr`. Never annualized
- **FR-048–FR-052 are out of scope** — delivered by feature 008. No task implements them; the quickstart.md Prerequisites `curl` verifies the surface exists before US1 starts
- **Zero backend files, migrations, or smoke tests are touched** — verified by T093
