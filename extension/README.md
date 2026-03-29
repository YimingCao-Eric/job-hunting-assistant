# Job Hunting Assistant — Chrome extension

## Overview

This extension automates scanning job search result pages on **LinkedIn** (`linkedin.com/jobs`), **Indeed Canada** (`ca.indeed.com/jobs`), and **Glassdoor Canada** (`glassdoor.ca` / `www.glassdoor.ca`), extracts job details, and **POST**s each job to the Job Hunting Assistant backend (`/jobs/ingest`) using the token and base URL stored in `chrome.storage.local`. **`GET /config`** supplies `config.website`, nested **`config.glassdoor`** (keyword/location slugs, filters), and Indeed/LinkedIn fields; **`background/scan_manual.js`** `handleManualScan(options)` uses **`effectiveWebsite`** (`options.websiteOverride` from **`GET /extension/pending-scan`** when set, else `config.website`, else `"linkedin"`) to choose URL builders (`buildSearchUrl` / `buildIndeedSearchUrl` / **`buildGlassdoorSearchUrl`**), **`scanConfig.website`**, and run-log `search_filters`.

**Starting a scan (two paths):** (1) **Web app — Jobs page** — `POST /extension/trigger-scan` with body `{"website":"linkedin"}`, `{"website":"indeed"}`, or **`{"website":"glassdoor"}`** sets `scan_requested` and `scan_website` in the backend; **`background/poll.js`** polls **`GET /extension/pending-scan` every 3s** and calls `handleManualScan({ websiteOverride })` when `pending` is true (so e.g. LinkedIn can run even if `config.website` is `indeed`). (2) **Extension popup — Scan Now** — sends **`MANUAL_SCAN`** with no override; `handleManualScan()` runs with `effectiveWebsite` from config only.

The service worker coordinates scans, forwards ingest requests from content scripts, updates run logs and extension state on the backend, and closes the scan window (popup) when a run finishes. The **popup** (`popup/popup.html`) lets the user set the backend URL, trigger **Scan Now** (`MANUAL_SCAN`), stop a scan, and see live progress read from storage. Full config (including `website`, `indeed_*`, and nested **`glassdoor`**) is edited on the **web Config page** or via `PUT /config` — see repo root `README.md`. Run history and detailed reports live in the **web app** (e.g. Search Report); the extension does not render those UIs.

## Architecture

```
extension/
├── manifest.json                    Chrome extension manifest (MV3)
├── background/
│   ├── background.js                Service worker entry — importScripts() loads modules below
│   ├── keepalive.js                 Periodic no-op to reduce MV3 worker suspension
│   ├── settings.js                  Cached backendUrl / authToken / scanDelay from storage
│   ├── config_fetch.js              GET /config and f_TPR computation from run logs
│   ├── search_urls.js               LinkedIn, Indeed & Glassdoor job search URL builders
│   ├── scan_manual.js               handleManualScan — reset state, run log, 90min safety timer, open scan in popup window
│   ├── ingest.js                    POST /jobs/ingest (job payload from content scripts)
│   ├── runtime_messages.js          chrome.runtime.onMessage router (ingest, tab nav, etc.)
│   ├── scan_completion.js           On scanComplete in storage → PUT run-log, close tab
│   ├── tabs_safety.js               Clear scan state if user closes tab mid-scan
│   ├── poll.js                      Poll backend for pending-scan / pending-stop
│   └── startup.js                   Clear stale scan flags on browser startup
├── content/
│   ├── content_style.css            Shared styles (e.g. scan overlay classes where used)
│   ├── shared/
│   │   ├── utils.js                 sleep()
│   │   ├── delays.js                SCAN_DELAYS + cardDelay() for pacing between cards
│   │   └── messaging.js             ingestJob() + recordSkip() → INGEST_JOB
│   ├── linkedin/
│   │   ├── constants.js             Job card & pagination selector lists
│   │   ├── scroll.js                scrollDelay() for virtualized list pacing (reserved)
│   │   ├── dom.js                   Card discovery, session check, card field extraction
│   │   ├── voyager.js               Voyager API + company fetch for JD and metadata
│   │   ├── process.js               pushScanError (ingest from page.js)
│   │   ├── page.js                  One results page + navigate to next URL
│   │   ├── overlay.js               Full-width scanning banner (inline styles)
│   │   └── init.js                  Entry: wait for scanConfig, run scan, write scanComplete
│   ├── indeed/
│   │   ├── dom.js                   Session, card anchors, waitForCards, extractCardData
│   │   ├── rate_strategy.js         fetchIndeedJD — Indeed GraphQL JD fetch (see fetch_jd.js)
│   │   ├── fetch_jd.js              Comment stub — `fetchIndeedJD` lives in `rate_strategy.js` (load order: strategy before process)
│   │   ├── process.js               Per-card JD fetch + ingest
│   │   ├── page.js                  One page + pagination via next link
│   │   ├── overlay.js               Corner banner using .jha-scanning-overlay
│   │   └── init.js                  Entry: wait for scanInProgress + scanConfig (same as LinkedIn)
│   └── glassdoor/                   No shared/*.js — self-contained scripts, load order matters
│       ├── parse.js                 parseGlassdoorCard — DOM fields + jl from card/listing URL
│       ├── fetch_jd.js              GET job-listing HTML → __NEXT_DATA__ / JSON-LD / DOM fallback, 10s abort
│       ├── process.js               Per-card JD + INGEST_JOB (phantom / rateLimited handling)
│       ├── page.js                  scanGlassdoorPage — cards loop, early stop, rate-limit cooldown
│       └── init.js                  Manual: scanInProgress + scanConfig.website===glassdoor → scan + scanComplete; else optional debounced auto-scan (GET_CONFIG, SCAN_STARTED, SCAN_COMPLETE)
└── popup/
    ├── popup.html                   Extension toolbar popup UI
    └── popup.js                     Settings save/load, MANUAL_SCAN / STOP_SCAN, progress polling
```

