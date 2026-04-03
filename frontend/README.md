# Job Hunting Assistant — Frontend

Single-page app for **search configuration**, **job list**, **run logs** (scan + dedup reports), and **dedup** controls. It talks to the FastAPI backend over **REST** using `api.js` and bearer auth.

For Docker-based full-stack setup, see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| UI | [React 18](https://react.dev/) |
| Routing | [React Router v6](https://reactrouter.com/) |
| Build | [Vite](https://vite.dev/) (dev server default port **5173**) |
| Styling | CSS modules (`*.module.css`) |

## Layout

```
frontend/
├── index.html
├── vite.config.js       dev server: host 0.0.0.0, port 5173
├── package.json
├── Dockerfile           dev-mode image (npm run dev)
├── src/
│   ├── main.jsx         React root
│   ├── App.jsx          Routes + nav
│   ├── api.js           Central fetch wrapper (VITE_API_URL, VITE_AUTH_TOKEN)
│   ├── pages/
│   │   ├── ConfigPage.jsx
│   │   ├── JobsPage.jsx        Scans, Scan All, job grid, filters
│   │   ├── LogsPage.jsx        Search runs + expandable dedup reports
│   │   └── DedupPage.jsx       Dedup mode, run/reset, filter pills, job grid
│   ├── components/
│   │   ├── PageTitle.jsx, Spinner.jsx, JobCard.jsx, JobModal.jsx
│   │   └── DedupSkipBadge.jsx  Skip reason + lazy fetch for dedup_original_job
│   └── utils/
│       ├── location.js
│       ├── runLog.js
│       └── time.js
└── .env.example
```

## Routes

| Path | Page |
| --- | --- |
| `/` | Config — search config, dedup mode, site filters, URL previews |
| `/jobs` | Jobs — list, filters, scans (LinkedIn / Indeed / Glassdoor / **Scan All**), progress |
| `/logs` | Logs — **Search** tab (extension run logs) and **Dedup** tab (dedup reports) |
| `/dedup` | Dedup — manual/sync mode, run dedup, reset, All / Passed / Removed filters |

Legacy routes **`/search-report`** → **`/logs`**; **`/dedup/passed`** / **`/dedup/removed`** → **`/dedup`** (redirects).

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
| `getJobs` | `GET /jobs` |
| `getJob` / `getJobsByDedupStatus` | Job detail and dedup-filtered lists |
| `resetDedup` | `POST /jobs/dedup/reset` |
| `runDedup` | `POST /jobs/dedup` |
| `getDedupReports` | `GET /dedup/reports` |
| `triggerScan(website, extra?)` | `POST /extension/trigger-scan` — optional **`extra`** for Scan All (`scan_all`, `scan_all_position`, `scan_all_total`) |
| `stopScan` | `POST /extension/trigger-stop` |
| `getRunLogs` | `GET /extension/run-log` |
| `getExtensionState` | `GET /extension/state` |

## Scan All (Jobs page)

**Scan All** loops `linkedin` → `indeed` → `glassdoor` and calls **`triggerScan(website, { scan_all: true, scan_all_position, scan_all_total })`** so the backend can run **sync dedup** only after the **last** site completes. Single-site buttons call **`triggerScan('linkedin')`** (etc.) with no extra payload.

## Linting

```bash
npm run lint
```

## See also

- [Backend API](../backend/README.md) — endpoint reference
- [Extension](../extension/README.md) — Chrome extension behavior
