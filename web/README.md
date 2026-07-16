# JHA Frontend

The search-only frontend: **four pages, one shell, one visual system, one access layer.**

Vite + React 18 + TypeScript, TanStack Query, Tailwind, react-router (data router).

> **Status**: built at `web/`, running on **5174** while the old app still occupies 5173.
> The cutover (task T091) deletes `frontend/` and renames this directory into its place,
> after which this app serves on 5173 with no `docker-compose.yml` change.

## Quick start

```bash
cd web
npm install
cp .env.example .env      # VITE_API_URL, VITE_AUTH_TOKEN
npm run dev               # http://localhost:5174
```

The backend must be up (`docker compose up -d backend postgres redis`). No backend
change is needed for the dev port: CORS admits any `http://localhost:<port>`.
**LAN IPs and `https://localhost` are not admitted** — reach the dev server via
`localhost`, not a LAN address.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on 5174 |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` over **both** projects (`src/` and the build config) |
| `npm run lint` | ESLint over `**/*.{ts,tsx}` with `typescript-eslint` + `react-hooks` |
| `npm run test` | Vitest — pure logic only |
| **`npm run verify`** | **typecheck && lint && test — the gate. Run this before every commit.** |

There is **no CI** in this repo, so `verify` is the gate a human runs.

## Environment

| Var | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8000` | Backend base URL |
| `VITE_AUTH_TOKEN` | `dev-token` | Bearer token |

⚠️ **Both are baked into the bundle at BUILD time**, so the token ships inside the
production JS. This is unchanged from the previous app and is accepted by the spec
(single operator, trusted self-hosted deployment). It also means changing the token
requires a **restart**, not a page reload — the 401 screen says so.

`NEXT_PUBLIC_*` is not read. Vite only exposes `VITE_*` on `import.meta.env`, so the
old app's `NEXT_PUBLIC_API_BASE` fallback was always `undefined`.

## The four routes

Each page binds to **exactly one** backend surface.

| Route | Page | Backend surface |
|---|---|---|
| `/` | Config | `/config` |
| `/jobs` | Jobs | `/jobs` (+ `/extension/*` for scan control) |
| `/logs` | Logs | `/extension/run-log` |
| `/dashboard/auto-scrape` | Auto-Scrape | `/admin/auto-scrape/*` |
| `*` | Not found | none |

`src/lib/nav.ts` is the single source of both the nav and the routes, so they cannot
drift. Legacy URLs (`/profile`, `/skills`, `/matching`, `/dedup`, …) land on a
"page removed" state — **not** a redirect, because those endpoints are gone and a
redirect would imply they merely moved.

## Rules that are enforced, not just documented

**Two ESLint rules fail the build**, because both failures are otherwise silent:

1. **`/extension/pending*` is forbidden.** Those three routes are `GET`s that *mutate
   and commit*: one call clears the flag, steals the extension's queued command, and
   **the scan then silently never runs** — no error, nothing to debug. They look like
   reads. Use `GET /extension/state`, which does not consume.
2. **`fetch()` only in `src/lib/api/client.ts`.** The old app had three access layers;
   several of its methods never checked `response.ok`.

Also structural:

- **`PUT /admin/auto-scrape/state` is not bound at all.** It is a whole-object replace
  that would destroy unsent keys. Use the server-side mutators (`/enable`, `/pause`, …).
- **`src/` is 100% TypeScript.** The old app was `strict` *and* `noEmit` yet checked
  ~700 of 12,235 lines, because its source was `.jsx` and `allowJs` was off.
- **Job descriptions are sanitized** (`lib/format/description.ts`) before ever reaching
  `dangerouslySetInnerHTML`. They are untrusted third-party HTML.

## Layout

```
src/
├── pages/        one file per route
├── components/
│   ├── ui/       the ONLY owner of visual treatment (+ states/)
│   ├── layout/   TopNav
│   └── jobs|logs|config|auto-scrape/
├── lib/
│   ├── api/      client.ts is the only fetch site
│   ├── format/   pure, unit-tested
│   ├── tokens/   status -> tone maps
│   └── nav.ts    the single source of pages
├── hooks/
└── types/        mirrors the backend schemas; compile-time only
```

**No runtime schema validation** — responses are cast, not parsed, so added backend
keys pass through (Constitution Principle VII). Do not add Zod to the client.

Design tokens live in `tailwind.config.ts` + `src/index.css`. Nothing outside
`components/ui/` may declare a colour, radius or shadow.

## Testing

Vitest covers **pure logic only** — no component or DOM tests, deliberately. The one
exception is `description.test.ts`, which runs under jsdom because it tests XSS
sanitization, where a silent failure is a security hole.

Covered: salary formatting, the tri-state `remote`, heartbeat grading, error
normalization, search-preview URLs, the trace window math, the unsaved guard, and the
sanitizer.

Page behaviour is validated by hand — see
[`specs/007-frontend-redesign/quickstart.md`](../specs/007-frontend-redesign/quickstart.md).

## Backend traits worth knowing before you change anything

These are real, verified against the live API, and each one has bitten someone:

- **`remote` is tri-state.** `null` means the site did not say — **not** "on-site".
  Glassdoor never emits `false`, so `remote ? 'Remote' : 'On-site'` mislabels *every*
  non-remote Glassdoor job.
- **Salaries are plain-notation strings and are never annualized.** An `HOURLY` `"55"`
  is $55/hr. `YEARLY` is never stored — it maps to `ANNUAL` at ingest.
- **The backend returns four different error shapes.** `lib/api/errors.ts` normalizes
  them. `String(detail)` yields `"[object Object]"` for two of them.
- **Traces are included by default and are huge.** 10 runs cost 8 KB with
  `include_debug_log=false` and **537 KB** without it.
- **`GET /jobs` has no per-site count endpoint** — counts cost one `?source_site=X&limit=1`
  read each.
- **`date_from`/`date_to` compare a timestamp to bare-date midnight**, so `date_to=today`
  drops nearly all of today. Use `scraped_from`/`scraped_to`.
- **`GET /jobs` has no sort tiebreaker**, so offset pagination can drop/repeat a row on
  ties. The fix is a backend secondary sort key.