## Chrome Extension Constraints

**Manifest permissions** include **`windows`** (with **`tabs`**, **`storage`**, **`scripting`**, **`activeTab`**) so the background script can open the search URL in a **separate popup window** via `chrome.windows.create` and remove the scan tab by id on completion or force-stop.

**Content scripts** listed under `manifest.json` → `content_scripts` → `js` are plain scripts: they **do not** support `import` / `export` (no ES modules). Chrome injects them **in order** into a **shared global scope** for that match pattern. **LinkedIn and Indeed** list `content/shared/*.js` first so `sleep`, `cardDelay`, `ingestJob`, and `recordSkip` exist before site scripts. **Glassdoor** does not load `shared/*`; it uses only `content/glassdoor/*.js` with **`init.js` last** so `scanGlassdoorPage` / `parseGlassdoorCard` / `fetchGlassdoorJD` are defined before the entry IIFE runs.

The **service worker** uses **`importScripts()`** in `background/background.js`. That API loads additional scripts into the **same global scope** as the worker (like content scripts, no ES modules here). Paths are **relative to the service worker file’s directory** (e.g. `keepalive.js` next to `background.js`). This project does **not** use `"type": "module"` for the background script.

## File & Function Reference

### `background/background.js`

| Function | Description |
| --- | --- |
| *(none)* | Calls `importScripts()` to load all background modules in dependency order. |

### `background/keepalive.js`

| Function | Description |
| --- | --- |
| `startKeepAlive()` | Clears any prior interval, then starts a **5s** interval: **`chrome.runtime.getPlatformInfo`** plus **`chrome.storage.local.set({ _keepalive })`** (storage helps keep the SW alive). |
| `stopKeepAlive()` | Clears the keepalive interval. |

### `background/settings.js`

| Function | Description |
| --- | --- |
| `getSettings()` | Returns `backendUrl`, `authToken`, and `scanDelay` from `chrome.storage.local` with a 30s in-memory cache. |

### `background/config_fetch.js`

| Function | Description |
| --- | --- |
| `fetchConfig()` | GETs `/config` from the backend using the stored token. |
| `computeFtpr(fTprBound)` | Computes LinkedIn `f_TPR` time filter from the last completed run log and bound hours. |

### `background/search_urls.js`

| Function | Description |
| --- | --- |
| `salaryToLinkedInFilter(salaryMin)` | Maps minimum salary to LinkedIn `f_SB2` bracket codes. |
| `buildSearchUrl(config, f_tpr, startOffset)` | Builds LinkedIn job search URL with filters and pagination offset. |
| `buildIndeedSearchUrl(config, startOffset)` | Builds Indeed Canada job search URL with Indeed-specific query params. |
| `buildGlassdoorSearchUrl(config)` | Builds Glassdoor Canada SERP URL from `config.glassdoor` (location/keyword slugs, `SRCH_IL` path segment, `fromAge` and other query params). |

