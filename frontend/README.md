# Job Hunting Assistant — Frontend

Single-page app for **search configuration**, **profile / resume**, **job list**, **run logs** (scan runs, dedup reports, pipeline match reports, and **issue reports**), **skill candidate review**, **matching pipeline** (dedup + extraction + gates + CPU score + optional **LLM re-score**), and **dedup** controls. It talks to the FastAPI backend over **REST** using `api.js` and bearer auth. The **Jobs** page also opens a **WebSocket** (**`/ws/run-log`**) with the same token (see backend README) so scan progress updates without aggressive polling.

For Docker-based full-stack setup, see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| UI | [React 18](https://react.dev/) |
| Routing | [React Router v6](https://reactrouter.com/) |
| Build | [Vite](https://vite.dev/) (dev server default port **5173**) |
| Styling | CSS modules (`*.module.css`); **Tailwind** utilities for **Auto-scrape** dashboard (preflight off — see `tailwind.config.js`) |
| Auto-scrape UI | TypeScript (`.tsx`) under `src/app/(dashboard)/…`, `src/components/auto-scrape/`, `src/lib/api/autoScrape.ts` |

## Layout

```
frontend/
├── index.html
├── vite.config.js       dev server: host 0.0.0.0, port 5173; `@` → `src/`
├── tailwind.config.js   Tailwind (preflight off; utilities for auto-scrape)
├── postcss.config.js
├── tsconfig.json        TypeScript path alias `@/*`
├── package.json
├── Dockerfile           dev-mode image (npm run dev)
├── src/
│   ├── main.jsx         React root
│   ├── App.jsx          Routes + nav (includes **Sidebar** with Auto-scrape link)
│   ├── app/
│   │   └── (dashboard)/auto-scrape/page.tsx   Auto-scrape dashboard (client page)
│   ├── api.js           Central fetch wrapper (VITE_API_URL, VITE_AUTH_TOKEN)
│   ├── lib/api/
│   │   └── autoScrape.ts    **`/admin/auto-scrape`** REST helpers (+ instances poll)
│   ├── hooks/
│   │   └── useScanGrace.js    Short post-scan grace before treating a run as finished
│   ├── pages/
│   │   ├── ConfigPage.jsx
│   │   ├── ProfilePage.jsx     Resume upload, parsed profile, skills
│   │   ├── JobsPage.jsx        Scans, Scan All, job grid, filters; **`WebSocket /ws/run-log`** + adaptive poll interval
│   │   ├── LogsPage.jsx        Search runs (expandable **Debug trace**); Dedup / Matching run reports (same **Debug trace** when **`debug_log`** present); **Reports** (issue reports from Matching)
│   │   ├── SkillsPage.jsx      Skill alias candidates (approve / merge / reject)
│   │   ├── MatchingPage.jsx    Pipeline buttons (CPU / LLM extract / CPU score / LLM score), filters, job grid, **report flag** per card
│   │   └── DedupPage.jsx       Dedup mode, run/reset, filter pills, job grid
│   ├── components/
│   │   ├── layout/Sidebar.tsx     Top nav (Config, Jobs, …, **Auto-scrape**)
│   │   ├── auto-scrape/           StatusHeader, CurrentCycle, CycleHistory, SessionHealth, ConfigEditor
│   │   ├── PageTitle.jsx, Spinner.jsx, JobCard.jsx, JobModal.jsx, DebugTracePanel.jsx
│   │   ├── DedupSkipBadge.jsx  Dedup skip reason + lazy fetch for dedup_original_job
│   │   ├── MatchBadge.jsx, MatchSkipBadge.jsx  Match level / gate skip UI
│   └── utils/
│       ├── glassdoorUrl.js   Glassdoor SERP / job URL helpers
│       ├── location.js
│       ├── runLog.js
│       └── time.js
└── .env.example
```

## Routes

| Path | Page |
| --- | --- |
| `/` | Config — search config, dedup mode, LLM toggle, site filters, URL previews |
| `/profile` | Profile — resume upload, parsed fields, skills for matching |
| `/jobs` | Jobs — list, filters, scans (LinkedIn / Indeed / Glassdoor / **Scan All**), live run-log row via **WebSocket** (fallback: poll run logs every **2s** when disconnected, **10s** when connected) |
| `/logs` | Logs — **Search** (run logs; **Debug trace** from `debug_log.events`), **Dedup** / **Matching** (pipeline metrics + **Debug trace** on each report card when present), **Reports** (user issue reports; filter by status, dismiss, open job in Matching) |
| `/skills` | Skills — review skill alias candidates from JD extraction |
| `/matching` | Matching — **All CPU work** (dedup + `cpu_only` match), LLM extraction + gates, CPU score, optional **LLM re-score** (`llm_score`); removed/passed filters with gate pills; **`?job=<uuid>`** opens the job modal (e.g. from **Logs → Reports → View job**). On load, **`GET /match/status`** rehydrates the running spinner if the backend still has a pipeline task; long runs poll **`GET /match/reports`** with extended timeouts (up to **30 minutes** for LLM-heavy buttons). |
| `/dashboard/auto-scrape` | **Auto-scrape** — orchestrator status, enable/pause/shutdown, session health (CAPTCHA / reset), **Configuration** (**`PUT /admin/auto-scrape/config`** with **`enabled_sites`** and **`keywords`**; extension reads fresh config each cycle), cycle history, multi-instance warning (**polls every 5s**; uses **`src/lib/api/autoScrape.ts`**) |
| `/dedup` | Dedup — manual/sync mode, run dedup, reset, All / Passed / Removed filters (route only; no top-nav link — use URL or bookmark) |

Legacy routes **`/search-report`** → **`/logs`**; **`/dedup/passed`** / **`/dedup/removed`** → **`/matching`** (redirects).

The extension popup only syncs a **subset** of fields; use **Config** for full control (`website`, Glassdoor, `dedup_mode`, etc.).

## Environment

Copy [`.env.example`](./.env.example) to `.env` (Vite reads `VITE_*` variables at build/dev time).

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Backend base URL (default `http://localhost:8000`) |
| `VITE_AUTH_TOKEN` | Bearer token sent as `Authorization: Bearer …` (default `dev-token` in development) |

## Local development

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The dev server binds to all interfaces (`host: true` in `vite.config.js`) so you can reach it from other devices on the LAN if needed.

### Production build

```bash
npm run build
```

Static output is written to `dist/`. Serve with any static host; set `VITE_API_URL` / `VITE_AUTH_TOKEN` at **build** time so they are baked into the bundle.

```bash
npm run preview   # optional: local preview of dist/
```

## Docker

From the **repository root**, `docker compose` runs the frontend with hot-reload on `src/` (see root `docker-compose.yml`). The container exposes port **5173**.

Environment in Compose sets `VITE_API_URL` and `VITE_AUTH_TOKEN` for the dev server. If the browser runs on the **host** and the API is on `localhost:8000`, that URL is correct for the browser.

## API client (`src/api.js`)

The `api` object exports methods (all requests use the shared `Authorization` header from `VITE_AUTH_TOKEN`), including:

| Method | Purpose |
| --- | --- |
| `getConfig` / `updateConfig` | `/config` |
| `getJobs` | `GET /jobs` (items include **`has_report`**) |
| `getJob` / `getJobsByDedupStatus` | Job detail and dedup-filtered lists |
| `createJobReport` | `POST /jobs/{id}/report` |
| `getJobReports` | `GET /jobs/reports` |
| `getJobReportStats` | `GET /jobs/reports/stats` |
| `actionJobReport` | `PUT /jobs/reports/{id}/action` |
| `resetDedup` | `POST /jobs/dedup/reset` |
| `runDedup` | `POST /jobs/dedup` |
| `getDedupReports` | `GET /dedup/reports` |
| `getDedupReport` | `GET /dedup/reports/{id}` |
| `triggerScan(website, extra?)` | `POST /extension/trigger-scan` — optional **`extra`** for Scan All (`scan_all`, `scan_all_position`, `scan_all_total`) |
| `stopScan` | `POST /extension/trigger-stop` |
| `getRunLogs` | `GET /extension/run-log` |
| `getExtensionState` | `GET /extension/state` |
| `runMatching` | `POST /jobs/match` — body `{ mode?: 'cpu_only' \| 'llm_extraction_gates' \| 'cpu_score' \| 'llm_score' }`; returns **`{ status: 'started', mode }`** immediately |
| `getMatchStatus` | `GET /match/status` — **`{ running, mode }`** for rehydrating UI after navigation |
| `getMatchReports` / `getMatchReport` | `GET /match/reports`, `/match/reports/{id}` |
| `getMatchExtractedCount` | `GET /jobs/match/extracted-count` |
| `getMatchLogs` | `GET /match/logs` |
| `runGates`, `scoreJobs`, `resetGates`, `resetScore`, `resetExtraction` | Other `/jobs/match/*` helpers |
| `undoButton1` … `undoButton4`, `dismissJob`, `undismissJob` | Pipeline undo + dismiss endpoints |
| `getProfile`, `saveProfile`, `uploadResume`, `parseResume`, `getProfileExtracted` | `/profile` |
| `getSkillCandidates`, `getSkillCandidateStats`, `approveSkillCandidate`, `mergeSkillCandidate`, `rejectSkillCandidate`, `refreshSkillAliases` | `/skills/candidates/*` |

**Matching page polling:** After **`runMatching`**, the API finishes work in a detached background task. The UI polls **`getMatchReports`** until the report count increases. Default wait is **15 minutes**; Buttons **2** and **4** use **30 minutes**. Timeout errors note that the backend task may still be running. **`getMatchStatus`** on mount restores the “running” state if you navigated away mid-run.

## Scan All (Jobs page)

**Scan All** loops `linkedin` → `indeed` → `glassdoor` and calls **`triggerScan(website, { scan_all: true, scan_all_position, scan_all_total })`** so the backend can run **sync dedup** only after the **last** site completes. Single-site buttons call **`triggerScan('linkedin')`** (etc.) with no extra payload.

## Auto-scrape dashboard (`/dashboard/auto-scrape`)

Uses **`src/lib/api/autoScrape.ts`**: state, cycles, sessions, instances poll, **`saveConfig`** → **`PUT /admin/auto-scrape/config`** with **`enabled_sites`**, **`keywords`**, and other orchestrator fields validated by the backend. The Chrome extension reads that row via **`GET /admin/auto-scrape/config`** at **each cycle start** (not cached across cycles). **`POST /enable`** (from the dashboard) applies after save when the user starts the orchestrator.

## Dedup chain repair (optional)

The backend exposes **`POST /jobs/dedup/resolve-chains`** to fix rows where **`dedup_original_job_id`** still points at another removed job (one-time / idempotent DB repair). Call it with the same bearer auth as other endpoints (e.g. `curl`); it is not wrapped in `api.js` by default.

## Linting

```bash
npm run lint
```

## See also

- [Backend API](../backend/README.md) — endpoint reference and server logging (`docker compose logs backend`)
- [Extension](../extension/README.md) — Chrome extension behavior
