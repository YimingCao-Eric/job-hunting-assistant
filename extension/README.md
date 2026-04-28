# Job Hunting Assistant — Chrome extension

## Overview

This extension automates scanning job search result pages on **LinkedIn** (`linkedin.com/jobs`), **Indeed Canada** (`ca.indeed.com/jobs`), and **Glassdoor Canada** (`glassdoor.ca` / `www.glassdoor.ca`), extracts job details, and **POST**s each job to the Job Hunting Assistant backend (`/jobs/ingest`) using the token and base URL stored in `chrome.storage.local`. **`GET /config`** supplies `config.website`, nested **`config.glassdoor`** (keyword/location slugs, filters), and Indeed/LinkedIn fields; **`background/scan_manual.js`** `handleManualScan(options)` uses **`effectiveWebsite`** (`options.websiteOverride` from **`GET /extension/pending-scan`** when set, else `config.website`, else `"linkedin"`) to choose URL builders (`buildSearchUrl` / `buildIndeedSearchUrl` / **`buildGlassdoorSearchUrl`**), **`scanConfig.website`**, and run-log `search_filters`.

**Starting a scan (two paths):** (1) **Web app — Jobs page** — `POST /extension/trigger-scan` with body `{"website":"linkedin"|"indeed"|"glassdoor"}` (and optional **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** for **Scan All**). The backend stores the request on **`extension_state`**; **`background/poll.js`** polls **`GET /extension/pending-scan` every 3s** and calls `handleManualScan({ websiteOverride, scan_all, scan_all_position, scan_all_total })` when `pending` is true. **Scan All** sends metadata so each run log row records position/total; the **backend** runs **sync dedup** only after the **last** site completes (not the extension). (2) **Extension popup — Scan Now** — sends **`MANUAL_SCAN`** with no override; `handleManualScan()` runs with `effectiveWebsite` from config only (no Scan All metadata).

The service worker coordinates scans, forwards ingest requests from content scripts, updates run logs and extension state on the backend, and closes the scan window (popup) when a run finishes. **Scan debug trace:** content scripts use **`JhaDebug`** (`content/shared/debug_logger.js`) to record structured events (pagination, cards, session checks, etc.) in **`chrome.storage.local.debugLog`**; the background worker flushes batches to **`POST /extension/run-log/{runId}/debug`** and sends a final flush when the run completes (**`scan_completion.js`**). The web app **Logs** page can show and export this stream per run. **Dedup** runs on the server (`POST /jobs/dedup` or automatic after run completion when `dedup_mode` is sync). Post-scan dedup is scheduled with **`asyncio.create_task`** so closing the extension tab does not cancel it. **Matching** (CPU/LLM job-description extraction, gates, CPU scoring, optional LLM re-score) is **web-app only**: open the **Matching** page in the JHA UI (`/matching`), which calls `POST /jobs/match` with modes such as `cpu_only`, `llm_extraction_gates`, `cpu_score`, or `llm_score` (queued on the server as a detached task) and polls match reports — the extension does not invoke those endpoints. **Issue reports** (flag on job cards → `POST /jobs/{id}/report`) and the **Logs → Reports** tab are also **web-app only**. The **popup** (`popup/popup.html`) lets the user set the backend URL, trigger **Scan Now** (`MANUAL_SCAN`), stop a scan, and see live progress read from storage. Full config (including `website`, `indeed_*`, nested **`glassdoor`**, **`dedup_mode`**, **`llm`**) is edited on the **web Config page** or via `PUT /config` — see repo root `README.md`. Run history, dedup reports, pipeline match reports, and issue reports live in the **web app** (**Logs**); the extension does not render those UIs.

## Architecture