### `background/scan_manual.js`

| Function | Description |
| --- | --- |
| `handleManualScan(options)` | Optional `options.websiteOverride` (from poll when frontend triggers scan). Computes **`effectiveWebsite`** and uses it for **LinkedIn vs Indeed vs Glassdoor** branching (`isIndeed` / `isGlassdoor` / else LinkedIn), `scanConfig.website`, run-log `search_filters` (including **`website`**, **`general_date_posted`**, **`general_internship_only`**, **`general_remote_only`**), and search URL. Otherwise: clears `stopRequested`, removes `scanPageState`, returns early if a scan is already in progress. PUTs backend extension state with `current_page: 1` and `today_searches: 0`. Fetches config, calls `computeFtpr(config.f_tpr_bound)` for LinkedIn. Starts the run log via POST, then **`chrome.windows.create`** (`type: "popup"`, 1280×800, `focused: false`) with the search URL, stores **`tabId`** on `scanConfig` with `f_tpr`, `runId`, **`website: effectiveWebsite`**, full config including **`glassdoor`**, and initial `liveProgress`, calls `startKeepAlive()`, **90-minute** safety timeout. |

### `background/ingest.js`

| Function | Description |
| --- | --- |
| `handleIngest(job)` | Serializes the job (strips `voyager_raw` if needed) and POSTs to `/jobs/ingest`. Reads **`res.text()`** and **`JSON.parse`** so non-JSON responses return **`null`** instead of throwing. |

### `background/runtime_messages.js`

| Function | Description |
| --- | --- |
| *(listener)* | On **every** message, **`stopKeepAlive()` + `startKeepAlive()`** to reset the keepalive timer while the SW handles work. Dispatches `MANUAL_SCAN`, `INGEST_JOB`, `GET_TAB_ID`, `GET_EXTENSION_STATE`, `PUT_EXTENSION_STATE`, `STOP_SCAN`, `TRIGGER_STOP`, `NAVIGATE_SCAN_TAB`, `SESSION_ERROR`, **`GET_CONFIG`** (GET `/config` for Glassdoor content scripts), **`CHECK_STOP`**, **`SCAN_STARTED`** (POST run-log for auto Glassdoor), **`SCAN_COMPLETE`** (PUT run-log for auto Glassdoor), **`GET_MAIN_WORLD_VALUE`** (Indeed API key in main world) to the appropriate handlers. |

### `background/scan_completion.js`

| Function | Description |
| --- | --- |
| *(listener)* | On `scanComplete` in storage, clears scan timeout, PUTs completed run log, clears progress, removes the scan tab (`chrome.tabs.remove`). |

### `background/tabs_safety.js`

| Function | Description |
| --- | --- |
| *(listener)* | On tab removal, clears `scanInProgress` if no `scanComplete` is pending. |

### `background/poll.js`

Both triggers use **`setInterval(..., 3000)`** (3s).

| Function | Description |
| --- | --- |
| `pollForScanTrigger()` | GETs `/extension/pending-scan`; the backend **atomically** read-and-clears the `scan_requested` flag and returns `website` (optional override). If `pending`, calls `handleManualScan({ websiteOverride: data.website or null })`. |
| `pollForStopTrigger()` | GETs `/extension/pending-stop`; the backend **atomically** read-and-clears `stop_requested`. If `pending`, sets `stopRequested`, **`chrome.tabs.remove(scanConfig.tabId)`** if present, clears scan-related storage (`scanInProgress`, `scanConfig`, `scanPageState`, `liveProgress`, …), clears the **90-minute** timeout id, calls **`stopKeepAlive()`** — in addition to content scripts seeing `stopRequested`. |

### `background/startup.js`

| Function | Description |
| --- | --- |
| *(listener)* | On `chrome.runtime.onStartup`, clears stale `scanInProgress` / `liveProgress`. |

### `content/shared/utils.js`

| Function | Description |
| --- | --- |
| `sleep(ms)` | Returns a Promise that resolves after `ms` milliseconds. |

### `content/shared/delays.js`

| Function | Description |
| --- | --- |
| `cardDelay(scanDelay)` | Waits a random interval between min/max ms for the chosen speed (`fast` / `normal` / `slow`). |

