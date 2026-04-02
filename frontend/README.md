# Job Hunting Assistant — Frontend

Single-page app for **search configuration**, **job list**, and **search reports**. It talks to the FastAPI backend over **REST** using a small `api.js` client and bearer auth.

For Docker-based full-stack setup, see the [repository root README](../README.md).

## Stack

| Layer | Technology |
| --- | --- |
| UI | [React 18](https://react.dev/) |
| Routing | [React Router v6](https://reactrouter.com/) |
| Build | [Vite](https://vite.dev/) (dev server default port **5173**) |
| Styling | Plain CSS modules (`*.module.css`) |

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
│   │   ├── ConfigPage.jsx   Search config (keyword, location, LinkedIn/Indeed/Glassdoor filters, URL preview)
│   │   ├── JobsPage.jsx     Job list, filters, dismiss, scan controls (Scan LinkedIn/Indeed/Glassdoor, Scan All, Stop, progress bar)
│   │   └── SearchReportPage.jsx
│   ├── components/
│   │   ├── PageTitle.jsx
│   │   └── Spinner.jsx
│   └── utils/
│       ├── location.js      normaliseLocation — strips work-mode suffix, abbreviates provinces
│       ├── runLog.js        detectWebsiteFromRunLog
│       └── time.js          formatAbsoluteTime
└── .env.example
```

## Routes

| Path | Page |
| --- | --- |
| `/` | Config — edit search config (keyword, location, LinkedIn/Indeed/Glassdoor filters, URL preview per source) |
| `/jobs` | Jobs — list, filter, dismiss scraped jobs; trigger scans (LinkedIn / Indeed / Glassdoor / Scan All) and monitor live scan progress |
| `/search-report` | Search Report — run history / reporting |

The extension popup only syncs a **subset** of fields; use **Config** for full control (e.g. `website`, `glassdoor`, `f_tpr_bound`).

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

The `api` object exports these methods (all requests use the shared `Authorization` header from `VITE_AUTH_TOKEN`):

| Method | Purpose |
| --- | --- |
| `getConfig` | `GET /config` |
| `updateConfig(data)` | `PUT /config` |
| `getJobs(params)` | `GET /jobs` with optional query params |
| `getJob(jobId)` | `GET /jobs/{id}` |
| `getSkippedJobs(scanRunId, params)` | `GET /jobs/skipped` |
| `triggerScan(website)` | `POST /extension/trigger-scan` (optional `website`) |
| `stopScan` | `POST /extension/trigger-stop` |
| `getRunLogs(limit)` | `GET /extension/run-log` |
| `getExtensionState` | `GET /extension/state` |

## Linting

```bash
npm run lint
```

## See also

- [Backend API](../backend/README.md) — endpoint reference
- [Extension](../extension/README.md) — Chrome extension behavior