```
extension/
├── manifest.json                    Chrome extension manifest (MV3)
├── background/
│   ├── background.js                Service worker entry — importScripts() loads modules below
│   ├── keepalive.js                 Periodic no-op to reduce MV3 worker suspension
│   ├── progress_mirror.js           Debounced PUT of **`liveProgress`** counters → **`PUT /extension/run-log/{id}`** (so the web UI/WebSocket sees mid-scan progress)
│   ├── settings.js                  Cached backendUrl / authToken from storage
│   ├── config_fetch.js              GET /config and f_TPR computation from run logs
│   ├── search_urls.js               LinkedIn, Indeed & Glassdoor job search URL builders
│   ├── scan_manual.js               handleManualScan — reset state, run log, 90min safety timer, open scan in popup window
│   ├── ingest.js                    POST /jobs/ingest (job payload from content scripts)
│   ├── debug_flush.js               DEBUG_LOG_FLUSH → POST /extension/run-log/{id}/debug
│   ├── runtime_messages.js          chrome.runtime.onMessage router (ingest, tab nav, etc.)
│   ├── scan_completion.js           On scanComplete in storage → PUT run-log, close tab
│   ├── tabs_safety.js               Clear scan state if user closes tab mid-scan
│   ├── poll.js                      Poll backend for pending-scan / pending-stop
│   └── startup.js                   Clear stale scan flags on browser startup
├── content/
│   ├── content_style.css            Shared styles (e.g. scan overlay classes where used)
│   ├── shared/
│   │   ├── utils.js                 sleep()
│   │   ├── debug_logger.js          JhaDebug — emit / batch flush scan trace events
│   │   ├── delays.js                SCAN_DELAYS (scroll pacing; used by linkedin/scroll.js)
│   │   ├── messaging.js             ingestJob() + recordSkip() → INGEST_JOB
│   │   └── init_helpers.js          **`runScanPipeline`** — shared boot/session/overlay/scan lifecycle for site **`init.js`**
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
│   └── glassdoor/                   Shared scripts + **`content/indeed/overlay.js`** (corner banner); **`init.js` last**
│       ├── parse.js                 parseGlassdoorCard — DOM fields + jl from card/listing URL
│       ├── fetch_jd.js              GET job-listing HTML → __NEXT_DATA__ / JSON-LD / DOM; directApply → easy_apply
│       ├── process.js               Per-card JD + INGEST_JOB (phantom / rateLimited handling)
│       ├── page.js                  scanGlassdoorPage — cards loop, early stop, rate-limit cooldown
│       └── init.js                  Manual: scanInProgress + scanConfig.website===glassdoor → scan + scanComplete; else optional debounced auto-scan (GET_CONFIG, SCAN_STARTED, SCAN_COMPLETE)
└── popup/
    ├── popup.html                   Extension toolbar popup UI
    ├── popup.css                    Popup layout and typography
    └── popup.js                     Settings save/load, MANUAL_SCAN / STOP_SCAN, progress polling
```

## Chrome Extension Constraints

**Manifest permissions** include **`windows`** (with **`tabs`**, **`storage`**, **`scripting`**, **`activeTab`**) so the background script can open the search URL in a **separate popup window** via `chrome.windows.create` and remove the scan tab by id on completion or force-stop.