### `content/shared/messaging.js`

| Function | Description |
| --- | --- |
| `ingestJob(jobData)` | **`_swHeartbeat`** + **150ms**, then **`INGEST_JOB`** with **`correlationId`**. Background **acks immediately** and returns the real payload via **`INGEST_JOB_RESULT`** (`chrome.tabs.sendMessage`) so slow **`/jobs/ingest`** does not hit the message-channel timeout. Retries **3** times with **3s / 4s / 6s** delays if no result. |
| `recordSkip(website, cardData, reason, runId)` | Same **`correlationId` / `INGEST_JOB_RESULT`** pattern as `ingestJob`. |

### `content/linkedin/constants.js`

| Constant | Description |
| --- | --- |
| `JOB_CARD_SELECTORS` | Ordered list of selectors to find job cards in the LinkedIn jobs list DOM. |
| `NEXT_BUTTON_SELECTORS` | Ordered list of selectors for the pagination “next” control. |

### `content/linkedin/scroll.js`

| Function | Description |
| --- | --- |
| `scrollDelay(scanDelay)` | Random wait using the `scroll` range in `SCAN_DELAYS` (for list virtualization pacing). |

### `content/linkedin/dom.js`

| Function | Description |
| --- | --- |
| `getCards(silent)` | Finds job cards using `JOB_CARD_SELECTORS`. |
| `waitForCards(timeoutMs)` | Polls every **300ms** (default **8s** max) until **≥1** list node exists (DOM mounted). |
| `collectOccludableJobIds()` | Unique job ids from **`[data-occludable-job-id]`** (all shells on the SERP). |
| `getJobId(card)` | Reads LinkedIn job id from attributes or job view link. |
| `checkSession()` | Returns session status: `live`, `captcha`, `expired`, or `redirected`. |
| `reportSessionError(error)` | Sends `SESSION_ERROR` with the error key. |
| `extractCardData(card)` | Optional DOM read (not used by the main Voyager scan). |
| `isStale(post_datetime)` | Returns true if posting time is older than 48 hours. |

### `content/linkedin/voyager.js`

| Function | Description |
| --- | --- |
| `getCsrfToken()` | Extracts CSRF token from `JSESSIONID` cookie for Voyager requests. |
| `fetchCompanyName(companyUrn, csrfToken)` | Fetches company display name from Voyager entities API; wrapped in **`Promise.race` with a 3s timeout** so a hung fetch does not block the scan indefinitely. |
| `fetchJDViaVoyager(jobId)` | Wraps each Voyager **`fetch()`** in **`withSwKeepalive()`** (storage ping every **5s** while the request is in flight). Up to **2** attempts, **500ms** apart. Minimum JD length **50** chars (trimmed). **429** → 60s pause then `null`. |

### `content/linkedin/process.js`

| Function | Description |
| --- | --- |
| `pushScanError(counters, entry)` | Caps **`errors`** at **200** entries for run logs. |

### `content/linkedin/page.js`

| Function | Description |
| --- | --- |
| `runSinglePage(config, state)` | After **`waitForCards`**, **`collectOccludableJobIds()`** (unique **`data-occludable-job-id`** values, including empty Ember shells). For each id: **`cardDelay`**, **`fetchJDViaVoyager`**, **`isStale`** from Voyager **`listedAt`**, then **`ingestJob`** with Voyager + **`search_filters`** (no DOM card extraction). Duplicate early-stop, bottom scroll, PUT state, **`NAVIGATE_SCAN_TAB`**. |

### `content/linkedin/overlay.js`

| Function | Description |
| --- | --- |
| `showScanOverlay()` | Injects a full-width fixed banner at the top of the page. |
| `hideScanOverlay()` | Removes `#jha-overlay`. |

### `content/linkedin/init.js`

| Function | Description |
| --- | --- |
| `init()` | Waits for `scanInProgress` / `scanConfig`, validates session, runs `runSinglePage`. **`scanConfig` is not cleared when merely advancing pages** — it stays in storage until the run ends so the next page load still has config. It is removed only when `summary.done` (success path) or in the **catch** path (error). The **90-minute** stuck-scan guard lives in **`handleManualScan()`** (service worker timeout), not in `init()`. |

### `content/indeed/dom.js`

| Function | Description |
| --- | --- |
| `checkSession()` | Returns `live`, `expired`, or `redirected` for Indeed jobs pages. |
| `getCards()` | Returns all `a[data-jk]` anchors. |
| `waitForCards(timeoutMs)` | Waits until card count stabilizes or times out. |
| `extractCardData(anchor)` | Reads title, company, location, snippets, easy apply, and viewjob URL from card DOM. |

### `content/indeed/rate_strategy.js`

| Function | Description |
| --- | --- |
| `fetchIndeedJD(jk, scanDelay)` | Indeed JD extraction via **`apis.indeed.com/graphql`** (page-injected **`oneGraphApiKey`** via **`GET_MAIN_WORLD_VALUE`**). Returns `{ jd }`, `{ rateLimited: true }`, `{ phantom: true }`, or `null`. |

### `content/indeed/fetch_jd.js`

| Function | Description |
| --- | --- |
| *(comment only)* | Notes that **`fetchIndeedJD`** is defined in **`rate_strategy.js`** (load order: `rate_strategy.js` before `process.js`). |

### `content/indeed/process.js`

| Function | Description |
| --- | --- |
| `processCard(anchor, config, counters)` | Validates `jk`, fetches JD, calls `ingestJob` with Indeed fields, updates counters. |

### `content/indeed/page.js`

| Function | Description |
| --- | --- |
| `runSinglePage(config, state)` | Processes one page of cards, PUTs state, follows pagination `href` or completes. |

### `content/indeed/overlay.js`

| Function | Description |
| --- | --- |
| `showScanOverlay()` | Adds a corner banner with class `jha-scanning-overlay`. |
| `hideScanOverlay()` | Removes `#jha-overlay`. |

### `content/indeed/init.js`

| Function | Description |
| --- | --- |
| `init()` | Same control flow as LinkedIn: wait for scan, session check, `runSinglePage`, `scanComplete`. |

### `content/glassdoor/parse.js`

| Function | Description |
| --- | --- |
| `parseGlassdoorCard(cardEl)` | Reads job id, title, company, location, salary, easy apply, age text, listing URL, and **`jl`** (listing id). |

### `content/glassdoor/fetch_jd.js`

| Function | Description |
| --- | --- |
| `fetchGlassdoorJD(jobUrl, jl, scanDelay)` | **GET** the job-listing **`jobUrl`** (`credentials: include`, **10s** abort). Parses JD from embedded **`__NEXT_DATA__`** JSON (Next.js), then JSON-LD, then DOM selectors on parsed HTML. **429/503** → **`{ rateLimited: true }`**; no usable description → **`{ phantom: true }`**; else **`{ jd }`** or `null` (timeout / HTTP error). |

### `content/glassdoor/process.js`

| Function | Description |
| --- | --- |
| `processGlassdoorCard(cardEl, config, counters, settings)` | `INGEST_JOB` with **`{ job }`** (not `ingestJob()` helper). Handles phantom (stale_skipped), rateLimited, jd_failed, duplicates. |

### `content/glassdoor/page.js`

| Function | Description |
| --- | --- |
| `scanGlassdoorPage(config, settings, runId)` | Finds cards, loops with **`CHECK_STOP`**, **`processGlassdoorCard`**, early stop on consecutive duplicates, optional rate-limit cooldowns. |

### `content/glassdoor/init.js`

| Function | Description |
| --- | --- |
| `glassdoorMain()` | **Manual (web app / popup scan):** waits for **`scanInProgress`** + **`scanConfig.website === "glassdoor"`** (retries like Indeed), then **`runManualGlassdoorScan`** — uses existing **`runId`** from `scanConfig`, does **not** call `SCAN_STARTED`, writes **`scanComplete`** for `scan_completion.js`. **Auto (optional):** if no manual scan, may run debounced auto-scan (`GET_CONFIG`, `SCAN_STARTED`, `SCAN_COMPLETE`) when `scanInProgress` is false and URL looks like a job SERP; skips auto if another site’s scan is in progress. |

### `popup/popup.js`