**Content scripts** listed under `manifest.json` → `content_scripts` → `js` are plain scripts: they **do not** support `import` / `export` (no ES modules). Chrome injects them **in order** into a **shared global scope** for that match pattern. **LinkedIn, Indeed, and Glassdoor** load **`content/shared`** in the same order: **`utils`**, **`debug_logger`**, **`delays`**, **`messaging`**, **`init_helpers`** (then site-specific scripts); Glassdoor then loads **`content/indeed/overlay.js`** before its **`glassdoor/*.js`** files. Each bundle ends with **`init.js`** (or **`init.js`'s entry**) so dependents are defined earlier.

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
| `getSettings()` | Returns `backendUrl` and `authToken` from `chrome.storage.local` with a 30s in-memory cache. |

### `background/config_fetch.js`

| Function | Description |
| --- | --- |
| `fetchConfig()` | GETs `/config` from the backend using the stored token. |
| `computeFtpr(fTprBound)` | Computes LinkedIn `f_TPR` time filter from the last completed run log and bound hours. |

### `background/search_urls.js`

| Function | Description |
| --- | --- |
| `buildSearchUrl(config, f_tpr, startOffset)` | Builds LinkedIn job search URL with filters and pagination offset. |
| `buildIndeedSearchUrl(config, startOffset)` | Builds Indeed Canada job search URL with Indeed-specific query params (single **`jt`** from internship shortcut or **`indeed_jt`**). |
| `buildGlassdoorSearchUrl(config)` | Builds Glassdoor Canada SERP URL from `config.glassdoor` (location/keyword slugs, `SRCH_IL` path segment, `fromAge` and other query params; single **`jobType`** when set). |

### `background/scan_manual.js`

| Function | Description |
| --- | --- |
| `handleManualScan(options)` | Optional **`websiteOverride`** (from poll). Optional **`scan_all`**, **`scan_all_position`**, **`scan_all_total`** — when `scan_all` is true, these are included on **`POST /extension/run-log/start`** so the backend can attach Scan All metadata to the run log. Computes **`effectiveWebsite`** and uses it for **LinkedIn vs Indeed vs Glassdoor** branching, `scanConfig.website`, run-log `search_filters`, and search URL. Clears `stopRequested`, removes `scanPageState`, returns early if a scan is already in progress. PUTs **`/extension/state`** (stop flag + page counters), fetches config, `computeFtpr` for LinkedIn. **`POST /extension/run-log/start`** with body above, then **`chrome.windows.create`**, stores `scanConfig` / `liveProgress`, **`startKeepAlive()`**, **90-minute** safety timeout. |

### `background/debug_flush.js`

| Function | Description |
| --- | --- |
| `handleDebugLogFlush(runId, events)` | POSTs **`{ events }`** to **`/extension/run-log/{runId}/debug`**; on failure may retry with a trimmed payload. |

### `background/ingest.js`

| Function | Description |
| --- | --- |
| `handleIngest(job)` | Serializes the job (strips `voyager_raw` if needed) and POSTs to `/jobs/ingest`. Reads **`res.text()`** and **`JSON.parse`** so non-JSON responses return **`null`** instead of throwing. |

### `background/runtime_messages.js`

| Function | Description |
| --- | --- |
| *(listener)* | On **every** message, **`stopKeepAlive()` + `startKeepAlive()`** to reset the keepalive timer while the SW handles work. Dispatches `MANUAL_SCAN`, `INGEST_JOB`, **`DEBUG_LOG_FLUSH`** (batched debug events → **`debug_flush.js`**), `GET_TAB_ID`, `GET_EXTENSION_STATE`, `PUT_EXTENSION_STATE`, `STOP_SCAN`, `TRIGGER_STOP`, `NAVIGATE_SCAN_TAB`, `SESSION_ERROR`, **`GET_CONFIG`** (GET `/config` for Glassdoor content scripts), **`CHECK_STOP`**, **`SCAN_STARTED`** (POST run-log for auto Glassdoor), **`SCAN_COMPLETE`** (PUT run-log for auto Glassdoor), **`GET_MAIN_WORLD_VALUE`** (Indeed API key in main world) to the appropriate handlers. |

### `background/scan_completion.js`

| Function | Description |
| --- | --- |
| *(listener)* | On `scanComplete` in storage, clears scan timeout, **PUT**s **`/extension/run-log/{runId}`** with `status: "completed"`, counters (`pages_scraped`, `scraped`, `new_jobs`, `existing`, `stale_skipped`, `jd_failed`, `early_stop`), and **`errors`** (from `summary.errors` / `pushScanError`, max **200** per site), then removes `scanComplete` / `scanPageState` from storage, sets **`lastRunSummary`**, removes the scan tab (`chrome.tabs.remove`). |

### `background/tabs_safety.js`

| Function | Description |
| --- | --- |
| *(listener)* | On tab removal, clears `scanInProgress` if no `scanComplete` is pending. |

### `background/poll.js`

Both triggers use **`setInterval(..., 3000)`** (3s).

| Function | Description |
| --- | --- |
| `pollForScanTrigger()` | GETs `/extension/pending-scan`; the backend **atomically** read-and-clears the pending scan and returns **`website`**, **`scan_all`**, **`scan_all_position`**, **`scan_all_total`**. If `pending`, calls `handleManualScan({ websiteOverride, scan_all, scan_all_position, scan_all_total })`. |
| `pollForStopTrigger()` | GETs `/extension/pending-stop`; the backend **atomically** read-and-clears `stop_requested`. If `pending`, sets `stopRequested`, **`chrome.tabs.remove(scanConfig.tabId)`** if present, clears scan-related storage (`scanInProgress`, `scanConfig`, `scanPageState`, `liveProgress`, …), clears the **90-minute** timeout id, calls **`stopKeepAlive()`** — in addition to content scripts seeing `stopRequested`. |

### `background/startup.js`

| Function | Description |
| --- | --- |
| *(listener)* | On `chrome.runtime.onStartup`, clears stale `scanInProgress` / `liveProgress`. |

### `content/shared/debug_logger.js`

| Symbol | Description |
| --- | --- |
| `JhaDebug` | **`init(runId, scanStartMs)`**, **`emit(type, payload?)`** (truncates long strings / redacts credential-like keys), **`setPage(n)`**, **`finalize()`** — batches events to storage and **`DEBUG_LOG_FLUSH`** (every **100** events or **5s**). |

### `content/shared/utils.js`

| Function | Description |
| --- | --- |
| `sleep(ms)` | Returns a Promise that resolves after `ms` milliseconds. |

### `content/shared/delays.js`

| Constant | Description |
| --- | --- |
| `SCAN_DELAYS` | `fast` / `normal` / `slow` → `{ scroll: [minMs, maxMs] }` for LinkedIn **`scrollDelay()`** (uses **`normal`** only). |

### `content/shared/messaging.js`

| Function | Description |
| --- | --- |
| `ingestJob(jobData)` | **`_swHeartbeat`** + **150ms**, then **`INGEST_JOB`** with **`correlationId`**. Background **acks immediately** and returns the real payload via **`INGEST_JOB_RESULT`**. Waits up to **60s** per attempt for **`INGEST_JOB_RESULT`**, then retries (**3** attempts, **1s / 2s / 3s** backoff). |
| `recordSkip(website, cardData, reason, runId)` | Same **`correlationId` / `INGEST_JOB_RESULT`** pattern as `ingestJob`. |

### `content/linkedin/constants.js`

| Constant | Description |
| --- | --- |
| `JOB_CARD_SELECTORS` | Ordered list of selectors to find job cards in the LinkedIn jobs list DOM. |
| `NEXT_BUTTON_SELECTORS` | Ordered list of selectors for the pagination “next” control. |

### `content/linkedin/scroll.js`

| Function | Description |
| --- | --- |
| `scrollDelay()` | Random wait using the `scroll` range in `SCAN_DELAYS.normal` (for list virtualization pacing). |

### `content/linkedin/dom.js`

| Function | Description |
| --- | --- |
| `getCards(silent)` | Finds job cards using `JOB_CARD_SELECTORS`. |
| `waitForCards(timeoutMs)` | Stabilization: **≥25** cards, or **>0** count stable **1s**, or timeout; else returns last **`getCards(true)`**. |
| `getJobId(card)` | Reads LinkedIn job id from attributes or job view link. |
| `checkSession()` | Returns session status: `live`, `captcha`, `expired`, or `redirected`. |
| `reportSessionError(error)` | Sends `SESSION_ERROR` with the error key. |
| `extractCardData(card)` | Title, company, location, time, URL, easy apply from the card DOM. |

### `content/linkedin/voyager.js`

| Function | Description |
| --- | --- |
| `getCsrfToken()` | Extracts CSRF token from `JSESSIONID` cookie for Voyager requests. |
| `fetchJDViaVoyager(jobId)` | Direct **`fetch()`** to Voyager job postings API. Up to **2** attempts, **500ms** apart. Accepts any **non-empty** trimmed JD text. Company name comes from the card DOM (`extractCardData`), not a second Voyager entities call. Omits **`voyager_raw`** from ingest payloads. |

### `content/linkedin/process.js`

| Function | Description |
| --- | --- |
| `pushScanError(counters, entry)` | Caps **`errors`** at **200** entries for run logs. |
| `processCard(card, config, counters, preExtractedCardData?)` | Uses **`preExtractedCardData`** when provided (from **`page.js`**); else **`extractCardData(card)`**. Voyager JD + ingest: if **`apply_url`** is LinkedIn **`job-apply`**, sets **`easy_apply: true`** and **`apply_url: null`** (platform apply); otherwise keeps external ATS URL. |

### `content/linkedin/page.js`

| Function | Description |
| --- | --- |
| `runSinglePage(config, state, processedJobIds)` | After **`waitForCards`**: skip duplicate **`job_id`**; **`extractCardData`**; **`processCard(..., cardData)`**. Persists **`processed_job_ids`** in **`scanPageState`**. Bottom scroll, **`NAVIGATE_SCAN_TAB`** for multi-page scans. |

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
| `extractCardData(anchor)` | Reads title, company, location, snippets, and viewjob URL from card DOM (card may still expose easy-apply hints; **`processCard`** uses only the job-page **`detectIndeedEasyApply()`** for the stored **`easy_apply`** flag). |

### `content/indeed/rate_strategy.js`

| Function | Description |
| --- | --- |
| `fetchIndeedJD(jk)` | Indeed JD extraction via **`apis.indeed.com/graphql`** with a **10s `AbortController`** timeout. **`oneGraphApiKey`** is read from the page via **`GET_MAIN_WORLD_VALUE`**. Returns `{ jd }` when text is non-empty after trim, `{ rateLimited: true }`, `{ phantom: true }` (timeout / HTTP / GraphQL / empty job), or `null` if no API key. |

### `content/indeed/fetch_jd.js`

| Function | Description |
| --- | --- |
| *(comment only)* | Notes that **`fetchIndeedJD`** is defined in **`rate_strategy.js`** (load order: `rate_strategy.js` before `process.js`). |

### `content/indeed/process.js`

| Function | Description |
| --- | --- |
| `pushScanError(counters, entry)` | Same cap (**200**) as LinkedIn/Glassdoor for run-log **`errors`**. |
| `parseIndeedPostDate(snippets)` | Derives ISO **`post_datetime`** from card snippet lines (e.g. “30 days ago”, “just posted”) when parseable; else `null`. |
| `processCard(anchor, config, counters)` | Validates `jk`, fetches JD. **`easy_apply`** is determined only by **`detectIndeedEasyApply()`** (sync DOM on the job view: Indeed apply widget / buttons — no async **`executeScript`** from this file). **`apply_url`** is **`null`** when easy apply, else the viewjob URL. Calls `ingestJob` with Indeed fields (including **`post_datetime`** from **`parseIndeedPostDate`**), updates counters. |

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
| `ensureIndeedRunLog(config)` | If **`config.runId`** is missing, **POST**s **`/extension/run-log/start`** using **`backendUrl` / `authToken`** from storage (Indeed-shaped body), persists **`runId`** on **`scanConfig`**. Ensures a run log exists **before** overlay / card processing when the background did not attach an id. |
| `init()` | After **`scanConfig`** exists, calls **`ensureIndeedRunLog`** first (first backend touch for logging). Then: **`tabId`** guard, overlay, **`runSinglePage`**, **`scanComplete`**. Same high-level control flow as LinkedIn otherwise. |

### `content/glassdoor/parse.js`

| Function | Description |
| --- | --- |
| `parseGlassdoorCard(cardEl)` | Reads job id, title, company, location, salary, easy apply, age text, listing URL, and **`jl`** (listing id). |

### `content/glassdoor/fetch_jd.js`

| Function | Description |
| --- | --- |
| `fetchGlassdoorJD(jobUrl, jl)` | **GET** the job-listing **`jobUrl`** (`credentials: include`, **20s** abort). Parses JD from **`__NEXT_DATA__`**, JSON-LD, or DOM. Reads JSON-LD **`JobPosting.directApply`** for **`easy_apply`**. **429/503** → **`{ rateLimited: true, easy_apply: false }`**; phantom → **`{ phantom: true }`**; success → **`{ jd, easy_apply }`**. |

### `content/glassdoor/process.js`

| Function | Description |
| --- | --- |
| `pushScanError(counters, entry)` | Caps **`errors`** at **200** for run logs (same pattern as LinkedIn/Indeed). |
| `processGlassdoorCard(cardEl, config, counters)` | `INGEST_JOB` with **`{ job }`** (not `ingestJob()` helper). Ingest uses **`post_datetime: null`**. When **`easy_apply`** is true, **`apply_url`** is **`null`** (listing URL stays on **`job_url`**). Handles phantom (stale_skipped), rateLimited, jd_failed, duplicates. |

### `content/glassdoor/page.js`

| Function | Description |
| --- | --- |
| `scanGlassdoorPage(config, runId)` | Finds cards, loops with **`CHECK_STOP`**, **`processGlassdoorCard`**, inter-card pacing (**`interCardPacingMs`**), optional rate-limit cooldowns. |

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
| `loadConfig()` | GETs `/config` and fills **only** the fields listed in `CONFIG_FIELDS` in `popup.js` (keyword, location, `f_tpr_bound`, experience/job-type/remote filters, `salary_min`). **There are no popup inputs for `website`, `indeed_*`, or nested `glassdoor`** — configure those via the **web app Config page** or PUT `/config` directly; the service worker still reads the full config from the backend when a scan starts. |
| `saveSettings()` | Writes `backendUrl` and `authToken` to storage and PUTs the same **subset** of config keys as `loadConfig()`. |
| `startScan()` | Hides scan button, sends `MANUAL_SCAN`, starts progress polling. |
| `stopScan()` | Sends `STOP_SCAN` and updates UI. |
| `startPolling()` | `setInterval` for `pollProgress`. |
| `stopPolling()` | Clears the interval. |
| `pollProgress()` | Reads `liveProgress` / `lastRunSummary` from storage and updates UI. |
| `renderSummary(s)` | Renders last run statistics. |

## Data Flow

1. **Scan start** — either:
   - **Web app:** user clicks **Scan LinkedIn**, **Scan Indeed**, or **Scan Glassdoor** → **`POST /extension/trigger-scan`** with `website` only; **Scan All** also sends **`scan_all`**, **`scan_all_position`**, **`scan_all_total`**. On the next poll, **`pollForScanTrigger()`** calls `handleManualScan` with override + Scan All fields. **or**
   - **Popup:** user clicks **Scan Now** → `popup.js` sends `{ type: "MANUAL_SCAN" }` → **`handleManualScan()`** with no override (site from `config.website`).
2. `background/scan_manual.js` `handleManualScan()` clears `scanPageState`, **PUT**s extension state, GETs config, **`POST /extension/run-log/start`** (including **`scan_all`** fields when present), builds the search URL, opens a **popup window**, stores `scanConfig` / `liveProgress`, **90-minute** safety timeout.
3. **LinkedIn:** `init()` → `runSinglePage()` → job ids from **`data-occludable-job-id`** + Voyager + **`ingestJob`**. **Indeed:** `init()` runs **`ensureIndeedRunLog`** when needed, then loops **`processCard()`** over result cards. **Glassdoor:** `glassdoorMain()` waits for **`scanInProgress`** + **`scanConfig.website === "glassdoor"`**, then **`scanGlassdoorPage()`** → **`processGlassdoorCard()`** (single SERP page; completion via **`scanComplete`** like other sites).
4. **LinkedIn:** `fetchJDViaVoyager()` → Voyager APIs → `ingestJob()` sends `{ type: "INGEST_JOB", job }`. **Indeed:** `fetchIndeedJD()` in **`rate_strategy.js`** (GraphQL + **10s** abort) → same `ingestJob()` path. **Glassdoor:** `fetchGlassdoorJD()` (job-listing HTML + **`__NEXT_DATA__`**) → **`processGlassdoorCard`** sends `{ type: "INGEST_JOB", job }` directly (does not use `shared/messaging.js`).
5. `background/ingest.js` `handleIngest()` POSTs to `/jobs/ingest`; the backend persists the job.
6. **`post_datetime` on ingest:** **LinkedIn** — card `<time datetime>` and/or Voyager **`listedAt`** (see `content/linkedin/process.js`). **Indeed** — **`parseIndeedPostDate`** from card snippet text when it matches posted/active patterns (`content/indeed/process.js`). **Glassdoor** — **`null`** (listing age is not sent). The web app Jobs page may show “Posted” / “Scraped” using **`post_datetime`** and **`created_at`** for **LinkedIn** jobs only; other sites omit that row in the UI.
7. The web app (or other client) loads jobs via the backend API (e.g. GET `/jobs`); the extension popup only mirrors **live** counters from `chrome.storage.local` (`liveProgress`), not the full job list.
8. When a page finishes without navigating onward, or on error, `init()` sets `scanComplete` in storage → `scan_completion.js` PUTs the run log as completed and closes the scan tab/window.

## Message Reference

| Type | Payload | Sent from | Handled in |
| --- | --- | --- | --- |
| `MANUAL_SCAN` | *(none)* | `popup/popup.js` | `background/runtime_messages.js` → `handleManualScan()` |
| `DEBUG_LOG_FLUSH` | `{ runId, events }` | `content/shared/debug_logger.js` | `background/runtime_messages.js` → **`handleDebugLogFlush`** (`debug_flush.js`) |
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
| `debugLog` | While a scan runs: `{ runId, scanStartMs, events[], lastFlushAt }` for **`JhaDebug`**; cleared after final flush to the API (or on tab-safety cleanup). |
| `backendUrl`, `authToken` | Connection settings (`settings.js`, popup). |

Other keys may appear for short periods during saves or errors.

## Troubleshooting

**Indeed scan hangs or long stalls:** The Indeed GraphQL JD fetch uses a **10s** abort; slow or stuck network calls return **`phantom`** instead of blocking indefinitely. **Easy apply** is detected with synchronous DOM checks in **`process.js`** only (no **`executeScript`** from the content script). The **`GET_MAIN_WORLD_VALUE`** path (background **`executeScript`**) exists solely to read **`oneGraphApiKey`** for GraphQL — if that fails, **`fetchIndeedJD`** returns **`null`** and the card is skipped as JD failed.

**JD / ingest failures on LinkedIn with mysterious “Internal Server Error” plain-text responses:** Some browser extensions (notably **Adobe Acrobat**) inject into LinkedIn and override `window.fetch`. Content scripts must **never** `fetch` the JHA backend directly; job ingest uses **`INGEST_JOB`** → **`background/ingest.js`** only. If you still see odd behavior, open `chrome://extensions` → Adobe Acrobat → **Details** → **Site access** → restrict or remove `linkedin.com`, or disable that extension while scanning.

**`background/ingest.js`** parses ingest responses with `res.text()` then `JSON.parse` so non-JSON bodies fail gracefully instead of throwing.