| Function | Description |
| --- | --- |
| `$` | Shorthand for `getElementById`. |
| `getBackend()` | Normalized backend base URL from the input field. |
| `authHeaders()` | Bearer and JSON headers for `fetch`. |
| `showToast(msg, ms)` | Brief saved / error toast. |
| `setStatus(html)` | Renders HTML into the status area. |
| `showWarningBanner(errorType)` | Shows session warning from `lastSessionError`. |
| `clearWarning()` | Clears session error from storage and hides banner. |
| `loadSettings()` | Loads storage into fields and resumes polling if a scan is active. |
| `loadConfig()` | GETs `/config` and fills **only** the fields listed in `CONFIG_FIELDS` in `popup.js` (keyword, location, `f_tpr_bound`, experience/job-type/remote filters, `salary_min`). **There are no popup inputs for `website`, `indeed_*`, `indeed_enabled`, or nested `glassdoor`** — configure those via the **web app Config page** or PUT `/config` directly; the service worker still reads the full config from the backend when a scan starts. |
| `saveSettings()` | Writes `backendUrl`, `authToken`, `scanDelay` to storage and PUTs the same **subset** of config keys as `loadConfig()`. |
| `startScan()` | Hides scan button, sends `MANUAL_SCAN`, starts progress polling. |
| `stopScan()` | Sends `STOP_SCAN` and updates UI. |
| `startPolling()` | `setInterval` for `pollProgress`. |
| `stopPolling()` | Clears the interval. |
| `pollProgress()` | Reads `liveProgress` / `lastRunSummary` from storage and updates UI. |
| `renderSummary(s)` | Renders last run statistics. |

## Data Flow

1. **Scan start** — either:
   - **Web app:** user clicks **Scan LinkedIn**, **Scan Indeed**, or **Scan Glassdoor** → backend **`POST /extension/trigger-scan`** with `{"website":"linkedin"|"indeed"|"glassdoor"}` → on the next poll, **`pollForScanTrigger()`** receives `pending` and calls `handleManualScan({ websiteOverride })`, **or**
   - **Popup:** user clicks **Scan Now** → `popup.js` sends `{ type: "MANUAL_SCAN" }` via `chrome.runtime.sendMessage` → **`handleManualScan()`** with no override (site comes from `config.website`).
2. `background/scan_manual.js` `handleManualScan()` clears `scanPageState`, resets backend page counters, GETs config, runs `computeFtpr` for LinkedIn, POSTs run log start, builds the search URL, then opens a **popup window** (`chrome.windows.create`) and stores `scanConfig` (including **`tabId`**) / `liveProgress`, arms the **90-minute** safety timeout. URL: **`buildSearchUrl`** / **`buildIndeedSearchUrl`** / **`buildGlassdoorSearchUrl`** (LinkedIn URL includes `f_SB2` via `salaryToLinkedInFilter` when `salary_min` maps to a bracket).
3. **LinkedIn:** `init()` → `runSinglePage()` → job ids from **`data-occludable-job-id`** + Voyager + **`ingestJob`**. **Indeed:** loops **`processCard()`** over result cards. **Glassdoor:** `glassdoorMain()` waits for **`scanInProgress`** + **`scanConfig.website === "glassdoor"`**, then **`scanGlassdoorPage()`** → **`processGlassdoorCard()`** (single SERP page; completion via **`scanComplete`** like other sites).
4. **LinkedIn:** `fetchJDViaVoyager()` → Voyager APIs → `ingestJob()` sends `{ type: "INGEST_JOB", job }`. **Indeed:** `fetchIndeedJD()` in **`rate_strategy.js`** → same `ingestJob()` path. **Glassdoor:** `fetchGlassdoorJD()` (job-listing HTML + **`__NEXT_DATA__`**) → **`processGlassdoorCard`** sends `{ type: "INGEST_JOB", job }` directly (does not use `shared/messaging.js`).
5. `background/ingest.js` `handleIngest()` POSTs to `/jobs/ingest`; the backend persists the job.
6. The web app (or other client) loads jobs via the backend API (e.g. GET `/jobs`); the extension popup only mirrors **live** counters from `chrome.storage.local` (`liveProgress`), not the full job list.
7. When a page finishes without navigating onward, or on error, `init()` sets `scanComplete` in storage → `scan_completion.js` PUTs the run log as completed and closes the scan tab/window.

## Message Reference

| Type | Payload | Sent from | Handled in |
| --- | --- | --- | --- |
| `MANUAL_SCAN` | *(none)* | `popup/popup.js` | `background/runtime_messages.js` → `handleManualScan()` |
| `INGEST_JOB` | **`correlationId` set (LinkedIn/Indeed):** immediate **`{ ack, correlationId }`**, then **`handleIngest`** → **`tabs.sendMessage`** `INGEST_JOB_RESULT`. **No `correlationId` (Glassdoor):** legacy async **`sendResponse(result)`** after **`handleIngest`**. | `content/shared/messaging.js`, **`content/glassdoor/process.js`** | `background/runtime_messages.js` → `handleIngest()` |
| `INGEST_JOB_RESULT` | `{ correlationId, result }` — delivered to the tab that sent `INGEST_JOB` | `background/runtime_messages.js` | `content/shared/messaging.js` (waiter map) |
| `GET_TAB_ID` | *(none)* | `content/linkedin/init.js`, `content/indeed/init.js` | `background/runtime_messages.js` |
| `GET_EXTENSION_STATE` | *(none)* | `content/*/init.js` | `background/runtime_messages.js` → GET `/extension/state` |
| `PUT_EXTENSION_STATE` | `{ data: { current_page, today_searches } }` | `content/linkedin/page.js`, `content/indeed/page.js` | `background/runtime_messages.js` → PUT `/extension/state` |
| `STOP_SCAN` | *(none)* | `popup/popup.js` | `background/runtime_messages.js` → sets `stopRequested` |
| `TRIGGER_STOP` | *(none)* | *(reserved / parity with backend naming)* | `background/runtime_messages.js` → sets `stopRequested` |
| `NAVIGATE_SCAN_TAB` | `{ url: string }` | `content/linkedin/page.js`, `content/indeed/page.js` | `background/runtime_messages.js` → `chrome.tabs.update` |
| `SESSION_ERROR` | `{ error: string }` | `content/linkedin/dom.js` (`reportSessionError`), `content/indeed/init.js` | `background/runtime_messages.js` → storage + POST `/extension/session-error` |
| `GET_CONFIG` | *(none)* | `content/glassdoor/init.js` (auto-scan path) | `background/runtime_messages.js` → `fetchConfig()` |
| `CHECK_STOP` | *(none)* | `content/glassdoor/page.js` | `background/runtime_messages.js` → `{ stop: boolean }` from `stopRequested` |
| `SCAN_STARTED` | `{ keyword?, location?, source?, filters? }` | `content/glassdoor/init.js` (auto Glassdoor run log) | POST `/extension/run-log/start` → `{ runId }` |
| `SCAN_COMPLETE` | `{ runId, counters? }` | `content/glassdoor/init.js` | PUT `/extension/run-log/{runId}` completed |
| `GET_MAIN_WORLD_VALUE` | *(none)* | `content/indeed/rate_strategy.js` (Indeed oneGraph API key) | `chrome.scripting.executeScript` **MAIN** world |

Internal scan coordination uses **`chrome.storage.local`**. Keys include:

| Key | Role |
| --- | --- |
| `scanInProgress` | True while a scan is active. |
| `scanConfig` | Backend config snapshot + `runId` / `f_tpr` / **`tabId`** (scan tab in the popup window); kept until the run finishes or errors (not cleared between paginated page loads). |
| `scanPageState` | Counters + `current_page` persisted before `NAVIGATE_SCAN_TAB`. |
| `liveProgress` | Live counters for the popup (`scraped`, `new_jobs`, `page`, …). |
| `scanComplete` | Written when a run ends; triggers run-log completion and tab close. |
| `stopRequested` | User or `/pending-stop` requested stop. |
| `scanTimeoutId` | String id for the 90-minute safety `setTimeout` (cleared when `scanComplete` fires). |
| `lastRunSummary` | Last completed run stats for the popup. |
| `lastSessionError` | Session error key from content scripts for the warning banner. |
| `backendUrl`, `authToken`, `scanDelay` | Connection settings (`settings.js`, popup). |

Other keys may appear for short periods during saves or errors.

## Troubleshooting

**JD / ingest failures on LinkedIn with mysterious “Internal Server Error” plain-text responses:** Some browser extensions (notably **Adobe Acrobat**) inject into LinkedIn and override `window.fetch`. Content scripts must **never** `fetch` the JHA backend directly; job ingest uses **`INGEST_JOB`** → **`background/ingest.js`** only. If you still see odd behavior, open `chrome://extensions` → Adobe Acrobat → **Details** → **Site access** → restrict or remove `linkedin.com`, or disable that extension while scanning.

**`background/ingest.js`** parses ingest responses with `res.text()` then `JSON.parse` so non-JSON bodies fail gracefully instead of throwing.
