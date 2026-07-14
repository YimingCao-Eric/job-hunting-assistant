# JHA Extension — Onboarding Walkthrough of the Scan Algorithm

> **Audience:** A new teammate joining the JHA project. You can read code,
> but you may not know Chrome extensions, FastAPI, or the JHA codebase.
> This document is your guided tour from the moment a user clicks
> "Scan LinkedIn" in the web UI to the moment a job appears in the database.
>
> **What you'll get:**
> - The full end-to-end algorithm in 8 phases, each explained step by step
> - Every code block cited as `path/to/file.js:line-range` so you can read along
> - Every technical term explained the first time it appears
> - Inline notes about known bugs that affect each phase, with fix suggestions
> - "Unreasonable behavior" flags — places where the code does something
>   surprising, with my recommendation for what to do about it
>
> **How to use this:** Read sections 1-3 sequentially to get the high-level
> picture. Then either keep reading section by section, or jump to the phase
> you need to understand. Each phase is self-contained.
>
> **Source:** Live code reading session 2026-04-25, plus
> `bugs-summary.md` from 2026-04-22.

---

## Table of Contents

1. [What is JHA and what does it do?](#1-what-is-jha-and-what-does-it-do)
2. [Glossary — terms you'll see throughout](#2-glossary--terms-youll-see-throughout)
3. [System topology — how the pieces fit together](#3-system-topology--how-the-pieces-fit-together)
4. [The 8 phases of a scan, at a glance](#4-the-8-phases-of-a-scan-at-a-glance)
5. [Phase 1 — Frontend trigger (the user clicks a button)](#5-phase-1--frontend-trigger-the-user-clicks-a-button)
6. [Phase 2 — Backend stores the scan request](#6-phase-2--backend-stores-the-scan-request)
7. [Phase 3 — Service worker polls and consumes the request](#7-phase-3--service-worker-polls-and-consumes-the-request)
8. [Phase 4 — `handleManualScan` orchestrates setup](#8-phase-4--handlemanualscan-orchestrates-setup)
9. [Phase 5 — Content script boots inside the popup tab](#9-phase-5--content-script-boots-inside-the-popup-tab)
10. [Phase 6 — Per-card scrape and ingest loop](#10-phase-6--per-card-scrape-and-ingest-loop)
11. [Phase 7 — Pagination — getting to the next page of results](#11-phase-7--pagination--getting-to-the-next-page-of-results)
12. [Phase 8 — Completion and optional sync dedup](#12-phase-8--completion-and-optional-sync-dedup)
13. [Scan All — sequential three-site orchestration](#13-scan-all--sequential-three-site-orchestration)
14. [The debug trace system (cuts across all phases)](#14-the-debug-trace-system-cuts-across-all-phases)
15. [Error and recovery paths](#15-error-and-recovery-paths)
16. [Storage state reference](#16-storage-state-reference)
17. [Per-site behavioural differences](#17-per-site-behavioural-differences)
18. [Unreasonable behaviors I noticed (with fix suggestions)](#18-unreasonable-behaviors-i-noticed-with-fix-suggestions)
19. [Appendix A — Complete end-to-end timeline (LinkedIn single-site)](#19-appendix-a--complete-end-to-end-timeline-linkedin-single-site)
20. [Appendix B — Documented vs. code discrepancies](#20-appendix-b--documented-vs-code-discrepancies)
21. [Cleanup batch retrospective (Prompts 1-5c, April 2026)](#21-cleanup-batch-retrospective-prompts-1-5c-april-2026)
22. [Issues discovered during verification (B-31, B-32, B-33)](#22-issues-discovered-during-verification-b-31-b-32-b-33)
23. [Auto-scrape system — what shipped (Phases 1-7.1)](#23-auto-scrape-system--what-shipped-phases-1-71)
24. [Auto-scrape architecture in detail](#24-auto-scrape-architecture-in-detail)
25. [Bugs found and fixed during auto-scrape rollout](#25-bugs-found-and-fixed-during-auto-scrape-rollout)
26. [The 5-hour validation run (2026-04-29)](#26-the-5-hour-validation-run-2026-04-29)
27. [Operations guide for auto-scrape](#27-operations-guide-for-auto-scrape)
28. [Per-source scrape tables — the schema redesign (May 2026)](#28-per-source-scrape-tables--the-schema-redesign-may-2026)
29. [Auto-expiration mechanism](#29-auto-expiration-mechanism)
30. [The `matched` mechanism — claim-and-flag for matching](#30-the-matched-mechanism--claim-and-flag-for-matching)
31. [Iterative conflict-scan workflow (six rounds)](#31-iterative-conflict-scan-workflow-six-rounds)
32. [Post-scrape orchestrator integration (Step 7)](#32-post-scrape-orchestrator-integration-step-7)
33. [Lessons learned & operating principles](#33-lessons-learned--operating-principles)
34. [Verification methodology — patterns that work](#34-verification-methodology--patterns-that-work)
35. [Cycle 455 incident — false-fail accounting bug (2026-05-07)](#35-cycle-455-incident--false-fail-accounting-bug-2026-05-07)
36. [What's deferred and what comes next](#36-whats-deferred-and-what-comes-next)

---

## 1. What is JHA and what does it do?

JHA (Job Hunting Assistant) is a personal job-search automation system. The user installs a **Chrome extension** that knows how to scrape job listings from LinkedIn, Indeed Canada, and Glassdoor Canada. They run a **web dashboard** in their browser (a React app) that lets them configure searches, view results, and trigger scans. Behind both of those is a **FastAPI backend** that stores everything in **PostgreSQL**.

The "scan" is the core feature this document explains. When the user clicks "Scan LinkedIn" in the dashboard, the extension opens LinkedIn's job search page in a new window, scrolls through the results, fetches the full job description for each posting, and sends each one to the backend, which stores it in a `scraped_jobs` table.

Once jobs are in the database, two later stages process them:

- **Stage 2 (Dedup):** Removes duplicates so the user isn't shown the same job twice.
- **Stage 3 (Matching):** Compares each job to the user's profile and assigns a match score.

This document covers **only Stage 1 (the scan).** Stages 2 and 3 are described in their own design docs (`step2-dedup-design.md`, `step3-match-design.md`).

---

## 2. Glossary — terms you'll see throughout

These terms come up repeatedly. Skim this section now; come back when something is unfamiliar.

**Chrome extension (MV3).** A browser plugin. "MV3" means **Manifest V3** — the current Chrome extension API version. The relevant file is `extension/manifest.json`, which declares what scripts the browser should run, on which pages, and what permissions the extension has.

**Service worker (SW).** In MV3, the extension's background logic runs in a **service worker** — a JavaScript context with no UI that Chrome starts when needed and **suspends after about 30 seconds of inactivity** to save resources. This is a *huge* deal for our system because anything we want to keep running between scans must survive suspension. Our SW lives in `extension/background/background.js`.

**Content script.** JavaScript that the extension injects into a *web page* (e.g. linkedin.com). It can read and modify the page's DOM but cannot make backend API calls reliably (other extensions like Adobe Acrobat may wrap `window.fetch` and corrupt responses). All backend communication is delegated to the service worker. Our content scripts live under `extension/content/{linkedin,indeed,glassdoor,shared}/`.

**Popup window.** A separate Chrome window we open for scanning, distinct from the user's main browser window. We use `chrome.windows.create({type: "popup"})` so it has no toolbar and won't be confused with the user's tabs. Important: the popup window is *not* the same as the popup that appears when you click the extension icon in the toolbar (that's `extension/popup/popup.html`).

**`chrome.storage.local`.** A small key-value store provided by Chrome, accessible from both the service worker and content scripts. We use it as the in-memory state-of-the-world for an active scan: keys like `scanInProgress`, `scanConfig`, `liveProgress`, `debugLog`. It is NOT the same as the user's browser localStorage on a website.

**Run log.** A row in the `extension_run_logs` PostgreSQL table representing one scan attempt. Has a UUID `id` (called the "runId" elsewhere), a `status` (`running` / `completed` / `failed`), counters (`scraped`, `new_jobs`, etc.), search filters used, and an optional `debug_log` JSONB field containing every diagnostic event emitted during the scan.

**`runId`.** The UUID of a run log. Once the run log is created, this UUID is threaded through every later step: it goes into `scanConfig` storage, into every `INGEST_JOB` payload's `scan_run_id` field, and into the final completion PUT request. It links every job ingested during a scan back to the scan that produced it.

**Voyager.** LinkedIn's *internal* (undocumented, but stable) JSON API. Job descriptions on linkedin.com are loaded via Voyager calls; our extension uses the same calls to fetch JD text efficiently, with the user's session cookie for authentication.

**JD.** Short for "job description." The full body text of a job posting. The thing we actually want to scrape (everything else — title, company, location — is visible on the listing page, but the JD often is not until you click into it).

**JSONB.** PostgreSQL's binary JSON column type. Faster to query than plain JSON. We use JSONB for `extension_run_logs.debug_log`, `extension_run_logs.search_filters`, and similar.

**`asyncio.create_task`.** A Python function that starts a coroutine running in the background and returns immediately. Critically, it is **not tied to the HTTP request lifecycle** — if the client (the extension) disconnects, the task keeps running. We use this for sync-dedup-after-scan (Phase 8). FastAPI also has a `BackgroundTask` class, but that *is* tied to the request: if the client disconnects, the task is cancelled. We avoid `BackgroundTask` for long-running work.

**Bearer token / `dev-token`.** A simple authentication scheme: every API request must include an `Authorization: Bearer <token>` header. In development, the token is the literal string `dev-token`. In production this would be replaced with a real auth system (the README explicitly notes this).

**`scrape_run_id`, `scan_run_id`, `runId`.** All the same thing — the UUID of the run log. The naming is inconsistent across the codebase. I'll use `runId` consistently in this document.

**SPA (Single Page Application).** A website that mutates its URL and DOM without doing a full page reload. LinkedIn's job search is an SPA: clicking "Next page" changes the URL bar but doesn't actually reload the page. Indeed is the opposite — it does a real navigation per page. Glassdoor uses neither; it has a "Show more jobs" button that loads more results inline.

**Ring buffer.** A capped-size append-only collection. When it's full, the oldest entries are discarded to make room for new ones. Our `debug_log` is a ring buffer of 10,000 events per run.

**`Promise.all`, `await`.** Standard JavaScript async patterns. `Promise.all([a, b])` runs `a` and `b` in parallel and waits for both. `await` pauses execution until a promise resolves. Used heavily throughout the extension.

**Correlation ID.** A unique string we generate per ingest request (`ing_<timestamp>_<random>`). It lets us match an asynchronous response back to the request that made it. See Phase 6 for the full pattern.

---

## 3. System topology — how the pieces fit together

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Web UI         │    │  FastAPI         │    │  Postgres 16     │
│  (React/Vite    │◄──►│  Backend         │◄──►│                  │
│   :5173)        │    │  (:8000)         │    │  scraped_jobs    │
└────────┬────────┘    └────────┬─────────┘    │  extension_      │
         │                      │              │    run_logs      │
         │                      │              │  extension_state │
         │                      │              │  dedup_reports   │
         │                      │              │  match_reports   │
         │                      │              └──────────────────┘
         │                      │
         │  poll every 3s ──────┘ (SW polls backend; backend never pushes to SW)
         │
         ▼
┌────────────────────────────────────────────────────────┐
│                Chrome Extension (MV3)                  │
│                                                        │
│  ┌──────────────────────────────────────────────┐     │
│  │ Service Worker (background/*.js)             │     │
│  │   Top-level concerns:                        │     │
│  │   - Polling backend for scan/stop requests   │     │
│  │   - Opening scan windows                     │     │
│  │   - Forwarding ingest requests to backend    │     │
│  │   - Flushing debug logs to backend           │     │
│  └─────────────┬────────────────────────────────┘     │
│                │ chrome.windows.create (popup)        │
│                ▼                                       │
│  ┌──────────────────────────────────────────────┐     │
│  │ Content Scripts (per-site, isolated worlds)  │     │
│  │   Top-level concerns:                        │     │
│  │   - Reading the job listing page DOM         │     │
│  │   - Fetching full JDs (Voyager / GraphQL /   │     │
│  │     HTML, depending on site)                 │     │
│  │   - Per-card pipeline + pagination logic     │     │
│  │   - Emitting trace events for diagnostics    │     │
│  └──────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
                │
                │ Calls site APIs with the user's logged-in cookies
                ▼
       LinkedIn / Indeed CA / Glassdoor CA
```

There are **three places that hold authoritative state**:

1. **PostgreSQL** — the durable record. Jobs, run logs, the `extension_state` mailbox row.
2. **`chrome.storage.local`** — the runtime state of an in-flight scan. Keys like `scanInProgress`, `scanConfig`, `scanComplete`, `debugLog`. Lives only as long as Chrome is running.
3. **React state in the JobsPage component** — what the user sees in the dashboard. Polled every 2 seconds from the backend.

The system uses a **poll-based handoff** between the dashboard and the extension: **the dashboard never talks to the extension directly.** Instead:

- The dashboard writes a request to the backend (`POST /extension/trigger-scan`).
- The extension's service worker polls the backend every 3 seconds (`GET /extension/pending-scan`).
- When the SW sees a pending request, it consumes it (the backend atomically clears the flag) and acts on it.

This indirection is why there's an `extension_state` table at all — it's a one-row "mailbox" that the dashboard writes to and the extension reads from.

> **Why not direct messaging?** Chrome extensions can receive messages from external pages via `externally_connectable`, but that requires the dashboard's origin to be hardcoded into the manifest. Polling avoids that coupling and works the same in dev and production. The cost is up to 3 seconds of latency between click and action — and a serious bug we'll cover in Phase 3 when the SW is suspended (see **BUG-10**).

---

## 4. The 8 phases of a scan, at a glance

Every scan, regardless of which site, follows the same overall flow. The differences between LinkedIn, Indeed, and Glassdoor are mostly inside Phases 6 and 7. Here is the full sequence:

```
Phase 1: Frontend Trigger
   The user clicks "Scan LinkedIn" in the web dashboard.
   The dashboard makes one HTTP call: POST /extension/trigger-scan
   with body {website: "linkedin"}. That's it. The dashboard's
   role is now over until the scan completes; it just polls
   to update its progress UI.
                                ▼
Phase 2: Backend Stores the Request
   The backend writes scan_requested=True (and the website name)
   to row id=1 of the extension_state table — a single mailbox row.
                                ▼
Phase 3: Service Worker Polls and Consumes
   The extension's service worker has been polling
   GET /extension/pending-scan every 3 seconds. When it sees
   pending=true, it atomically clears the flag and calls
   handleManualScan(...).
                                ▼
Phase 4: handleManualScan Orchestrates Setup
   This function is the heart of "starting a scan." It:
     - resets stop flags
     - fetches live config (keyword, location, filters, etc.)
     - computes the time window (LinkedIn's f_TPR parameter)
     - creates a run-log row in the backend, getting a runId
     - builds the search URL for the chosen site
     - opens that URL in a new popup window
     - writes scanInProgress=true, scanConfig=... to chrome.storage.local
     - starts a 5-second keepalive ping
     - sets a 90-minute safety timeout
                                ▼
Phase 5: Content Script Boots Inside the Popup Tab
   The popup loads the search URL. Chrome's manifest matches
   the URL pattern and injects the per-site content scripts
   (e.g. all the linkedin/*.js files). The last script,
   init.js, runs and:
     - waits up to 3 seconds for scanInProgress to appear
     - initializes the debug trace buffer
     - emits a "scan_start" event
     - checks the user is logged in (session check)
     - shows a "Scan in progress" overlay
     - starts a 10-second heartbeat for diagnostics
                                ▼
Phase 6: Per-Card Scrape and Ingest Loop
   For each job card on the current page:
     - Check the stopRequested flag (exit early if set)
     - Read the card's basic data from the DOM
       (title, company, location, jobId)
     - Fetch the full JD from a site-specific source
       (LinkedIn = Voyager API; Indeed = GraphQL;
        Glassdoor = HTML page)
     - Build a JSON payload
     - Send INGEST_JOB message to the SW, which POSTs
       to /jobs/ingest. The backend de-duplicates by URL
       and content hash, then inserts the row.
     - Update local counters and emit trace events.
                                ▼
Phase 7: Pagination
   How we get to the next page differs by site:
     - LinkedIn: click the "Next" button (SPA navigation;
       same content script keeps running)
     - Indeed: read the next-page URL, navigate the tab to it
       (NEW content script invocation per page!)
     - Glassdoor: click "Show more jobs" button (cards are
       appended to the same DOM)
                                ▼
Phase 8: Completion and Optional Sync Dedup
   Content script writes scanComplete to storage.
   The SW's scan_completion.js handler fires:
     - flushes the last debug events
     - PUTs the run-log to status="completed" with final counters
     - stops the keepalive
     - closes the popup window
   The backend's PUT handler checks: was this status change
   "completed"? Is dedup_mode set to "sync"? If yes (and if
   this is the last leg of Scan All), schedule a background
   dedup task that runs in its own DB session.
```

Each phase has its own retry logic and error boundaries. The next 8 sections walk through each one in detail. Read them in order if you want the full picture, or jump to a specific phase if you only need to understand one piece.

---

## 5. Phase 1 — Frontend trigger (the user clicks a button)

**Files involved:**
- `frontend/src/pages/JobsPage.jsx` lines 313-344 (the click handlers)
- `frontend/src/api.js` lines 35-43 (the network call)

### What the user sees

The dashboard's Jobs page has four buttons at the top: 🔵 Scan LinkedIn, 🟢 Scan Indeed, 🟢 Scan Glassdoor, and ▶▶ Scan All. The first three are single-site scans; Scan All runs all three in sequence (covered in Section 13). Each button is rendered with a `disabled` attribute that's true while any scan is in progress, so a frantic user clicking twice will not double-fire.

```jsx
// frontend/src/pages/JobsPage.jsx:424-431
<button
  type="button"
  className={s.scanBtnLinkedIn}
  disabled={scanning || scanAllActive || jobsLoading}
  onClick={handleScanLinkedIn}
>
  🔵 Scan LinkedIn
</button>
```

`scanning`, `scanAllActive`, and `jobsLoading` are all React state variables in the JobsPage component. While any of them is true, the button is greyed out.

### The click handler

When the user clicks Scan LinkedIn, this runs:

```jsx
// frontend/src/pages/JobsPage.jsx:313-322
async function handleScanLinkedIn() {
  try {
    scanTriggerGraceRef.current = Date.now()   // start a 15-second grace window
    setScanning(true)                          // optimistic UI flip
    await api.triggerScan('linkedin')          // POST to backend
  } catch {
    setScanning(false)
    scanTriggerGraceRef.current = 0
  }
}
```

Three things to notice. They look small but each one matters.

**(1) Optimistic UI flip.** The line `setScanning(true)` runs **before** the network call. This is deliberate. The actual run-log row in the database (the source of truth for "is a scan running?") doesn't exist yet — it gets created later, by the *extension*, in Phase 4. There's a window of 3-15 seconds between "user clicks" and "run-log row exists." Without the optimistic flip, the user would click and see absolutely nothing happen for that whole time. So the React state flips immediately, the button greys out, the spinner appears, and the user gets feedback even though nothing has actually happened on the backend yet.

**(2) The 15-second grace window.** `scanTriggerGraceRef.current = Date.now()` records a timestamp using a React `useRef` (which lets us mutate a value without triggering re-renders). Elsewhere, in the polling loop that watches the run-log status, there's a check:

```jsx
// frontend/src/pages/JobsPage.jsx:222, 246-258
const GRACE_MS = 15000
// ...
const inGrace = Date.now() - scanTriggerGraceRef.current < GRACE_MS
if (!inGrace) {
  setScanning(prev => {
    // start a 5s timeout to flip scanning back to false
    // ...
  })
}
```

In plain language: "If 15 seconds have passed since the user clicked and there is *still* no running run-log on the backend, assume the trigger silently failed and flip `scanning` back to false." Without this, a failed trigger would leave the UI stuck spinning forever.

**(3) The dashboard never creates the run log.** The dashboard's only job here is to set a *flag* on the backend saying "please scan." It does **not** call `POST /extension/run-log/start` directly. That call is made later by the service worker in Phase 4, after the SW has consumed the trigger flag. The dashboard just creates a request and waits.

### The API call itself

`api.triggerScan('linkedin')` is a thin wrapper:

```js
// frontend/src/api.js:35-43
triggerScan: (website = null, extra = {}) => {
  const body = { ...extra };
  if (website) body.website = website;
  return fetch(`${BASE_URL}/extension/trigger-scan`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  }).then(r => r.json());
}
```

`BASE_URL` and the auth token come from environment variables:

```js
// frontend/src/api.js:1-7
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const TOKEN = import.meta.env.VITE_AUTH_TOKEN || 'dev-token';

const headers = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
});
```

`import.meta.env.*` is Vite's mechanism for build-time environment variables. In development with default settings, the dashboard talks to `http://localhost:8000` with `Authorization: Bearer dev-token`. Both can be overridden via `.env` for production deployment.

For a single-site scan the request body is just `{"website": "linkedin"}`. For Scan All, the loop will pass `{website, scan_all: true, scan_all_position: 1, scan_all_total: 3}` per leg — we'll see that in Section 13.

### What the dashboard does next

After the POST succeeds, the dashboard's role in actually *starting* the scan is over. From this point forward, the dashboard simply polls the backend every 2 seconds to update its progress display. This is in the `useEffect` at `frontend/src/pages/JobsPage.jsx:220-280`. It calls two endpoints in parallel: `GET /extension/run-log?limit=1` (the most recent run log) and `GET /extension/state` (the mailbox row). When `run.status === 'running'`, the UI shows a spinner and a progress bar. When it flips to `'completed'`, the UI refreshes the job grid.

### Bug notes for this phase

> **BUG-10 affects this phase indirectly.** The dashboard makes its POST request and returns 200 OK, but if the extension's service worker is suspended at this moment (Phase 3), the request will sit unconsumed. The user sees the spinner appear and "Scan in progress…" appear, but no popup window ever opens. After 15 seconds, the grace timer expires and `scanning` flips back to false — but the request is *still* sitting in `extension_state.scan_requested = true` on the backend. Any user activity that wakes the SW (closing a tab, opening a new tab) will then cause the scan to fire belatedly. We'll see the full root-cause analysis in Phase 3.
>
> **Suggested fix from `bugs-summary.md`:** Replace the `setInterval` polling in `extension/background/poll.js` with `chrome.alarms`, which survive SW suspension. Also add a "ping" message from the dashboard to the extension via `chrome.runtime.sendMessage` to give an instant wake.

### Unreasonable behavior in this phase

> **The grace window logic is split across two files in opaque ways.** `handleScanLinkedIn` writes `scanTriggerGraceRef.current = Date.now()`, but the *consumer* of that ref is 100+ lines away in a `useEffect`. A new reader (you, right now) has no way to know about the 15-second grace except by reading both. **Fix suggestion:** Extract the grace logic into a named custom hook like `useScanGrace()` so the two halves live together. Alternatively, add a comment at the click handler pointing to the consumer. Low priority but a nice cleanup.

---

## 6. Phase 2 — Backend stores the scan request

**Files involved:**
- `backend/routers/extension.py` lines 95-122 (`POST /extension/trigger-scan`)
- `backend/models/extension_state.py` (the table model — single row, `id=1`)

### The mailbox table

The backend has a tiny PostgreSQL table called `extension_state`. It is designed to hold **exactly one row**, with `id=1`. That row is a "mailbox" between the dashboard and the extension. The dashboard writes to it; the extension reads from it.

The columns relevant to scan triggering:

| Column | Purpose |
|---|---|
| `scan_requested` | Boolean — true when a scan has been requested but not yet consumed |
| `scan_website` | String — `'linkedin'` / `'indeed'` / `'glassdoor'` (which site to scan) |
| `scan_all` | Boolean — true if this trigger is part of a Scan All sequence |
| `scan_all_position` | Integer — which leg of Scan All (1, 2, or 3) |
| `scan_all_total` | Integer — total number of legs in Scan All (always 3 currently) |
| `stop_requested` | Boolean — true when the user clicked Stop |
| `current_page` | Integer — page counter (used by content scripts) |
| `today_searches` | Integer — daily counter |

Plus a few others not relevant here.

### The trigger endpoint

Here's the full handler:

```python
# backend/routers/extension.py:95-122
@router.post("/trigger-scan")
async def trigger_scan(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
    body: TriggerScanRequest | None = Body(default=None),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)
    row.scan_requested = True
    if body is None:
        row.scan_website = None
        row.scan_all = False
        row.scan_all_position = None
        row.scan_all_total = None
    else:
        row.scan_website = body.website
        row.scan_all = body.scan_all
        row.scan_all_position = body.scan_all_position
        row.scan_all_total = body.scan_all_total
    await db.flush()
    return {"ok": True, "scan_requested": True}
```

What this does, step by step:

1. **Auth check.** `Depends(get_current_user)` runs the bearer-token check. If the `Authorization` header is missing or wrong, FastAPI returns 401 before the handler body runs.

2. **Fetch the mailbox row.** `select(...).where(ExtensionState.id == 1)` builds a SQL query. `.scalar_one_or_none()` runs it and expects either zero or exactly one result.

3. **Lazy initialization.** If the row doesn't exist (first-ever request after a fresh DB), create it. `db.add(row)` stages the new row for insertion.

4. **Set the flags.** `scan_requested = True` is the main signal. The other four fields tell the extension *what* to scan.

5. **Flush.** `await db.flush()` sends the changes to PostgreSQL but does *not* commit the transaction. FastAPI's session lifecycle handles the commit at the end of the request.

6. **Return.** The response body is just `{"ok": True, "scan_requested": True}`. The dashboard doesn't use this body — it just wants to know the request didn't 4xx or 5xx.

### Single-site vs Scan All — what gets written

| Field | Single-site scan | Scan All leg `i` |
|---|---|---|
| `scan_requested` | `True` | `True` |
| `scan_website` | `'linkedin'` / `'indeed'` / `'glassdoor'` | site name for this leg |
| `scan_all` | `False` | `True` |
| `scan_all_position` | `null` | `i+1` (i.e. 1, 2, or 3) |
| `scan_all_total` | `null` | `3` |

The `scan_all_*` fields are critical for the sync-dedup gate in Phase 8: they let the backend tell which leg of Scan All just finished, and only fire dedup after the *last* leg.

### Concurrency caveat

This is **not a queue.** It's a single-row mailbox with last-write-wins semantics. If the user (or an automated test) calls `trigger-scan` twice rapidly before the SW polls, the second call overwrites the first. In practice the SW polls every 3 seconds and there's only one extension instance, so this is fine. But it's worth knowing — if you ever build a "schedule multiple scans" feature, you cannot just call `trigger-scan` in a loop; you have to wait for each one to be consumed first.

### Bug notes for this phase

There are no known bugs in this endpoint specifically. The code is straightforward.

### Unreasonable behavior in this phase

> **The dashboard's "stop" button bypasses this mailbox entirely.** Looking at `backend/routers/extension.py:158-176` (`POST /extension/trigger-stop`), the stop endpoint not only sets `stop_requested = true` in `extension_state`, it *also* directly marks all `running` `extension_run_logs` rows as `failed`:
>
> ```python
> # backend/routers/extension.py:171-177
> await db.execute(
>     update(ExtensionRunLog)
>     .where(ExtensionRunLog.status == "running")
>     .values(
>         status="failed",
>         error_message="Stopped by user",
>         completed_at=datetime.now(timezone.utc),
>     )
> )
> ```
>
> This is "belt-and-suspenders" — the run-log gets cleaned up even if the SW never actually sees the stop signal. But the asymmetry is jarring: trigger-scan only writes a flag and lets the SW do the work, while trigger-stop both writes a flag AND directly mutates run-log state. **Fix suggestion:** None really needed. The asymmetry exists because a stop must succeed even if the extension is unreachable, while a trigger inherently requires a working extension. Worth flagging in a code comment so the next maintainer doesn't think it's a bug.

---

## 7. Phase 3 — Service worker polls and consumes the request

**Files involved:**
- `extension/background/poll.js` (the polling loops)
- `extension/background/background.js` (entry point that loads the SW modules)
- `backend/routers/extension.py` lines 124-161 (`GET /extension/pending-scan`, `GET /extension/pending-stop`)

### The service worker entry point

When Chrome starts up, or when an extension event fires (a tab change, a click on the toolbar icon, an alarm, etc.), the browser starts our service worker. The entry point is `background.js`, which does nothing but load all the other modules:

```js
// extension/background/background.js:3-15
importScripts(
  "keepalive.js",
  "settings.js",
  "debug_flush.js",
  "config_fetch.js",
  "search_urls.js",
  "scan_manual.js",
  "ingest.js",
  "runtime_messages.js",
  "scan_completion.js",
  "tabs_safety.js",
  "poll.js",
  "startup.js"
);
```

`importScripts(...)` is a classic-script API (originally from Web Workers) that loads scripts into the **same global scope**. So functions defined in `keepalive.js` are visible to functions defined in `poll.js`, and so on. The order matters because some files reference functions defined in earlier files.

`poll.js` is loaded near the end and registers two `setInterval` timers:

```js
// extension/background/poll.js:30
setInterval(pollForScanTrigger, 3000);
// extension/background/poll.js:69
setInterval(pollForStopTrigger, 3000);
```

These run forever — every 3 seconds, each function fires. **As long as the service worker is alive.** That qualifier is critical and is the source of BUG-10.

### `pollForScanTrigger`

```js
// extension/background/poll.js:3-21
async function pollForScanTrigger() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/extension/pending-scan`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pending) {
        console.log("[JHA] Scan triggered from frontend");
        await handleManualScan({
          websiteOverride: data.website || null,
          scan_all: !!data.scan_all,
          scan_all_position:
            data.scan_all_position != null ? data.scan_all_position : null,
          scan_all_total:
            data.scan_all_total != null ? data.scan_all_total : null,
        });
      }
    }
  } catch {
    // Backend unreachable — silently skip
  }
}
```

What it does:

1. **Get backend URL and auth token.** `getSettings()` (defined in `settings.js`) returns these from `chrome.storage.local`, with a 30-second TTL cache to avoid hammering storage. Defaults: `http://localhost:8000` and `dev-token`.

2. **Make the GET request.** Standard `fetch` with bearer token.

3. **If `data.pending` is true, call `handleManualScan(...)`** with the website name and Scan All metadata. We'll cover `handleManualScan` in Phase 4.

4. **Errors are silently swallowed.** If the backend is down, the function does nothing and returns. The next 3-second tick will try again. No exponential backoff, no retry counter.

### The atomic-read-and-clear endpoint

The pending-scan endpoint is more interesting than the trigger-scan endpoint:

```python
# backend/routers/extension.py:124-156
@router.get("/pending-scan")
async def pending_scan(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        return {
            "pending": False,
            "website": None,
            "scan_all": False,
            "scan_all_position": None,
            "scan_all_total": None,
        }
    if row.scan_requested:
        row.scan_requested = False
        w = row.scan_website
        sa = row.scan_all
        pos = row.scan_all_position
        tot = row.scan_all_total
        row.scan_website = None
        row.scan_all = False
        row.scan_all_position = None
        row.scan_all_total = None
        await db.flush()
        return {
            "pending": True,
            "website": w,
            "scan_all": sa,
            "scan_all_position": pos,
            "scan_all_total": tot,
        }
    return {
        "pending": False,
        "website": None,
        "scan_all": False,
        "scan_all_position": None,
        "scan_all_total": None,
    }
```

The pattern is **read, clear, return.** When the SW polls and sees `scan_requested = true`, the backend:

1. Captures the current values into local variables
2. Clears the flags back to defaults
3. Flushes the change
4. Returns the captured values as the response

This means a *duplicate* poll on the next 3-second tick will not re-trigger the scan — the flag is already cleared. The handoff is one-shot.

> **Note:** This is not transactionally atomic in the strict sense (no `SELECT ... FOR UPDATE`). If two concurrent pollers were racing each other, you could in theory have a tiny window where both see `pending: true` and both think they have the request. But there's only one SW polling, so this never happens in practice.

### The same pattern for stop

`pollForStopTrigger` is a near-mirror of `pollForScanTrigger`:

```js
// extension/background/poll.js:34-67
async function pollForStopTrigger() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/extension/pending-stop`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pending) {
        await chrome.storage.local.set({ stopRequested: true });

        const { scanConfig } = await chrome.storage.local.get("scanConfig");
        if (scanConfig?.tabId != null) {
          try {
            await chrome.tabs.remove(scanConfig.tabId);
          } catch {
            // tab may already be gone
          }
        }

        const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
        if (scanTimeoutId) {
          clearTimeout(Number(scanTimeoutId));
        }

        await chrome.storage.local.remove([
          "scanInProgress",
          "scanConfig",
          "scanPageState",
          "liveProgress",
          "scanComplete",
          "scanTimeoutId",
        ]);

        stopKeepAlive();
        console.log("[JHA] Force-stopped scan");
      }
    }
  } catch {}
}
```

When stop is consumed, the SW:

1. Sets `stopRequested = true` in storage. Content scripts read this between every card and break out of their loop when they see it.
2. Closes the scan tab via `chrome.tabs.remove`.
3. Cancels the 90-minute safety timeout.
4. Wipes all scan-related storage keys.
5. Stops the keepalive.

### BUG-10 — the SW suspension trap

Now we come to the most important known bug in this phase. From `bugs-summary.md`:

> **BUG-10: Scan trigger sometimes doesn't fire — SW suspension + setInterval**
>
> **Severity:** HIGH — blocks primary user action
>
> **Symptom:** User clicks "Scan" on the dashboard. Nothing happens — no popup window opens. User opens or closes any unrelated tab. Scan then fires correctly, often a minute later.
>
> **Root cause:** `poll.js` uses top-level `setInterval(pollForScanTrigger, 3000)`. In MV3, service worker `setInterval` timers are destroyed when the SW suspends (after ~30 seconds of inactivity). When the SW wakes, `importScripts` re-runs and the `setInterval` is registered fresh — **but only if an event wakes the SW first**. There is no mechanism that wakes the SW on its own.

The failure sequence:

1. User finishes the previous scan; the SW becomes idle.
2. After ~30 seconds of inactivity, Chrome suspends the SW. The `setInterval` timer is destroyed.
3. User clicks "Scan" → backend stores the pending flag.
4. **Nothing wakes the SW.** The polling timer is gone. The dashboard's POST response was 200 OK, but the dashboard never talks to the SW directly.
5. User does something — opens a tab, closes a tab, clicks the extension icon — and Chrome wakes the SW for that event.
6. SW boot re-runs `importScripts`, re-registers the polling intervals.
7. On the next 3-second tick, `pollForScanTrigger` sees the pending flag and the scan finally fires.

> **Why doesn't `keepalive.js` save us?** Look at `keepalive.js`:
>
> ```js
> // extension/background/keepalive.js:5-15
> let keepAliveInterval = null;
> function startKeepAlive() {
>   stopKeepAlive();
>   keepAliveInterval = setInterval(() => {
>     chrome.runtime.getPlatformInfo(() => {});
>     chrome.storage.local.set({ _keepalive: Date.now() });
>   }, 5000);
> }
> ```
>
> `startKeepAlive()` is only called inside `handleManualScan` (Phase 4) — that is, **after a scan has started**. It's stopped after scan completion. Between scans, no keepalive runs. So the SW will inevitably suspend.

### Suggested fix from `bugs-summary.md`

Replace the `setInterval` calls with `chrome.alarms`. Alarms survive SW suspension; Chrome wakes the SW when the alarm fires, runs the listener, then lets the SW re-suspend.

```js
// PROPOSED replacement for setInterval in poll.js
chrome.alarms.create("jha_scan_poll", { periodInMinutes: 0.5 });
chrome.alarms.create("jha_stop_poll", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "jha_scan_poll") pollForScanTrigger();
  else if (alarm.name === "jha_stop_poll") pollForStopTrigger();
});
```

Also requires adding `"alarms"` to the manifest's `permissions` array in `extension/manifest.json`.

**Caveat:** `chrome.alarms` has a minimum period of 30 seconds (`periodInMinutes: 0.5`). The current `setInterval(3000)` polls every 3 seconds. After the fix, clicking Scan will wait *up to* 30 seconds before the extension notices, instead of *up to* 3 seconds. The user-experience tradeoff is that the new behavior is correct *always* (currently it sometimes is correct in 3s, sometimes never until the user does something), and acceptable to most users (30s is not a long wait for a scan that itself takes minutes).

**Optional add-on:** To eliminate the 30s delay entirely, the dashboard could push a wake message directly to the extension via `chrome.runtime.sendMessage(extensionId, ...)`. This requires adding the dashboard's origin to `externally_connectable` in the manifest. Bigger change, defer until the basic alarm fix is in.

This is currently the highest-priority unresolved bug. Fix it before any cosmetic improvements.

### Unreasonable behavior in this phase

> **Two separate polling intervals when one would do.** `poll.js` registers two `setInterval` calls — one for scan polling, one for stop polling. Each fires every 3 seconds. Twice the network requests for no good reason. **Fix suggestion:** Combine them into one polling loop that calls both endpoints in parallel via `Promise.all`. Or better, add a single endpoint `GET /extension/pending` that returns both `pending_scan` and `pending_stop` in one response. Each currently-active scan generates one extra unnecessary HTTP request every 3 seconds, which adds up over a long-running scan (several thousand wasted calls per scan). Worth fixing as part of the BUG-10 chrome.alarms migration.

> **Silent error swallowing makes diagnosis hard.** Both poll functions wrap their fetch in `try { ... } catch {}` with no logging. If the backend is unreachable for an hour, there is no record anywhere — neither in the SW console nor in `chrome.storage.local`. **Fix suggestion:** At minimum, write a `_lastPollError` storage key with the error message and timestamp. Even better, surface this in the popup ("Cannot reach backend at http://localhost:8000"). Right now if the dev forgot to start the backend, the only feedback is "scans never fire" with no clue why.

---

## 8. Phase 4 — `handleManualScan` orchestrates setup

**File involved:**
- `extension/background/scan_manual.js` (the entire file)
- `extension/background/config_fetch.js` (for `fetchConfig` and `computeFtpr`)
- `extension/background/search_urls.js` (for the URL builders)
- `backend/routers/extension.py` lines 211-228 (`POST /extension/run-log/start`)

This is the single most important function in the extension. It transforms "the backend told us to scan website X" into "a fully-configured popup window is open and a content script is about to start scraping." It runs eight steps, in order. Let's walk through each.

### Step 1 — Reset stop flags and check for existing scan

```js
// extension/background/scan_manual.js:11-15
async function handleManualScan(options = {}) {
  // ...destructure options...
  await chrome.storage.local.set({ stopRequested: false });
  await chrome.storage.local.remove("scanPageState");
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (scanInProgress) return;
```

In plain language: clear any leftover stop flag from a previous scan, clear any leftover Indeed page-state, and *bail out* if a scan is already in progress. This prevents two simultaneous scans, which would corrupt shared `chrome.storage.local` state.

If `scanInProgress` is true but the previous scan crashed without cleaning up, it gets cleared by either:
- `extension/background/startup.js` on next browser startup
- `extension/background/tabs_safety.js` if the user closes the scan tab

### Step 2 — Clear backend-side stop and reset extension state

```js
// extension/background/scan_manual.js:17-44
const { backendUrl, authToken } = await getSettings();
try {
  await fetch(`${backendUrl}/extension/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ stop_requested: false }),
  });
} catch (e) {
  console.warn("[JHA] Could not clear stop_requested:", e.message);
}

try {
  await fetch(`${backendUrl}/extension/state`, {
    method: "PUT",
    headers: { /* same as above */ },
    body: JSON.stringify({
      current_page: 1,
      today_searches: 0,
    }),
  });
} catch (e) {
  console.warn("[JHA] scan_manual: could not reset extension state:", e.message);
}
```

Two PUT requests to `/extension/state`. The first clears any leftover `stop_requested` flag (so a stop from a previous session won't immediately cancel this new scan). The second resets `current_page` to 1 and `today_searches` to 0 — both used by content scripts to track progress.

If either request fails, we log and continue. The scan can still proceed without these resets; the worst case is content scripts read stale `current_page` from the previous scan.

### Step 3 — Fetch live config

```js
// extension/background/scan_manual.js:46-50
const config = await fetchConfig();
if (!config) {
  console.log("[JHA] Cannot fetch config — backend unreachable");
  return;
}
```

`fetchConfig` is defined in `config_fetch.js`:

```js
// extension/background/config_fetch.js:3-14
async function fetchConfig() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/config`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}
```

It just GETs `/config` and returns the parsed JSON. The config object has fields like `keyword`, `location`, `f_tpr_bound`, the per-site filter blocks (`indeed_*`, `glassdoor.*`), `dedup_mode`, `llm`, etc.

If the backend is unreachable, `fetchConfig` returns `null` and we abort. The previous Step 2 PUTs are now wasted, but that's fine — they were idempotent.

### Step 4 — Compute the LinkedIn time window (`f_tpr`)

LinkedIn's job search API has a parameter called `f_TPR` (filter Time Posted Range) that takes a value like `r86400` (the `r` prefix means "recent", `86400` is seconds — i.e. "jobs posted in the last 24 hours"). We compute this dynamically based on when the last LinkedIn scan completed.

```js
// extension/background/scan_manual.js:55-59
let f_tpr = await computeFtpr(config.f_tpr_bound, effectiveWebsite);
const liHours = parseInt(String(config.linkedin_f_tpr ?? "").trim(), 10);
if (!Number.isNaN(liHours) && liHours > 0) {
  f_tpr = `r${liHours * 3600}`;
}
```

`computeFtpr` is more interesting:

```js
// extension/background/config_fetch.js:16-49
async function computeFtpr(fTprBound, website) {
  if (!fTprBound || fTprBound <= 0) return null;
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(
      `${backendUrl}/extension/run-log?limit=20&status=completed`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!res.ok) return `r${fTprBound * 3600}`;
    const raw = await res.json();
    const logs = Array.isArray(raw) ? raw : raw.items || [];
    const w = website || "linkedin";
    const matching = logs.filter(
      (l) => (l.search_filters?.website || "linkedin") === w
    );
    if (!matching.length || !matching[0].completed_at)
      return `r${fTprBound * 3600}`;
    const lastScrapeTime = new Date(matching[0].completed_at).getTime();
    const hoursSinceLast = (Date.now() - lastScrapeTime) / (1000 * 60 * 60);
    let hoursToLookBack;
    if (hoursSinceLast < 0.5) {
      hoursToLookBack = fTprBound;
    } else {
      hoursToLookBack = Math.min(hoursSinceLast, fTprBound);
    }
    const seconds = Math.max(Math.round(hoursToLookBack * 3600), 3600);
    return `r${seconds}`;
  } catch {
    return `r${fTprBound * 3600}`;
  }
}
```

Plain-language summary: "Look at the last 20 completed run logs. Filter to runs of the *same* website we're about to scan. If there's a recent one, use the time since that run as our lookback window — but cap it at `fTprBound` (typically 168 = 1 week) and floor it at 1 hour. If there's no prior run, just use the full bound."

The point: avoid scraping jobs we already have, while not missing anything from the gap.

> **BUG-3 historical context.** Before 2026-04-22, this function did *not* filter by website. So a LinkedIn scan would compute its `f_tpr` based on the most recent completed run *of any site*, including Indeed and Glassdoor. If you scanned Indeed at noon and LinkedIn at 1pm, LinkedIn would only look back 1 hour — missing 6 days' worth of LinkedIn jobs. The `matching = logs.filter(...)` line was added to fix this. The fix is now live and the bug is RESOLVED, but it's a useful illustration of how subtle cross-source contamination bugs can be.

### Step 5 — Build the run-log creation body

The shape of the run-log start request depends on which site we're scanning. Three branches:

#### Indeed branch

```js
// extension/background/scan_manual.js:64-87
if (isIndeed) {
  runLogBody = {
    strategy: "C",
    search_keyword: config.indeed_keyword || config.keyword,
    search_location: config.indeed_location || config.location,
    search_filters: {
      website: effectiveWebsite,
      indeed_fromage: config.indeed_fromage,
      indeed_jt: config.indeed_jt,
      indeed_remotejob: config.indeed_remotejob,
      indeed_sort: "relevance",
      indeed_explvl: config.indeed_explvl,
      indeed_lang: config.indeed_lang,
      general_date_posted: config.general_date_posted ?? null,
      general_internship_only:
        config.general_internship_only === true ? true : null,
      general_remote_only:
        config.general_remote_only === true ? true : null,
    },
  };
}
```

The `strategy: "C"` field is a legacy artifact from when there were multiple scraping strategies (A, B, C). Only "C" is used now.

`search_keyword` and `search_location` use the Indeed-specific config field if present, falling back to the global `config.keyword` / `config.location`. The `search_filters` object captures all the per-site filter parameters for later inspection.

#### Glassdoor branch

```js
// extension/background/scan_manual.js:88-100
} else if (isGlassdoor) {
  const g = config.glassdoor || {};
  runLogBody = {
    strategy: "C",
    search_keyword: g.keyword || config.keyword,
    search_location: g.location || config.location,
    search_filters: {
      website: effectiveWebsite,
      ...(config.glassdoor || {}),
      general_date_posted: config.general_date_posted ?? null,
      general_internship_only:
        config.general_internship_only === true ? true : null,
      general_remote_only:
        config.general_remote_only === true ? true : null,
    },
  };
}
```

Same structure; the entire `config.glassdoor` block is spread into `search_filters` so all of its nested fields (keyword, location, slugs, fromAge, etc.) are preserved.

#### LinkedIn branch (the default)

```js
// extension/background/scan_manual.js:101-119
} else {
  runLogBody = {
    strategy: "C",
    search_keyword: config.keyword,
    search_location: config.location,
    search_filters: {
      website: effectiveWebsite,
      f_tpr,
      linkedin_f_tpr: config.linkedin_f_tpr,
      f_experience: config.f_experience,
      f_job_type: config.f_job_type,
      f_remote: config.f_remote,
      salary_min: config.salary_min,
      general_date_posted: config.general_date_posted ?? null,
      general_internship_only:
        config.general_internship_only === true ? true : null,
      general_remote_only:
        config.general_remote_only === true ? true : null,
    },
  };
}
```

LinkedIn uses the top-level `config.keyword` and `config.location`, plus the computed `f_tpr` from Step 4 and the LinkedIn-specific filter codes (`f_experience`, `f_job_type`, etc.).

#### Scan All metadata

If this trigger came from Scan All, three extra fields are added:

```js
// extension/background/scan_manual.js:121-125
if (scan_all) {
  runLogBody.scan_all = true;
  runLogBody.scan_all_position = scan_all_position;
  runLogBody.scan_all_total = scan_all_total;
}
```

These propagate into the new run-log row and become the trigger for "is this the last leg of Scan All?" in Phase 8.

### Step 6 — Create the run log on the backend

```js
// extension/background/scan_manual.js:127-134
const runRes = await fetch(`${backendUrl}/extension/run-log/start`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(runLogBody),
});
const { id: runId } = await runRes.json();
```

The backend handler is straightforward:

```python
# backend/routers/extension.py:215-228
@router.post("/run-log/start", response_model=_RunLogStartResponse)
async def start_run_log(
    body: RunLogCreate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    log = ExtensionRunLog(
        status="running",
        strategy=body.strategy,
        search_keyword=body.search_keyword,
        search_location=body.search_location,
        search_filters=body.search_filters,
        scan_all=body.scan_all,
        scan_all_position=body.scan_all_position,
        scan_all_total=body.scan_all_total,
    )
    db.add(log)
    await db.flush()
    return _RunLogStartResponse(id=log.id)
```

It inserts a new row in `extension_run_logs` with `status="running"` and returns just the row's UUID. **This UUID is `runId`** — the most important identifier in the system. Every later step uses it:

- It goes into `scanConfig` storage in Step 8 below
- It goes into every `INGEST_JOB` payload's `scan_run_id` field (linking each job to this scan)
- It goes into the final completion PUT request
- It goes into every debug trace event's metadata
- It's used by downstream dedup/match reports to scope to this scan's jobs

### Step 7 — Build the search URL

The URL builders live in `search_urls.js`:

#### LinkedIn

```js
// extension/background/search_urls.js:3-21
function buildSearchUrl(config, f_tpr, startOffset = 0) {
  const params = new URLSearchParams({
    keywords: config.keyword,
    location: config.location,
  });
  const liHours = parseInt(String(config.linkedin_f_tpr ?? "").trim(), 10);
  let fTprParam = null;
  if (!Number.isNaN(liHours) && liHours > 0) {
    fTprParam = `r${liHours * 3600}`;
  } else if (f_tpr) {
    fTprParam = f_tpr;
  }
  if (fTprParam) params.set("f_TPR", fTprParam);
  if (config.f_experience) params.set("f_E", config.f_experience);
  if (config.f_job_type) params.set("f_JT", config.f_job_type);
  if (config.f_remote) params.set("f_WT", config.f_remote);
  if (startOffset > 0) params.set("start", startOffset);
  return `https://www.linkedin.com/jobs/search?${params.toString()}`;
}
```

Produces something like `https://www.linkedin.com/jobs/search?keywords=software+engineer&location=Vancouver&f_TPR=r86400&f_E=2,3,4&f_JT=F&f_WT=2`.

#### Indeed

```js
// extension/background/search_urls.js:23-37
function buildIndeedSearchUrl(config, startOffset = 0) {
  const params = new URLSearchParams();
  params.set("q", config.indeed_keyword || config.keyword || "software engineer");
  params.set("l", config.indeed_location || config.location || "Canada");
  params.set("sort", "relevance");
  if (config.indeed_fromage) params.set("fromage", String(config.indeed_fromage));
  if (config.indeed_remotejob) params.set("remotejob", "1");
  const ij = config.general_internship_only
    ? "internship"
    : (config.indeed_jt || "").trim();
  if (ij) params.set("jt", ij);
  if (config.indeed_explvl) params.set("explvl", config.indeed_explvl);
  if (config.indeed_lang) params.set("lang", config.indeed_lang);
  if (startOffset > 0) params.set("start", String(startOffset));
  return `https://ca.indeed.com/jobs?${params.toString()}`;
}
```

Produces something like `https://ca.indeed.com/jobs?q=software+engineer&l=Canada&sort=relevance&fromage=7&remotejob=1`.

#### Glassdoor (the strangest of the three)

```js
// extension/background/search_urls.js:39-62
function buildGlassdoorSearchUrl(config) {
  const g = config.glassdoor;

  const locSlug = g.location_slug;
  const kwSlug  = g.keyword_slug;
  const locLen  = locSlug.length;
  const kwStart = locLen + 1;
  const kwEnd   = kwStart + kwSlug.length;

  const path = `https://www.glassdoor.ca/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${locLen}_IN3_KO${kwStart},${kwEnd}.htm`;

  const params = new URLSearchParams();
  if (g.fromAge != null)         params.set("fromAge",         g.fromAge);
  if (g.applicationType != null) params.set("applicationType", g.applicationType);
  if (g.remoteWorkType != null)  params.set("remoteWorkType",  g.remoteWorkType);
  if (g.minSalary != null)       params.set("minSalary",       g.minSalary);
  if (g.maxSalary != null)       params.set("maxSalary",       g.maxSalary);
  if (g.minRating != null)       params.set("minRating",       g.minRating);
  if (g.jobType) params.set("jobType", g.jobType);
  if (g.seniorityType != null)   params.set("seniorityType",   g.seniorityType);
  params.set("sortBy", "date_desc");

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
```

Glassdoor encodes the keyword and location *into the URL path itself*, with byte-offset markers (`SRCH_IL.0,9_IN3_KO10,27`). The numbers `0,9` mean "the location starts at character 0 and ends at character 9 of the slug"; `10,27` means "the keyword starts at character 10 and ends at character 27." That's why the config has both `keyword` and `keyword_slug` as separate fields — the slug version is URL-friendly (lowercased, hyphenated) and used here.

This URL format is fragile; if Glassdoor ever changes its URL scheme, this builder breaks. We mitigate by also having the user pre-compute the slugs in the dashboard (rather than auto-slugifying here, which would be lossy for special characters).

### Step 8 — Open the popup window and write `scanConfig`

The final step:

```js
// extension/background/scan_manual.js:147-172
const win = await chrome.windows.create({
  url: searchUrl,
  type: "popup",
  width: 1280,
  height: 800,
  focused: false,
});
const tabId = win.tabs[0].id;

await chrome.storage.local.set({
  scanInProgress: true,
  scanConfig: {
    ...config,
    f_tpr,
    runId,
    website: effectiveWebsite,
    tabId,
  },
  liveProgress: {
    scraped: 0,
    new_jobs: 0,
    existing: 0,
    stale_skipped: 0,
    jd_failed: 0,
    page: 1,
  },
});

startKeepAlive();
```

Three critical decisions are encoded here:

**`type: "popup"`.** A separate Chrome window — not a tab in the user's main window. The popup has no toolbar, so the user can't accidentally navigate away. They CAN close it, but `tabs_safety.js` (covered in Section 15) detects this case and cleans up.

**`focused: false`.** The popup opens in the background. The user's main window stays focused. They can keep working while the scan runs in the background.

**`scanConfig` is the handoff payload.** It contains everything content scripts need to know: the full config, the computed `f_tpr`, the `runId`, the chosen website, and the popup tab's `tabId`. Content scripts read this from storage in Phase 5.

> **Wasteful but harmless:** `scanConfig` spreads the *entire* config (`...config`) rather than just the fields the content script needs. The full config can be hundreds of bytes including resume data and skill aliases. For a single scan it doesn't matter, but it's not great hygiene. **Fix suggestion:** In a future cleanup, define a `buildScanConfig(config, runId, website, tabId)` helper that picks only the fields actually consumed by content scripts (keyword, location, the relevant per-site filter block, runId, website, tabId, f_tpr).

### Step 9 — The 90-minute safety timeout

```js
// extension/background/scan_manual.js:174-200
const SCAN_TIMEOUT_MS = 90 * 60 * 1000;
const scanTimeoutId = setTimeout(async () => {
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (!scanInProgress) return;
  console.warn("[JHA] Scan safety timeout (90min) — force-completing");
  const { scanConfig } = await chrome.storage.local.get("scanConfig");
  if (scanConfig?.runId) {
    await fetch(`${backendUrl}/extension/run-log/${scanConfig.runId}`, {
      method: "PUT",
      // ...
      body: JSON.stringify({
        status: "failed",
        error_message: "Scan timeout — exceeded 90 minutes",
      }),
    }).catch(() => {});
  }
  await chrome.storage.local.set({
    scanInProgress: false,
    liveProgress: null,
  });
  await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
  stopKeepAlive();
}, SCAN_TIMEOUT_MS);

await chrome.storage.local.set({
  scanTimeoutId: scanTimeoutId.toString(),
});
```

If a scan is still running after 90 minutes, this fires:

1. Check `scanInProgress` is still true (otherwise scan already completed cleanly; do nothing).
2. Mark the run-log as `failed` with a timeout message.
3. Clear the storage flags.
4. Stop the keepalive.

Real scans take 1-15 minutes per site. The 90-minute timeout is a "the scan is genuinely hung" safety net, not a "the scan is taking longer than expected" timeout.

> **Note:** This timeout does *not* close the scan tab. If Chrome itself is hung, the run-log gets marked failed but the user has to manually close the popup. There's no `chrome.tabs.remove` call in the timeout handler.

### Bug notes for this phase

There's one historical bug, **BUG-3**, mentioned earlier — the `computeFtpr` cross-source contamination. That's already fixed.

### Unreasonable behavior in this phase

> **The 90-minute timeout's `setTimeout` ID is stored as a string.** Look at the storage write: `scanTimeoutId: scanTimeoutId.toString()`. Then when `scan_completion.js` reads it back, it does `clearTimeout(parseInt(scanTimeoutId))`. This roundtrip serialization is unnecessary — `chrome.storage.local` happily stores numbers. **Fix suggestion:** Just store the number. `chrome.storage.local.set({ scanTimeoutId })` would work without any wrappers. Trivial cleanup.

> **The 90-minute timeout doesn't close the scan tab.** If a scan is genuinely hung (e.g. LinkedIn returned a JS-only error page that the content script can't parse), the run-log gets marked failed but the popup window sits there forever, eventually littering the user's taskbar. **Fix suggestion:** Add `if (scanConfig?.tabId) await chrome.tabs.remove(scanConfig.tabId).catch(() => {});` to the timeout handler. One line. Catches the genuine-hang case without affecting the normal-completion path (which already handles tab close in `scan_completion.js`).

---

## 9. Phase 5 — Content script boots inside the popup tab

**Files involved:**
- `extension/manifest.json` (the content_scripts blocks)
- `extension/content/linkedin/init.js`
- `extension/content/indeed/init.js`
- `extension/content/glassdoor/init.js`
- `extension/content/shared/debug_logger.js`

### How content scripts get loaded

When the popup window navigates to (e.g.) `linkedin.com/jobs/search?...`, Chrome's manifest matches the URL and injects the configured content scripts. From `manifest.json`:

```json
// extension/manifest.json:18-37
{
  "matches": ["https://www.linkedin.com/jobs/*"],
  "js": [
    "content/shared/utils.js",
    "content/shared/debug_logger.js",
    "content/shared/delays.js",
    "content/shared/messaging.js",
    "content/linkedin/constants.js",
    "content/linkedin/scroll.js",
    "content/linkedin/dom.js",
    "content/linkedin/voyager.js",
    "content/linkedin/process.js",
    "content/linkedin/page.js",
    "content/linkedin/overlay.js",
    "content/linkedin/init.js"
  ],
  "css": ["content/content_style.css"],
  "run_at": "document_idle"
}
```

A few things to notice:

**Order matters.** Files load in array order, into a **shared global scope per match pattern**. So a function defined in `dom.js` is visible to `process.js`. There's no `import`/`export`; this is classic-script land. The order ensures dependencies load before their dependents.

**`run_at: "document_idle"`.** The script fires after the page's DOM has been fully parsed and most subresources have loaded, but before all of them are done. This is the right timing for our scrape work — we need the DOM but we don't want to wait for every image to download.

**Site-specific load lists.** Each site has its own `js` array. Glassdoor's is notably shorter:

```json
// extension/manifest.json:55-65
{
  "matches": [
    "https://www.glassdoor.ca/*",
    "https://glassdoor.ca/*"
  ],
  "js": [
    "content/shared/debug_logger.js",
    "content/glassdoor/parse.js",
    "content/glassdoor/fetch_jd.js",
    "content/glassdoor/process.js",
    "content/glassdoor/page.js",
    "content/glassdoor/init.js"
  ]
}
```

Glassdoor only loads `debug_logger` from shared — no `utils.js`, no `messaging.js`, no `delays.js`. It is designed to be self-contained. It defines its own `sleep()` function inline in three places, sends ingest messages directly without the shared message-batching pattern, and has its own per-card pacing logic. This is partly a historical artifact (Glassdoor was added later, with a cleaner-but-redundant codebase) and partly intentional (less coupling, easier to deprecate independently).

**`init.js` is always last.** It's the entry point. By the time it runs, every helper function it needs is already defined.

### LinkedIn `init.js` — the canonical case

Let me walk through LinkedIn's init in full. It's the cleanest of the three.

```js
// extension/content/linkedin/init.js:1-17
async function getStorageKeepaliveAge() {
  const { _keepalive } = await chrome.storage.local.get("_keepalive");
  return _keepalive ? Date.now() - _keepalive : null;
}

async function init() {
  let storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
  if (!storage.scanInProgress) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
      if (storage.scanInProgress) break;
    }
  }
  if (!storage.scanInProgress) {
    console.log("[JHA] init: scanInProgress not set after 3s — exiting");
    return;
  }
```

**Step 1: Wait for `scanInProgress`.** When the popup opens, the content script may run *before* the SW has finished writing `scanConfig` to storage (a race condition between Phase 4's `chrome.windows.create` and Phase 4's `chrome.storage.local.set`). So we poll up to 6 times, every 500ms = 3 seconds total. If still not set, exit silently. This means the script is "primed" — it runs on every linkedin.com/jobs/* page, but immediately exits unless a scan is in progress.

```js
// extension/content/linkedin/init.js:20-23
const config = storage.scanConfig;
if (!config) {
  console.log("[JHA] init: no scanConfig — exiting duplicate");
  return;
}

if (window.__JHA_LINKEDIN_SCAN_BOOTED) {
  console.log("[JHA] init: duplicate boot in same document — exiting");
  return;
}
window.__JHA_LINKEDIN_SCAN_BOOTED = true;
```

**Step 2: Duplicate-boot guard.** The `__JHA_LINKEDIN_SCAN_BOOTED` flag is a window-level marker (lives in the page's JS context, separate from `chrome.storage.local`). If the content script gets re-injected (Chrome sometimes does this on SPA navigations), this prevents a second `init()` from running and stomping on the first one's state.

```js
// extension/content/linkedin/init.js:31-34
const tabResult = await new Promise((resolve) =>
  chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
);
const tabId = tabResult?.id;
```

**Step 3: Get this tab's ID.** The content script doesn't know its own `tabId` directly. It asks the SW via a `GET_TAB_ID` message. The SW receives the message, sees it via `sender.tab.id` (Chrome attaches sender info automatically), and replies with that ID. `tabId` is later passed to debug events and used by the `INGEST_JOB_RESULT` reply mechanism.

```js
// extension/content/linkedin/init.js:36-50
await JhaDebug.init(config.runId, Date.now());

await JhaDebug.emit("scan_start", {
  runId: config.runId,
  tabId,
  source: "linkedin",
  keyword: config.keyword,
  location: config.location,
  filters: { /* ... */ },
  entry_url: location.href,
});
```

**Step 4: Initialize the debug trace and emit `scan_start`.** `JhaDebug` is a namespace defined in `content/shared/debug_logger.js`. We'll cover it in detail in Section 14. For now: it's a buffer in `chrome.storage.local` that collects diagnostic events and periodically flushes them to the backend. The `init` call sets up the buffer; the `emit` call writes the first event of the scan.

```js
// extension/content/linkedin/init.js:52-67
const session = checkSession();
await JhaDebug.emit("session_check", {
  result: session,
  cookie_length: document.cookie.length,
  has_li_at: document.cookie.includes("li_at"),
  has_jsessionid: document.cookie.includes("JSESSIONID"),
});
if (session !== "live") {
  await reportSessionError(session);
  await JhaDebug.emit("error", { where: "session", message: String(session) }, "error");
  await JhaDebug.finalize();
  if (session === "captcha") {
    console.log("[JHA] CAPTCHA detected — stopping scan, leaving page open");
  } else {
    window.location.href = "https://www.linkedin.com/login";
  }
  await chrome.storage.local.set({ scanInProgress: false });
  return;
}
```

**Step 5: Session check.** `checkSession()` is in `dom.js`:

```js
// extension/content/linkedin/dom.js:42-50
function checkSession() {
  const href = window.location.href;
  if (href.includes("/checkpoint/challenge")) return "captcha";
  if (
    href.includes("/login") ||
    href.includes("/authwall") ||
    href.includes("/checkpoint")
  ) return "expired";
  if (!href.includes("/jobs/")) return "redirected";
  return "live";
}
```

It looks at the current URL. If LinkedIn redirected us to a login page, an authwall, or a captcha challenge, we return early. The session error is reported to the backend (so the user sees a banner) and the run is finalized as failed.

For captcha specifically, we *don't* navigate away — we leave the page open so the user can solve the captcha themselves. For login/authwall, we redirect to the login page so the user can sign in.

```js
// extension/content/linkedin/init.js:69
showScanOverlay();
```

**Step 6: Show the visual overlay.** This is the "🔍 JHA Scan in progress" banner at the top of the page. The user can see it and knows they shouldn't interact with the page.

```js
// extension/content/linkedin/init.js:71-78
const heartbeatInterval = setInterval(async () => {
  try {
    await JhaDebug.emit("heartbeat", {
      url: location.href,
      storage_keepalive_age_ms: await getStorageKeepaliveAge(),
    });
  } catch (_) { /* logger guarantees no throw */ }
}, 10000);
```

**Step 7: Start a heartbeat.** Every 10 seconds, emit a `heartbeat` debug event. This includes `storage_keepalive_age_ms` — the age of the SW's `_keepalive` storage write. If this number grows large (>10 seconds), the SW is suspended and we should be worried.

```js
// extension/content/linkedin/init.js:80-101
let summary = null;
try {
  summary = await runFullScan(config, tabId);
} catch (e) {
  console.error("[JHA] Scan error:", e);
  await JhaDebug.emit("error", { where: "init", message: e.message, stack: e.stack }, "error");
  summary = { /* zero counters with error field */ };
} finally {
  clearInterval(heartbeatInterval);
  hideScanOverlay();
}
```

**Step 8: Run the actual scan.** `runFullScan` is the meat of the scan — it loops over pages and processes cards. We cover it in Phase 6. The `try/catch/finally` ensures we always clean up the heartbeat and overlay, even if the scan crashes.

```js
// extension/content/linkedin/init.js:103-119
await JhaDebug.emit("scan_end", { /* summary stats */ });
await JhaDebug.finalize();

await chrome.storage.local.remove(["scanConfig"]);
await chrome.storage.local.set({
  scanInProgress: false,
  scanComplete: {
    tabId,
    summary,
    runId: config.runId,
    completedAt: Date.now(),
  },
});
```

**Step 9: Trigger Phase 8.** Emit `scan_end`, drain the debug log, then write `scanComplete` to storage. The `scanComplete` write is what triggers `scan_completion.js` in the background to fire (Phase 8). The content script's job is now done.

### Indeed `init.js` — the multi-invocation case

Indeed paginates by **navigating the tab to a new URL.** Each navigation is a fresh content-script load, so `init()` runs **once per page**. This creates a need for the `JhaDebug.init` to be idempotent:

```js
// extension/content/indeed/init.js:103-115
const { debugLog: dbgBefore } = await chrome.storage.local.get("debugLog");
const continuing =
  dbgBefore &&
  dbgBefore.runId === config.runId &&
  dbgBefore.scanStartMs != null;
await JhaDebug.init(config.runId, Date.now());

if (!continuing) {
  await JhaDebug.emit("scan_start", {
    runId: config.runId,
    tabId,
    source: "indeed",
    keyword: config.indeed_keyword || config.keyword,
    location: config.indeed_location || config.location,
  });
}
```

If a debug log already exists for this `runId`, we're "continuing" (i.e. on page 2 or later), and we skip emitting `scan_start` again. Without this check, every page navigation would emit a fresh `scan_start`, polluting the trace.

Indeed init also has a unique safeguard called `ensureIndeedRunLog`:

```js
// extension/content/indeed/init.js:3-46
async function ensureIndeedRunLog(config) {
  if (config.runId) return config;
  // ...creates a run-log on the fly if missing...
}
```

This handles the edge case where the user lands on indeed.com manually (without going through the dashboard) and we want to scan anyway. For dashboard-triggered scans, `config.runId` is always already set (from Phase 4), so this is a no-op.

The rest of Indeed's init is structurally similar to LinkedIn's. The major difference is that Indeed calls `runSinglePage(config, state)` instead of `runFullScan`, and only writes `scanComplete` when `summary.done === true`:

```js
// extension/content/indeed/init.js:172-189
const summary = await runSinglePage(config, state);

if (summary.done) {
  hideScanOverlay();
  await JhaDebug.emit("scan_end", { summary: { /* ... */ } });
  await JhaDebug.finalize();
  await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
  await chrome.storage.local.set({
    scanInProgress: false,
    scanComplete: { tabId, summary, runId: config.runId, completedAt: Date.now() },
  });
}
```

When `summary.done === false` (i.e. there's a next page to navigate to), the content script just exits without writing `scanComplete`. The next content-script invocation (after the tab navigates) will continue from where we left off.

### Glassdoor `init.js` — has a second auto-scan path

Glassdoor's init has two completely different flows:

```js
// extension/content/glassdoor/init.js:212-230
async function glassdoorMain() {
  if (window.location.search.includes("jha_preview=1")) {
    console.log("[JHA-Glassdoor] preview mode — skipping scan");
    return;
  }
  let storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
  if (!storage.scanInProgress) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
      if (storage.scanInProgress) break;
    }
  }

  if (storage.scanInProgress && storage.scanConfig?.website === "glassdoor") {
    await runManualGlassdoorScan(storage.scanConfig);
    return;
  }

  await runAutoGlassdoorScan();
}

glassdoorMain();
```

**Manual path** (the dashboard-triggered case): same shape as LinkedIn/Indeed. Runs when `scanInProgress=true` and `scanConfig.website === 'glassdoor'`.

**Auto path** (the surprise path): runs when the user just *visits* Glassdoor with the extension installed, no scan triggered. It has its own debouncing:

```js
// extension/content/glassdoor/init.js:153-180
async function runAutoGlassdoorScan() {
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (scanInProgress) return;

  const url = window.location.href;
  const u = url.toLowerCase();
  if (!u.includes("srch_") && !u.includes("/job/")) return;

  const settings = await new Promise((resolve) =>
    chrome.storage.local.get(["autoScan", "lastGlassdoorScanTime"], resolve)
  );

  if (settings.autoScan === false) return;

  const DEBOUNCE_MS = 15 * 60 * 1000;
  const now = Date.now();
  const lastScan = settings.lastGlassdoorScanTime || 0;
  if (now - lastScan < DEBOUNCE_MS) return;

  chrome.storage.local.set({ lastGlassdoorScanTime: now });
  // ... continues with scan setup ...
}
```

In plain language: "If the user is on a Glassdoor job search page, the `autoScan` flag isn't explicitly disabled, and we haven't auto-scanned in the last 15 minutes — kick off a scan automatically."

This is **not documented in the design docs.** It runs whenever someone with the extension installed visits Glassdoor. Whether this is desired behavior is a product question, but it's surprising behavior for a teammate to discover.

> **BUG / unreasonable behavior — undocumented auto-scan.** The auto-scan path silently creates run-log rows on the user's natural Glassdoor browsing. If the user visits Glassdoor 5 times a day for normal job searching, we get 1 auto-scan per visit (15-min debounce permitting), each producing a run-log row, each potentially triggering sync dedup. The `autoScan` storage flag has no UI to toggle it. **Fix suggestion:** Either (a) make this opt-in by defaulting `autoScan = false` and adding a checkbox to the dashboard, or (b) remove the auto path entirely and stick with manual triggers. Document whichever is chosen.

### Bug notes for this phase

Beyond the auto-scan note above, no specific bugs. The phase is mostly a setup-and-handoff layer.

### Unreasonable behavior in this phase

> **Per-site init.js files duplicate ~80% of their logic.** Each site has a near-identical `init()` shape: wait for `scanInProgress`, get tabId, init JhaDebug, emit `scan_start`, session check, show overlay, start heartbeat, run the scan, emit `scan_end`, finalize, set `scanComplete`. The only real differences are session-check rules and which run-function to call. **Fix suggestion:** Extract a shared `runScanPipeline(config, { source, runScan, sessionCheck })` helper into `content/shared/init_helpers.js`. Each site's init.js shrinks to ~10 lines. Reduces drift between sites and makes future bug fixes apply uniformly.

> **The `__JHA_LINKEDIN_SCAN_BOOTED` flag has no Indeed/Glassdoor equivalent.** LinkedIn alone has the duplicate-boot guard. Indeed and Glassdoor could in theory be re-injected too (especially Glassdoor with its long-running page that survives "Show more" clicks). **Fix suggestion:** Add `__JHA_INDEED_SCAN_BOOTED` and `__JHA_GLASSDOOR_SCAN_BOOTED` guards. Or, with the shared-helper refactor above, make this part of the shared pipeline keyed on `source`. Cheap defense.

---

## 10. Phase 6 — Per-card scrape and ingest loop

**Files involved:**
- `extension/content/linkedin/page.js` (the LinkedIn page-level loop)
- `extension/content/linkedin/process.js` (the LinkedIn per-card pipeline)
- `extension/content/linkedin/voyager.js` (the LinkedIn JD fetcher)
- `extension/content/linkedin/dom.js` (the LinkedIn card extractor)
- `extension/content/indeed/page.js`, `process.js`, `rate_strategy.js`, `dom.js` (Indeed equivalents)
- `extension/content/glassdoor/page.js`, `process.js`, `fetch_jd.js`, `parse.js` (Glassdoor equivalents)
- `extension/content/shared/messaging.js` (the LinkedIn/Indeed ingest message protocol)
- `extension/background/ingest.js` (the SW-side handler)
- `backend/routers/jobs.py` lines 61-223 (`POST /jobs/ingest`)

This phase is where the actual scraping happens. For each job card on the current page, we:

1. Check if the user has clicked Stop
2. Read the card's basic data from the DOM
3. Fetch the full job description from a site-specific source
4. Build a JSON payload
5. Send it to the SW, which forwards it to the backend
6. Update local counters and emit trace events

Each site implements these steps slightly differently. We'll cover the shape first, then the per-site details.

### The shared shape

Across all three sites, the per-page card loop looks like:

```
1. waitForCards(timeoutMs) — get the list of cards from the DOM
   (with a stability check — only return when count is stable)
2. For each card:
   a. Read stopRequested flag, break if set
   b. Optional: page-local dedup (skip cards we've already processed)
   c. Extract basic card data from DOM
   d. Fetch full JD via site-specific method
   e. Build payload, send INGEST_JOB to SW
   f. Update counters, write liveProgress, emit trace events
```

### Step 1 — Card discovery with stability gate

All three sites use a **stability check**: poll the DOM, and only return when the count has been *unchanged* for some window. This avoids reading the cards mid-render (when LinkedIn is still inserting cards into the list, we'd see partial data).

LinkedIn's version:

```js
// extension/content/linkedin/dom.js:13-31
async function waitForCards(timeoutMs = 8000) {
  const start = Date.now();
  let lastCount = 0;
  let stableFor = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(300);
    const cards = getCards(true);
    const count = cards.length;
    if (count > 0 && count === lastCount) {
      stableFor += 300;
      if (stableFor >= 600) return cards;
    } else {
      stableFor = 0;
    }
    lastCount = count;
  }
  return getCards(true);
}
```

Plain language: "Every 300ms, get the card count. If it hasn't changed since last check (and is non-zero), increment our 'stable for' timer. Once we've been stable for 600ms, return the cards. Give up after 8 seconds total."

The constants by site:

| Site | Stability window | Default timeout | Selectors used |
|---|---|---|---|
| LinkedIn | 600ms unchanged | 8s | `li[data-occludable-job-id]`, plus 3 fallbacks |
| Indeed | 1000ms unchanged | 10s | `a[data-jk]` |
| Glassdoor | None — different model | 10×800ms = 8s | `[data-jobid]` filtered by `processedJobIds` |

Glassdoor's logic is the most distinctive: instead of waiting for *any* cards, it waits for **new cards not in `processedJobIds`** — because the page persists across "Show more" button clicks (covered in Phase 7).

### Step 2 — Stop check (per card)

Before each card, all three sites check the stop flag:

```js
// extension/content/linkedin/page.js:108-118
const { stopRequested: stopNow } =
  await chrome.storage.local.get("stopRequested");
if (stopNow) {
  await JhaDebug.emit("pagination_ended", {
    type: "pagination_ended",
    page: currentPage,
    reason: "stop_requested_mid_page",
    url: location.href,
  });
  await emitPageEnd(counters, currentPage, true);
  return { ...counters, pages_scanned: currentPage };
}
```

If stopped mid-page, emit a `pagination_ended` event and exit. Glassdoor uses a `CHECK_STOP` runtime message to the SW instead of reading storage directly — same effect, slightly more roundabout.

### Step 3 — Per-page deduplication

LinkedIn and Glassdoor maintain a `Set<string>` of already-seen job IDs:

```js
// extension/content/linkedin/page.js:120-129
const jobId = card.getAttribute("data-occludable-job-id");
await JhaDebug.emit("card_process", {
  job_id: jobId || null,
  idx_on_page: idx,
  duplicate_in_set: !!(jobId && processedJobIds.has(jobId)),
});
if (!jobId) continue;
if (processedJobIds.has(jobId)) {
  console.log(`[JHA-LinkedIn] Skipping duplicate job id: ${jobId}`);
  continue;
}
processedJobIds.add(jobId);
```

This is the **Stripe promoted-card fix**. LinkedIn shows the same Stripe job on every page of search results with a *different* `job_id` per impression. Wait, that's wrong — actually, LinkedIn shows the same job with a *consistent* `data-occludable-job-id` across pages. The Set blocks the second-and-later occurrences.

Indeed doesn't need this because each Indeed page is a fresh content-script invocation. There's no shared in-memory state to use a Set anyway. Indeed relies on the backend's URL-duplicate gate (Step 7 below) to handle cross-page dedup.

### Step 4 — Card data extraction

Each site has its own `extractCardData` (LinkedIn, Indeed) or `parseGlassdoorCard` (Glassdoor) function. They pull:

- **Job ID** — `data-occludable-job-id` (LI) / `data-jk` (Indeed) / `data-jobid` (GD)
- **Title** — multi-selector fallback chain (the DOM class names are obfuscated and change occasionally)
- **Company** — multi-selector. Glassdoor strips trailing rating numbers (e.g. "Stripe 4.5" → "Stripe") via regex
- **Location** — multi-selector
- **Job URL** — built from anchor `href`. LinkedIn strips query strings; Glassdoor prepends domain to relative paths
- **Easy apply hint** — heuristic check for an "Easy Apply" badge
- **Snippets** (Indeed only) — small attribute pills like "Posted 3 days ago", parsed later for `post_datetime`

Example, LinkedIn:

```js
// extension/content/linkedin/dom.js:60-95
function extractCardData(card) {
  if (!card) return null;

  const job_id = getJobId(card);
  const anchor = card.querySelector('a[href*="/jobs/view/"]');
  const rawUrl =
    anchor?.href ||
    (job_id ? `https://www.linkedin.com/jobs/view/${job_id}/` : null);
  const job_url = rawUrl ? rawUrl.split("?")[0].split("&")[0] : null;

  const titleEl =
    card.querySelector(".job-card-list__title") ||
    card.querySelector('[class*="job-card-list__title"]') ||
    card.querySelector('a[class*="job-card"][aria-label]') ||
    card.querySelector('[class*="job-title"]') ||
    card.querySelector("strong") ||
    card.querySelector('a[href*="/jobs/view/"]');
  // ... company, location, time, easy_apply ...

  return {
    job_id,
    job_title: titleEl?.innerText?.trim().split("\n")[0] || titleEl?.getAttribute("aria-label") || null,
    company: companyEl?.innerText?.trim() || null,
    location: locationEl?.innerText?.trim() || null,
    post_datetime: timeEl?.getAttribute("datetime") || null,
    job_url,
    easy_apply,
  };
}
```

Notice the **multi-selector fallback chain** for titleEl. LinkedIn changes its CSS class names regularly (or has multiple variants for different locales/A-B-tests), so we try several selectors in order. The first that matches wins.

If `job_id` (or `jk` or `jl`) is missing, the card is skipped (`stale_skipped` or `id_skipped`). On LinkedIn and Indeed, `recordSkip()` writes a synthetic skip-row to the database so it appears in run reports; Glassdoor silently increments `stale_skipped` without recording a row.

### Step 5 — JD fetch (the site-specific heart of the scan)

This is where the three sites genuinely diverge.

#### LinkedIn — Voyager API

LinkedIn's job description is loaded via the same internal API the LinkedIn website uses. The endpoint is `linkedin.com/voyager/api/jobs/jobPostings/{jobId}` and it returns JSON.

```js
// extension/content/linkedin/voyager.js:42-50
const res = await fetch(
  `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`,
  {
    credentials: "include",
    headers: {
      "csrf-token": csrfToken,
      Accept: "application/vnd.linkedin.normalized+json+2.1",
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
    },
  }
);
```

Two important headers:
- **`credentials: "include"`** — sends the user's LinkedIn session cookies. Without this, Voyager returns 401.
- **`csrf-token`** — extracted from the `JSESSIONID` cookie (LinkedIn's CSRF protection). We pull it via:

```js
// extension/content/linkedin/voyager.js:3-6
function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID=([^;]+)/);
  return match ? match[1].replace(/"/g, "") : null;
}
```

The full `fetchJDViaVoyager` function does up to 2 attempts with 500ms between, returns `{error, status}` on rate-limit (429/403/999) without retry, and parses the response:

```js
// extension/content/linkedin/voyager.js:64-83
const data = await res.json();
const jdRaw =
  data?.data?.description?.text ||
  data?.included?.[0]?.description?.text ||
  data?.description?.text ||
  null;
const trimmed = jdRaw != null ? String(jdRaw).trim() : "";

if (trimmed.length > 0) {
  const apply_url =
    data?.data?.applyMethod?.companyApplyUrl ||
    data?.data?.applyMethod?.easyApplyUrl ||
    null;
  const companyUrn = data?.data?.companyDetails?.company || null;
  const companyName = await fetchCompanyName(companyUrn, csrfToken);
  // ... return success object ...
}
```

After getting the JD, it makes a **second** Voyager call to resolve the company name from a URN (Uniform Resource Name — LinkedIn's internal entity identifier format). This is `fetchCompanyName(companyUrn, csrfToken)` and it adds latency per card.

> **Unreasonable behavior — `fetchCompanyName` doubles the per-card Voyager round-trip cost.** The card DOM already contains the company name (we extracted it in Step 4 above as `cardData.company`). The Voyager response also has `companyDetails`, but we then fire *another* HTTP request to look up the company name from the URN. The design doc claims this was removed, but the code shows it's still happening. Each LinkedIn card now takes ~200-360ms total instead of ~150ms, and on a 200-card scan this adds 10-40 seconds. **Fix suggestion:** Trust the card DOM company name (it's almost always present) and only fall back to `fetchCompanyName` when the card extraction failed AND `companyDetails` URN is present. Better yet, just rely on the card-extracted company and remove `fetchCompanyName` entirely. The `voyagerResult.company` field can become null and the upstream code already handles that (it falls back to `cardData.company`).

#### Indeed — GraphQL API

Indeed has a public-ish GraphQL endpoint at `apis.indeed.com/graphql`:

```js
// extension/content/indeed/rate_strategy.js:13-26
res = await fetch("https://apis.indeed.com/graphql", {
  method: "POST",
  credentials: "include",
  headers: {
    "content-type": "application/json",
    "indeed-api-key": apiKey,
    "indeed-co": "CA",
  },
  body: JSON.stringify({
    query: `query { jobData(input: { jobKeys: [${JSON.stringify(jk)}] }) {
      results { job { title description { text html } } } } }`,
  }),
  signal: controller.signal,
});
```

The `apiKey` is `oneGraphApiKey` — a static key Indeed injects into the page's "main world" JavaScript (`window._initialData.oneGraphApiKey`). Content scripts run in an "isolated world" and can't read main-world globals, so we have to use Chrome's `chrome.scripting.executeScript({ world: "MAIN" })` API to extract it:

```js
// extension/content/indeed/rate_strategy.js:75-89
async function fetchIndeedJD(jk) {
  let apiKey = document.head.getAttribute("data-jha-api-key");

  if (!apiKey) {
    const result = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "GET_MAIN_WORLD_VALUE" }, resolve)
    );
    apiKey = result?.value || null;
    if (apiKey) {
      document.head.setAttribute("data-jha-api-key", apiKey);
    }
  }

  if (!apiKey) {
    console.warn("[JHA-Indeed] strategy6: oneGraphApiKey not found — falling back to null");
    return null;
  }

  return _strategy6(jk, apiKey);
}
```

Plain language: "If we already have the API key cached on `<head>` as a data attribute, use it. Otherwise, ask the SW to fetch it from the main world. Cache it for the next call."

The SW handler:

```js
// extension/background/runtime_messages.js:175-203
if (message.type === "GET_MAIN_WORLD_VALUE") {
  (async () => {
    const tabId = sender.tab?.id;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const key =
          window?._initialData?.oneGraphApiKey ||
          window?.mosaic?.providerData?.["mosaic-provider-jobcards"]?.oneGraphApiKey ||
          // ... more fallbacks ...
          null;
        return key;
      },
    });
    const value = results?.[0]?.result || null;
    sendResponse({ value });
  })();
  return true;
}
```

The `chrome.scripting.executeScript` with `world: "MAIN"` runs the function in the page's actual JavaScript context, where Indeed's `_initialData` is visible.

The GraphQL response is parsed: `descHtml` (preferred — converted to structured plain text via tag substitutions like `<br>` → `\n`, `</p>` → `\n\n`, `<li>` → `• `) or `descText` (fallback).

The function has a 10-second AbortController timeout. **Any non-success outcome — 429, 403, abort, GraphQL errors, missing job, empty description — returns `{phantom: true, http_status}`.** This is a deliberately wide net: Indeed has a small percentage of "phantom" jks (sponsored cards with placeholder IDs that don't actually exist), and we treat them all the same way.

> **BUG-6: Dead `rateLimited` path in Indeed.** The downstream code in `process.js` checks for `jdResult.rateLimited` and aborts the scan if seen, but `_strategy6` never returns that key — it returns `{phantom: true}` for all errors including 429/403. So the rate-limit abort branch is unreachable. Currently this is harmless (volumes are low, no rate limiting observed) but if Indeed tightens its limits, we'd want this to actually fire. **Fix suggestion:** Make `_strategy6` return `{rateLimited: true, http_status}` for 429/403 specifically. One-line change. Activates the existing downstream logic.

> **BUG-7: Dead null-apiKey path in Indeed.** When the API key extraction fails, `fetchIndeedJD` returns `null` (vs `{phantom}` for other failures). The caller treats `null` as `jd_failed`. The distinction is real — null means "couldn't even try" while phantom means "tried and got nothing useful" — but it's never been observed in 296 fetches across multiple runs. **Fix suggestion:** Unify returns to always be an object: `{error: "no_api_key", http_status: null}`. Cosmetic but consistent.

#### Glassdoor — HTML page fetch (4-strategy cascade)

Glassdoor doesn't have a JSON API we can use, so we fetch the actual HTML of the job-listing page and try multiple extraction strategies:

```js
// extension/content/glassdoor/fetch_jd.js:139-152
const res = await fetch(safeUrl, {
  method: "GET",
  credentials: "include",
  signal: controller.signal,
  headers: {
    Accept: "text/html,application/xhtml+xml",
    "Upgrade-Insecure-Requests": "1",
  },
});
```

`safeUrl` rewrites `glassdoor.com` to `glassdoor.ca` (a CORS workaround — the page context is `.ca`, so cross-domain fetches to `.com` fail).

After getting the HTML, we try four strategies in order:

```js
// extension/content/glassdoor/fetch_jd.js:175-244
let jd = jdFromRenderedDom(doc);
if (!hasJdText(jd)) {
  // Strategy 2: JSON-LD JobPosting.description
  const jobPosting = extractFirstJobPostingFromDoc(doc);
  // ...
}
if (!hasJdText(jd)) {
  // Strategy 3: __NEXT_DATA__ Next.js embed
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  // ...
}
if (!hasJdText(jd)) {
  // Strategy 4: First JSON-LD script via raw regex
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  // ...
}
if (!hasJdText(jd)) {
  // Strategy 5: DOM plain-text fallback (.innerText)
  // ...
}
```

Each strategy is tried only if the previous returned nothing useful. The strategies, in order:

1. **Rendered DOM** — query for `[class*="JobDetails_jobDescription"]` etc. and extract via `stripHtmlToStructuredText` (preserves bullets, paragraph breaks)
2. **JSON-LD JobPosting.description** — Glassdoor embeds a structured data block per the schema.org spec; we parse it via `DOMParser`
3. **`__NEXT_DATA__`** — Glassdoor is a Next.js app and embeds full state in a single JSON blob in a script tag; we regex it out of the raw HTML
4. **First JSON-LD via raw regex** — sometimes the script ordering differs from the DOMParser walk
5. **DOM plain-text fallback** — `.innerText`, last resort

The function also extracts `easy_apply` (from the JSON-LD `directApply` field) and `location` (from `addressLocality, addressRegion`, with provinces abbreviated via a hardcoded map):

```js
// extension/content/glassdoor/fetch_jd.js:38-55
const PROVINCE_ABBR = {
  Ontario: "ON",
  "British Columbia": "BC",
  Quebec: "QC",
  // ... rest of provinces ...
  Yukon: "YT",
};
```

If all five strategies fail, returns `{phantom: true, http_status}`.

### Step 6 — Build the job payload

All three sites converge on a payload of the same shape:

```js
{
  website: "linkedin" | "indeed" | "glassdoor",
  job_title, company, location,
  job_description: jd,
  job_url, apply_url, easy_apply, post_datetime,
  search_filters: { /* site-specific */ },
  scan_run_id: config.runId,
}
```

The `apply_url` rule is consistent: if `easy_apply === true`, set `apply_url = null`. Off-site jobs get the `job_url` as `apply_url` (Indeed/Glassdoor) or the actual ATS URL (LinkedIn from Voyager's `applyMethod.companyApplyUrl`).

`post_datetime` differs:
- **LinkedIn** uses Voyager's `originalListedAt` or `listedAt` field (an epoch milliseconds value, converted to ISO)
- **Indeed** parses card snippets (e.g. "Posted 3 days ago") via `parseIndeedPostDate`:

```js
// extension/content/indeed/process.js:18-34
function parseIndeedPostDate(snippets) {
  if (!Array.isArray(snippets)) return null;
  const snippet = snippets.find(s => /posted|active/i.test(s));
  if (!snippet) return null;

  const now = new Date();
  const justPosted = /just posted|today/i.test(snippet);
  if (justPosted) return now.toISOString();

  const match = snippet.match(/(\d+)\s*(day|hour|minute)/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit.startsWith('hour') ? amount * 3600000
            : unit.startsWith('minute') ? amount * 60000
            : amount * 86400000;
  return new Date(now.getTime() - ms).toISOString();
}
```

- **Glassdoor** has no source — it's hardcoded to `null`, even though the card has an `ageText` field (parsed by `parseGlassdoorCard` but discarded by `process.js`).

> **Unreasonable behavior — Glassdoor `ageText` is extracted but never used.** `parseGlassdoorCard` extracts `ageText` like "3 days ago" from each card, but `process.js` drops it and writes `post_datetime: null`. **Fix suggestion:** Mirror Indeed's approach. Move `parseIndeedPostDate` to `content/shared/utils.js` (renamed `parseRelativePostDate`), import in both `glassdoor/process.js` and `indeed/process.js`. Glassdoor's `post_datetime` would now be populated, useful for downstream `f_tpr`-style filtering.

> **Unreasonable behavior — `parseGlassdoorCard` extracts `salary` and `easyApply` that are also unused.** `process.js` discards `cardData.salary` entirely (no `salary_min` field on the payload). It also discards `cardData.easyApply` in favor of the JSON-LD `directApply` field from `fetch_jd.js`. **Fix suggestion:** Either use these fields (e.g. populate `salary_min_extracted` from `cardData.salary`) or remove the extraction code from `parseGlassdoorCard` to make the dead-code obvious to future readers.

### Step 7 — Send INGEST_JOB message (LinkedIn/Indeed correlationId pattern)

LinkedIn and Indeed both use the shared `ingestJob()` helper from `messaging.js`. The pattern is non-obvious and worth understanding in detail.

**The problem:** `chrome.runtime.sendMessage` has a 30-second timeout. If the SW takes longer than that to handle the message (because the backend is slow), the channel times out and the result is lost. We can't increase this timeout (it's a Chrome internal).

**The solution:** Don't have the SW respond synchronously. Instead:
1. Content script sends `INGEST_JOB` with a `correlationId`
2. SW *immediately* responds with `{ack: true}` (this fits in the 30s timeout)
3. SW does the actual ingest in the background
4. SW sends a separate message back to the content script (`INGEST_JOB_RESULT`) when done
5. Content script has a waiter map keyed by `correlationId` that resolves a Promise when the result message arrives

Here's the content-side code:

```js
// extension/content/shared/messaging.js:13-23
const _ingestResultWaiters = new Map();

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INGEST_JOB_RESULT" && msg.correlationId) {
      const resolve = _ingestResultWaiters.get(msg.correlationId);
      if (resolve) {
        _ingestResultWaiters.delete(msg.correlationId);
        resolve(msg.result);
      }
    }
  });
}
```

Plain language: "We have a global Map. When the SW sends us back an `INGEST_JOB_RESULT`, we look up the matching waiter in the map and call its `resolve` function with the result."

The send-side:

```js
// extension/content/shared/messaging.js:29-78
async function ingestJob(jobData) {
  await new Promise((resolve) =>
    chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
  );
  await new Promise((r) => setTimeout(r, 150));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const correlationId = newCorrelationId();   // "ing_<timestamp>_<random>"

    const result = await new Promise((resolve) => {
      let finished = false;
      const localTimeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        _ingestResultWaiters.delete(correlationId);
        resolve(undefined);
      }, 12000);

      const settle = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(localTimeout);
        _ingestResultWaiters.delete(correlationId);
        resolve(r);
      };

      _ingestResultWaiters.set(correlationId, settle);

      try {
        chrome.runtime.sendMessage(
          { type: "INGEST_JOB", job: jobData, correlationId },
          (ack) => {
            if (chrome.runtime.lastError || !ack?.ack) {
              settle(undefined);
            }
          }
        );
      } catch (e) {
        clearTimeout(localTimeout);
        settle(undefined);
      }
    });

    if (result !== undefined) return result;

    const delay = attempt * 1000;
    console.warn(`[JHA] Ingest: no response (attempt ${attempt}/3)...`);
    // ... heartbeat write + sleep ...
  }
  return undefined;
}
```

Step by step:

1. **Pre-write `_swHeartbeat` and wait 150ms.** Storage writes wake the SW (more reliably than messages). The 150ms gap gives Chrome time to actually wake the SW before we send the message.
2. **Up to 3 attempts.** Each attempt has its own `correlationId` (so a stale ack from a previous attempt doesn't accidentally resolve a new attempt's waiter).
3. **12-second local timeout.** Per attempt. If the SW doesn't respond in 12s with the result, give up on this attempt.
4. **Register the waiter** in the global Map *before* sending the message (avoid a race where the result arrives before we register).
5. **Send the message.** The callback runs immediately when the SW acks. If the ack indicates failure (`chrome.runtime.lastError` set, or `ack.ack` is falsy), we settle the Promise immediately with `undefined`.
6. **Wait for either ack-failure or `INGEST_JOB_RESULT`.** The `settle` function is registered as the waiter; when the result arrives, the listener at the top of the file calls it.
7. **On success, return result. On failure, sleep and retry.** Backoff is `attempt * 1000ms` (1s, 2s, 3s).

> **Unreasonable behavior — `_ingestResultWaiters` Map has no size cap.** In theory, if a content script crashes mid-scan (or somehow leaks waiters), the Map could grow without bound. In practice the 12s timeout always cleans up, but it's worth noting. **Fix suggestion:** Add an assertion that the map size never exceeds, say, 100 entries. Crash loudly if it does.

### Step 7b — Glassdoor's simpler send (no correlationId)

Glassdoor doesn't use `messaging.js` (it's not in the manifest's content_scripts list for Glassdoor). It just sends directly:

```js
// extension/content/glassdoor/process.js:97-105
const result = await new Promise((resolve) =>
  chrome.runtime.sendMessage({ type: "INGEST_JOB", job }, (r) => {
    if (r !== undefined) { resolve(r); return; }
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "INGEST_JOB", job }, resolve);
    }, 2000);
  })
);
```

Single send with one 2-second retry on failure. No 12s timeout, no waiter pattern. **If the SW response takes >30s, the result is lost silently.**

In practice ingest is 9-56ms per the design-doc benchmarks, so this is fine. But it does mean Glassdoor scans are more vulnerable to backend slowdowns.

### Step 8 — Backend ingest pipeline

The `POST /jobs/ingest` handler in `backend/routers/jobs.py` has **three branches** based on the request body.

#### Branch A — `body.skip_reason` is set

This is the path used when a content script calls `recordSkip()` to record a card it couldn't process (e.g. `no_id`, `jd_failed`):

```python
# backend/routers/jobs.py:79-104
if body.skip_reason:
    t_stage = monotonic()
    data = body.model_dump(exclude_unset=False)
    data["job_url"] = None
    new_job = ScrapedJob(**data)
    new_job.ingest_source = "extension"
    db.add(new_job)
    await db.flush()
    # ... logging ...
    return ScrapedJobIngestResponse(
        id=new_job.id,
        already_exists=False,
        content_duplicate=False,
        skip_reason=body.skip_reason,
    )
```

It nullifies `job_url` (a skip-row shouldn't claim a unique URL — that would block a future real ingest of the same URL), inserts the row with the skip reason set, and returns. No dedup checks.

#### Branch B — URL duplicate gate

Otherwise, check if a row with the same `job_url` already exists:

```python
# backend/routers/jobs.py:106-142
t_dedup = monotonic()
if body.job_url:
    existing = await db.execute(
        select(ScrapedJob).where(ScrapedJob.job_url == body.job_url)
    )
    row = existing.scalars().first()
    if row is not None:
        # ... logging ...
        return ScrapedJobIngestResponse(
            id=row.id,
            already_exists=True,
            content_duplicate=False,
            skip_reason="url_duplicate",
        )
```

If yes, **no row is inserted** — return the existing row's ID with `already_exists=True`. This is why "url_exact" was removed from the dedup pipeline (Stage 2): the unique URL constraint at ingest time makes it impossible for two rows with the same URL to coexist, so a Stage-2 URL-equality check would always be a no-op.

Note: `.scalars().first()` — not `.scalar_one_or_none()`. This is a subtle but important distinction. **It's the fix for BUG-1.**

#### Branch C — Insert with content-hash detection

Otherwise, hash the description and check for content duplicates:

```python
# backend/routers/jobs.py:56-58, 144-213
def _hash_description(text: str | None) -> str:
    raw = (text or "").strip().lower()
    return hashlib.sha256(raw.encode()).hexdigest()

# ...later in the handler...
jd = body.job_description
if jd is not None and not str(jd).strip():
    jd = None
    body = body.model_copy(update={"job_description": None})

desc_hash = _hash_description(jd)

hash_match = await db.execute(
    select(ScrapedJob).where(ScrapedJob.raw_description_hash == desc_hash)
)
content_dup_row = hash_match.scalars().first()
content_duplicate = content_dup_row is not None

# ... logging ...

payload = body.model_dump(exclude_unset=False)
payload.pop("original_job_id", None)
if content_duplicate and content_dup_row is not None:
    payload["original_job_id"] = content_dup_row.id
else:
    payload["original_job_id"] = None

new_job = ScrapedJob(
    **payload,
    raw_description_hash=desc_hash,
)
new_job.ingest_source = "extension"
db.add(new_job)
await db.flush()
return ScrapedJobIngestResponse(
    id=new_job.id,
    already_exists=False,
    content_duplicate=content_duplicate,
    skip_reason="content_duplicate" if content_duplicate else None,
)
```

If a row with the same JD hash already exists, **the new row is still inserted** (different URL, same content) but with `original_job_id` pointing to the prior row. The new row's `skip_reason` is null at ingest time — Stage 2's hash_exact dedup will later flag it as `already_scraped`.

> **BUG-1 historical context.** Before 2026-04-22, both branches B and C used `.scalar_one_or_none()`, which asserts "exactly 0 or 1 row." When two existing rows shared the same `raw_description_hash` (legitimately — employer reposts, ATS template sharing), this raised `MultipleResultsFound` and the request returned HTTP 500. 6-10% of LinkedIn ingests on every scan failed this way. The fix replaced both calls with `.scalars().first()`, which tolerates duplicates. After the fix, no more 500s and `new_jobs` per scan jumped from ~50-150 to ~240.

> **Subtle behavior — empty JDs hash collisively.** `_hash_description(None)` returns the SHA-256 of the empty string. So *all* blank-JD rows hash to the same value and are flagged as content duplicates of each other. In practice this rarely matters because the upstream `recordSkip("jd_failed")` path catches most blank-JD cases before they reach this branch. But if it does happen, you end up with a chain of `original_job_id` references through synthetic empty-JD rows, which the Stage-2 chain-resolution logic is designed to flatten.

### Step 9 — Update counters and emit ingest event

After the ingest result comes back, the content script:

```js
// extension/content/linkedin/process.js:117-160
const resultType = !result
  ? "no_response"
  : result.error
    ? "error"
    : !result.id
      ? "rejected"
      : result.already_exists
        ? "existing"
        : result.content_duplicate
          ? "content_duplicate"
          : "new";

await JhaDebug.emit("ingest", {
  job_id: cardData.job_id,
  title: cardData.job_title,
  company: cardData.company,
  took_ms: Date.now() - ingStart,
  result_type: resultType,
  result_error: result?.error || null,
  http_status: result?.http_status ?? null,
}, result && result.id ? "info" : "warn");

if (!result) {
  counters.jd_failed++;
  // ...pushScanError...
} else if (result.error || !result.id) {
  counters.jd_failed++;
  // ...pushScanError...
} else if (result.already_exists || result.content_duplicate) {
  counters.existing++;
} else {
  counters.new_jobs++;
}

await chrome.storage.local.set({ liveProgress: { ...counters } });
```

The `result_type` enum is the canonical taxonomy of ingest outcomes. There are six: `no_response`, `error`, `rejected`, `existing`, `content_duplicate`, `new`.

`liveProgress` is what the popup reads for its display.

> **Unreasonable behavior — run-log counters never update mid-scan.** The run-log row in the backend (`extension_run_logs`) only gets updated at scan completion (Phase 8). During a scan, its `scraped`, `new_jobs`, etc. counters all stay at 0. The dashboard polls `getRunLogs(1)` every 2s expecting to show progress, but it just sees 0/0/0 until the scan completes. The popup gets fresher data because it reads `liveProgress` from extension storage directly. **Fix suggestion:** The content script could PUT incremental updates to the run-log every N cards (say, every 25), or `chrome.storage.onChanged` watching the SW could mirror `liveProgress` to the run-log via debounced PUTs. The dashboard's progress bar is currently aspirational — it shows 0% the whole time, jumps to 100% at completion. Fixing this would make the dashboard genuinely live during scans, not just at the end.

### Bug notes for this phase

- **BUG-1** (resolved) — backend ingest 500s caused by `MultipleResultsFound`. Fixed via `.scalars().first()`.
- **BUG-6** (deferred) — dead `rateLimited` path in Indeed.
- **BUG-7** (deferred) — dead null-apiKey path in Indeed.
- **BUG-8** (deferred) — `processCard` redundant JD compute in LinkedIn (cosmetic).

### Unreasonable behaviors recap

Already covered in line above:
- LinkedIn `fetchCompanyName` doubles per-card cost
- Glassdoor `ageText` extracted but unused
- Glassdoor `salary` / `easyApply` extracted but unused
- `_ingestResultWaiters` Map has no size cap
- Run-log counters don't update mid-scan

---

## 11. Phase 7 — Pagination — getting to the next page of results

The three sites have **fundamentally different pagination models**, which is why their content-script architectures look so different. This section walks through each one.

### LinkedIn — SPA in-place pagination

**File:** `extension/content/linkedin/page.js`, function `runFullScan`.

LinkedIn is a Single Page Application. Clicking "Next page" in the UI changes the URL but does NOT do a full page reload. The same JavaScript context (and our content script) keeps running across all pages. So `runFullScan` is a single `while(true)` loop:

```js
// extension/content/linkedin/page.js:40-59
async function runFullScan(config, tabId) {
  const processedJobIds = new Set();
  const counters = {
    scraped: 0, new_jobs: 0, existing: 0, stale_skipped: 0,
    jd_failed: 0, id_skipped: 0, errors: [],
  };
  let currentPage = 1;

  let mutationCount = 0;
  let mutationObserver = null;
  const cardListEl = document.querySelector(
    ".scaffold-layout__list, .jobs-search-results-list"
  );
  if (cardListEl) {
    mutationObserver = new MutationObserver((mutations) => {
      mutationCount += mutations.length;
    });
    mutationObserver.observe(cardListEl, { childList: true, subtree: true });
  }
```

Note the `MutationObserver` setup: we count DOM changes per page and emit them as a `dom_mutations` event. This is purely diagnostic — useful for figuring out whether a page is "stuck" (mutations stopped happening) vs "completed."

The main loop:

```js
// extension/content/linkedin/page.js:61-85
try {
  while (true) {
    JhaDebug.setPage(currentPage);

    const { stopRequested } = await chrome.storage.local.get("stopRequested");
    if (stopRequested) {
      // emit pagination_ended, break
    }

    await JhaDebug.emit("page_start", {
      url: location.href,
      current_page: currentPage,
      // ...
    });

    const isFirstPage = currentPage === 1;
    const waitStart = Date.now();
    let cards = await waitForCards(isFirstPage ? 12000 : 8000);
    // ...
```

First page gets a 12-second timeout (the SPA needs longer on initial load); subsequent pages get 8 seconds.

The card-processing loop within the page is what we covered in Phase 6. After processing all cards, we move to pagination:

```js
// extension/content/linkedin/page.js:151-167
await new Promise((resolve) =>
  chrome.runtime.sendMessage(
    {
      type: "PUT_EXTENSION_STATE",
      data: {
        current_page: currentPage + 1,
        today_searches: currentPage,
      },
    },
    resolve
  )
);

await JhaDebug.emit("dom_mutations", { page: currentPage, count: mutationCount });
mutationCount = 0;

await JhaDebug.emit("scroll", { /* ... */ });
for (const sel of PAGINATION_CONTAINER_SELECTORS) {
  const el = document.querySelector(sel);
  if (el) {
    el.scrollIntoView({ behavior: "instant", block: "end" });
    break;
  }
}
window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
```

We update the backend's `extension_state.current_page`, scroll to the bottom (LinkedIn lazy-renders the pagination at the bottom — without scrolling, the buttons don't exist in the DOM), and then look for the next button:

```js
// extension/content/linkedin/page.js:169-184
const nextBtn = await pollForNextButton();
const nextDisabled =
  nextBtn &&
  (nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true");

if (!nextBtn || nextDisabled) {
  const pe = {
    type: "pagination_ended",
    page: currentPage,
    reason: nextBtn ? "next_button_disabled" : "next_button_not_found",
    url: location.href,
    // ...
  };
  pushScanError(counters, pe);
  await JhaDebug.emit("pagination_ended", pe);
  await emitPageEnd(counters, currentPage, true);
  break;
}
```

`pollForNextButton` tries five different CSS selectors (LinkedIn class names change A/B-test by A/B-test) for up to 5 seconds:

```js
// extension/content/linkedin/page.js:225-249
async function pollForNextButton(maxMs = 5000, intervalMs = 300) {
  const start = Date.now();
  let iter = 0;
  while (Date.now() - start < maxMs) {
    iter++;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    await sleep(intervalMs);
    for (const sel of NEXT_BUTTON_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        await JhaDebug.emit("next_poll", {
          iter, found: true, selector_matched: sel, elapsed_ms: Date.now() - start,
        });
        return btn;
      }
    }
    await JhaDebug.emit("next_poll", { iter, found: false, elapsed_ms: Date.now() - start });
  }
  return null;
}
```

After clicking next, we wait for the SPA to actually transition. This is tricky because LinkedIn might:
- Change the URL (e.g. add `&start=25`)
- Replace the cards in the DOM
- Or both, in either order

So we watch for *either* signal:

```js
// extension/content/linkedin/page.js:251-261
async function waitForSpaTransition(urlBefore, cardIdsBefore, maxMs = 10000) {
  const start = Date.now();
  const checkIntervalMs = 250;
  while (Date.now() - start < maxMs) {
    await sleep(checkIntervalMs);
    if (location.href !== urlBefore) return true;
    const currentCardIds = getCurrentCardIdSet();
    if (!cardIdSetsEqual(currentCardIds, cardIdsBefore)) return true;
  }
  return false;
}
```

If neither signal fires in 10 seconds, we treat it as a failed transition and end the scan with `reason: "spa_transition_timeout"`.

**Termination conditions for LinkedIn:**
- `stop_requested` → `reason: "stop_requested"`
- 0 cards found after 8s + 3s retry + 8s second retry → `reason: "no_cards_found"`
- Next button not found after 5s polling → `reason: "next_button_not_found"`
- Next button found but disabled → `reason: "next_button_disabled"`
- SPA transition timeout (10s after click) → `reason: "spa_transition_timeout"`

### Indeed — tab navigation pagination

**File:** `extension/content/indeed/page.js`, function `runSinglePage`.

Indeed does *real* page navigation. Each "next page" click changes the actual URL and reloads everything. From our content-script's perspective, this means we lose all in-memory state and have to start fresh on each page.

The function name says it all: `runSinglePage`, not `runFullScan`. It processes one page and returns:

```js
// extension/content/indeed/page.js:21-32
async function runSinglePage(config, state) {
  const counters = {
    scraped: state.scraped || 0,
    new_jobs: state.new_jobs || 0,
    existing: state.existing || 0,
    stale_skipped: state.stale_skipped || 0,
    jd_failed: state.jd_failed || 0,
    totalRateLimited: state.totalRateLimited || 0,
    errors: state.errors || [],
  };
  const currentPage = state.current_page || 1;
```

The counters are inherited from the previous page via the `state` parameter, which itself comes from `chrome.storage.local.scanPageState` (read by `init.js` before calling `runSinglePage`).

After processing all cards:

```js
// extension/content/indeed/page.js:114-138
const nextBtn = document.querySelector(
  '[data-testid="pagination-page-next"]'
);
await JhaDebug.emit("next_poll", {
  iter: 1,
  found: !!nextBtn,
  disabled: !!(nextBtn && nextBtn.disabled),
  has_href: !!(nextBtn && nextBtn.getAttribute("href")),
  selector: '[data-testid="pagination-page-next"]',
});

if (!nextBtn || nextBtn.disabled) {
  // emit pagination_ended, return done:true
}

const nextHref = nextBtn.getAttribute("href");
if (!nextHref) {
  // emit pagination_ended, return done:true
}

const nextUrl = nextHref.startsWith("http")
  ? nextHref
  : "https://ca.indeed.com" + nextHref;
```

Note that we read the `href` attribute rather than clicking. This is because we want to navigate the tab via `chrome.tabs.update` (which gives us better control and triggers our content script to reinject), not via a direct DOM click.

```js
// extension/content/indeed/page.js:152-169
await chrome.storage.local.set({
  scanPageState: {
    ...counters,
    current_page: currentPage + 1,
    today_searches: (state.today_searches || 0) + 1,
  },
  liveProgress: { ...counters, page: currentPage + 1 },
});

await JhaDebug.emit("navigate", {
  next_url: nextUrl,
  from_page: currentPage,
});

await new Promise((resolve) =>
  chrome.runtime.sendMessage({ type: "NAVIGATE_SCAN_TAB", url: nextUrl }, resolve)
);

await emitPageEnd(counters, currentPage, false);
return { ...counters, pages_scanned: currentPage, done: false };
```

In plain language: "Save the current counters and `current_page+1` to storage so the next content-script invocation can pick up. Send `NAVIGATE_SCAN_TAB` to the SW, which calls `chrome.tabs.update(tabId, { url: nextUrl })`. Return `done: false`."

When the tab navigates, the new page loads, the content script gets injected fresh, `init.js` runs again, reads `scanPageState`, calls `runSinglePage` with the carried-over counters, processes the new page, navigates again, and so on.

Only when the next button is missing (or disabled, or has no href) does `runSinglePage` return `{done: true}`. That's the signal for `init.js` to write `scanComplete` and trigger Phase 8.

### Glassdoor — "Show more jobs" infinite scroll

**File:** `extension/content/glassdoor/page.js`, function `scanGlassdoorPage`.

Glassdoor uses neither real navigation nor SPA URL changes. Instead, the search results page has a "Show more jobs" button at the bottom; clicking it appends additional job cards to the same DOM. The URL never changes during a Glassdoor scan.

```js
// extension/content/glassdoor/page.js:21-30
async function scanGlassdoorPage(config, runId) {
  const counters = {
    scraped: 0, new_jobs: 0, existing: 0, stale_skipped: 0,
    jd_failed: 0, pages: 0, errors: [],
  };
  const SHOW_MORE_MIN_WAIT_MS = 1500;
  const SHOW_MORE_POLL_MS = 500;
  const SHOW_MORE_MAX_WAIT_MS = 12000;
  const processedJobIds = new Set();
  let pageNum = 0;
```

The outer `while(true)` loop iterates "pages" (really "batches of cards added by Show more clicks"). Within each iteration:

1. Filter `[data-jobid]` cards by `processedJobIds` Set → only cards we haven't processed
2. If no new cards found after 10×800ms polling → end (everything we have is already processed)
3. Process each new card (Phase 6 inner loop)
4. Find "Show more jobs" button by **text match** (no stable CSS selector!)
5. Click it
6. Wait at least 1.5 seconds, then poll DOM count every 500ms for up to 12 seconds
7. If new cards appeared → loop. If not → end.

The text-match button finder:

```js
// extension/content/glassdoor/page.js:140-142
const showMoreBtn = Array.from(document.querySelectorAll("button")).find(
  (b) => b.offsetParent !== null && b.textContent.trim() === "Show more jobs"
);
```

Plain language: "Find a `<button>` whose text is exactly 'Show more jobs' and which is currently visible (`offsetParent !== null`)." This is fragile — if Glassdoor renames the button or localizes it (e.g. French Canadian users might see "Voir plus d'emplois"), this breaks. But the button has no stable id or class, so text-match is the cleanest available option.

The DOM-count polling after click:

```js
// extension/content/glassdoor/page.js:153-180
showMoreBtn.click();
await sleep(SHOW_MORE_MIN_WAIT_MS);
let waited = SHOW_MORE_MIN_WAIT_MS;
while (waited < SHOW_MORE_MAX_WAIT_MS) {
  await sleep(SHOW_MORE_POLL_MS);
  waited += SHOW_MORE_POLL_MS;
  const newTotal = document.querySelectorAll("[data-jobid]").length;
  if (newTotal > domCountBefore) {
    await JhaDebug.emit("show_more_loaded", { /* ... */ });
    break;
  }
}

const finalDomCount = document.querySelectorAll("[data-jobid]").length;
if (finalDomCount === domCountBefore) {
  // emit pagination_ended with reason: "show_more_timeout"
  break;
}
```

We wait at least 1.5 seconds (Glassdoor's animation; we don't want to poll during it), then check every 500ms for up to 12 seconds. As soon as the count grows, we break and continue to the next iteration.

**Termination conditions for Glassdoor:**
- `stop_requested` → `reason: "stop_requested"`
- No new cards found after 10×800ms polling → `reason: "no_new_cards_found"`
- Show more button not found → `reason: "show_more_button_not_found"`
- 12s timeout after click with no DOM growth → `reason: "show_more_timeout"`

> **Why ~71 Glassdoor cards is the practical max.** Glassdoor's UI says things like "107 jobs" but the "Show more jobs" button stops appearing after roughly 30+30+11 cards. The remaining listings are behind a deeper auth wall (or maybe they're already sold ad slots — hard to tell). Our scan correctly grabs all accessible cards.

### Rate-limit handling differs across sites

| Site | Rate-limit detection | Response |
|---|---|---|
| LinkedIn | 429/403/999 from Voyager | Per-card fail (`error: "http_429"`); scan continues |
| Indeed | Any non-success including 429 → `phantom: true` | Per-card silent skip (`stale_skipped`); scan continues |
| Glassdoor | Per-card `rateLimited` flag (currently unreachable) → 60s sleep + continue | Per-card cooldown |

In practice with the current Indeed GraphQL strategy, rate limits are virtually never hit. The cooldown branches are rarely or never exercised.

### Bug notes for this phase

- **BUG-6** (deferred) — dead Indeed `rateLimited` path, mentioned in Phase 6.

### Unreasonable behavior in this phase

> **LinkedIn pagination logic is deeply nested inside one ~250-line function.** `runFullScan` does card discovery, card processing, scrolling, next-button polling, click, transition wait, error handling, and finalization, all inline in one `while` loop. **Fix suggestion:** Extract per-page-step helpers: `processPage(cards, config, counters)`, `scrollToBottom()`, `findAndClickNext()`, `awaitTransition(prevUrl, prevCardIds)`. Each helper becomes 20-30 lines and individually testable. The main loop becomes 30 lines and reads as a high-level outline. Same fix is appropriate for Glassdoor's `scanGlassdoorPage`.

> **Glassdoor "Show more jobs" button matching by exact text breaks on locale changes.** A French Canadian user with Glassdoor's UI in French would see "Voir plus d'emplois" (or similar) and our matcher returns nothing — pagination ends after page 1. **Fix suggestion:** Match by stable structural property if possible (the button's parent has a particular class, or the button is the last `<button>` in a particular container), or maintain a list of known-good text strings keyed by `document.documentElement.lang`. Lowest effort: match by `textContent.trim().toLowerCase().includes("show more") || textContent.includes("voir plus")` etc.

---

## 12. Phase 8 — Completion and optional sync dedup

**Files involved:**
- `extension/background/scan_completion.js` (the SW-side completion handler)
- `backend/routers/extension.py` lines 261-298 (`PUT /extension/run-log/{log_id}`)
- `backend/routers/extension.py` lines 31-57 (`_run_dedup_for_scan`)

### Step 1 — Content script writes `scanComplete` to storage

This is the trigger for the entire completion phase. Recall from Phase 5 that `init.js` ends with:

```js
// extension/content/linkedin/init.js:113-119
await chrome.storage.local.remove(["scanConfig"]);
await chrome.storage.local.set({
  scanInProgress: false,
  scanComplete: { tabId, summary, runId, completedAt: Date.now() },
});
```

The `scanComplete` write is what triggers the next step. It contains:
- `tabId` — the popup window's tab, so the SW knows which one to close
- `summary` — final counters (`scraped`, `new_jobs`, `existing`, etc.)
- `runId` — the UUID linking back to the run-log row
- `completedAt` — timestamp

### Step 2 — `scan_completion.js` handler fires

The SW has a `chrome.storage.onChanged` listener that watches for `scanComplete`:

```js
// extension/background/scan_completion.js:3-66
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.scanComplete) return;
  if (!changes.scanComplete.newValue) return;

  const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
  if (scanTimeoutId) {
    clearTimeout(parseInt(scanTimeoutId));
    chrome.storage.local.remove("scanTimeoutId");
  }

  const { tabId, summary, runId } = changes.scanComplete.newValue;
  const { backendUrl, authToken } = await getSettings();

  const { debugLog } = await chrome.storage.local.get("debugLog");
  if (
    debugLog &&
    debugLog.runId === runId &&
    Array.isArray(debugLog.events) &&
    debugLog.events.length
  ) {
    try {
      await fetch(`${backendUrl}/extension/run-log/${runId}/debug`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: debugLog.events }),
      });
    } catch (e) {
      console.warn("[JHA] Final debug flush failed:", e.message);
    }
  }
  await chrome.storage.local.remove("debugLog");

  try {
    await fetch(`${backendUrl}/extension/run-log/${runId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "completed",
        completed_at: new Date().toISOString(),
        pages_scanned: summary.pages_scanned,
        scraped: summary.scraped,
        new_jobs: summary.new_jobs,
        existing: summary.existing,
        stale_skipped: summary.stale_skipped,
        jd_failed: summary.jd_failed,
        errors: summary.errors || [],
      }),
    });
  } catch (e) {
    console.error("[JHA] Failed to update run log:", e);
  }

  stopKeepAlive();
  chrome.storage.local.remove(["scanComplete", "scanPageState"]);
  chrome.storage.local.set({ lastRunSummary: summary, liveProgress: null });
  if (tabId) chrome.tabs.remove(tabId);
});
```

In order:

1. **Cancel the 90-minute safety timeout.** The scan completed cleanly, no need for the safety net.
2. **Final debug flush.** Send any remaining trace events from `chrome.storage.local.debugLog` to the backend's debug endpoint. This is a critical step — without it, events emitted right at the end of the scan would be lost.
3. **PUT the run-log to status="completed"** with all final counters. This is the trigger for the backend's optional sync-dedup logic (next step).
4. **Stop keepalive.** No more SW pinging needed.
5. **Clean up storage.** Remove `scanComplete`, `scanPageState`. Set `lastRunSummary` (for the popup display) and clear `liveProgress`.
6. **Close the popup window.** `chrome.tabs.remove(tabId)`. The user sees the popup close — visual confirmation the scan is done.

The order **debug-flush before run-log PUT** matters. The PUT response can trigger sync dedup, and we want all trace events captured before any post-scan processing modifies things.

### Step 3 — Backend PUT handler decides whether to fire dedup

```python
# backend/routers/extension.py:261-298
@router.put("/run-log/{log_id}", response_model=RunLogRead)
async def update_run_log(
    log_id: UUID,
    body: RunLogUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.id == log_id)
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=404, detail="Run log not found")

    prior_status = log.status

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(log, field, value)

    await db.flush()
    await db.refresh(log)

    if body.status == "completed" and prior_status != "completed":
        config_data = await read_config_file()
        cfg = SearchConfigRead(**config_data)
        if cfg.dedup_mode == "sync":
            should_dedup = True
            if log.scan_all:
                should_dedup = (
                    log.scan_all_position is not None
                    and log.scan_all_total is not None
                    and log.scan_all_position == log.scan_all_total
                )
            if should_dedup:
                task = asyncio.create_task(_run_dedup_for_scan(log_id))
                _BACKGROUND_TASKS.add(task)
                task.add_done_callback(_BACKGROUND_TASKS.discard)

    return log
```

Three guards control whether dedup actually fires:

**Guard 1: `prior_status != "completed"`.** Captures the prior status *before* applying the body update. If the body is setting `status=completed` and the row was previously something else (`running`), this is a real transition and we proceed. If the row was already `completed` (e.g. duplicate PUT), we don't fire dedup again. Idempotent.

**Guard 2: `cfg.dedup_mode == "sync"`.** Read live from the config file. If the user has dedup_mode set to `"manual"`, no auto-dedup ever fires; they have to click "Run Dedup" on the dashboard's `/dedup` page.

**Guard 3: Scan All last-leg gate.** If this run was part of Scan All (`log.scan_all == True`), only fire dedup when `scan_all_position == scan_all_total`. For a 3-leg Scan All (LinkedIn, Indeed, Glassdoor), this is true only when leg 3 (Glassdoor) completes. Legs 1 and 2 skip dedup; we wait until everything is in.

If all three guards pass, we use **`asyncio.create_task`** to fire the dedup task in the background. Two important details about this:

- `_BACKGROUND_TASKS.add(task)` — without this, Python's garbage collector might collect the task object while it's still running (orphaned tasks are eligible for GC).
- `task.add_done_callback(_BACKGROUND_TASKS.discard)` — when the task finishes, remove its reference so the set doesn't grow forever.

This is the correct way to "fire and forget" in asyncio. The alternative, `FastAPI.BackgroundTask`, has a fatal flaw: it's tied to the request lifecycle. If the extension closes the connection (which it does, immediately after the PUT response), the BackgroundTask gets cancelled. We need our task to outlive the request, which only `asyncio.create_task` can do.

### Step 4 — `_run_dedup_for_scan` runs in detached task

```python
# backend/routers/extension.py:31-57
async def _run_dedup_for_scan(log_id: UUID) -> None:
    """
    Runs full dedup after a scan completes. Uses its own DB session — the request
    session is closed after the PUT response.
    """
    async with AsyncSessionLocal() as db:
        try:
            config_data = await read_config_file()
            cfg = SearchConfigRead(**config_data)
            await run_dedup(
                db=db,
                config=cfg,
                settings=settings,
                scan_run_id=log_id,
                trigger="post_scan",
            )
            if cfg.dedup_mode == "sync":
                await run_step_b_extraction(db, trigger="post_dedup")
            await db.commit()
        except Exception:
            logger.exception("Auto dedup failed for scan run %s", log_id)
            await db.rollback()
```

Three things to note:

**Fresh `AsyncSessionLocal`.** The request session that handled the PUT is closed immediately after the response. The detached task opens its own session via `AsyncSessionLocal()` (a SQLAlchemy session factory). Never reuses the request's session — that would cause "session is closed" errors as soon as we try to query.

**Auto-chains B-extraction after dedup in sync mode.** The line `await run_step_b_extraction(db, trigger="post_dedup")` runs *immediately after* dedup completes. Stage 3 (Matching) has multiple steps, and the first (Step B = CPU-based JD extraction) is fired automatically. This is **not documented in the design docs** — the design doc says sync mode only runs dedup. The reality is: sync mode = dedup + Step B chained.

**Error handling rolls back the transaction.** If anything fails, log it and roll back. The run-log row stays as `completed` (we already returned that response), but the dedup/extraction work is undone.

### Step 5 — Frontend detects completion via polling

The dashboard's polling loop (Phase 1) detects the status change:

```jsx
// frontend/src/pages/JobsPage.jsx:291-305
useEffect(() => {
  const wasScanning = prevScanningRef.current
  prevScanningRef.current = scanning
  if (wasScanning && !scanning && !scanAllActive) {
    setWebsiteFilter('all')
    setScrapedFrom('')
    setJobsPage(1)
    fetchJobsList(1).catch(() => {})
    checkRunLog().catch(() => {})
    setProgressOverride(100)
    const t = setTimeout(() => setProgressOverride(null), 1500)
    return () => clearTimeout(t)
  }
  return undefined
}, [scanning, scanAllActive, fetchJobsList, checkRunLog])
```

When `scanning` flips from true to false (and we're not in a Scan All sequence):
- Reset filters to defaults (so the user sees newly-scraped jobs from the run)
- Reset page to 1
- Refetch the job grid (newly-scraped jobs now appear)
- Refresh the run-log
- Flash the progress bar at 100% for 1.5 seconds before clearing

The user sees: spinner stops, progress bar shows 100% briefly, then clears. The job grid populates with new jobs. The "Last scan: 🔵 LinkedIn · 187 new · 8 existing · started 2:34 PM" footer appears.

### Bug notes for this phase

No outstanding bugs in Phase 8 specifically. The design is solid.

### Unreasonable behavior in this phase

> **Sync mode auto-chains Step B but it's not documented.** Reading the design docs, you'd think `dedup_mode = "sync"` only triggers dedup. The actual behavior chains `run_step_b_extraction` after dedup. **Fix suggestion:** Either remove the auto-chaining (let users explicitly trigger Step B from the Matching page) or document it loudly. Currently it's a hidden behavior that a future maintainer would need to discover by reading the code.

> **The dedup task uses module-level state.** `_BACKGROUND_TASKS` is a module-level `set`. If the FastAPI process is restarted mid-dedup (e.g. deploy), the task is killed. The run-log says `status: completed` but the dedup never finished — and there's no way to detect this. **Fix suggestion:** Either persist task state in PostgreSQL (a `dedup_tasks` table with `status: pending|running|completed|failed`) or accept this as a known tradeoff and document it: "after a backend restart, manually re-run dedup via the dashboard."

---

## 13. Scan All — sequential three-site orchestration

**Files involved:**
- `frontend/src/pages/JobsPage.jsx` lines 346-399 (the `handleScanAll` function)
- `frontend/src/pages/JobsPage.jsx` lines 200-280 (the polling loop that watches for leg completion)
- `frontend/src/api.js` (the `triggerScan` and `getRunLogs` calls)

Scan All is a one-button shortcut: instead of the user clicking Scan LinkedIn, waiting for it to finish, then clicking Scan Indeed, then clicking Scan Glassdoor, they click ▶▶ Scan All once and the dashboard runs all three sequentially. **The orchestration lives entirely in the dashboard, not the extension.** The extension just sees three normal scan triggers in sequence; it has no concept of "this is part of Scan All" beyond the metadata fields we pass.

### Why sequential, not parallel

You might wonder: why not run all three sites in parallel? Two reasons:

**(1) The extension is single-instance.** There's exactly one service worker and one `chrome.storage.local.scanInProgress` flag. Trying to scan two sites simultaneously would have them stomp on each other's storage state.

**(2) Resource contention.** Each scan opens a popup window with continuous network activity. Three at once would compete for bandwidth, and any rate-limiting on the user's connection (or the site) would cascade across all of them.

So Scan All is *strictly* sequential. The dashboard launches one site, waits for it to finish, then launches the next.

### The handler

```jsx
// frontend/src/pages/JobsPage.jsx:346-399
async function handleScanAll() {
  if (scanAllActive) return
  setScanAllActive(true)
  setScanAllProgress({ position: 0, total: 3 })
  try {
    const websites = ['linkedin', 'indeed', 'glassdoor']
    const totals = {}
    const totalPromises = await Promise.all([
      api.getJobs({ website: 'linkedin', limit: 1 }).catch(() => null),
      api.getJobs({ website: 'indeed',   limit: 1 }).catch(() => null),
      api.getJobs({ website: 'glassdoor',limit: 1 }).catch(() => null),
    ])
    websites.forEach((w, idx) => {
      totals[w] = totalPromises[idx]?.total ?? null
    })
    setScanAllTotals(totals)

    for (let i = 0; i < websites.length; i++) {
      const w = websites[i]
      setCurrentScanWebsite(w)
      setScanAllProgress({ position: i + 1, total: websites.length })
      scanTriggerGraceRef.current = Date.now()
      setScanning(true)

      await api.triggerScan(w, {
        scan_all: true,
        scan_all_position: i + 1,
        scan_all_total: websites.length,
      })

      await new Promise(r => setTimeout(r, 3000))

      const deadline = Date.now() + 30 * 60 * 1000
      while (Date.now() < deadline) {
        const logs = await api.getRunLogs(5).catch(() => [])
        const matching = logs.find(l =>
          l.search_filters?.website === w &&
          (l.status === 'completed' || l.status === 'failed')
        )
        if (matching) break
        await new Promise(r => setTimeout(r, 5000))
      }

      await new Promise(r => setTimeout(r, 2000))
    }
  } finally {
    setScanAllActive(false)
    setCurrentScanWebsite(null)
    setScanAllProgress({ position: 0, total: 0 })
    setScanning(false)
    setScanAllTotals({})
    fetchJobsList(1).catch(() => {})
    checkRunLog().catch(() => {})
  }
}
```

Walk through it carefully. There's a lot packed into 53 lines.

### Step 1 — Pre-fetch the per-site totals

```jsx
// frontend/src/pages/JobsPage.jsx:351-359
const totalPromises = await Promise.all([
  api.getJobs({ website: 'linkedin', limit: 1 }).catch(() => null),
  api.getJobs({ website: 'indeed',   limit: 1 }).catch(() => null),
  api.getJobs({ website: 'glassdoor',limit: 1 }).catch(() => null),
])
websites.forEach((w, idx) => {
  totals[w] = totalPromises[idx]?.total ?? null
})
setScanAllTotals(totals)
```

Three parallel `getJobs` calls with `limit: 1`. The point isn't to fetch jobs — it's to read the `total` field from the response (the count of all jobs from that website currently in the DB). These totals are stored and used later by the progress-bar component to compute "how far through the current leg are we?"

`Promise.all` runs all three in parallel for speed (sequential would be three round trips). `.catch(() => null)` ensures one failure doesn't crash the whole `Promise.all`.

### Step 2 — Loop over the three websites

```jsx
// frontend/src/pages/JobsPage.jsx:362-388
for (let i = 0; i < websites.length; i++) {
  const w = websites[i]
  setCurrentScanWebsite(w)
  setScanAllProgress({ position: i + 1, total: websites.length })
  scanTriggerGraceRef.current = Date.now()
  setScanning(true)

  await api.triggerScan(w, {
    scan_all: true,
    scan_all_position: i + 1,
    scan_all_total: websites.length,
  })
```

For each iteration:
1. **`setCurrentScanWebsite(w)`** — update the React state so the progress UI shows "Scanning LinkedIn (1/3)…"
2. **`setScanAllProgress({position, total})`** — these drive the leg counter
3. **`scanTriggerGraceRef.current = Date.now()`** — start the 15-second grace timer (same as single-site scan, Phase 1)
4. **`setScanning(true)`** — optimistic UI flip
5. **`api.triggerScan(w, {scan_all, scan_all_position, scan_all_total})`** — POST to backend with Scan All metadata

The metadata `{scan_all: true, scan_all_position: 1, scan_all_total: 3}` flows through the system: it's stored in `extension_state` (Phase 2), consumed by `pollForScanTrigger` (Phase 3), passed into `handleManualScan` options (Phase 4), written into the new run-log row (Phase 4 step 6), and used by the sync-dedup gate at the very end (Phase 8 step 3).

### Step 3 — Wait 3 seconds, then poll for completion

```jsx
// frontend/src/pages/JobsPage.jsx:374-385
await new Promise(r => setTimeout(r, 3000))

const deadline = Date.now() + 30 * 60 * 1000
while (Date.now() < deadline) {
  const logs = await api.getRunLogs(5).catch(() => [])
  const matching = logs.find(l =>
    l.search_filters?.website === w &&
    (l.status === 'completed' || l.status === 'failed')
  )
  if (matching) break
  await new Promise(r => setTimeout(r, 5000))
}
```

The 3-second initial wait gives the SW time to consume the trigger and create a run-log row. Without this, the polling loop's first iteration could see a stale run-log from the previous leg and incorrectly think *that* one was the current leg's completion.

Then we poll `GET /extension/run-log?limit=5` every 5 seconds, looking for a run-log whose `search_filters.website` matches the current leg AND whose `status` is `completed` or `failed`. When we find one, we know this leg is done and can move on.

The 30-minute deadline per leg is the per-leg upper bound. Real legs take 1-15 minutes, so 30 is plenty of margin. If a leg genuinely hangs for 30 minutes, the loop exits without finding the completion and falls through to the next leg — leaving the hung scan still running in the background. Not great, but Scan All keeps moving rather than getting stuck.

### Step 4 — Wait 2 seconds before next leg

```jsx
// frontend/src/pages/JobsPage.jsx:387
await new Promise(r => setTimeout(r, 2000))
```

A 2-second pause between legs. Gives the previous scan's tab time to actually close (the `chrome.tabs.remove` from Phase 8 is async) and the storage cleanup to settle before the next `triggerScan` fires.

### Progress calculation across legs

The progress bar is computed by `getScanAllPct`:

```jsx
// frontend/src/pages/JobsPage.jsx:71-104
function getScanAllPct({
  scanAllProgress, currentScanWebsite, scanAllTotals, runLogs, scanInProgress
}) {
  if (!scanAllProgress.total) return 0
  const SLICE = 100 / scanAllProgress.total
  const websiteIdx = scanAllProgress.position - 1
  const baseProgress = websiteIdx * SLICE

  if (!scanInProgress || !currentScanWebsite) return baseProgress

  const total = scanAllTotals[currentScanWebsite]
  if (!total || total <= 0) return baseProgress

  const recentLog = runLogs.find(
    l => l.search_filters?.website === currentScanWebsite && l.status === 'running'
  )
  if (!recentLog) return baseProgress

  const scraped = recentLog.scraped || 0
  const within = Math.min(SLICE - 0.5, (scraped / total) * SLICE)
  return Math.min(99, baseProgress + within)
}
```

The progress bar covers 0-99% across all three legs (capped at 99% so it only hits 100% at completion). Each leg gets a "slice" of `100 / 3 = 33.33%`. Within a leg, progress is `(scraped / total) * SLICE`, capped to `SLICE - 0.5` to prevent a leg from prematurely showing 100% if `scraped` exceeds `total` (which can happen — `total` was a snapshot from before the scan, and the scan can scrape new jobs).

Combined: `baseProgress + within` = "completed legs" + "fraction of the current leg." For example, halfway through Indeed (leg 2 of 3) when `scraped == total/2`, you'd see `33.33% + (33.33% / 2) = 50%`.

### Sync-dedup gate at the end of Scan All

This is the punchline of all the `scan_all_*` metadata threading. Recall from Phase 8 step 3:

```python
# backend/routers/extension.py:285-294
if cfg.dedup_mode == "sync":
    should_dedup = True
    if log.scan_all:
        should_dedup = (
            log.scan_all_position is not None
            and log.scan_all_total is not None
            and log.scan_all_position == log.scan_all_total
        )
    if should_dedup:
        task = asyncio.create_task(_run_dedup_for_scan(log_id))
```

For Scan All:
- Leg 1 (LinkedIn) completes with `scan_all_position=1, scan_all_total=3` → `1 != 3` → **no dedup**
- Leg 2 (Indeed) completes with `scan_all_position=2, scan_all_total=3` → `2 != 3` → **no dedup**
- Leg 3 (Glassdoor) completes with `scan_all_position=3, scan_all_total=3` → `3 == 3` → **fire dedup**

This avoids three separate dedup runs (which would each be working with partial data) and fires a single comprehensive one after all data is in.

### Bug notes for this phase

No outstanding bugs specific to Scan All.

### Unreasonable behavior in this phase

> **Dashboard polls per-leg via the same generic `getRunLogs` endpoint.** Every 5 seconds during Scan All, the dashboard fetches the 5 most recent run-logs and filters by website. With 3 legs × ~10 polls per leg, that's ~30 needless requests, each fetching 5 run-log rows including all their `debug_log` JSONB. **Fix suggestion:** Add an endpoint `GET /extension/run-log/by-website/{website}/latest?status=completed,failed` that returns just the most recent matching log without `debug_log`. Halves the bandwidth and is faster to query (uses an index).

> **The 30-minute per-leg deadline is silent on timeout.** If a leg actually hangs for 30 minutes (which would be a serious bug), the polling loop exits without any error, the next leg starts, and the hung leg's run-log stays as `status: running` forever. There's no UI indication that anything went wrong. **Fix suggestion:** When the deadline expires without finding completion, surface an error toast ("LinkedIn scan exceeded 30 minutes — skipping to next leg. Check the run log."). Also call `triggerStop` to clean up the hung scan rather than leaving it running.

---

## 14. The debug trace system (cuts across all phases)

**Files involved:**
- `extension/content/shared/debug_logger.js` (the JhaDebug namespace, used by content scripts)
- `extension/background/debug_flush.js` (the SW-side debug message handler)
- `backend/routers/extension.py` lines 232-256 (the `POST /extension/run-log/{log_id}/debug` endpoint)

The debug trace is the single most important diagnostic feature in the extension. Every scan emits 100-1000+ trace events that get persisted to the run-log's `debug_log` JSONB column. When a scan misbehaves, the trace tells you exactly what happened, when, and where.

### What's in a trace event

Every event has the same envelope:

```js
{
  ts: 1714065432123,           // epoch milliseconds
  iso: "2026-04-25T19:30:32.123Z", // ISO timestamp
  ts_rel_ms: 4523,             // milliseconds since scan_start
  type: "ingest",              // event type — see taxonomy below
  level: "info",               // info | warn | error
  runId: "abc-uuid",           // the run-log UUID
  page: 2,                     // current page number (set via JhaDebug.setPage)
  data: { /* event-specific payload */ }
}
```

`ts_rel_ms` is the most useful field for diagnosis — it lets you scan down a trace and see "the scan started taking too long around 30 seconds in." Absolute timestamps are harder to read.

### Event taxonomy

There are about 25 distinct event types. The most important:

| Type | Emitted by | When | Useful for |
|---|---|---|---|
| `scan_start` | content init | Once at scan begin | Recording config, entry URL |
| `scan_end` | content init | Once at scan end | Final summary, exit reason |
| `session_check` | content init | Once after `scan_start` | LinkedIn auth status (live/expired/captcha) |
| `heartbeat` | content init | Every 10s during scan | SW liveness check, page URL changes |
| `page_start` | content page.js | Once per page | Card count, mutation count baseline |
| `page_end` | content page.js | Once per page | Per-page counters delta |
| `card_process` | content page.js | Once per card | Job ID, duplicate detection |
| `voyager_fetch` | LinkedIn voyager.js | Per JD attempt | HTTP status, retry count, JD length |
| `indeed_jd_fetch` | Indeed rate_strategy.js | Per JD attempt | API key state, GraphQL response shape |
| `glassdoor_jd_fetch` | Glassdoor fetch_jd.js | Per JD attempt | Which strategy succeeded |
| `ingest` | content process.js | Per ingest call | result_type (new/existing/etc), HTTP status |
| `next_poll` | content page.js | Per next-button check | Selector matched, elapsed ms |
| `pagination_ended` | content page.js | Once per scan | The reason the scan stopped paginating |
| `error` | anywhere | On exceptions | Stack trace, where, message |
| `dom_mutations` | LinkedIn page.js | Per page | Mutation count (was DOM active?) |

The full taxonomy is in `step3-match-design.md`'s observability section, but you mostly only need to recognize these.

### How emit works

The core `emit` function:

```js
// extension/content/shared/debug_logger.js:71-119
async emit(type, data = {}, level = "info") {
  if (!this._inited) return;
  try {
    const now = Date.now();
    const event = {
      ts: now,
      iso: new Date(now).toISOString(),
      ts_rel_ms: now - this._scanStartMs,
      type,
      level,
      runId: this._runId,
      page: this._currentPage,
      data: this._sanitize(data),
    };

    const { debugLog } = await chrome.storage.local.get("debugLog");
    if (!debugLog || debugLog.runId !== this._runId) {
      await chrome.storage.local.set({
        debugLog: {
          runId: this._runId,
          scanStartMs: this._scanStartMs,
          events: [event],
        },
      });
    } else {
      const events = debugLog.events || [];
      events.push(event);
      await chrome.storage.local.set({
        debugLog: { ...debugLog, events },
      });
    }

    if (
      this._lastFlushAtMs === 0 ||
      now - this._lastFlushAtMs > 5000 ||
      (await this._eventCount()) >= 100
    ) {
      await this._flush();
    }
  } catch (_) {
    // swallow — never throw from logger
  }
}
```

In plain language:
1. Build the event envelope with timestamp, type, level, sanitized data
2. Read current `debugLog` from storage (initializing it if missing or for a different runId)
3. Append the new event
4. Write back to storage
5. **Auto-flush** if either (a) it's been 5+ seconds since last flush OR (b) buffer has 100+ events

Auto-flush bounds storage usage: in a long scan with 5000+ events, we don't keep all 5000 in chrome.storage.local — we periodically push them to the backend.

### How flush works

```js
// extension/content/shared/debug_logger.js:121-152
async _flush() {
  if (!this._inited) return;
  const { debugLog } = await chrome.storage.local.get("debugLog");
  if (!debugLog || !debugLog.events || debugLog.events.length === 0) return;
  const eventsToSend = debugLog.events.slice();

  this._lastFlushAtMs = Date.now();

  try {
    const result = await new Promise((resolve) =>
      chrome.runtime.sendMessage(
        { type: "FLUSH_DEBUG_LOG", events: eventsToSend, runId: this._runId },
        resolve
      )
    );
    if (result && result.ok) {
      const { debugLog: cur } = await chrome.storage.local.get("debugLog");
      if (cur && cur.runId === this._runId) {
        const remaining = (cur.events || []).slice(eventsToSend.length);
        await chrome.storage.local.set({
          debugLog: { ...cur, events: remaining },
        });
      }
    }
  } catch (_) {}
}
```

The pattern: snapshot the events array, send to SW, on success remove the **first N** from the storage array (where N is what we sent). The "first N" approach (`slice(eventsToSend.length)`) instead of "clear the array" is deliberate — it preserves any events that were appended *during* the flush operation. Without this, those concurrent events would be lost.

> **BUG-4 (deferred): JhaDebug emit has a read-modify-write race.** The heartbeat `setInterval` at 10s and the per-card emits run concurrently. Both do `read storage → mutate events array → write storage` without coordination. Occasionally a write is clobbered, losing one event from the trace. Observed once on Glassdoor: 1 lost event out of 513 (0.2%). The actual scan behavior is unaffected — only trace completeness suffers. **Fix suggestion:** Add a promise-chain serialization. Roughly:
> ```js
> // proposed fix
> let _emitChain = Promise.resolve();
> async emit(type, data, level) {
>   _emitChain = _emitChain.then(() => this._doEmit(type, data, level));
>   return _emitChain;
> }
> ```
> All emits become serial. ~5 lines. Defer until trace gaps actually cause a diagnosis to fail.

### The SW-side handler

The `FLUSH_DEBUG_LOG` message is handled by `debug_flush.js`:

```js
// extension/background/debug_flush.js:3-30
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FLUSH_DEBUG_LOG") {
    (async () => {
      const { backendUrl, authToken } = await getSettings();
      const runId = message.runId;
      const events = Array.isArray(message.events) ? message.events : [];
      if (!runId || events.length === 0) {
        sendResponse({ ok: true, sent: 0 });
        return;
      }
      try {
        const res = await fetch(
          `${backendUrl}/extension/run-log/${runId}/debug`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ events }),
          }
        );
        sendResponse({ ok: res.ok, sent: events.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
```

The `return true` is critical — it tells Chrome "I'm going to respond asynchronously," keeping the message channel open until `sendResponse` is called. Without it, the channel closes immediately and the content script's `await` on `sendMessage` resolves with `undefined`.

### The backend endpoint

```python
# backend/routers/extension.py:232-256
@router.post("/run-log/{log_id}/debug")
async def append_debug_log(
    log_id: UUID,
    body: DebugLogAppend,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.id == log_id)
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=404, detail="Run log not found")
    existing = list(log.debug_log or [])
    new_events = list(body.events or [])
    combined = existing + new_events
    if len(combined) > settings.debug_log_ring_size:
        combined = combined[-settings.debug_log_ring_size :]
    log.debug_log = combined
    await db.flush()
    return {"ok": True, "appended": len(new_events), "total": len(combined)}
```

It's an **append-with-truncation** pattern: read existing events, append new, if the total exceeds the ring buffer size (default 10000 from `settings.debug_log_ring_size`), keep only the last 10000. Earlier events are discarded.

This means scans with >10000 events will lose the *earliest* events. In practice scans emit ~500-2000 events, well under the cap. But complex Scan All sequences with verbose tracing can hit it.

### Sanitization

The `_sanitize` function redacts sensitive fields. Looking at the regex:

```js
// extension/content/shared/debug_logger.js:13
const JHA_DEBUG_CREDENTIAL_KEY_RE = /token|auth|bearer|csrf|api.?key|cookie|password|secret/i;
```

Any object key matching this regex has its value replaced with `"[REDACTED]"`. The walk is recursive (depth limit 6) and bounded:
- Max string length: 2000 chars (longer strings get truncated with `...[N more]`)
- Max recursion depth: 6
- Max array length: 500

This prevents huge nested objects from making trace events enormous.

### Bug notes for this phase

- **BUG-4** (deferred) — emit race, mentioned above.
- **BUG-5** (deferred) — `storage_keepalive_age_ms` reports stale data on first heartbeat (cosmetic only).

### Unreasonable behavior in this phase

> **Per-event chrome.storage write is wasteful for high-frequency emits.** Each `emit` does a `chrome.storage.local.get` followed by a `chrome.storage.local.set`. At 5-10 emits per card on LinkedIn, that's 1000-4000 storage round trips per scan. Each is ~1ms, so ~1-4 seconds of overhead. **Fix suggestion:** Buffer emits in a module-level array and only write to storage on auto-flush (or scan end). This also fixes BUG-4 as a side effect.

> **`emit` returns a Promise that is rarely awaited.** Most callers do `await JhaDebug.emit(...)`, but a few call it without await. On a slow storage path, those non-awaited emits race against subsequent code. Visible in `linkedin/page.js` heartbeat — the `setInterval` callback fires emit but doesn't await it. **Fix suggestion:** Either always await (audit the codebase and add `await`) or change `emit` to be sync-write-to-buffer + async-flush so the await wouldn't matter. The buffer-then-flush approach above gives both.

---

## 15. Error and recovery paths

This section catalogs every failure mode in a scan and how the system handles it. As an onboarding teammate, you'll want to recognize these when they appear in trace events and bug reports.

### A. The user closes the popup window

The popup window is open during the scan. The user sees it, ignores it, and either accidentally or deliberately closes it.

**Detection:** `tabs_safety.js` registers a `chrome.tabs.onRemoved` listener:

```js
// extension/background/tabs_safety.js:3-44
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { scanInProgress, scanConfig } = await chrome.storage.local.get([
    "scanInProgress",
    "scanConfig",
  ]);
  if (!scanInProgress) return;
  if (!scanConfig || scanConfig.tabId !== tabId) return;

  console.log("[JHA] Scan tab closed — cleaning up");
  const { backendUrl, authToken } = await getSettings();

  if (scanConfig.runId) {
    try {
      await fetch(`${backendUrl}/extension/run-log/${scanConfig.runId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          error_message: "Scan tab closed by user",
        }),
      }).catch(() => {});
    } catch {}
  }

  await chrome.storage.local.remove([
    "scanInProgress",
    "scanConfig",
    "scanPageState",
    "scanComplete",
    "liveProgress",
  ]);
  stopKeepAlive();

  const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
  if (scanTimeoutId) {
    clearTimeout(parseInt(scanTimeoutId));
    await chrome.storage.local.remove("scanTimeoutId");
  }
});
```

The two `if` checks are guards: first that any scan is in progress at all (otherwise this is just normal tab cleanup), then that the closed tab is actually our scan tab (otherwise the user closed an unrelated tab).

When both pass:
1. Mark the run-log as `failed` with `error_message: "Scan tab closed by user"`
2. Wipe all `scan*` storage keys
3. Stop keepalive
4. Cancel the 90-min safety timeout

**Recovery:** None automatic. The user has to start a new scan.

> **BUG-2 historical context.** Before 2026-04-22, this listener did NOT check `scanConfig.tabId === tabId` — it cleaned up the scan whenever *any* tab was closed. So if you had a scan running and closed a different unrelated tab in your normal browser window, the scan was killed. The fix added the tabId check. RESOLVED.

### B. The user clicks Stop on the dashboard

The Stop button calls `POST /extension/trigger-stop`:

```python
# backend/routers/extension.py:158-176
@router.post("/trigger-stop")
async def trigger_stop(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)
    row.stop_requested = True
    row.scan_requested = False
    await db.execute(
        update(ExtensionRunLog)
        .where(ExtensionRunLog.status == "running")
        .values(
            status="failed",
            error_message="Stopped by user",
            completed_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return {"ok": True, "stop_requested": True}
```

**Two parallel cleanup paths fire:**

1. **Database side:** The handler immediately marks all `running` run-logs as `failed`. This means even if the extension is suspended/dead/closed, the run-log gets cleaned up. The user sees "scan stopped" in the UI within seconds.

2. **Extension side:** `pollForStopTrigger` (Phase 3) sees the flag on its next 3-second tick, sets `stopRequested: true` in storage, removes the popup tab, wipes storage, stops keepalive.

The content script's per-card stop check (Phase 6 step 2) sees `stopRequested: true` between cards and breaks out of the loop with `pagination_ended: { reason: "stop_requested" }`.

**Race window:** If the user clicks Stop while a card is in mid-fetch, that card might still complete and emit an `INGEST_JOB`. That's fine — the backend ingests it, then the loop's next iteration sees the stop and exits. We never lose work mid-card; we just may complete one extra card after the stop.

### C. LinkedIn session expired

The user's LinkedIn cookie has expired. They're effectively logged out, but they didn't notice.

**Detection:** `init.js` calls `checkSession()` (covered in Phase 5) before any scraping. If the URL is a login page, authwall, or other non-jobs URL:

```js
// extension/content/linkedin/init.js:62-67
if (session !== "live") {
  await reportSessionError(session);
  await JhaDebug.emit("error", { where: "session", message: String(session) }, "error");
  await JhaDebug.finalize();
  if (session === "captcha") {
    console.log("[JHA] CAPTCHA detected — stopping scan, leaving page open");
  } else {
    window.location.href = "https://www.linkedin.com/login";
  }
  await chrome.storage.local.set({ scanInProgress: false });
  return;
}
```

`reportSessionError` PUTs to the backend with status="failed" and a session error message. The user sees an alert in the dashboard.

**Recovery:** User logs in to LinkedIn manually, then re-triggers the scan.

### D. LinkedIn captcha challenge

A subtype of session expiration. LinkedIn detects bot-like behavior and serves a captcha.

**Detection:** Same `checkSession()`:

```js
// extension/content/linkedin/dom.js:43
if (href.includes("/checkpoint/challenge")) return "captcha";
```

**Behavior:** *Different from session-expired*. We **don't redirect** the user away from the captcha page. We leave the popup open so the user can solve the captcha. The scan run-log is marked failed, but the popup stays.

**Recovery:** User solves the captcha, then re-triggers a scan. (The current scan can't continue from where it stopped; it has to be re-run from scratch.)

### E. Voyager API rate limit (LinkedIn)

LinkedIn's Voyager API returns HTTP 429 (Too Many Requests), 403 (Forbidden), or 999 (LinkedIn-specific "stop bothering us") when we exceed their rate limits.

**Detection in `fetchJDViaVoyager`:**

```js
// extension/content/linkedin/voyager.js:51-62
if (res.status === 429 || res.status === 403 || res.status === 999) {
  await JhaDebug.emit("voyager_fetch", {
    job_id: jobId,
    attempt,
    http_status: res.status,
    rate_limited: true,
  }, "warn");
  return { error: `http_${res.status}`, status: res.status };
}
```

**Behavior:** The current card fails (counters.jd_failed++ via `recordSkip`). The scan continues — we don't abort the whole scan on a single rate-limited card. With LinkedIn's actual rate limits being relatively generous (we've never sustainedly hit them in practice), this is rare.

**Recovery:** Per-card. Aggregate rate limiting would show as many `voyager_fetch` events with `rate_limited: true` in the trace.

### F. Indeed phantom card

Indeed's GraphQL endpoint returns no useful data for a small percentage of cards. These are typically promoted/sponsored placeholder cards where the `jk` (Indeed's job key) doesn't correspond to a real job.

**Detection in `_strategy6`:**

```js
// extension/content/indeed/rate_strategy.js:42-59
const data = await res.json();
const job = data?.data?.jobData?.results?.[0]?.job;
if (!job) {
  return { phantom: true, http_status: res.status };
}
const descHtml = job?.description?.html || null;
const descText = job?.description?.text || null;
if (!descHtml && !descText) {
  return { phantom: true, http_status: res.status };
}
```

**Behavior:** Per-card silent skip (counters.stale_skipped++). No error, no trace alarm — phantom cards are *expected* and a healthy Indeed scan will have ~6-7% of fetches return phantom.

> **N-2 from `bugs-summary.md`: Phantom rate is normal.** ~6-7% phantom fetches on Indeed is expected behavior, not a bug. The placeholder hex patterns (`f1e2d3c4b5a67890`) repeat across pages within a single scan. They're correctly classified as `stale_skipped`, don't increment `jd_failed`, and don't waste ingest calls. **Don't try to "fix" this** by, say, special-casing the placeholder pattern — Indeed could change it any time.

### G. Glassdoor multi-strategy fallthrough

Glassdoor's HTML structure varies — sometimes the JD is in the rendered DOM, sometimes only in the `__NEXT_DATA__` blob, sometimes only in `JobPosting` JSON-LD.

**Detection:** Walk the four strategies (Phase 6 Step 5). If all return empty, return `{phantom: true}`.

**Behavior:** Per-card silent skip. Same as Indeed phantom.

**Recovery:** None per-card. If a particular Glassdoor URL pattern starts consistently failing all four strategies, that's a sign the page structure has changed and we need to add a fifth strategy.

### H. Backend unreachable during scan

The user's backend server crashes mid-scan, or the user's network goes down briefly.

**Detection:** Each `INGEST_JOB` message goes through the SW's `ingestJob` retry pattern (Phase 6 Step 7). After 3 attempts with backoff, if all fail, the call returns `undefined`.

**Behavior:** Content script counts the failure as `jd_failed` and continues to the next card. The card's data is **lost** — there's no local persistence for retry-after-recovery.

**Recovery:** The user re-runs the scan once the backend is back up. The `f_tpr` window will be appropriate (covers since the last successful scan, see Phase 4 Step 4) so we re-fetch the missed jobs.

> **Unreasonable behavior — no local persistence for failed ingests.** If the backend is down for 5 minutes during a 10-minute scan, half the scraped jobs are silently lost. **Fix suggestion:** Buffer failed ingests in `chrome.storage.local._failedIngests` and retry them in batch when the backend comes back. Current behavior is acceptable for a personal-use system but bad for a multi-user system.

### I. Service worker dies mid-scan

Less common in practice (the keepalive prevents it most of the time) but possible. Chrome can suspend the SW even during active scans if the keepalive misses too many ticks.

**Detection:** Difficult — there's no proactive detection. Symptoms:
- The keepalive heartbeat in `chrome.storage.local._keepalive` gets stale (5+ seconds old)
- Ingest messages start failing the 12-second timeout
- The popup window is still open but no progress is being made

**Behavior:** From the content script's perspective, ingest calls return `undefined` after retries. From the SW's perspective when it eventually wakes (e.g. on the next storage write from the heartbeat), some of its in-flight state may be lost.

**Recovery:** The 90-minute safety timeout (Phase 4 Step 9) catches truly hung scans. Or the user manually clicks Stop.

> **Unreasonable behavior — no SW death detection.** The content script's heartbeat reports `storage_keepalive_age_ms` to the backend, but nothing watches this for anomalies. **Fix suggestion:** If `storage_keepalive_age_ms > 30000` for 3 consecutive heartbeats, the content script should treat the SW as dead and try to wake it (via a `chrome.runtime.sendMessage` of any kind, which forces SW wake). If that fails, abort the scan and flag the run-log as `sw_died`.

### J. Page-load timeout (no cards found)

The popup loads the search URL, but no cards ever appear in the DOM. Could be a JavaScript error on the site, a network issue, or LinkedIn serving a non-results page (e.g. an interstitial).

**Detection:** `waitForCards` returns 0 cards after its timeout (8s for LinkedIn, 10s for Indeed, etc.).

**Behavior:** LinkedIn does an extra retry with 3s delay then 8s wait before giving up:

```js
// extension/content/linkedin/page.js:97-105
if (!cards.length) {
  console.log(`[JHA-LinkedIn] No cards on page ${currentPage}, retrying after 3s`);
  await sleep(3000);
  cards = await waitForCards(8000);
  if (!cards.length) {
    console.log(`[JHA-LinkedIn] Still no cards after retry on page ${currentPage} — ending`);
    pushScanError(counters, { type: "no_cards", page: currentPage });
    break;
  }
}
```

If still no cards, end the scan with `pagination_ended: { reason: "no_cards_found" }`.

**Recovery:** User re-triggers the scan. May be transient.

### K. Backend ingest 500 (now resolved, but historical context)

> **BUG-1 historical context.** Until 2026-04-22, the backend's content-hash dedup check at `backend/routers/jobs.py:154` used `.scalar_one_or_none()`, which crashes if 2+ existing rows share the same `raw_description_hash`. This happened legitimately when employers reposted jobs or used ATS templates. ~6-10% of LinkedIn ingests returned HTTP 500. The Voyager fetch had succeeded; the backend was the failure site. Fixed by changing to `.scalars().first()`. RESOLVED. The reason this is worth knowing: when investigating future ingest failures, check the backend logs for `MultipleResultsFound` — even with the fix, it's the kind of error that could resurface if some new code path uses `.scalar_one_or_none()` against a non-unique column.

### Summary table

| Failure mode | Detected by | Run-log status | User action needed |
|---|---|---|---|
| User closes popup | `chrome.tabs.onRemoved` | `failed` | Restart scan |
| User clicks Stop | `pollForStopTrigger` | `failed` | None |
| LinkedIn session expired | `checkSession()` | `failed` | Log in, restart |
| LinkedIn captcha | `checkSession()` | `failed` | Solve captcha, restart |
| Voyager rate limit | HTTP 429/403/999 | `running` (per-card) | None |
| Indeed phantom | GraphQL no-result | `running` (per-card) | None |
| Glassdoor strategy fallthrough | All 4 strategies fail | `running` (per-card) | None |
| Backend unreachable | Ingest retry exhausted | `running` then `completed` with high `jd_failed` | Restart scan |
| SW dies mid-scan | Stale keepalive | Eventually `failed` (90-min timeout) | Restart scan |
| No cards on page | `waitForCards` timeout | `completed` (with `pagination_ended`) | Maybe retry |

---

## 16. Storage state reference

The single most useful thing for debugging an in-flight scan is to open Chrome DevTools on the popup window, go to Application → Storage → Extension Storage, and read the keys directly. This section is your reference for what you'll see.

### `chrome.storage.local` keys (MV3 extension storage)

| Key | Lifecycle | Set by | Read by | Contents |
|---|---|---|---|---|
| `scanInProgress` | Set in Phase 4, cleared in Phase 8 | scan_manual.js, scan_completion.js | All content scripts | `true` / `false` |
| `scanConfig` | Set in Phase 4, cleared by content script before scan_complete | scan_manual.js | All content scripts | `{...config, runId, website, tabId, f_tpr}` |
| `scanComplete` | Set by content init at scan end, cleared by scan_completion.js | content init.js | scan_completion.js | `{tabId, summary, runId, completedAt}` |
| `scanPageState` | Per-page state for Indeed (carries counters across navigations) | indeed page.js | indeed init.js | `{scraped, new_jobs, current_page, ...}` |
| `liveProgress` | Updated per-card during scan | All content process.js | popup.html, dashboard | `{scraped, new_jobs, existing, jd_failed, ...}` |
| `lastRunSummary` | Set at scan end | scan_completion.js | popup.html | `{...summary fields}` |
| `debugLog` | Appended per-emit, drained by flush | shared/debug_logger.js | shared/debug_logger.js | `{runId, scanStartMs, events: [...]}` |
| `_keepalive` | Updated every 5s by SW | keepalive.js | content init.js heartbeat | epoch milliseconds |
| `_swHeartbeat` | Pre-emptively set by content before INGEST_JOB | shared/messaging.js | (SW wake signal) | epoch milliseconds |
| `stopRequested` | Set by pollForStopTrigger | poll.js | All content page.js | `true` / `false` |
| `scanTimeoutId` | Set after scan_manual.js timeout | scan_manual.js | scan_completion.js, tabs_safety.js | string-encoded number |
| `lastGlassdoorScanTime` | Set on Glassdoor auto-scan | glassdoor init.js | glassdoor init.js | epoch milliseconds |
| `autoScan` | User-controlled (no UI) | (not set by code) | glassdoor init.js | `false` to disable |
| `backendUrl` | Settings (cached 30s) | settings.js | All SW modules | string |
| `authToken` | Settings (cached 30s) | settings.js | All SW modules | string |

### `extension_state` table (one row, id=1)

| Column | Set by | Read by | Purpose |
|---|---|---|---|
| `scan_requested` | trigger-scan endpoint | poll.js (then cleared) | Mailbox flag for new scan |
| `scan_website` | trigger-scan endpoint | poll.js | Which site to scan |
| `scan_all` | trigger-scan endpoint | poll.js | Is this part of Scan All? |
| `scan_all_position` | trigger-scan endpoint | poll.js → scan_manual.js → run-log | 1, 2, or 3 |
| `scan_all_total` | trigger-scan endpoint | poll.js → scan_manual.js → run-log | Always 3 currently |
| `stop_requested` | trigger-stop endpoint | poll.js (then cleared) | Mailbox flag for stop |
| `current_page` | scan_manual.js + content scripts | (mostly informational) | Page counter |
| `today_searches` | scan_manual.js + content scripts | (mostly informational) | Daily counter |

### `extension_run_logs` table (one row per scan)

The full schema is large; key fields:

| Field | Type | When set | Purpose |
|---|---|---|---|
| `id` | UUID | At creation | The `runId` threaded through the system |
| `status` | string | Created `running`, updated to `completed`/`failed` | Lifecycle state |
| `strategy` | string | At creation | Always "C" currently |
| `search_keyword` | string | At creation | What the user was looking for |
| `search_location` | string | At creation | Where |
| `search_filters` | JSONB | At creation | Full filter object including `website` |
| `scan_all`, `scan_all_position`, `scan_all_total` | bool/int/int | At creation | Scan All metadata |
| `scraped` | int | Updated at completion | Total cards processed |
| `new_jobs` | int | Updated at completion | New rows inserted |
| `existing` | int | Updated at completion | Already-existed rows |
| `stale_skipped` | int | Updated at completion | Phantom/skipped cards |
| `jd_failed` | int | Updated at completion | JD fetch failures |
| `pages_scanned` | int | Updated at completion | Number of pages |
| `errors` | JSONB | Updated at completion | Array of error objects |
| `debug_log` | JSONB | Appended via debug endpoint | Ring buffer of events (max 10000) |
| `error_message` | string | On failure | Failure reason |
| `completed_at` | timestamp | At completion | Wall-clock end time |

### Reading state during a scan

While a scan is running:

1. Open the dashboard's `/jobs` page
2. Open Chrome DevTools (F12) on the **popup window** (the one with the LinkedIn/Indeed/Glassdoor page being scanned)
3. Go to Application → Storage → Extension Storage → Local
4. You'll see all the `scan*` keys with their current values

For backend state:
1. `psql` to the postgres database
2. `SELECT * FROM extension_state WHERE id = 1;`
3. `SELECT id, status, scraped, new_jobs FROM extension_run_logs ORDER BY started_at DESC LIMIT 5;`

### Unreasonable behavior in this section

> **`autoScan` flag has no UI.** It controls Glassdoor's auto-scan path (Section 9), but there's no checkbox or setting in the dashboard to toggle it. The only way to disable auto-scan is to manually run `chrome.storage.local.set({autoScan: false})` in DevTools console. **Fix suggestion:** Add a "Glassdoor auto-scan" checkbox to the dashboard's settings page. Default to off (the auto-scan is a surprise behavior; better to make it opt-in).

> **`scanTimeoutId` is stored as a string.** Already mentioned in Phase 4. The roundtrip `setTimeout()` → `.toString()` → `parseInt()` has no purpose; just store the number directly.

> **Storage keys mix conventions.** Some are camelCase (`scanInProgress`, `liveProgress`), others use underscores (`_keepalive`, `_swHeartbeat`), some use neither (`debugLog`). The underscore prefix seems intended to mark "internal" keys but isn't applied consistently. **Fix suggestion:** Pick one convention. I'd recommend underscoring all internals (`_swHeartbeat`, `_keepalive`, `_failedIngests`) and camelCasing all user-facing state (`scanInProgress`, `scanConfig`, `liveProgress`).

---

## 17. Per-site behavioural differences

This section condenses everything we've covered into a single comparison reference. When you're debugging a site-specific issue, this is your cheat sheet.

### High-level architecture

| Aspect | LinkedIn | Indeed | Glassdoor |
|---|---|---|---|
| **Pagination model** | SPA in-place (URL changes, no reload) | Real navigation (full page reload per page) | Infinite scroll ("Show more jobs" button) |
| **Content script lifecycle** | One invocation for the whole scan | One invocation per page (re-injected) | One invocation for the whole session |
| **JD fetch source** | Voyager JSON API | GraphQL API at apis.indeed.com | HTML page fetch + 4-strategy parser |
| **Auth required** | LinkedIn `li_at` + `JSESSIONID` cookies | Indeed `oneGraphApiKey` (extracted from page) | Glassdoor session cookie |
| **CORS rewrites** | None (Voyager is on `linkedin.com`) | None | `glassdoor.com` → `glassdoor.ca` |
| **Per-page card dedup** | Set in memory (`processedJobIds`) | None (each page is fresh) | Set in memory (across "Show more" clicks) |
| **Page-level timeout** | 8s (12s on first page) | 10s | 10×800ms polling |
| **Card stability gate** | 600ms unchanged | 1000ms unchanged | None — uses set-difference |
| **Practical max cards** | ~1000 (LinkedIn's hard cap) | Variable, up to ~600 typically | ~71 (Glassdoor's deeper-auth wall) |
| **Uses `messaging.js`?** | Yes (correlationId + waiter pattern) | Yes | No (direct sendMessage) |
| **Has `__JHA_*_BOOTED` guard?** | Yes (`__JHA_LINKEDIN_SCAN_BOOTED`) | No | No |
| **Has auto-scan path?** | No | No | Yes (15-min debounce, undocumented) |

### Card extraction details

| Field | LinkedIn | Indeed | Glassdoor |
|---|---|---|---|
| **Job ID source** | `data-occludable-job-id` attribute | `data-jk` attribute | `data-jobid` attribute |
| **Title selector** | 6-deep fallback chain | `[data-testid="job-title"]` + fallbacks | `[data-test="job-link"]` |
| **Company selector** | 4-deep fallback chain | `[data-testid="company-name"]` | `[class*="employer-name"]` (strips trailing rating) |
| **Location selector** | 3-deep fallback chain | `[data-testid="text-location"]` | `[data-test="emp-location"]` |
| **Time/date source** | Voyager `originalListedAt` | Card snippet text parsed | None (always `null`) |
| **URL handling** | Strip query string | Convert relative to absolute | Convert relative to absolute |

### JD fetch details

| Aspect | LinkedIn | Indeed | Glassdoor |
|---|---|---|---|
| **Endpoint** | `/voyager/api/jobs/jobPostings/{id}` | `/graphql` | `/job-listing/...html` |
| **Method** | GET | POST | GET |
| **Auth header** | csrf-token from JSESSIONID cookie | `indeed-api-key` header | (cookies only) |
| **Retry policy** | 2 attempts, 500ms apart | 1 attempt, 10s timeout | 1 attempt, no explicit timeout |
| **Rate-limit response** | 429/403/999 → `{error}` | (currently routed to `{phantom}`) | `{rateLimited: true}` (unreachable) |
| **Empty/missing response** | Returns null JD | `{phantom: true}` | `{phantom: true}` after 4 strategies |
| **Extra calls per card** | Yes (`fetchCompanyName`) | No | No |

### Trace event differences

| Event type | LinkedIn | Indeed | Glassdoor |
|---|---|---|---|
| `voyager_fetch` | ✅ | ❌ | ❌ |
| `indeed_jd_fetch` | ❌ | ✅ | ❌ |
| `glassdoor_jd_fetch` | ❌ | ❌ | ✅ |
| `dom_mutations` | ✅ (per page) | ❌ | ❌ |
| `show_more_loaded` | ❌ | ❌ | ✅ |
| `navigate` | ❌ | ✅ (per pagination) | ❌ |
| `next_poll` | ✅ | ✅ (single check, not loop) | ✅ |

### Counter increments

All three sites maintain the same counter shape, but increment differently:

| Counter | LinkedIn increments when... | Indeed increments when... | Glassdoor increments when... |
|---|---|---|---|
| `scraped` | After processing a card (post-skip) | Same | Same |
| `new_jobs` | Backend returned new id | Same | Same |
| `existing` | Backend returned `already_exists` or `content_duplicate` | Same | Same |
| `stale_skipped` | No job_id, skipped duplicates within page | Phantom/missing JD, skipped duplicates | Phantom/missing JD |
| `jd_failed` | Voyager error, ingest failure | GraphQL error, ingest failure | All-strategy failure, ingest failure |
| `id_skipped` | Card with no extractable job_id | Card with no `jk` | (combined into `stale_skipped`) |

### Pagination termination reasons

These are the values that appear in `pagination_ended.reason` events. Knowing the full taxonomy helps you read traces.

**LinkedIn:**
- `stop_requested` — user clicked Stop
- `stop_requested_mid_page` — same, but mid-card-loop
- `no_cards_found` — `waitForCards` returned 0 even after retry
- `next_button_not_found` — `pollForNextButton` returned null
- `next_button_disabled` — found button but `disabled` or `aria-disabled`
- `spa_transition_timeout` — clicked next, neither URL nor card-set changed within 10s

**Indeed:**
- `stop_requested` / `stop_requested_mid_page`
- `no_cards_found`
- `next_button_disabled` (no separate not_found — selector is single)
- `next_href_missing` — found button but it has no href

**Glassdoor:**
- `stop_requested`
- `no_new_cards_found` — set-difference returned empty
- `show_more_button_not_found`
- `show_more_timeout` — clicked but DOM count didn't grow in 12s

### Per-site bug exposure

| Bug | LinkedIn affected? | Indeed affected? | Glassdoor affected? |
|---|---|---|---|
| BUG-1 (ingest 500s, RESOLVED) | Yes (heavy) | Light | Light |
| BUG-2 (tabs_safety, RESOLVED) | All | All | All |
| BUG-3 (computeFtpr cross-source, RESOLVED) | Primary impact | Indirect | Indirect |
| BUG-4 (emit race, deferred) | All | All | Observed once |
| BUG-5 (stale keepalive_age, deferred) | All | All | Observed |
| BUG-6 (Indeed dead rateLimited) | N/A | Yes | N/A |
| BUG-7 (Indeed dead null-apiKey) | N/A | Yes | N/A |
| BUG-8 (LinkedIn redundant compute) | Yes | N/A | N/A |
| BUG-9 (popup display) | All | All | All |
| BUG-10 (SW suspension, FIX NEXT) | All | All | All |
| N-1 (LinkedIn 1000 cap) | Yes (by design) | N/A | N/A |
| N-2 (Indeed phantom rate) | N/A | Yes (by design) | N/A |

---

## 18. Unreasonable behaviors I noticed (with fix suggestions)

This section consolidates every "unreasonable behavior" flagged inline in the previous sections, plus a few I haven't covered elsewhere. Numbered for reference. Severity is my subjective rating: 🔴 = real impact, 🟡 = noticeable, 🟢 = cosmetic.

Use this section as a backlog of cleanup work. Each item is independent — fix in any order.

### B-1 ✅ 🟡 Grace window logic split across two files

**Where:** `frontend/src/pages/JobsPage.jsx:316` writes `scanTriggerGraceRef.current`; the consumer is in the polling `useEffect` at `frontend/src/pages/JobsPage.jsx:222, 246-258`.

**The behavior:** The 15-second grace window between "user clicks Scan" and "if no run-log exists, give up" is split across the click handler and a different `useEffect`. A new reader has no clue the grace exists unless they read both files.

**Fix suggestion:** Extract a custom hook:
```jsx
function useScanGrace(graceMs = 15000) {
  const ref = useRef(0)
  return {
    start: () => { ref.current = Date.now() },
    isInGrace: () => Date.now() - ref.current < graceMs,
    clear: () => { ref.current = 0 },
  }
}
```
Then `const grace = useScanGrace()` and call `grace.start()` / `grace.isInGrace()` in the relevant places. The two halves now live together and have a meaningful name.

---

### B-2 ✅ 🟢 Trigger-scan vs trigger-stop endpoint asymmetry

**Where:** `backend/routers/extension.py:95-122` (trigger-scan) vs `backend/routers/extension.py:158-176` (trigger-stop).

**The behavior:** Trigger-scan only sets a flag and waits for the SW to do work. Trigger-stop both sets a flag *and* directly mutates `extension_run_logs` to `failed` without waiting for the SW. The asymmetry is jarring.

**Fix suggestion:** None really required — the asymmetry exists for good reason (a stop must succeed even if the SW is dead, while a trigger inherently requires a working SW). Just add a comment to trigger-stop explaining why the dual-path is intentional.

---

### B-3 ✅ 🟡 Two separate polling intervals when one would do

**Where:** `extension/background/poll.js:30, 69`.

**The behavior:** Two `setInterval` calls — one for scan polling, one for stop polling. Each fires every 3 seconds. Twice the network requests for no good reason.

**Fix suggestion:** Combine into one polling loop that calls both endpoints in parallel via `Promise.all`. Or better: add a single endpoint `GET /extension/pending` that returns both states in one response. This is doubly worth doing as part of the BUG-10 chrome.alarms migration — alarms have a 30-second minimum, so each redundant alarm is more painful than each redundant setInterval.

---

### B-4 ✅ 🟡 Silent error swallowing in poll.js

**Where:** `extension/background/poll.js:18-21, 65-67`.

**The behavior:** Both poll functions wrap their fetch in `try { ... } catch {}` with no logging. If the backend is unreachable for an hour, there's no record anywhere.

**Fix suggestion:** Write a `_lastPollError` storage key with the error message and timestamp on every catch. Surface this in the popup as "Cannot reach backend." The dev experience when forgetting to start the backend is currently "scans never fire" with zero feedback — adding a 5-line catch handler fixes this.

---

### B-5 ✅ 🟢 `scanConfig` storage spreads the entire config

**Where:** `extension/background/scan_manual.js:153`, the `chrome.storage.local.set` call.

**The behavior:** `scanConfig: {...config, runId, website, tabId, f_tpr}` puts the *entire* config (which can include resume data, skill aliases, etc.) into storage. The content scripts only need a small subset.

**Fix suggestion:** Define a `buildScanConfig(config, runId, website, tabId, f_tpr)` helper in `scan_manual.js` that picks only the fields actually consumed by content scripts: `keyword`, `location`, the relevant per-site filter block (`indeed_*` for indeed, etc.), `runId`, `website`, `tabId`, `f_tpr`. Reduces storage footprint and makes the contract between SW and content scripts explicit.

---

### B-6 ✅ 🟢 `setTimeout` ID stored as string

**Where:** `extension/background/scan_manual.js:200` writes `scanTimeoutId.toString()`; `extension/background/scan_completion.js:9` reads via `parseInt(scanTimeoutId)`.

**The behavior:** Round-trip serialization of a number through a string for no reason. `chrome.storage.local` happily stores numbers.

**Fix suggestion:** Just store the number: `chrome.storage.local.set({ scanTimeoutId })`. Trivial.

---

### B-7 ✅ 🟡 90-minute safety timeout doesn't close the scan tab

**Where:** `extension/background/scan_manual.js:174-200`.

**The behavior:** When the 90-minute scan timeout fires, the run-log is marked failed and storage is cleaned up — but the popup window is **not** closed. If a scan is genuinely hung (e.g. a JS error in the content script), the user is left with an orphaned popup window they have to close manually.

**Fix suggestion:** Add `if (scanConfig?.tabId) await chrome.tabs.remove(scanConfig.tabId).catch(() => {});` to the timeout handler. One line. Catches the genuine-hang case without affecting normal completion (which already closes the tab in `scan_completion.js`).

---

### B-8 ✅ 🟡 Per-site init.js files duplicate ~80% of their logic

**Where:** `extension/content/{linkedin,indeed,glassdoor}/init.js`.

**The behavior:** Each site has a near-identical `init()` shape. Differences: session-check rules, which run-function to call (`runFullScan` vs `runSinglePage` vs `scanGlassdoorPage`), and the source string emitted in events.

**Fix suggestion:** Extract a shared `runScanPipeline(config, opts)` helper:
```js
// extension/content/shared/init_helpers.js
async function runScanPipeline(config, {
  source,           // 'linkedin' / 'indeed' / 'glassdoor'
  sessionCheck,     // function returning 'live' / 'expired' / etc.
  runScan,          // the per-site run function
  bootedFlag,       // window-level guard property name
}) { /* shared lifecycle */ }
```
Each site's init.js shrinks to ~10 lines that pass site-specific arguments. Reduces drift; future bug fixes apply uniformly.

---

### B-9 ✅ 🟡 Only LinkedIn has a `__JHA_*_BOOTED` duplicate-boot guard

**Where:** `extension/content/linkedin/init.js:25-29`. Indeed and Glassdoor have no equivalent.

**The behavior:** LinkedIn alone protects against duplicate content-script invocations. Indeed and Glassdoor could in theory be re-injected too.

**Fix suggestion:** Either add `__JHA_INDEED_SCAN_BOOTED` / `__JHA_GLASSDOOR_SCAN_BOOTED` guards explicitly, or fold this into the `runScanPipeline` helper from B-8.

---

### B-10 ✅ 🔴 Glassdoor auto-scan is undocumented and surprising

**Where:** `extension/content/glassdoor/init.js:153-180` (the `runAutoGlassdoorScan` function).

**The behavior:** When the user just *visits* Glassdoor with no scan triggered, the extension auto-starts a scan after a 15-minute debounce. There's no UI to disable it. This is not documented in any design doc.

**Fix suggestion:** Two options:
1. **Make opt-in:** Default `autoScan = false`, add a checkbox to the dashboard's settings page. Only auto-scan if the user explicitly enabled it.
2. **Remove entirely:** Drop the auto-scan path, rely only on dashboard-triggered scans.

I'd recommend option 2 unless there's a specific use case I'm missing. The auto-scan creates run-log noise and surprises users.

---

### B-11 ✅ 🔴 LinkedIn `fetchCompanyName` doubles per-card Voyager cost

**Where:** `extension/content/linkedin/voyager.js:80` calls `fetchCompanyName`.

**The behavior:** After fetching the JD via Voyager, we make a *second* Voyager call to resolve the company name from a URN. The card DOM already has the company name. Adds 100-200ms per card × 200 cards = 20-40 seconds wasted per scan.

**Fix suggestion:** Trust the card-extracted `cardData.company` field. Only fall back to `fetchCompanyName` if (a) the card extraction failed *and* (b) `companyDetails` URN is present in the Voyager response. Better: just remove `fetchCompanyName` entirely. The downstream code already handles `voyagerResult.company === null`.

The design doc claims this was already removed; the code shows it wasn't. Either the change was reverted or never landed. **Verify and finish the removal.**

---

### B-12 🟢 Glassdoor `ageText`, `salary`, `easyApply` extracted but unused

**Where:** `extension/content/glassdoor/parse.js:parseGlassdoorCard` extracts these; `extension/content/glassdoor/process.js` ignores them.

**The behavior:**
- `ageText` is extracted but `process.js` writes `post_datetime: null`
- `salary` is extracted but no `salary_min` field on the payload
- `easyApply` is extracted from the card, but `process.js` uses the JSON-LD `directApply` field from `fetch_jd.js` instead

**Fix suggestion:**
- For `ageText`: move `parseIndeedPostDate` to `content/shared/utils.js` (rename to `parseRelativePostDate`), use in both `glassdoor/process.js` and `indeed/process.js`. Glassdoor's `post_datetime` becomes useful.
- For `salary`: either populate a `salary_min_extracted` field or remove the extraction code in `parseGlassdoorCard`.
- For `easyApply`: pick one source. JSON-LD is more reliable; remove the card extraction.

---

### B-13 🟡 `_ingestResultWaiters` Map has no size cap

**Where:** `extension/content/shared/messaging.js:13`.

**The behavior:** The waiter Map can in theory leak entries if a content script crashes mid-scan. In practice the 12-second timeout cleans up, but it's worth noting.

**Fix suggestion:** Add an assertion that the map size never exceeds 100. Crash loudly via `throw new Error("waiter leak")` if it does. Likely never fires, but catches genuine bugs early.

---

### B-14 ✅ 🔴 Run-log counters never update mid-scan

**Where:** Backend `extension_run_logs` rows only update at completion, in `scan_completion.js:55-66` (the PUT request).

**The behavior:** During a scan, the run-log's `scraped`, `new_jobs`, etc. counters all stay at 0. The dashboard polls `getRunLogs(1)` every 2s expecting to show progress, but sees 0/0/0 until completion. The popup gets fresher data because it reads `liveProgress` directly.

**Fix suggestion:** Two options:
1. **Periodic PUT:** Content script PUTs incremental counter updates every 25 cards.
2. **SW-mirror:** SW's `chrome.storage.onChanged` watcher mirrors `liveProgress` to the run-log via debounced PUTs every ~10 seconds.

The dashboard's progress bar is currently aspirational — it shows 0% the whole time, then jumps to 100% at completion. Fixing this would make the dashboard genuinely live during scans, which is a real UX win.

---

### B-15 ✅ 🟡 LinkedIn pagination logic is deeply nested in one function

**Where:** `extension/content/linkedin/page.js:runFullScan` (~250 lines).

**The behavior:** Card discovery, card processing, scrolling, next-button polling, click, transition wait, error handling, and finalization are all inline in one massive `while` loop.

**Fix suggestion:** Extract per-step helpers: `processPage(cards, config, counters)`, `scrollToBottom()`, `findAndClickNext()`, `awaitTransition(prevUrl, prevCardIds)`. Each helper is 20-30 lines and individually testable. The main loop becomes 30 lines and reads as a high-level outline. Same fix appropriate for Glassdoor's `scanGlassdoorPage`.

---

### B-16 🟡 Glassdoor "Show more jobs" button matched by exact English text

**Where:** `extension/content/glassdoor/page.js:140-142`.

**The behavior:** The "Show more jobs" button is found via `.textContent.trim() === "Show more jobs"`. A French Canadian user would see "Voir plus d'emplois" and pagination ends after page 1.

**Fix suggestion:** Either:
- Match by stable structural property (the button is always inside a particular container)
- Maintain a list of known-good text strings keyed by `document.documentElement.lang`
- Easiest: match `textContent.trim().toLowerCase().includes("show more") || .includes("voir plus")`

---

### B-17 ✅ 🟡 Sync mode auto-chains Step B but it's not documented

**Where:** `backend/routers/extension.py:_run_dedup_for_scan:46-47`.

**The behavior:** When `dedup_mode = "sync"` triggers dedup, it then *also* chains `run_step_b_extraction`. The design docs say sync mode only runs dedup. The actual behavior runs dedup + Step B.

**Fix suggestion:** Either:
1. Remove the auto-chain (let users explicitly trigger Step B from the Matching page)
2. Document it loudly — "sync mode = dedup + B-extraction"

I'd recommend option 1 for separation of concerns. The dashboard's Matching page already has a "Run Step B" button.

---

### B-18 ✅ Module-level `_BACKGROUND_TASKS` set is killed on backend restart *(resolved P4)*

**Where:** `backend/routers/extension.py:24` (the global set).

**The behavior:** If the FastAPI process is restarted while a sync-dedup task is running, the task is killed. The run-log says `status: completed` but dedup never finished. There's no way to detect this from the run-log alone.

**Original fix suggestion:** Either:
1. Persist task state in a `dedup_tasks` table with `status: pending|running|completed|failed`, and have a startup check that re-runs any `running` tasks.
2. Accept this as a known tradeoff and document it.

**Actual resolution:** Option 1 implemented in Prompt 4. New `dedup_tasks` table (migration `022_create_dedup_tasks_table`). The dedup runner creates a row, updates `last_heartbeat_at` every 30s, transitions to `completed` or `failed` at end. Lifespan startup hook (`mark_stale_dedup_tasks_failed`) scans for tasks where `last_heartbeat_at < NOW() - 5 minutes` and marks them `failed`. Verified by `verify_p4_dedup_recovery.py` and the `[OK] stale dedup_task marked failed` line in `smoke_test_p4.py`.

**Retrospective note:** initially flagged as over-engineered (a UI badge could surface the orphaned-task condition without a new table). But for full automation, the scheduler needs a programmatic "did dedup finish?" answer that the new table provides cleanly. Kept as shipped.

---

### B-19 ✅ 🟡 Dashboard polls per-leg via the same generic endpoint

**Where:** `frontend/src/pages/JobsPage.jsx:378` (the Scan All polling loop).

**The behavior:** Every 5s during Scan All, the dashboard fetches the 5 most recent run-logs (including their full `debug_log` JSONB) and filters by website. With ~10 polls per leg × 3 legs, that's ~30 wasted requests.

**Fix suggestion:** Add an endpoint `GET /extension/run-log/by-website/{website}/latest?status=completed,failed` that returns just the most recent matching log without `debug_log`. Halves the bandwidth.

---

### B-20 ✅ 🟡 The 30-min per-leg deadline is silent on timeout

**Where:** `frontend/src/pages/JobsPage.jsx:377` (the deadline calculation).

**The behavior:** If a leg actually hangs for 30 minutes, the polling loop exits without finding completion, the next leg starts, and the hung leg's run-log stays as `status: running` forever.

**Fix suggestion:** When the deadline expires, surface an error toast and call `triggerStop` to clean up the hung scan. Don't silently move on.

---

### B-21 ✅ 🟡 BUG-4 emit race + per-event storage write is doubly inefficient

**Where:** `extension/content/shared/debug_logger.js:emit`.

**The behavior:** Each emit does `chrome.storage.local.get` + `set`. At 5-10 emits per card on LinkedIn, that's 1000-4000 storage round trips per scan. Plus the read-modify-write race documented as BUG-4.

**Fix suggestion:** Buffer emits in a module-level array. Only write to storage on auto-flush (every 5 seconds OR every 100 events). This:
- Reduces storage writes 100×
- Eliminates BUG-4 (no more concurrent writes)
- Reduces total emit time from ~1-4s down to negligible

Single fix kills two birds.

---

### B-22 ✅ 🟡 `emit` returns a Promise that's rarely awaited

**Where:** Various callers of `JhaDebug.emit`.

**The behavior:** Most callers `await emit(...)`, but a few don't. On a slow storage path, those non-awaited emits race against subsequent code.

**Fix suggestion:** With B-21 applied, `emit` becomes synchronous (write to in-memory buffer) and the await question is moot. Otherwise, audit every caller and add `await`.

---

### B-23 ✅ No local persistence for failed ingests during backend outage *(resolved P5+5b)*

**Where:** `extension/content/shared/messaging.js:ingestJob`.

**The behavior:** If the backend goes down for 5 minutes during a 10-minute scan, half the scraped jobs are silently lost. The retry pattern only does 3 attempts × 12s timeout = up to ~40 seconds of retry per call.

**Original fix suggestion:** Buffer failed ingests in `chrome.storage.local._failedIngests`. On every successful ingest, check and replay one buffered entry. This auto-recovers without complex re-scan logic. Cap the buffer at, say, 200 entries to prevent runaway storage growth.

**Actual resolution (Approach D — halt-and-report):** The buffer-and-replay approach was implemented in Prompt 4 (Approach A) but rejected during retrospective as over-engineered. Replaced in Prompt 5 with a simpler pattern: when ingest retries exhaust, set `chrome.storage.local._backendDownDuringScan = true`. The per-site scrape loop checks this flag between cards and aborts cleanly. The run-log gets `status: failed` with `error_message` describing the outage. The user (or scheduler) retries when the backend is back. Tomorrow's scheduled scan picks up jobs that were missed today — the system has natural redundancy through scheduled re-scrapes, so elaborate recovery isn't needed.

**Critical bug found during verification (P5b):** the SW's `INGEST_JOB` handler returned a "graceful" failure response `{id: null, error: "..."}` on fetch errors. The content script's `if (result !== undefined) return result` check exited the retry loop on the first attempt, treating failure as success. Fixed by changing the success check to `if (result !== undefined && !result?.error && result?.id != null)`.

**Critical bug found during verification (P5c):** when the backend was down at *scan-end*, the final PUT to update run-log status also failed. Result: stale `running` rows in the database that wedged future trigger-scan calls via the `scan_in_progress` guard. Fixed by adding lazy cleanup to `trigger_scan`: any `running` run-log older than 5 minutes gets marked `failed` before the running guard runs. Requires `await db.flush()` after the UPDATE to take effect within the same handler.

---

### B-24 ✅ No SW death detection during scans *(resolved P5; see B-32)*

**Where:** Implicit — the heartbeat reports `storage_keepalive_age_ms` but nothing watches it.

**The behavior:** If the SW dies mid-scan, the content script keeps emitting heartbeats showing growing `storage_keepalive_age_ms`, but no code reacts. The scan eventually fails via the 90-min timeout, but in the meantime, every ingest fails silently.

**Original fix suggestion:** If `storage_keepalive_age_ms > 30000` for 3 consecutive heartbeats, the content script should:
1. Try to wake the SW via any `chrome.runtime.sendMessage`
2. If still unresponsive (next heartbeat still shows >30s), abort the scan with a `sw_died` error and trigger normal completion

Surfaces the failure quickly instead of waiting 90 minutes.

**Initial implementation (P3) was broken:** see B-32 for details. The watchdog set a flag but nothing read it; meanwhile false positives fired on every normal scan. Fixed properly in P5 by (a) writing `_keepalive` from the alarm-tick handler so timing is reliable, and (b) adding a mid-stream abort check in each per-site scrape loop. See B-32 for the full story.

---

### B-25 ✅ 🟢 `autoScan` flag has no UI

**Where:** `extension/content/glassdoor/init.js:165` reads it; nothing writes it.

**The behavior:** No way to disable Glassdoor auto-scan from the dashboard. The only way is `chrome.storage.local.set({autoScan: false})` in DevTools console.

**Fix suggestion:** If keeping the auto-scan path (see B-10), add a toggle to the dashboard's settings page. If removing it, this becomes moot.

---

### B-26 ✅ 🟢 Storage key naming conventions are inconsistent

**Where:** Throughout `chrome.storage.local` usage.

**The behavior:** Some keys are camelCase (`scanInProgress`), some have underscores (`_keepalive`, `_swHeartbeat`), some have neither. The underscore prefix seems to mark "internal" keys but isn't applied consistently.

**Fix suggestion:** Pick one convention. I'd recommend:
- `_underscored` for SW-internal keys not visible to user-side code: `_keepalive`, `_swHeartbeat`, `_failedIngests`
- `camelCase` for keys read by user-facing UI or content scripts: `scanInProgress`, `scanConfig`, `liveProgress`

Then audit and rename. Low priority but improves readability.

---

### B-27 ✅ 🟡 Dead `rateLimited` path in Indeed (BUG-6 from inventory)

**Where:** `extension/content/indeed/process.js` checks `jdResult.rateLimited`; `extension/content/indeed/rate_strategy.js:_strategy6` never sets it.

**The behavior:** The downstream rate-limit handling code is unreachable. Currently harmless (no rate limits hit in practice), but if Indeed tightens limits we'd want this to actually fire.

**Fix suggestion:** Make `_strategy6` return `{rateLimited: true, http_status}` for HTTP 429/403 specifically (instead of `{phantom: true}`). One-line change, activates the existing downstream logic.

---

### B-28 ✅ 🟢 Dead null-apiKey path in Indeed (BUG-7 from inventory)

**Where:** `extension/content/indeed/rate_strategy.js:fetchIndeedJD` returns `null` for missing API key.

**The behavior:** The null-vs-phantom distinction has never been exercised. In 296+ fetches across multiple runs, `has_indeed_key: true` always.

**Fix suggestion:** Unify the return shape: always return an object, never bare null. `{error: "no_api_key", http_status: null}` is more consistent.

---

### B-29 ✅ 🟢 LinkedIn `processCard` redundant JD compute (BUG-8 from inventory)

**Where:** `extension/content/linkedin/process.js`.

**The behavior:** `jdRaw` and `jdText` are computed separately from the same `voyagerResult.jd` field. Cosmetic but unnecessary.

**Fix suggestion:** Consolidate to one variable. Trivial.

---

### B-30 ✅ 🟡 Popup `liveProgress` fallback after scan (BUG-9 from inventory)

**Where:** `extension/popup/popup.js`.

**The behavior:** Post-scan, the popup displays "No recent scan" because `liveProgress` is cleared. `lastRunSummary` exists in storage but the popup doesn't read it.

**Fix suggestion:** Have the popup read `lastRunSummary` when `scanInProgress: false`. ~5 lines.

---

### Priority for fixing

If I had to recommend a fix order, with limited time:

1. **BUG-10** (covered in `bugs-summary.md`, not in this list) — chrome.alarms migration. Highest impact.
2. **B-11** — `fetchCompanyName` removal. 20-40 second savings per scan.
3. **B-14** — Mid-scan run-log updates. Visible UX improvement.
4. **B-10 from this list** (Glassdoor auto-scan) — Reduces noise and surprise behavior.
5. **B-23** — Failed-ingest buffer. Important for system robustness.
6. **B-21** — Debug emit buffering. Side-fixes BUG-4 + perf.

Everything else is secondary cleanup.

---

## 19. Appendix A — Complete end-to-end timeline (LinkedIn single-site)

This appendix walks through one complete LinkedIn scan from click to job-grid-update, with timestamps, file:line references, and what's happening on every side. Use it as the canonical reference for "what does a scan actually look like."

The timeline assumes:
- Backend running on `localhost:8000`
- User logged into LinkedIn with a valid session
- ~200 jobs match the search criteria
- Backend is responsive (~20-50ms per ingest)
- SW is active (no suspension issues)

### T+0ms — User clicks Scan LinkedIn

**Where:** `frontend/src/pages/JobsPage.jsx:424-431` — the button onClick fires `handleScanLinkedIn`.

**State changes:**
- React: `scanning = true`, `scanTriggerGraceRef.current = T+0ms`
- UI: button greys out, spinner appears

### T+15ms — POST /extension/trigger-scan response

**Where:** `frontend/src/api.js:35-43` resolves; `backend/routers/extension.py:95-122` handled it.

**State changes:**
- DB: `extension_state` row id=1: `scan_requested = true`, `scan_website = 'linkedin'`, `scan_all = false`
- Network: 200 OK returned to dashboard
- Dashboard: silently continues polling at 2s intervals

### T+~1500ms — Dashboard polling reads back

**Where:** `frontend/src/pages/JobsPage.jsx:220-280` — the 2s polling `useEffect`.

**State observed:** `extension_state.scan_requested = true` (still pending, SW hasn't consumed yet). Run-log doesn't exist yet. Inside grace window (15000 - 1500 = 13.5s left), so `scanning` stays true.

### T+~3000ms — SW polls, sees pending scan

**Where:** `extension/background/poll.js:3-21` — `pollForScanTrigger` fires on its 3-second interval.

**Network:**
- GET `/extension/pending-scan` → response: `{pending: true, website: "linkedin", scan_all: false, ...}`
- Backend: `extension_state.scan_requested` flipped back to false (atomic read-and-clear)

**Action:** `handleManualScan({websiteOverride: "linkedin", scan_all: false, ...})` is called.

### T+~3050ms — Stop flag cleared, config fetched

**Where:** `extension/background/scan_manual.js:17-44`.

**Actions:**
- PUT `/extension/state` with `stop_requested: false` (idempotent cleanup)
- PUT `/extension/state` with `current_page: 1, today_searches: 0`
- GET `/config` returns the full config object

### T+~3150ms — `f_tpr` computed

**Where:** `extension/background/config_fetch.js:16-49` — `computeFtpr(168, "linkedin")`.

**Network:**
- GET `/extension/run-log?limit=20&status=completed`
- Filter by `search_filters.website === "linkedin"` → finds last LinkedIn scan was 6 hours ago
- Returns `r21600` (6 hours in seconds)

**Result:** `f_tpr = "r21600"`.

### T+~3200ms — Run-log row created

**Where:** `backend/routers/extension.py:215-228`.

**DB write:**
```
INSERT INTO extension_run_logs (
  id, status, strategy, search_keyword, search_location,
  search_filters, scan_all, scan_all_position, scan_all_total,
  started_at
) VALUES (
  gen_random_uuid(), 'running', 'C',
  'software engineer', 'Vancouver, BC',
  '{"website":"linkedin","f_tpr":"r21600","f_E":"2,3,4",...}',
  false, NULL, NULL,
  NOW()
);
```

**Returns:** `{id: "abc-uuid"}` — this is the `runId`.

### T+~3300ms — Search URL built

**Where:** `extension/background/search_urls.js:3-21`.

**Result:** `https://www.linkedin.com/jobs/search?keywords=software+engineer&location=Vancouver%2C+BC&f_TPR=r21600&f_E=2,3,4&f_JT=F`

### T+~3350ms — Popup window opens

**Where:** `extension/background/scan_manual.js:147-152` — `chrome.windows.create({url, type: "popup", width: 1280, height: 800, focused: false})`.

**Browser action:** New 1280x800 popup window opens in background. URL navigates to LinkedIn search page. Tab gets `tabId = 12345` (example).

**Storage write:**
- `scanInProgress: true`
- `scanConfig: {...config, runId: "abc-uuid", website: "linkedin", tabId: 12345, f_tpr: "r21600"}`
- `liveProgress: {scraped: 0, new_jobs: 0, ...}`

**Side effects:**
- Keepalive starts (5s interval)
- 90-min safety timeout scheduled (`scanTimeoutId` saved as string)

### T+~5000ms — LinkedIn page loads, content scripts inject

**Where:** Manifest `content_scripts` block matches the URL. All 13 scripts inject into the popup tab in order.

**Result:** Functions like `runFullScan`, `extractCardData`, `JhaDebug.emit` are now defined in the page's content-script context.

### T+~5050ms — `init()` runs

**Where:** `extension/content/linkedin/init.js:6`.

**Step-by-step:**
- T+5050ms: Read `chrome.storage.local` → `scanInProgress: true`, `scanConfig: {...}` ✅
- T+5060ms: `__JHA_LINKEDIN_SCAN_BOOTED = true` (duplicate-boot guard)
- T+5080ms: `chrome.runtime.sendMessage({type: "GET_TAB_ID"})` → returns `{id: 12345}`
- T+5100ms: `JhaDebug.init(runId, T+5100)` initializes
- T+5120ms: `JhaDebug.emit("scan_start", {...})` writes first event
- T+5160ms: `checkSession()` returns `"live"` (URL contains `/jobs/`)
- T+5180ms: `JhaDebug.emit("session_check", {result: "live"})`
- T+5200ms: `showScanOverlay()` adds the "🔍 JHA Scan in progress" banner
- T+5210ms: Heartbeat `setInterval` starts (10s)
- T+5220ms: `runFullScan(config, 12345)` called

### T+~5250ms — First page card discovery

**Where:** `extension/content/linkedin/page.js:64-95`.

**Actions:**
- `JhaDebug.setPage(1)`
- Check stop flag: `stopRequested = false` ✅
- `JhaDebug.emit("page_start", {url, current_page: 1, ...})`
- `waitForCards(12000)` — first page gets 12s timeout

**Inner loop of waitForCards:**
- T+5300ms: `getCards(true)` returns 0 cards (page still loading)
- T+5600ms: 0 cards
- T+5900ms: 0 cards
- T+6200ms: 5 cards (page partially rendered)
- T+6500ms: 12 cards
- T+6800ms: 25 cards
- T+7100ms: 25 cards (stable for 300ms)
- T+7400ms: 25 cards (stable for 600ms) ✅ → return

**Total card count for page: 25.**

### T+~7400ms — Per-card processing begins

For each of 25 cards:

- **Stop check** (`extension/content/linkedin/page.js:108-118`): `stopRequested = false` ✅
- **Get jobId** (`extension/content/linkedin/page.js:120`): `data-occludable-job-id` extracted
- **Per-page dedup**: `processedJobIds.has(jobId)` → false ✅, then `add(jobId)`
- **Extract card data** (`extension/content/linkedin/dom.js:60-95`): title, company, location, URL, easy_apply
- **Voyager fetch** (`extension/content/linkedin/voyager.js:42-83`):
  - GET `https://www.linkedin.com/voyager/api/jobs/jobPostings/{jobId}` with csrf-token
  - ~120ms response
  - Parse JD from `data.data.description.text`
  - **Second Voyager call** for company name (B-11 — wasted) → ~140ms
  - Total: ~260ms per card
- **Build payload**:
  ```js
  { website: "linkedin", job_title, company, location,
    job_description: jdText, job_url, apply_url, easy_apply,
    post_datetime, search_filters, scan_run_id: "abc-uuid" }
  ```
- **`ingestJob(payload)`** (`extension/content/shared/messaging.js:29-78`):
  - Pre-write `_swHeartbeat`, wait 150ms
  - Send `INGEST_JOB` with `correlationId: "ing_T+7800_abc"` to SW
  - SW receives, immediately responds `{ack: true}`
  - SW POST `/jobs/ingest` → backend processes (Phase 6 step 8)
  - Backend ~30ms response: `{id: "new-uuid", already_exists: false, content_duplicate: false}`
  - SW sends `INGEST_JOB_RESULT` back to content script
  - Waiter resolves, `ingestJob` returns the result
- **Update counters**:
  - `result.id` exists, not `already_exists`, not `content_duplicate` → `result_type: "new"`
  - `counters.scraped++; counters.new_jobs++`
  - `chrome.storage.local.set({liveProgress: {...counters}})`
  - `JhaDebug.emit("ingest", {result_type: "new", took_ms: 320, ...})`

**Per-card time: ~400ms (260ms Voyager + 30ms backend + 110ms misc).**

**For 25 cards on page 1: ~10 seconds total.**

### T+~17400ms — Page 1 done, pagination

**Where:** `extension/content/linkedin/page.js:151-184`.

**Actions:**
- PUT_EXTENSION_STATE: `current_page: 2, today_searches: 1`
- `JhaDebug.emit("dom_mutations", {page: 1, count: 47})`
- Scroll to `document.body.scrollHeight`
- `pollForNextButton()`:
  - T+17500ms: try selector 1 → not found
  - T+17800ms: try selector 1 → found ✅
- Click next button
- `waitForSpaTransition(urlBefore, cardIdsBefore, 10000)`:
  - T+18050ms: URL unchanged, cards unchanged
  - T+18300ms: URL unchanged, cards unchanged
  - T+18550ms: URL changed (`&start=25` appended) ✅ → return true

### T+~19000ms — Page 2 begins

Repeat from T+5250ms. `waitForCards(8000)` since this isn't first page. Likely faster card discovery (~2-3 seconds since DOM is already warm).

### T+~85000ms — All 8 pages processed, no more next button

After ~80 seconds of scanning across 8 pages × 25 cards = 200 jobs:

- T+85000ms: `pollForNextButton()` returns null after 5s polling
- T+85100ms: `JhaDebug.emit("pagination_ended", {page: 8, reason: "next_button_not_found", ...})`
- T+85200ms: `emitPageEnd(counters, 8, true)` (final page-end event)
- T+85250ms: `runFullScan` returns summary `{scraped: 200, new_jobs: 187, existing: 8, ...}`

### T+~85300ms — Init cleanup

**Where:** `extension/content/linkedin/init.js:99-119`.

**Actions:**
- `clearInterval(heartbeatInterval)`
- `hideScanOverlay()`
- `JhaDebug.emit("scan_end", {summary: {...}})`
- `JhaDebug.finalize()` drains last batch of events to backend (one final POST to `/extension/run-log/{runId}/debug`)
- `chrome.storage.local.remove(["scanConfig"])`
- `chrome.storage.local.set({scanInProgress: false, scanComplete: {tabId, summary, runId, completedAt}})`

### T+~85400ms — `scan_completion.js` handler fires

**Where:** `extension/background/scan_completion.js:3-66`.

**Actions:**
- `clearTimeout(scanTimeoutId)` — cancel the 90-min safety
- Final debug-flush POST → `/extension/run-log/{runId}/debug` with any straggler events
- `chrome.storage.local.remove("debugLog")`
- PUT `/extension/run-log/{runId}` with status="completed", all final counters, errors
- `stopKeepAlive()`
- `chrome.storage.local.remove(["scanComplete", "scanPageState"])`
- `chrome.storage.local.set({lastRunSummary: summary, liveProgress: null})`
- `chrome.tabs.remove(tabId)` — popup window closes

### T+~85500ms — Backend PUT handler fires sync dedup

**Where:** `backend/routers/extension.py:261-298`.

**Decisions:**
- `prior_status === "running"` ✅
- `body.status === "completed"` ✅ → real transition
- `cfg.dedup_mode === "sync"` ✅
- `log.scan_all === false` → no Scan All gate, fire dedup ✅

**Action:** `asyncio.create_task(_run_dedup_for_scan(runId))` — detached task starts.

### T+~85600ms — Detached dedup task running

**Where:** `backend/routers/extension.py:31-57`.

**Actions:**
- New `AsyncSessionLocal()` session opens (fresh DB session, not the request's)
- Read config from file
- `run_dedup(db, config, settings, scan_run_id=runId, trigger="post_scan")` — runs hash + cosine + chain resolution
- After dedup: `run_step_b_extraction(db, trigger="post_dedup")` — chains Step B (LLM-based JD extraction)
- `db.commit()`

This takes ~30-120 seconds depending on job count.

### T+~86000ms — Dashboard observes status change

**Where:** `frontend/src/pages/JobsPage.jsx:220-280`.

**Polling at T+86000ms (~2s after T+85500ms PUT):** GET `/extension/run-log?limit=1` returns the run-log with `status: "completed"`.

**State changes:**
- `scanning` → false (the `useEffect` at line 291-305 detects the transition)
- Refetch jobs grid → newly-scraped jobs appear
- Progress bar flashes 100% for 1.5s, then clears
- Footer updates: "Last scan: 🔵 LinkedIn · 187 new · 8 existing · started 2:34 PM"

### T+~85500ms to T+~205000ms — Background dedup completes

User sees the dashboard refresh. They can interact normally. The dedup task finishes silently in the background ~120s later. New entries appear in `dedup_reports` table.

### Total wall-clock time

| Phase | Approx duration |
|---|---|
| Click to popup open | ~3.5 seconds (mostly the SW poll interval) |
| Popup load + content scripts | ~2 seconds |
| 8 pages × 25 cards | ~80 seconds (~400ms/card) |
| Cleanup + run-log PUT | ~0.5 seconds |
| Dedup background task | ~30-120 seconds (invisible to user) |
| **User-perceived total** | **~85 seconds** |

The dominant cost is per-card Voyager fetch latency. Removing `fetchCompanyName` (B-11) would shave ~20-40 seconds off this.

---

## 20. Appendix B — Documented vs. code discrepancies

When you read the design docs (`step2-dedup-design.md`, `step3-match-design.md`, `jha-extension-knowledge.md`) alongside the code, you'll find places where they don't agree. This appendix catalogs every discrepancy I noticed during my code-reading session, so you can know what to trust.

**General rule:** When the docs and code disagree, **trust the code.** The docs are aspirational or historical; the code is what actually runs. Each discrepancy should ideally be resolved by either updating the doc or changing the code, but until then, the running system is the source of truth.

### D-1 — `TRIGGER_STOP` runtime message reportedly removed

**Doc says:** `step3-match-design.md` Section 9b row L claims the `TRIGGER_STOP` runtime message has been removed in favor of the `pollForStopTrigger` mechanism.

**Code shows:** `extension/background/runtime_messages.js` still has a `TRIGGER_STOP` handler.

**Reality:** Both paths exist. `pollForStopTrigger` is the primary mechanism (used by the dashboard's stop button). `TRIGGER_STOP` is dead but harmless code.

**Recommendation:** Remove `TRIGGER_STOP` from `runtime_messages.js`, or add a comment explaining why it's kept.

---

### D-2 — `scroll.js` reportedly deleted

**Doc says:** Same section claims `extension/content/linkedin/scroll.js` was deleted as part of the scrolling-strategy cleanup.

**Code shows:** The file still exists in the manifest's content_scripts list. It defines a `scrollToLoadCards()` function, but no code calls it (the LinkedIn scan now scrolls inline via `window.scrollTo` in `page.js`).

**Reality:** Dead file kept loaded.

**Recommendation:** Either delete the file and remove from manifest, or comment why it's kept.

---

### D-3 — `fetchCompanyName` reportedly removed

**Doc says:** `step3-match-design.md` row H states the secondary Voyager call to resolve company names was removed.

**Code shows:** `extension/content/linkedin/voyager.js:80` still calls `fetchCompanyName(companyUrn, csrfToken)`.

**Reality:** The call is still happening. This is **B-11** in the unreasonable-behaviors list. Significant per-card cost.

**Recommendation:** Verify whether this should have been removed (per the doc's claim) and finish the change. Or update the doc to admit this is still happening.

---

### D-4 — `isStale` flag reportedly kept in `dom.js`

**Doc says:** `step3-match-design.md` row F claims `isStale` was kept in `dom.js` while removed from `process.js`.

**Code shows:** `isStale` is **gone from both files**. `dom.js` no longer has the function; `process.js` no longer references it.

**Reality:** Fully removed.

**Recommendation:** Update the doc to reflect the full removal.

---

### D-5 — Overlay text "do not close this window"

**Doc says:** `step3-match-design.md` claims the overlay text reads "do not close this window" (a stronger user warning).

**Code shows:** `extension/content/linkedin/overlay.js` shows the actual text is "do not scroll or interact" — slightly different wording.

**Reality:** Less explicit warning. Users may close the popup without realizing the consequence.

**Recommendation:** Either update the code to match the doc (and warn against close), or update the doc to match the code.

---

### D-6 — Indeed `post_datetime` claim "always null"

**Doc says:** Some older documentation states Indeed's `post_datetime` is always null because the GraphQL response doesn't include posting date.

**Code shows:** `extension/content/indeed/process.js:18-34` defines `parseIndeedPostDate(snippets)` which parses card snippets like "Posted 3 days ago" and computes a real ISO timestamp.

**Reality:** Indeed's `post_datetime` IS populated, derived from card snippets. Less precise than LinkedIn's epoch-based source, but not null.

**Recommendation:** Update doc.

---

### D-7 — Step 4 (LLM Score) "not implemented"

**Doc says:** `step3-match-design.md` claims Step 4 ("LLM Score") is not yet implemented and is a future work item.

**Code shows:** Step D scoring IS implemented in `backend/services/match.py`. The 4-button matching pipeline (cpu_work → llm_extraction_gates → cpu_score → llm_score) is fully functional.

**Reality:** Step 4 is implemented and verified per recent run logs. The doc is outdated.

**Recommendation:** Update doc with current implementation state.

---

### D-8 — Sync mode "only runs dedup"

**Doc says:** `step2-dedup-design.md` describes sync mode as triggering dedup after a scan completes.

**Code shows:** `backend/routers/extension.py:_run_dedup_for_scan:46-47` chains `await run_step_b_extraction(db, trigger="post_dedup")` after dedup.

**Reality:** Sync mode = dedup + Step B extraction. This is **B-17** in the unreasonable-behaviors list.

**Recommendation:** Either remove the auto-chain (preferred — separation of concerns) or document that sync mode includes Step B.

---

### D-9 — Glassdoor "only manual scan"

**Doc says:** Design docs describe Glassdoor scanning as triggered only by the dashboard's Scan Glassdoor button.

**Code shows:** `extension/content/glassdoor/init.js:153-180` has a `runAutoGlassdoorScan` path that fires whenever the user visits Glassdoor (with a 15-min debounce).

**Reality:** Auto-scan path is alive and undocumented. This is **B-10** in the unreasonable-behaviors list.

**Recommendation:** Decide whether to keep auto-scan. If yes, document and add UI toggle. If no, remove the path.

---

### D-10 — `url_exact` dedup gate

**Doc says:** Older versions of `step2-dedup-design.md` described `url_exact` as one of the dedup gates.

**Code shows:** `url_exact` was removed from the dedup pipeline because the unique index on `scraped_jobs.job_url` (enforced at ingest time) makes it redundant. Two rows with the same URL cannot coexist; therefore a Stage-2 URL-equality check would always be a no-op.

**Reality:** No `url_exact` gate. Latest design doc has been updated.

**Recommendation:** None — already correct.

---

### D-11 — Documentation file paths

**Doc says:** Some references point to `/mnt/user-data/outputs/jha-extension-knowledge.md` as the persistent knowledge file.

**Code shows:** This is correct as far as the documentation lifecycle is concerned, but new readers need to know that the design docs (in `docs/`) are the **authoritative** source, not the knowledge file (which is more of an operational notes document).

**Recommendation:** Add a top-of-file note in each doc clarifying its role and authority.

---

### D-12 — `recordSkip` taxonomy

**Doc says:** Various older docs reference skip reasons like `no_id`, `jd_failed`, `phantom`, but the canonical list of valid skip reasons is not consolidated anywhere.

**Code shows:** Skip reasons used in practice include: `no_id`, `jd_failed`, `phantom`, `id_skipped`, `stale_skipped`, `url_duplicate`, `content_duplicate`. `url_duplicate` and `content_duplicate` are backend-set; the others are content-script-set.

**Recommendation:** Consolidate skip reasons into a single enum/table in the design doc. Helpful for trace analysis.

---

### D-13 — `dedup_mode` values

**Doc says:** Both `manual` and `sync` are described.

**Code shows:** Same — these are the two valid values. `cfg.dedup_mode` is read-only consumed; never `auto`, `disabled`, or other.

**Recommendation:** None — already correct.

---

### D-14 — Run-log `errors` field shape

**Doc says:** Different docs describe `errors` as either an array of strings or an array of objects.

**Code shows:** It's an **array of objects**, each with a `type` field plus type-specific fields. Examples:
- `{type: "ingest_error", job_id, error_message}`
- `{type: "voyager_error", job_id, http_status, attempt}`
- `{type: "pagination_ended", page, reason, url}`
- `{type: "no_cards", page}`

**Recommendation:** Document the canonical error-object shapes.

---

### D-15 — Trace event `level` values

**Doc says:** Some docs use `severity: critical|error|warning|info`.

**Code shows:** `extension/content/shared/debug_logger.js` uses three values: `info`, `warn`, `error`. No `critical`, no `severity` keyword (the field is `level`).

**Recommendation:** Update docs to match.

---

### How to keep this list current

When you change code:
1. Search the design docs for any claim about that code (`grep -ri "fetchCompanyName" docs/`).
2. If a doc claim contradicts your new code, update the doc in the same commit.
3. If you can't update the doc, add an entry to this Appendix B as a temporary marker.

When you read the design docs for guidance:
1. Skim Appendix B first to see if your section of interest has any known discrepancies.
2. Verify any non-trivial claim by grep-ing the codebase for the relevant function/symbol.
3. If you find a new discrepancy, add it here.

The goal is for Appendix B to shrink over time as discrepancies get resolved, eventually being empty when the docs match the code.

---

## 21. Cleanup batch retrospective (Prompts 1-5c, April 2026)

This section documents a multi-prompt cleanup batch that landed between 2026-04-25 and 2026-04-28. The batch shipped 30+ items across five prompts, then cleaned up its own over-engineering in three follow-up prompts (5, 5b, 5c). What follows is the post-mortem and the operating principles it produced.

### Timeline

| Prompt | Scope | Outcome |
|---|---|---|
| **Prompt 1** | 15 low-risk standalone fixes (B-11, B-17, B-19, B-1, BUG-6/7, etc.) | All shipped + verified |
| **Prompt 2** | BUG-10 (chrome.alarms two-tier polling) + B-3 + B-4 | Shipped + verified |
| **Prompt 3** | B-10 (Glassdoor auto-scan removed) + B-8 (refactor) + B-9 (universal boot guard) + B-24 (watchdog) + BUG-5 | Shipped; B-24 implementation later found broken (see B-32) |
| **Prompt 4** | BUG-4/B-21 (in-memory debug buffer) + B-23 Approach A (failed-ingest buffer) + B-14 (run-log progress mirror + WebSocket) + B-18 (dedup_tasks crash recovery) | Shipped; B-23 Approach A later replaced (see Prompt 5) |
| **Retrospective** | Reviewed every shipped fix against the principle "halt and let the user/scheduler retry, don't build elaborate in-flight recovery" | Identified B-23, B-24/B-32 as misaligned |
| **Prompt 5** | B-23 → Approach D (halt-and-report); B-24/B-32 → Approach C+ (proper fix); B-33 → Approach B (backend rejection) | All three shipped; verification revealed B-23 retry path broken |
| **Prompt 5b** | Fix B-23 retry detection (success-check); add B-33 `scan_pending` guard | Shipped + verified |
| **Prompt 5c** | Lazy cleanup of stale `running` run-logs in `trigger_scan` | Shipped + verified |

### What was right

The batch was mostly well-executed. About 20 of 30+ items were straightforward wins:

**Cosmetic / cleanup (uncontroversial):** B-2, B-5, B-6, B-15, B-26, BUG-8/B-29 — all simplifications.

**Real bug fixes proportional to the bug:** B-7, B-11, B-16, B-17, BUG-6/B-27, BUG-7/B-28, BUG-9/B-30, B-19.

**Aligned with "detect-and-halt" principle from the start:** BUG-10 (chrome.alarms), B-3 (combined endpoint), B-4 (`_lastPollError` write), B-1 (hook extraction), B-10 (auto-scan removal), B-20 (toast + auto-stop on deadline). These changes added detection without elaborate recovery — exactly the right shape.

### What was wrong (the over-engineering)

Two clear cases of misalignment with the "halt-and-report" principle:

**B-23 Approach A — failed-ingest buffer (Prompt 4):**
- Built: 200-entry FIFO buffer in `chrome.storage.local._failedIngests`, replay every 10th success, drain at scan_end, 5 attempts per entry. ~80 lines across 5 files.
- Failure mode it protected against: backend down for 30s during a 5-min scan = ~20 cards lost.
- Reality: those cards are still on the source page. Tomorrow's scheduled scan picks them up. Net data loss across the year: zero.
- Right answer: detect the failure, halt the scan, let the user/scheduler retry. ~10 lines.
- **Replaced in Prompt 5 with Approach D (halt-and-report).**

**B-24 watchdog — Prompt 3 implementation (later B-32):**
- Built: content-script tracks `_swDeathCounter`, escalates at 3 stale ticks, declares dead at 4.
- Two real problems: (1) `_keepalive` was written via `setInterval`, which doesn't survive SW suspension reliably → false positives on every normal scan (6-15 events per scan); (2) when SW genuinely died, the abort flag was set but never read mid-stream, so the scan didn't actually terminate.
- Right answer: write `_keepalive` from the chrome.alarms tick (reliable timing), and add per-card flag check in scrape loops. ~30-40 lines.
- **Properly fixed in Prompt 5 (Approach C+).**

### What was the right call (kept as shipped despite some over-engineering concern)

**B-18 dedup_tasks table (Prompt 4):**
- Initially flagged as over-engineered: a UI badge could surface "no dedup_report yet for recent scan" without a new DB table.
- Reconsidered for full automation: the scheduler needs a programmatic answer to "is dedup running, completed, or crashed?" The `dedup_tasks` table provides this cleanly. The lifespan startup hook (`mark_stale_dedup_tasks_failed`) is exactly the "software notices its own failures and recovers" pattern needed for automation.
- Verdict: kept as shipped. It's load-bearing for the future automation phase.

**B-14 layer C — WebSocket (Prompt 4):**
- Real-time run-log updates via `/ws/run-log` with subprotocol auth. ~60 lines.
- Polling at 2s already worked fine. WebSocket added a 5-second feedback improvement on a 5-minute task.
- Verdict: somewhat over-built for the immediate need, but useful infrastructure for future features (Step B progress, applications). Kept as shipped.

### Final state of cleanup work

| Item | Final approach | Status |
|---|---|---|
| B-23 | Approach D — halt-and-report via `_backendDownDuringScan` flag | ✅ Shipped (P5+5b) |
| B-24/B-32 | Approach C+ — alarm-tick keepalive + mid-stream abort + run-log status update | ✅ Shipped (P5) |
| B-33 | Approach B — backend-side rejection (3 guards: `scan_pending`, `stop_cooldown`, `scan_in_progress`) | ✅ Shipped (P5+5b) |
| B-23 stale-row cleanup | Lazy cleanup in `trigger_scan`: stale `running` rows older than 5 min get marked `failed` | ✅ Shipped (P5c) |
| B-31 (Glassdoor overlay) | Deferred — cosmetic, automation doesn't see overlays | Not addressed |

---

## 22. Issues discovered during verification (B-31, B-32, B-33)

Three items surfaced during live testing of the original 29-item batch and are tracked separately because they came after the initial bug analysis:

### B-31 🟢 Glassdoor overlay shows zero counters while jobs flow

**Where:** `extension/content/glassdoor/page.js` — the in-page overlay banner update logic.

**The behavior:** During a Glassdoor scan, the on-page overlay shows `Scraped: 0 · New: 0 · Existing: 0 · Failed: 0` even as jobs flow into the backend correctly. The dashboard counters are correct; only the in-page overlay is wrong.

**Severity:** Cosmetic. The actual signal (run-log counters) is fine. The overlay is a debug surface.

**Recommendation:** Defer. For a fully automated end-state, automation doesn't see overlays — they exist purely for human visual feedback. Only fix if/when human monitoring becomes part of the workflow again.

---

### B-32 ✅ B-24 watchdog triggers false positives AND fails to recover from real SW death *(resolved P5)*

**Where:** `extension/content/shared/init_helpers.js` (heartbeat callback) and per-site `page.js` files.

**The behavior:** The B-24 watchdog implementation from Prompt 3 had two distinct failures:

1. **False positives on every normal scan.** The `_keepalive` value was written by `setInterval` from `keepalive.js`, but MV3's aggressive SW suspension means `setInterval` callbacks don't fire reliably. The watchdog reads stale values and incorrectly declares SW death. Observed 6-15 spurious `sw_died` events per scan with 800+ events total.
2. **No actual recovery on real SW death.** When the SW genuinely died, the watchdog correctly set `_watchdogTripped: true` — but no code in the scrape loop ever read that flag mid-stream. The scan continued processing cards (whose ingests were now silently failing) until the 90-min safety timeout.

**Resolution (Approach C+ in Prompt 5):**

1. **Reliable keepalive timing.** Moved `_keepalive: Date.now()` write into the `chrome.alarms.onAlarm` handler in `extension/background/poll.js`. The alarm is the most reliable timing source in MV3 — it fires every 30s even when the SW has been suspended.
2. **Adjusted threshold to match new cadence.** Heartbeat checks `ageMs > 60000` (2x alarm cadence + slack) instead of 30000. Escalates at 3 stale ticks (PING attempt), declares dead at 4 ticks.
3. **Mid-stream abort wired in.** Per-site scrape loops now read `_watchdogTripped` (alongside `_backendDownDuringScan` and `stopRequested`) at the top of each card iteration via a single `chrome.storage.local.get([...])` call. On detection: emit `sw_died` error event, set `counters.aborted_reason = "sw_died"`, break out of the loop.
4. **Translated to run-log status.** `extension/background/scan_completion.js` translates `aborted_reason: "sw_died"` to `status: "failed"` with `error_message: "Service worker died during scan; please retry"`.

**Verification result:** 0 sw_died events on a 246-event normal Indeed scan (was 6-15 before). False positives eliminated.

---

### B-33 ✅ Click Scan during stop-cleanup window produces inconsistent state *(resolved P5+5b)*

**Where:** `backend/routers/extension.py:trigger_scan`.

**The behavior:** Clicking Scan within ~3-5 seconds after clicking Stop produced inconsistent state. The popup might not close, the new scan might not start, storage state was confused. In automation contexts (multiple triggers in quick succession from scheduler+agent), the same race exists.

**Resolution (Approach B — backend-side rejection):** Three guards added to `trigger_scan`, executed in this order before any state mutation:

1. **`scan_pending` guard** (P5b): rejects if `extension_state.scan_requested == True`. Catches "two triggers fired before SW consumed either."
2. **`stop_cooldown` guard** (P5): rejects if any run-log has `completed_at` within the last 5 seconds. Catches the actual stop-then-scan race.
3. **`scan_in_progress` guard** (P5): rejects if any run-log has `status='running'`. Catches "scan already in flight."

Each returns 409 Conflict with structured detail:
```json
{
  "reason": "stop_cooldown",
  "message": "A scan recently terminated; the extension is still cleaning up. Retry in 5 seconds.",
  "retry_after_ms": 5000
}
```

**Why backend-side rejection (not frontend cooldown):** Frontend cooldown only protects the dashboard. Backend rejection protects all callers, including future scheduler-driven and agent-driven triggers. Single source of truth.

**Frontend handling:** `frontend/src/api.js` `triggerScan` throws an `Error` with `status: 409` and `detail` on rejection. `frontend/src/pages/JobsPage.jsx` shows `window.alert(detail.message)` and (for Scan All) calls `grace.clear()` and breaks the loop.

**Lazy cleanup edge case (P5c):** the `scan_in_progress` guard caused a permanent block when a previous scan ended with the backend down (and so couldn't write `status='failed'`). Fixed by adding lazy cleanup before the running guard:

```python
stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
await db.execute(
    update(ExtensionRunLog)
    .where(ExtensionRunLog.status == "running")
    .where(ExtensionRunLog.started_at < stale_cutoff)
    .values(
        status="failed",
        error_message="Scan exceeded 5 minutes without completion; "
                      "backend likely lost contact during scan. Please retry.",
        completed_at=datetime.now(timezone.utc),
    )
)
await db.flush()  # CRITICAL: without this, the UPDATE doesn't take effect for the next SELECT
```

The `db.flush()` is essential — without it, the SQLAlchemy session still has the stale row visible to the subsequent `select(ExtensionRunLog).where(status == "running")`, so the running guard fires and the transaction rolls back without committing.

---
## 23. Auto-scrape system — what shipped (Phases 1-7.1)

This section documents the autonomous scraping loop that was built on top of the manual scan internals (sections 5-12) between 2026-04-25 and 2026-04-29. By the end of this work, the system could run unattended for hours, cycling through a configurable matrix of (site × keyword) scans without user intervention.

Status as of 2026-04-29: validated by a 5-hour production run with 8 successful cycles, zero parallel-cycle bugs, zero attribution mismatches on new data. **The autonomous scraping milestone is complete.**

### What "auto-scrape" means

A daemon-like loop that runs entirely while the user's browser is open. The user signs into LinkedIn, Indeed, and Glassdoor once, opens `/dashboard/auto-scrape`, clicks **Enable**, and the system runs cycles indefinitely until the user clicks **Stop and Exit** or shuts down the browser.

Each cycle consists of:
1. **Pre-cycle health check.** Probe each enabled site to see if its session is alive. Sites with dead sessions (login redirect, captcha) are excluded from the cycle.
2. **Matrix scrape.** For each (live site × configured keyword) pair, trigger the existing manual scan flow (sections 5-12) and wait for it to complete. The matrix is sequential — never two scans at once.
3. **Post-scrape phase.** Currently a no-op (dedup and matching deferred). The plumbing is in place to wire them in later.
4. **Schedule next cycle.** A `chrome.alarms` alarm fires after `min_cycle_interval_ms` (default 60s, dev default 30s).

Stop conditions:
- User clicks **Pause** or **Stop and Exit**
- 3 consecutive precheck failures (auto-pause)
- 24 consecutive cycles where a specific site is dead → that site is suspended (other sites continue)
- Browser closes (cycle pauses; user must explicitly re-Enable on next browser open)

### What's shipped vs deferred

| Component | Status | Notes |
|---|---|---|
| Phase 1 — backend foundations | ✅ Shipped | 4 new tables, 22 admin endpoints, ConfigValidator, lifespan stale-cycle cleanup |
| Phase 2 — extension foundations | ✅ Shipped | handleManualScan placeholder restructure, debugLog cap, manifest host_permissions |
| Phase 3 — SW orchestrator | ✅ Shipped | auto_scrape.js, runOneCycle, preCycleCheck, matrix loop, abort flags |
| Phase 4.5 — backend post-scrape orchestrator | ✅ Shipped (skeleton) | Redis subscriber, atomic claim, heartbeat. **Body is no-op** |
| Phase 5 — continuous mode | ✅ Shipped | State mirror in poll.js, auto_scrape_next_cycle alarm, scheduleNextCycle, handleGracefulExit |
| Phase 6 — dashboard | ✅ Shipped | `/dashboard/auto-scrape` with 5 components, self-bootstrap on Enable |
| Phase 7 — hardening | ✅ Shipped | Auto-pause on 3 precheck fails, per-site dead-session suspension, multi-instance warning |
| Phase 7.1 — captcha UX | ✅ Shipped | URL+body marker detection, per-cycle Chrome notifications, Resolve CAPTCHA button |
| Dedup pipeline integration | ⏸ Deferred | Phase 4.5 made post-scrape a no-op pending dedup redesign |
| Matching pipeline integration | ⏸ Deferred | Same as above |
| Phase 8 auto-apply | ⏸ Deferred | Separate workstream; builds on dedup + matching |
| D-4 dynamic pacing (double on 429, halve after 5 clean) | ⏸ Deferred | Premature; fixed-interval pacing is sufficient at observed scale |

### High-level architecture

Two orchestrators by necessity:

```
┌──────────────────────────────────────────────────────────────┐
│                EXTENSION ORCHESTRATOR (in SW)                 │
│                                                               │
│  pollAutoScrapeState (every 30s via jha_poll alarm)          │
│   ├─ Mirrors backend state into chrome.storage.local         │
│   ├─ Self-bootstraps auto_scrape_next_cycle if enabled       │
│   │   AND no cycle running (cycle_phase == "idle")           │
│   └─ Heartbeat to backend                                    │
│                                                               │
│  onAutoScrapeAlarm → runOneCycle                             │
│   ├─ Write cycle_phase="scrape_running" IMMEDIATELY          │
│   ├─ Clear stale flags                                       │
│   ├─ Pre-cycle probe of all enabled sites                    │
│   ├─ Matrix loop: site × keyword sequential scans            │
│   ├─ Post-cycle: write status="scrape_complete"              │
│   ├─ Wake backend orchestrator (Redis publish)               │
│   ├─ Wait for status="post_scrape_complete"                  │
│   └─ scheduleNextCycle → next alarm                          │
└──────────────────────────────────────────────────────────────┘
                           │
                  cycle table + Redis pub/sub
                           │
┌──────────────────────────────────────────────────────────────┐
│            BACKEND POST-SCRAPE ORCHESTRATOR                   │
│       (Redis subscriber + APScheduler 1-min fallback)         │
│                                                               │
│  Subscribe: "auto_scrape:cycle_complete"                     │
│   ├─ Atomic claim: UPDATE WHERE status='scrape_complete'     │
│   │   RETURNING id (only one worker claims any given cycle)  │
│   ├─ Run dedup (NO-OP — body deferred)                       │
│   ├─ Run matching (NO-OP — body deferred)                    │
│   └─ Set status="post_scrape_complete"                       │
└──────────────────────────────────────────────────────────────┘
```

The two-orchestrator split is structural, not aesthetic:
- The SW MUST run scrapes (only the extension has access to user session cookies, can open browser tabs, can read DOM)
- The backend MUST run dedup/matching (Python LLM pipelines, runtimes >30s exceeding MV3 SW limits)
- They communicate via the `auto_scrape_cycles` table (status transitions) and Redis pub/sub (instant wake) with APScheduler 1-min polling as fallback

### What's the same as manual scans

The matrix loop INVOKES the existing manual scan flow per pair. So sections 5-12 of this document still apply — `handleManualScan` is what the orchestrator calls. The orchestrator just sits ABOVE it, picking the (site, keyword) and waiting for the run-log to reach a terminal state.

This is the most important architectural decision: auto-scrape is not a parallel implementation of scraping — it's a scheduler that drives the existing manual scan flow.

---

## 24. Auto-scrape architecture in detail

### 24.1 Database tables

Migration `023_auto_scrape_foundations.py` created four new tables. All exist in PostgreSQL alongside the existing scraped_jobs / extension_run_logs / dedup_tasks tables.

#### `auto_scrape_state` — single-row mailbox

```sql
CREATE TABLE auto_scrape_state (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    state JSONB NOT NULL,
    last_sw_heartbeat_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The `state` JSONB holds:
- `enabled` — user's intent (set to true by clicking Enable, false by Pause/Stop)
- `cycle_phase` — current phase: `idle`, `scrape_running`, `postscrape_running`
- `exit_requested` — graceful shutdown flag
- `config_change_pending` — apply-now config restart flag
- `test_cycle_pending` — one-shot test cycle flag
- `consecutive_precheck_failures` — auto-pause counter (resets on `/enable`)
- `extension_instance_id` — UUID of the SW that wrote last
- `min_cycle_interval_ms` — pacing floor (default 60000)

**Why `last_sw_heartbeat_at` is a separate column** (not in JSONB): the heartbeat fires every 30s and we don't want to bump `updated_at` on every heartbeat. The dashboard's heartbeat freshness widget reads this column; everything else reads the JSONB.

#### `auto_scrape_cycles` — cycle history

```sql
CREATE TABLE auto_scrape_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id BIGINT NOT NULL,                    -- monotonic, server-assigned
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL,                        -- check constraint enforces enum
    phase_heartbeat_at TIMESTAMPTZ,              -- updated every 30s during postscrape
    precheck_status TEXT,
    precheck_details JSONB,
    scans_attempted INT DEFAULT 0,
    scans_succeeded INT DEFAULT 0,
    scans_failed INT DEFAULT 0,
    failures_by_reason JSONB,
    run_log_ids UUID[],
    cleanup_results JSONB,
    dedup_task_id UUID,
    match_results JSONB,
    error_message TEXT,
    notes TEXT
);

CREATE INDEX idx_auto_scrape_cycles_running ON auto_scrape_cycles(status)
    WHERE status IN ('scrape_running', 'postscrape_running');
```

Status enum: `scrape_running`, `scrape_complete`, `postscrape_running`, `post_scrape_complete`, `failed`.

The partial index on running statuses makes the every-minute stale-cleanup query fast — it only scans cycles in non-terminal states.

`cycle_id` is monotonic via PostgreSQL sequence `auto_scrape_cycle_id_seq`. Each `POST /admin/auto-scrape/cycle` does `nextval()`. Survives extension reinstall (since the extension doesn't generate it).

#### `auto_scrape_config` — user-tunable settings

```sql
CREATE TABLE auto_scrape_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    config JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Holds:
- `enabled_sites` — subset of {linkedin, indeed, glassdoor}
- `keywords` — array of search terms (max 10)
- `min_cycle_interval_minutes`, `inter_scan_delay_seconds`, `scan_timeout_minutes`
- `max_consecutive_precheck_failures` (default 3)
- `max_consecutive_dead_session_cycles` (default 24)
- `run_dedup_after_scrape`, `run_matching_after_dedup`, `run_apply_after_matching` (booleans, all currently no-ops downstream)

Validation lives in `backend/core/auto_scrape_validation.py`. The frontend reads `GET /admin/auto-scrape/config/limits` for live UI feedback.

#### `site_session_states` — per-site session tracking

```sql
CREATE TABLE site_session_states (
    site TEXT PRIMARY KEY,            -- check: linkedin/indeed/glassdoor
    last_probe_status TEXT NOT NULL,  -- live/expired/captcha/rate_limited/unknown
    last_probe_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consecutive_failures INT DEFAULT 0,
    notified_user BOOLEAN DEFAULT FALSE,
    backoff_multiplier REAL DEFAULT 1.0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

State machine for `last_probe_status` transitions is handled server-side in `PUT /admin/auto-scrape/sessions/{site}`:
- `live → expired/captcha`: consecutive_failures++; first transition triggers Chrome notification (E2 dedup via `notified_user`)
- `expired → live`: consecutive_failures=0; notified_user=false (recovery)
- `live → rate_limited`: consecutive_failures NOT incremented (rate limit ≠ session dead); backoff_multiplier doubles up to ×64

#### Two new columns on `extension_run_logs`

```sql
ALTER TABLE extension_run_logs ADD COLUMN failure_reason TEXT;
ALTER TABLE extension_run_logs ADD COLUMN failure_category TEXT;
```

`failure_reason` is structured (e.g., `setup_config_unavailable`, `scan_timeout`, `session_expired`, `rate_limited`).
`failure_category` is one of `transient`, `persistent`, `coordination`, `unknown`.

The orchestrator uses these to compute `failures_by_reason` per cycle.

### 24.2 Extension files — what's where

```
extension/
├── manifest.json                    # host_permissions added for site probes
├── background/
│   ├── auto_scrape.js              # Main orchestrator (runOneCycle, etc.)
│   ├── auto_scrape_init.js         # Initialization, instance_id generation
│   ├── auto_scrape_config.js       # Constants, probe URLs
│   ├── poll.js                     # State mirror + heartbeat (jha_poll alarm)
│   ├── scan_manual.js              # MODIFIED: HC-1 placeholder restructure
│   ├── scan_completion.js          # MODIFIED: structured failure_reason mapping
│   └── ...
└── content/
    └── shared/
        └── debug_logger.js          # MODIFIED: D-14 5000-event cap
```

The orchestrator never touches the content scripts directly. It calls the existing `POST /extension/trigger-scan` endpoint, which sets a flag in `extension_state`, which the SW's poll loop picks up — exactly the same path as a manual user click.

### 24.3 The `runOneCycle` flow

```javascript
async function runOneCycle({ isTestCycle = false } = {}) {
  // CRITICAL: write cycle_phase="scrape_running" FIRST (Revision 2 fix —
  // see §25 for why). Window between user click and this write must be <50ms
  // or self-bootstrap parallel cycle bug recurs.
  await updateAutoScrapeState({ cycle_phase: "scrape_running" });
  
  // Clear stale flags
  await chrome.storage.local.set({
    _backendDownDuringScan: false,
    _watchdogTripped: false,
    scanInProgress: false,
  });
  
  // Read config from backend (NOT hardcoded — see Bug B in §25)
  const config = await fetchAutoScrapeConfig();
  console.log(`[auto_scrape] config loaded: sites=${config.enabled_sites.length}, keywords=${config.keywords.length}`);
  
  // Pre-cycle health check
  const [precheckStatus, precheckDetails] = await preCycleCheck(config.enabled_sites);
  
  if (precheckStatus !== "ok") {
    // Increment consecutive_precheck_failures
    // Auto-pause if >= max_consecutive_precheck_failures
    // (see §25 Bug #1 for why this counter is critical)
    await handlePrecheckFailure(precheckStatus, precheckDetails);
    await updateAutoScrapeState({ cycle_phase: "idle" });
    return;
  }
  
  // Reset counter on success
  await updateAutoScrapeState({ consecutive_precheck_failures: 0 });
  
  // Filter eligible sites: live AND not in dead-session suspension
  const eligibleSites = filterEligibleSites(precheckDetails, config);
  
  if (eligibleSites.length === 0) {
    await markCycleFailed("No eligible sites (all suspended or dead)");
    await updateAutoScrapeState({ cycle_phase: "idle" });
    return;
  }
  
  // Create cycle row
  const cycleId = await createCycle({ started_at: new Date().toISOString() });
  
  // Run matrix
  const cycleResult = await runScrapeMatrix(eligibleSites, config.keywords, cycleId);
  
  // Handle abort cases (graceful exit, config change, etc.)
  if (cycleResult.aborted) {
    await handleAbortedCycle(cycleId, cycleResult);
    await updateAutoScrapeState({ cycle_phase: "idle" });
    return;
  }
  
  // Mark scrape complete; backend orchestrator picks up
  await updateCycle(cycleId, { status: "scrape_complete" });
  await fetch(`${backendUrl}/admin/auto-scrape/wake-orchestrator`, { method: "POST", headers });
  
  // Wait for backend to finish post-scrape (no-op currently, but
  // structure is in place for when dedup/matching are wired in)
  await waitForCycleStatus(cycleId, "post_scrape_complete", postScrapeTimeoutMs);
  
  // Schedule next cycle (with SC-4 trivially-short cooldown)
  if (!isTestCycle) {
    await scheduleNextCycle(cycleResult);
  }
  
  await updateAutoScrapeState({ cycle_phase: "idle" });
}
```

The five things to remember:
1. `cycle_phase = "scrape_running"` writes IMMEDIATELY at top — within milliseconds of entry
2. Config is fetched from the backend, not hardcoded (see Bug B in §25)
3. Eligible sites are filtered for both session liveness AND dead-session suspension
4. The matrix loop checks 5 abort flags in priority order before each scan
5. `cycle_phase = "idle"` is written in (effectively) finally, so self-bootstrap can resume

### 24.4 Pre-cycle health check

Probes each enabled site to determine session state. Updates `site_session_states` table.

```javascript
async function probeSiteSession(site) {
  const probeUrls = {
    linkedin: "https://www.linkedin.com/feed/",
    indeed: "https://www.indeed.com/jobs?q=test",  // www. not ca. (see §25 fix)
    glassdoor: "https://www.glassdoor.com/Job/index.htm",
  };
  
  try {
    const resp = await fetch(probeUrls[site], { credentials: "include", redirect: "manual" });
    
    // 4xx with login redirect → expired
    if (resp.url.includes("/login") || resp.url.includes("/authwall")) return "expired";
    
    // 200 → live
    if (resp.status === 200) return "live";
    
    // 429 always → rate_limited
    if (resp.status === 429) return "rate_limited";
    
    // 403 → ONLY captcha if URL/body has captcha markers (see §25 Bug #3)
    // Bare 403 → rate_limited (Indeed's anti-bot)
    if (resp.status === 403) {
      const url = resp.url.toLowerCase();
      if (url.includes("captcha") || url.includes("challenge") || url.includes("turnstile")) {
        return "captcha";
      }
      // Try to read body for captcha markers
      try {
        const text = await resp.text();
        if (text.includes("captcha") || text.includes("Cloudflare")) return "captcha";
      } catch {}
      return "rate_limited";
    }
    
    return "unknown";
  } catch (e) {
    return "unknown";
  }
}
```

The 403 → `rate_limited` distinction is what kept Indeed from being permanently suspended after Cloudflare anti-bot kicked in — see §25 Bug #3.

### 24.5 The matrix loop

```javascript
async function runScrapeMatrix(eligibleSites, keywords, cycleId) {
  const cycleResults = {
    scans_attempted: 0,
    scans_succeeded: 0,
    scans_failed: 0,
    failures_by_reason: {},
    run_log_ids: [],
  };
  
  for (let siteIdx = 0; siteIdx < eligibleSites.length; siteIdx++) {
    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      // Check 5 abort flags in priority order (single batched read)
      const flags = await chrome.storage.local.get([
        "_autoScrape.exit_requested",
        "stopRequested",
        "_backendDownDuringScan",
        "_watchdogTripped",
        "_autoScrape.config_change_pending",
      ]);
      
      if (flags["_autoScrape.exit_requested"]) return { ...cycleResults, aborted: "exit_requested" };
      if (flags["stopRequested"]) return { ...cycleResults, aborted: "user_stopped" };
      if (flags["_backendDownDuringScan"]) return { ...cycleResults, aborted: "backend_unavailable" };
      if (flags["_watchdogTripped"]) return { ...cycleResults, aborted: "sw_died" };
      if (flags["_autoScrape.config_change_pending"]) return { ...cycleResults, aborted: "config_changed" };
      
      const site = eligibleSites[siteIdx];
      const keyword = keywords[kwIdx];
      
      // Update keyword in profile config (the manual scan flow reads from there)
      await updateConfigKeyword(keyword, site);
      
      // Trigger and wait
      const result = await triggerScanAndWait(site, scanTimeoutMs);
      
      cycleResults.scans_attempted++;
      if (result.ok) cycleResults.scans_succeeded++;
      else {
        cycleResults.scans_failed++;
        cycleResults.failures_by_reason[result.reason] = (cycleResults.failures_by_reason[result.reason] ?? 0) + 1;
      }
      cycleResults.run_log_ids.push(result.runId);
      
      // Per-scan persist (so dashboard shows progress)
      await updateCycle(cycleId, { ...cycleResults });
      
      // Inter-scan delay (30s default — see SC-2 in v4 design)
      await sleep(interScanDelayMs);
    }
  }
  
  return cycleResults;
}
```

Abort flag precedence is documented in `auto-scrape-design-v4.md` §5.2. The five flags serve five distinct purposes:
- `exit_requested` — graceful shutdown (Stop and Exit button)
- `stopRequested` — user explicit stop (legacy from B-23)
- `_backendDownDuringScan` — backend halt (legacy from B-23)
- `_watchdogTripped` — SW death detection (legacy from B-32)
- `config_change_pending` — apply-now config restart

The 30-second inter-scan delay is greater than B-33's 5-second stop_cooldown, so back-to-back triggers within the matrix are never rejected by the cooldown guard.

### 24.6 The state mirror in poll.js

The SW maintains a local mirror of `auto_scrape_state` in `chrome.storage.local`, refreshed every 30s by the existing `jha_poll` alarm. This serves three purposes:

1. **Observability:** the dashboard's poll cycle can read the mirror without making backend calls every render
2. **Heartbeat:** when `enabled=true || test_cycle_pending=true`, poll.js writes `last_sw_heartbeat_at` (HC-3 piggyback design)
3. **Self-bootstrap:** if the alarm `auto_scrape_next_cycle` doesn't exist AND `enabled=true` AND `cycle_phase=="idle"`, poll.js bootstraps the alarm

Self-bootstrap is the failsafe: if the SW restarts and loses its alarm state, poll.js detects this and re-creates the alarm. The `cycle_phase=="idle"` guard is what prevents parallel cycles — see §25.

```javascript
async function pollAutoScrapeState() {
  const state = await fetchAutoScrapeState();
  await chrome.storage.local.set({ _autoScrape: state.state });
  
  // Heartbeat
  if (state.state.enabled || state.state.test_cycle_pending) {
    await fetch(`${backendUrl}/admin/auto-scrape/heartbeat`, {
      method: "POST", headers,
      body: JSON.stringify({ extension_instance_id: state.state.extension_instance_id }),
    });
  }
  
  // Self-bootstrap (fail-safe)
  if (state.state.enabled && state.state.cycle_phase === "idle") {
    const alarm = await chrome.alarms.get("auto_scrape_next_cycle");
    if (!alarm) {
      console.log("[poll] self-bootstrap: re-creating auto_scrape_next_cycle alarm");
      await chrome.alarms.create("auto_scrape_next_cycle", { when: Date.now() + 1000 });
    }
  }
}
```

### 24.7 The backend post-scrape orchestrator (skeleton)

In `backend/auto_scrape/post_scrape_orchestrator.py`. Architecturally complete but body deferred:

```python
async def run_post_scrape_phase(cycle_id: UUID):
    hb_task = asyncio.create_task(_heartbeat_loop(cycle_id))
    try:
        # PLACEHOLDER — dedup pipeline integration deferred
        # if config["run_dedup_after_scrape"]:
        #     dedup_task_id = await _run_dedup_for_cycle(cycle_id, run_log_ids)
        #     await _update_cycle(cycle_id, dedup_task_id=dedup_task_id)
        
        # PLACEHOLDER — matching pipeline integration deferred
        # if config["run_matching_after_dedup"]:
        #     await _run_matching_for_cycle(cycle_id, run_log_ids)
        #     match_results = await _compute_match_results(cycle_started_at)
        #     await _update_cycle(cycle_id, match_results=match_results)
        
        await _update_cycle_status(cycle_id, "post_scrape_complete",
                                    completed_at=datetime.now(timezone.utc))
    except Exception as e:
        await _update_cycle_status(cycle_id, "failed", error_message=str(e))
    finally:
        hb_task.cancel()
```

The Redis subscriber, atomic-claim transition, and APScheduler 1-minute polling fallback are all live and tested. When dedup and matching are ready, just uncomment the bodies.

### 24.8 The dashboard

`/dashboard/auto-scrape` — five components rendered as one page:

| Component | Shows | Polls |
|---|---|---|
| StatusHeader | Running/Disabled, heartbeat age + colored dot (D-2 thresholds: green<2min / yellow 2-5min / red>5min) | 5s |
| CurrentCycle | In-flight cycle: phase, progress (N/M scans), site/keyword | 5s |
| CycleHistory | Last 10 cycles | 5s |
| SessionHealth | Per-site live/expired/captcha indicators + Reset Session buttons | 5s |
| ConfigEditor | Sites checkboxes, keywords editor, numeric fields with validation, save modal | only on edit |

The save modal implements D-3: when a cycle is currently running, the user is asked whether to apply the new config "now" (abort current cycle, start fresh) or "at next cycle" (current finishes normally). The `config_change_pending` flag is the implementation hook.

A multi-instance warning banner appears if more than one `extension_instance_id` heartbeats within a 5-minute window. The detection is in-memory on the backend (no extra storage) and self-clears.

---

## 25. Bugs found and fixed during auto-scrape rollout

A 10-hour autonomous validation run on 2026-04-28 surfaced three production bugs that hadn't appeared in any short test. Followed by a parallel-cycle race condition with two iterations of fix. Followed by zombie popup attribution. Documenting in chronological order.

### Bug #1 — `config_change_pending` flag never cleared (10-hour run, 254/255 cycles aborted)

**Symptom:** During the long run, every cycle after the first ended with `Cycle aborted: config_changed`. 254 out of 255 cycles.

**Root cause:** `POST /restart-cycle` set `config_change_pending=true` in the state JSONB. **Nothing in the codebase ever set it back to false.** The flag persisted through SW reloads, Docker restarts, even shutdowns. After the user's first config change ever, the flag was on forever.

**Fix:** `POST /enable`, `POST /pause`, and `POST /shutdown` all explicitly set `config_change_pending=false` as part of their state updates. The orchestrator also clears it at end of any cycle that consumed it.

```python
# backend/routers/auto_scrape.py
@router.post("/enable")
async def enable():
    state = await get_state()
    state["enabled"] = True
    state["config_change_pending"] = False         # FIX
    state["consecutive_precheck_failures"] = 0     # FIX (precheck escalation)
    state["exit_requested"] = False                # FIX
    await put_state(state)
    return state
```

**Lesson:** boolean state flags need an explicit owner of the "set back to false" path. If you can't point to the code that clears the flag, it'll never get cleared.

### Bug #2 — `scanInProgress` flag stuck `true` between cycles

**Symptom:** Same 10-hour run had 369 `scan_in_progress` 409 errors when triggering the next scan in the matrix.

**Root cause:** When a matrix cycle aborts mid-scan via `_backendDownDuringScan` flag, the content script halts at the next card boundary. But `handleManualScan`'s finally block (which clears `scanInProgress`) only runs in some abort paths. In particular, when the SW kills the popup tab from outside, the finally never executes.

**First fix (broke single-cycle invariant — see Bug #4):** added `scanInProgress` cleanup to `runOneCycle` start. This caused parallel cycles because Phase 6's self-bootstrap was reading `scanInProgress` to detect "is cycle running" — wiping it at cycle start defeated the check.

**Final fix:** `scanInProgress` cleanup moved to `handleGracefulExit` (the SW shutdown path). The matrix loop tolerates a stale `scanInProgress` flag — it doesn't trigger from inside the matrix; it triggers from the user-facing `/extension/trigger-scan` endpoint, which is rate-limited by the 5s `stop_cooldown` (B-33).

**Lesson:** when introducing a cleanup, identify what other code reads the flag for what purpose. If something else uses the flag as a signal, your cleanup is changing its semantics.

### Bug #3 — Indeed 403 → permanent CAPTCHA suspension

**Symptom:** During the 10-hour run, Indeed went `live` → `captcha` after a few hours and stayed `captcha` for 191 consecutive probes. User solved the Cloudflare challenge in a browser tab; Indeed still classified as captcha; site was permanently excluded from matrix.

**Root cause:** Probe code unconditionally classified any 403 as `captcha`. But Indeed's 403s are NOT real captchas in the auto-scrape sense — they're rate limiting, geographic blocks, or generic anti-bot responses. Phase 7.1's captcha-suspension filter then permanently excluded indeed from the matrix.

**Fix:** 403 is classified as `captcha` ONLY when the URL or body contains explicit captcha markers (`captcha`, `challenge`, `turnstile`, `Cloudflare`). Bare 403 with no markers → `rate_limited` (which has different handling — site stays in the matrix with backoff, eventually recovers).

```javascript
if (resp.status === 403) {
  const url = resp.url.toLowerCase();
  if (url.includes("captcha") || url.includes("challenge") || url.includes("turnstile")) {
    return "captcha";
  }
  try {
    const text = await resp.text();
    if (text.includes("captcha") || text.includes("Cloudflare")) return "captcha";
  } catch {}
  return "rate_limited";  // bare 403 is rate-limit, not captcha
}
```

**Verified:** in cycle 373 of the 10-hour run, Indeed correctly classified as `rate_limited` after the fix. The 5-hour follow-up run had Indeed at `rate_limited` with backoff ×64 throughout — gracefully excluded from matrix without permanent suspension.

**Lesson:** HTTP status codes are signals, not classifications. A 403 means "forbidden" — the reason for the forbid is in the response body, headers, and URL.

### Bug #4 — Parallel cycle bug (revision 1, then revision 2)

**Symptom:** After Bug #2's first fix, a 1-hour test had 12 cycles run in parallel. Three popup windows scraping LinkedIn simultaneously.

**Root cause:** Phase 6's self-bootstrap in poll.js was reading `scanInProgress` to detect "is cycle currently running." When `runOneCycle` cleared `scanInProgress` at start (the buggy first fix), self-bootstrap thought no cycle was running and bootstrapped a parallel one.

**Revision 1 (still buggy):** Switched self-bootstrap to read `state.cycle_phase` instead of `scanInProgress`. But the fix placed the `cycle_phase = "scrape_running"` write AFTER `_createCycleRow()` — about 30 seconds into the cycle (after precheck completed). During that 30-second window, the SW's poll loop fired, saw `cycle_phase=="idle"`, and bootstrapped a parallel cycle.

```
T+0:  runOneCycle started
T+5:  probe linkedin: live           ← precheck running, cycle_phase still "idle"
T+10: [poll] self-bootstrap fired    ← THIS IS THE BUG
T+30: cycle row created, cycle_phase set to "scrape_running"
T+30: parallel cycle starts
```

**Revision 2 (final fix, verified):** `cycle_phase = "scrape_running"` write moved to FIRST action in `runOneCycle`, before any other code. The window collapsed from ~30s to ~50ms.

```javascript
async function runOneCycle({ isTestCycle = false } = {}) {
  // CRITICAL FIRST LINE — must execute within 50ms of entry
  await updateAutoScrapeState({ cycle_phase: "scrape_running" });
  
  // ... everything else ...
}
```

**Verified:** in the 5-hour run that followed, cycle 378→379 transitioned cleanly with no `[poll] self-bootstrap` line in the logs between cycles. The self-bootstrap parallel cycle bug is fixed.

**Lesson:** when an external observer reads state to make decisions, that state must be written ATOMICALLY at the start of the operation, not as a byproduct partway through.

### Bug #5 — Zombie popup window attribution mismatches

**Symptom:** After Bug #4 fix verification, 207 indeed jobs got attributed to a linkedin run-log. Cycle 378 ran linkedin + glassdoor only (indeed was rate_limited). But scrape ingestion attributed 207 indeed jobs to linkedin.

**Root cause:** A zombie popup from a force-stopped earlier cycle (374-375) was still alive in Chrome and scraping indeed. The popup didn't have a current run-log (its run-log had been force-marked failed via SQL UPDATE). When the popup's content script POSTed jobs via `/scraped-jobs/ingest`, the backend attributed them to the most recent run-log it could find — which was a linkedin run-log from cycle 378.

**Why it didn't surface in the 10-hour run:** the 10-hour run was killed via Stop and Exit, which ran handleGracefulExit. But cycles 374-375 were force-stopped via SQL UPDATE — that updates the database but doesn't kill Chrome popups. Zombie popups stayed alive.

**Fix:** Two parts.
1. **`handleGracefulExit` enumerates and closes scrape popup windows.** Uses `chrome.windows.getAll()` filtered by URL pattern matching the scrape sites.
2. **SW boot scan: `_cleanupOrphanScrapePopups`.** Runs on init when `cycle_phase=="idle"` — detects any popup windows that look like scrape pages and closes them. This catches popups from previous browser sessions that survived the SW's death.

**Verified:** 5-hour follow-up run had zero attribution mismatches on new data. (128 indeed-attributed-to-linkedin jobs from PRE-fix runs were re-attributed to NULL via SQL.)

**Lesson:** when force-stopping, you must enumerate ALL the resources owned by the operation, not just the database row that says it's running. Popups, alarms, and chrome.storage flags are all separate resources.

### Bug #6 — Dashboard config not connected to orchestrator

**Symptom:** User changed `enabled_sites` and `keywords` in the dashboard. Orchestrator continued using the OLD values from `auto_scrape_config.js`.

**Root cause:** The orchestrator was reading `DEFAULT_SITES` and `DEFAULT_KEYWORDS` constants from the JS module — meant as fallbacks for the FIRST cycle if backend was unavailable. The "fetch from backend" path was never wired in.

**Fix:** `runOneCycle` calls `fetchAutoScrapeConfig()` (which hits `GET /admin/auto-scrape/config`) and uses its `enabled_sites` and `keywords`. The constants in `auto_scrape_config.js` remain as fallbacks ONLY when the fetch throws.

```javascript
async function runOneCycle(...) {
  await updateAutoScrapeState({ cycle_phase: "scrape_running" });
  // ... clear flags ...
  
  const config = await fetchAutoScrapeConfig();
  console.log(`[auto_scrape] config loaded: sites=${config.enabled_sites.length}, keywords=${config.keywords.length}`);
  
  const sites = config.enabled_sites;
  const keywords = config.keywords;
  // ... use these everywhere instead of DEFAULT_SITES/DEFAULT_KEYWORDS ...
}
```

**Verified:** the 5-hour run had `[auto_scrape] config loaded: sites=3, keywords=2` in the SW console — confirming the dashboard's 2-keyword config was being honored.

**Lesson:** "fallback constants" in code that's wired up via tests usually become "live constants" because the dynamic path is never exercised. Always fetch from the canonical source on every call; use constants only as initial defaults.

---

## 26. The 5-hour validation run (2026-04-29)

The autonomous scraping milestone was validated by a 5-hour production run that exercised every fix from §25 in real conditions.

### Setup

- All four auto_scrape tables truncated; state reset to clean baseline
- Extension reloaded with the new probe URL (`www.indeed.com` instead of `ca.indeed.com`)
- Indeed Cloudflare challenge passed manually in a browser tab (Ray ID `9f412bc19b7d28dc`)
- Dashboard config: 3 sites × 2 keywords (`software engineer`, `machine learning engineer`)
- User clicked Enable; system ran for 5 hours unattended

### Results

| Metric | Value |
|---|---|
| Cycle starts | 9 |
| Cycles completed (`post_scrape_complete`) | 8 |
| Cycle in-flight when user stopped | 1 |
| `[poll] self-bootstrap` events | 1 (initial only — no parallel cycle bug) |
| `scan_in_progress` errors | 0 |
| `config_changed` aborts | 0 |
| Closed scrape popup windows during stop | 1 |
| Indeed `live` probes | 0 (Indeed never recovered) |
| Indeed `rate_limited` probes | 9 (gracefully excluded, didn't suspend the system) |
| Job attribution mismatches on new data | 0 |
| LinkedIn jobs scraped | 984 |
| Glassdoor jobs scraped | 65 |
| Indeed jobs scraped | 0 |

Every bug from §25 had its hypothesis confirmed in this run:
- **Bug #1 (config_changed):** zero aborts — flag clearing on Enable works
- **Bug #2 (scanInProgress):** zero errors — clearing only in graceful exit was correct
- **Bug #3 (Indeed 403 → captcha):** Indeed stayed `rate_limited` not `captcha` — gracefully excluded from matrix without permanent suspension
- **Bug #4 (parallel cycles):** zero `[poll] self-bootstrap` events between cycles — Revision 2 fix held
- **Bug #5 (zombie popups):** zero attribution mismatches on new data — graceful exit + boot scan worked
- **Bug #6 (config not honored):** dashboard's 2-keyword config used throughout — `[auto_scrape] config loaded: sites=3, keywords=2`

### Edge case found

When the user clicks Stop and Exit while a scan is currently in-flight, the cycle row and run-log are left in non-terminal status (`scrape_running` / `running`). The graceful exit doesn't update them before exiting.

Manual cleanup workaround:
```sql
UPDATE auto_scrape_cycles SET status='failed', error_message='Stuck after shutdown', completed_at=NOW() 
WHERE status IN ('scrape_running','postscrape_running');

UPDATE extension_run_logs SET status='failed', completed_at=NOW() 
WHERE status='running';
```

Low priority — doesn't affect data integrity, just leaves cosmetic stuck rows that the next backend lifespan startup cleanup eventually catches (the 2-hour stale-cycle sweep).

### Historical attribution cleanup

128 indeed jobs from PRE-Bug-#5-fix runs had been attributed to linkedin run-logs (zombie popup leak). One-time re-attribution via SQL:

```sql
UPDATE scraped_jobs SET scan_run_id = NULL 
WHERE website='indeed' 
  AND scan_run_id IN (
    SELECT id FROM extension_run_logs 
    WHERE search_filters->>'website' != 'indeed'
  );
```

After the fix, no new attribution mismatches occur.

---

## 27. Operations guide for auto-scrape

### How to enable/disable

1. Sign into LinkedIn, Indeed, Glassdoor in the same Chrome profile (one-time per session)
2. Open `http://localhost:5173/dashboard/auto-scrape`
3. Click **Enable Continuous Mode**
4. The system runs cycles indefinitely
5. To pause: click **Pause** — the current cycle finishes normally, no new cycle starts
6. To stop entirely: click **Stop and Exit** — confirm in dialog — current cycle aborts within ~30s

After clicking Enable: within 5 seconds, the dashboard's heartbeat dot should turn green and the cycle phase should transition to `scrape_running`. If it doesn't, check the SW DevTools console for errors.

### What auto-pause means

The system auto-pauses (sets `enabled=false`) in two situations:

1. **Three consecutive precheck failures.** If the backend is unreachable or all sites' sessions are dead for 3 cycles in a row, auto-pause fires. To recover: click **Enable** again — this resets `consecutive_precheck_failures` to 0.

2. **All eligible sites suspended.** If every enabled site has either a dead session OR `consecutive_failures >= 24` cycles, the cycle becomes a no-op. The system doesn't auto-pause in this case; it keeps cycling but with zero scans. Use the Reset Session buttons in the dashboard to recover individual sites.

### What to do when sessions die

The dashboard's Session Health widget shows per-site state. If a site shows ⚠ expired or ⚠ captcha:

1. Open the site in a normal browser tab (not the popup)
2. Sign in / solve the captcha challenge
3. Return to the dashboard and click **Reset Session** for that site
4. Next cycle's precheck will probe and (assuming you're now logged in) classify it as `live`
5. The site is back in the matrix

For Indeed specifically (Cloudflare anti-bot): if Indeed shows `rate_limited`, no action is needed — the site stays in the matrix with backoff. It'll recover automatically when Cloudflare un-flags. If it stays `rate_limited` for many cycles (24+), it's auto-suspended; manually resetting via dashboard restores it.

### Reading cycle history

Each cycle row in the dashboard shows:
- Cycle ID (monotonic)
- Started time (relative)
- Status (icon + word)
- Scans (X/Y) — how many of the configured matrix completed
- Failure reasons (if any)

Cycle status meanings:
- **post_scrape_complete** ✓ — full success
- **failed** ✗ — something stopped it; check `error_message`
- **scrape_running** / **postscrape_running** — currently in flight (should not be in history list except for the most recent cycle)

### Force-stopping a stuck cycle

If a cycle is stuck (visible in the Current Cycle widget but not progressing), force-stop:

```sql
UPDATE auto_scrape_cycles 
SET status='failed', error_message='Force-stopped', completed_at=NOW() 
WHERE status IN ('scrape_running','postscrape_running');

UPDATE extension_run_logs 
SET status='failed', completed_at=NOW() 
WHERE status='running';
```

This is incomplete cleanup — Chrome popups are NOT closed. The next time you click Enable (which writes `cycle_phase="scrape_running"` and runs `_cleanupOrphanScrapePopups`), the popups get closed. Or just close them manually before re-enabling.

### Multi-instance warning

If you've installed the JHA extension in more than one Chrome profile and both are running concurrently, the dashboard shows a warning banner: "⚠ Multiple extension instances detected (2). Disable auto-scrape in all but one Chrome profile."

The detection has a 5-minute window (instances stop counting after 5 min of no heartbeat). After resolving (disabling auto-scrape in the duplicate profile), the warning self-clears within 5 minutes.

### What can still go wrong

| Symptom | Cause | Recovery |
|---|---|---|
| Heartbeat dot stays gray | SW not heartbeating; auto-scrape probably disabled | Click Enable |
| Heartbeat dot is yellow (2-5 min) | SW recently stalled; transient issue | Wait 1 minute; if still yellow, reload extension |
| Heartbeat dot is red (>5 min) | SW dead or unreachable | Reload extension; verify it's not crashed in chrome://extensions/ |
| Cycle status stays `scrape_running` for hours | Stuck cycle (matrix loop blocked) | Force-stop SQL above + reload extension |
| Indeed never goes live | Cloudflare anti-bot block | VPN to US IP, or wait hours |
| Configuration won't save | Validation failure | Check the math display: scans/cycle ≤ 30 hard cap |
| `Cycle aborted: config_changed` | Bug #1 recurred (shouldn't anymore) | Click Pause then Enable; flag will clear |
| Jobs attributed to wrong site | Bug #5 recurred (shouldn't anymore) | Check zombie popup cleanup ran on last shutdown |

### Critical pitfalls for operators

1. **`docker compose up --build` does NOT rebuild the backend image.** Use `docker compose build backend && docker compose up -d backend`. Same for frontend. Extension changes require manual reload at `chrome://extensions/`.

2. **`PUT /admin/auto-scrape/state` replaces the WHOLE state JSONB.** If you're scripting state changes, always GET → merge → PUT. The SW does this automatically; PowerShell scripts must do it manually.

3. **`POST /enable` resets counters.** If you set `consecutive_precheck_failures=2` to test auto-pause, then call `/enable`, the counter goes back to 0. Set the counter AFTER enabling.

4. **`chrome.alarms.clearAll()` in SW DevTools is destructive.** It kills `jha_poll` (the state mirror alarm). Recovery: reload the extension at `chrome://extensions/`.

5. **`chrome.storage.local.clear()` in SW DevTools is destructive.** It wipes `backendUrl` and `authToken`. Recovery: reload extension OR manually set them back:
   ```javascript
   await chrome.storage.local.set({ backendUrl: "http://localhost:8000", authToken: "dev-token" });
   ```

6. **`cycle_phase` must transition to `scrape_running` within 50ms of `runOneCycle` entry.** If precheck takes 30s and `cycle_phase` is written after, parallel cycle bug recurs (Bug #4).

7. **`POST /enable` on a running cycle does nothing harmful.** It just resets counters. The cycle continues normally.

### Standard diagnostic queries

```powershell
$headers = @{ Authorization = "Bearer dev-token"; "Content-Type" = "application/json" }

# Current state
(Invoke-RestMethod -Headers $headers http://localhost:8000/admin/auto-scrape/state).state | 
  Select-Object enabled, cycle_phase, exit_requested, config_change_pending, consecutive_precheck_failures

# Concurrent cycles (must always be 0 or 1)
docker compose exec postgres psql -U jha -d jha -c "
  SELECT cycle_id, status FROM auto_scrape_cycles WHERE status IN ('scrape_running','postscrape_running');"

# Cycle outcomes summary (last 24h)
docker compose exec postgres psql -U jha -d jha -c "
  SELECT status, COUNT(*) FROM auto_scrape_cycles 
  WHERE started_at > NOW() - INTERVAL '24 hours' GROUP BY status;"

# Site session health
docker compose exec postgres psql -U jha -d jha -c "
  SELECT site, last_probe_status, consecutive_failures, backoff_multiplier FROM site_session_states ORDER BY site;"

# Job ingestion summary
docker compose exec postgres psql -U jha -d jha -c "
  SELECT website, COUNT(*) FROM scraped_jobs GROUP BY website ORDER BY website;"

# Attribution validation (must show no mismatches)
docker compose exec postgres psql -U jha -d jha -c "
  SELECT j.website AS job_site, l.search_filters->>'website' AS log_site, COUNT(*)
  FROM scraped_jobs j JOIN extension_run_logs l ON j.scan_run_id = l.id
  WHERE j.created_at > NOW() - INTERVAL '24 hours'
  GROUP BY j.website, l.search_filters->>'website';"
```

For SW-side diagnostics, open the Service Worker DevTools at `chrome://extensions/` → JHA → "Service worker" link, then in console:

```javascript
// All chrome.storage.local state
await chrome.storage.local.get(null)

// All registered alarms
await chrome.alarms.getAll()
// jha_poll must exist (state mirror); auto_scrape_next_cycle exists during cycle scheduling

// Verify code deployment
self.runOneCycle.toString().includes("max_consecutive_dead_session_cycles")
self.probeSiteSession.toString().includes("rate_limited")

// Force-fire next-cycle alarm (manual debug)
await chrome.alarms.create("auto_scrape_next_cycle", { when: Date.now() + 1000 });
```

---

## 28. Per-source scrape tables — the schema redesign (May 2026)

In late April 2026, after the auto-scrape system was stable, the project began a major schema redesign that's now (May 2026) shipped through migration 027. This section captures what changed, why, and what readers of the codebase need to know to navigate the new layout.

### 28.1 What changed and why

The legacy `scraped_jobs` table was a single wide table holding rows from all three sites. Every column was an attempt at a least-common-denominator schema — a compromise that worked for the early product but didn't scale as the project grew:

- LinkedIn's `applyMethod.$type`, Indeed's dual mosaic+graphql payloads, and Glassdoor's nested `jsonld` / `jobview_job` / `header` / `map` sub-trees all had to flatten into the same columns
- Site-specific fields (e.g., LinkedIn's `expireAt`, Indeed's `pay_period_adjusted_pay`) had no clean home
- The `source_raw JSONB` column became a dumping ground for fields that didn't fit elsewhere
- Schema drift was unbounded: every time a site added a field, the team had to decide whether to add a column to `scraped_jobs` (impacting all sites) or stuff it into JSONB

The redesign decision: split `scraped_jobs` into three per-source tables that each match their site's natural field shape. The merged-jobs concept (a single canonical view across sources) becomes a downstream concern handled by dedup/matching, not the ingest layer.

### 28.2 The three new tables

| Table | Columns | Notable site-specific elements |
|---|---|---|
| `linkedin_jobs` | 51 | `applyMethod.$type` flattened to `apply_method_type`; `companyDetails` resolved via URN lookup against `included[]` |
| `indeed_jobs` | 61 | Dual surfaces: `mosaic_*` columns from search results page + `graphql_*` columns from job-detail GraphQL fetch; both can be NULL but at least one must be populated (CHECK constraint) |
| `glassdoor_jobs` | 69 | Sub-tree prefixes: `header_*`, `map_*`, `jobview_job_*`, `jsonld_*` — preserves the source structure verbatim |

All three share a five-column common prefix (defined as CC-3, CC-7, CC-8 in `step1-schema-design.md`):
- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `scan_run_id UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT`
- `job_url VARCHAR(2048) NOT NULL UNIQUE` — the conflict-resolution key
- `scrape_time TIMESTAMPTZ NOT NULL DEFAULT NOW()` — server-side, never client-supplied
- `source_raw JSONB` (dev only — dropped in production migration)

Plus, since migration 028, a sixth common column:
- `matched BOOLEAN NOT NULL DEFAULT FALSE` — see §30

### 28.3 Cross-cutting decisions (CCs)

`step1-schema-design.md` v12 captures 12 cross-cutting decisions that apply to all three tables. Worth memorizing:

| CC | Rule | Why it matters |
|---|---|---|
| CC-1 | Append-only by convention (with two carve-outs: `matched` flips false→true once; auto-expiration deletes by `scrape_time + shelf_life`) | Anything else that mutates per-source rows is a bug |
| CC-2 | UUID primary keys via `gen_random_uuid()` | Matches project-wide pattern; no monotonic-order requirement |
| CC-3 | `scan_run_id` FK with `ON DELETE RESTRICT` | Run-logs become permanent records; cleanup via DELETE blocked |
| CC-4 | Dev/test keeps `source_raw JSONB`; production drops it | Safety net during dev; storage savings in production |
| CC-5 | No `search_filters` column on per-source tables | Filters live on `extension_run_logs.search_filters`; join through `scan_run_id` |
| CC-6 | Flatten LinkedIn's `data + included[]` at ingest | Voyager's URN-resolved entities (Company, Title, EmploymentStatus, WorkplaceType) become top-level columns |
| CC-7 | `job_url UNIQUE` per table; `ON CONFLICT (job_url) DO NOTHING RETURNING id` | Re-scrape returns existing row's id with `already_exists: true` semantics |
| CC-8 | `scrape_time TIMESTAMPTZ DEFAULT NOW()` | Server-side, never client-supplied; no `updated_at` (append-only) |
| CC-9 | Site-stable IDs as `VARCHAR(32)` not BIGINT | LinkedIn/Indeed/Glassdoor IDs differ in format; defensive against changes |
| CC-10 | No salary normalization at ingest | Per-source tables stay faithful to source vocab (`YEARLY` vs `YEAR` vs `ANNUAL`); normalize at merge |
| CC-11 | Nested objects stay JSONB on per-source tables | `postal_address`, `pay_period_adjusted_pay`, etc. — flattening is a merge concern |
| CC-12 | Minimum index set: PK (auto), `job_url UNIQUE` (auto), explicit FK index on `scan_run_id` | No speculative indexes; PostgreSQL doesn't auto-index FK columns |

### 28.4 The migration history

Migrations on the per-source tables happened in three steps:

| Migration | What it did | Status |
|---|---|---|
| `025_per_source_scrape_tables.py` | Created all three tables via raw SQL `CREATE TABLE` statements | Shipped |
| `026_cycle5_drops.py` | Dropped fields that proved unnecessary in dev (e.g., Indeed `apply_count`) | Shipped |
| `027_schema_reconciliation.py` | Reconciled remaining drift between design docs and live schema | Shipped |
| `028_add_matched_column.py` | Added `matched BOOLEAN` to all three tables | Shipped |
| `029_system_settings.py` | Created `system_settings` k/v table seeded with `shelf_life_days=7` | Shipped |

**Important for code readers:** the `025_per_source_scrape_tables.py` source file still embeds the original `CREATE TABLE` text including columns that 026/027 later dropped. Don't infer "current columns" from 025 alone. The effective schema after 027 is captured in:
- `backend/routers/jobs.py` — `LINKEDIN_COLS`, `INDEED_COLS`, `GLASSDOOR_COLS` constants
- `step1-schema-design.md` v12 — kept synchronized with reality
- `information_schema` introspection on a live DB

### 28.5 Ingest path: still unified at `POST /jobs/ingest`

Despite splitting into three tables, ingest stays unified. `backend/routers/jobs.py` handles `POST /jobs/ingest` by:
1. Reading `body.website` from the payload
2. Branching to per-site insert via raw SQL `INSERT INTO {table} ... ON CONFLICT (job_url) DO NOTHING RETURNING id`
3. Returning `{id, already_exists, content_duplicate, skip_reason}` — the unified response

The decision to keep the unified endpoint (not split into `/scrape/{site}/ingest`) was deliberate. Reasoning recorded in `matched-mechanism-codebase-changes-corrected.md` §13: splitting would duplicate logic three times, force extension-side changes (extension already targets `/jobs/ingest`), and provide no functional benefit since the per-site write path is internal to `jobs.py`.

The extension code in `extension/background/ingest.js` is unchanged from the legacy single-table era. The same payload shape (with `website`, `source_raw`, `scan_run_id`) works because the backend now routes per-site internally.

### 28.6 What's NOT in the per-source tables

These remain on the legacy `scraped_jobs` table:
- `skip_reason` — dedup pipeline output
- `dedup_original_job_id` — duplicate-pointing FK
- `matched_at` — JD-extraction/matching pipeline timestamp (different from `matched` in §30)
- `embedding` — vector embedding column for cosine dedup

The legacy `scraped_jobs` table is still live and still gets ingest writes during the transition. It will be retired once the dedup/matching pipelines are wired into the new merged-jobs flow. Until then, both tables coexist.

### 28.7 Reading the schema docs

Source-of-truth docs for the new schema:

| Doc | What it covers |
|---|---|
| `step1-schema-design.md` v12 | All 12 CCs, common columns, per-source column lists with site-source mapping, CREATE TABLE SQL, migration sequencing, Known Limitations |
| `scrape-fields-master.md` | Field-by-field analysis: source field name → kept/dropped → column name in target table → rationale |
| `step1-auto-expiration.md` | Auto-expiration mechanism (§29) |
| `matched-mechanism-codebase-changes-corrected.md` | The matched mechanism implementation plan, six rounds of conflict scans (§30, §31) |

When implementing anything that touches per-source tables, start with `step1-schema-design.md` for the contract, then `scrape-fields-master.md` for the per-field details.

---

## 29. Auto-expiration mechanism

The per-source tables are append-only by convention, but they can't grow unbounded. Auto-expiration is the mechanism that keeps total table size bounded.

### 29.1 The mechanism in one line

A row is deleted when `NOW() > scrape_time + shelf_life`. `shelf_life` is a single global setting stored in `system_settings.shelf_life_days` (default 7 days). Same value for all three platforms — there's no operational reason for LinkedIn jobs to live longer than Indeed jobs.

### 29.2 Storage: `system_settings` k/v table

Migration 029 created a small key-value table:

```sql
CREATE TABLE system_settings (
    key VARCHAR(64) PRIMARY KEY,
    value VARCHAR(256) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO system_settings (key, value) VALUES ('shelf_life_days', '7');
```

Future settings (other tunable knobs) can reuse this table with new keys. The accessor in `backend/core/system_settings.py` provides:

- `get_setting(db, key)` — generic accessor
- `get_shelf_life_days(db)` — typed convenience wrapper that returns 7 on missing/malformed values (defensive default, never raises)

The defensive default matters: if `system_settings.value` ever gets corrupted (manual edit to 'banana'), auto-expiration continues working with the safe default rather than crashing.

### 29.3 The `run_auto_expiration` helper

`backend/auto_scrape/auto_expiration.py` is a single function:

```python
async def run_auto_expiration(db: AsyncSession) -> dict:
    days = await get_shelf_life_days(db)
    deleted = {}
    for table in ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs"):
        result = await db.execute(
            text(f"DELETE FROM {table} "
                 f"WHERE scrape_time < NOW() - make_interval(days => :d)"),
            {"d": days},
        )
        deleted[table] = result.rowcount
    return {"deleted_per_table": deleted, "shelf_life_days": days}
```

Three points worth noting:

1. **Parameterized via `make_interval(days => :d)`.** Not string interpolation. The `shelf_life_days` value is user-editable from the frontend, so SQL injection would be a real risk if interpolated naively. `make_interval(days => :d)` accepts an integer parameter, type-checked at the DB layer.
2. **Deletes regardless of `matched` value.** Even un-matched rows (orphaned by a matching crash) get aged out at shelf_life. Documented as Known Limitation §15.2 in `step1-schema-design.md`. Recovery from a matching crash is manual (`UPDATE ... SET matched=FALSE`) — auto-expiration doesn't try to be clever.
3. **All three DELETEs in caller's transaction.** The function doesn't begin a new transaction; the post-scrape orchestrator wraps the call in `async with db.begin():` so all three DELETEs commit atomically.

### 29.4 When does auto-expiration run?

Per-cycle hook in the post-scrape orchestrator. After every scrape cycle completes, the orchestrator runs auto-expiration BEFORE the matching-claim phase. Sequence (per Issue 2.6 Solution A in the codebase-changes plan):

```
status: scrape_complete (extension orchestrator finished matrix loop)
   ↓
status: postscrape_running
   ├─ Phase 1 (NEW): auto-expiration
   │     ├─ Reads shelf_life_days from system_settings
   │     ├─ DELETEs from all three per-source tables in one transaction
   │     └─ Writes results to cycle.cleanup_results JSONB
   ├─ Phase 2: matched-claim (§30)
   └─ Phase 3: dedup → matching → match_results (still stubbed)
```

**Why per-cycle hook, not hourly cron.** Earlier design considered an hourly APScheduler job. The per-cycle hook was chosen because:
- It runs only when there's actual scrape activity — no deletion when system is paused (defensive: nothing surprising happens behind the user's back)
- It coordinates naturally with cycle lifecycle — no race with active scrapes
- It piggybacks on existing post-scrape orchestrator infrastructure (heartbeat, cleanup_results JSONB) — no separate cron infra to maintain

### 29.5 What's stored in `cycle.cleanup_results`

After Phase 1 runs, the cycle row's `cleanup_results JSONB` column carries:

```json
{
  "deleted_per_table": {
    "linkedin_jobs": 23,
    "indeed_jobs": 8,
    "glassdoor_jobs": 11
  },
  "shelf_life_days": 7
}
```

The dashboard reads this for observability: how many rows aged out per cycle, what shelf_life was active when. Useful when debugging "why did this job disappear?"

### 29.6 Known limitations

Documented in `step1-schema-design.md` §15:

- **§15.3 No per-row TTL extension.** One global `shelf_life`. There's no mechanism to keep a specific job in the system longer (e.g., "I want to apply to this one next month"). The future `pre_apply` table will record durable user interest separately from per-source row lifetime.
- **Auto-expiration deletes un-matched rows too.** A row scraped but never matched (matching pipeline crashed before claim-and-flag) gets deleted at shelf_life. Acceptable per the design philosophy (re-processing has low value vs. high new-job inflow). Recovery is manual.
- **Changing shelf_life takes effect on next cycle.** No migration; setting is read on each cleanup run. Lowering 7→3 days deletes a batch of rows on the first cycle after the change.

### 29.7 Verification

Smoke test `backend/smoke_test_auto_expiration.py` validates the helper:
1. Insert one row with `scrape_time = NOW() - 30 days` (well past 7-day default)
2. Insert one row with `scrape_time = NOW()` (fresh)
3. Run `run_auto_expiration`
4. Verify old row deleted, fresh row preserved
5. Verify result dict has the expected shape
6. Cleanup test rows

Passes cleanly as of 2026-05-06 implementation.

---

## 30. The `matched` mechanism — claim-and-flag for matching

After the per-source schema landed, the next gap was: how does the matching pipeline know which rows it has and hasn't processed yet? The answer is the `matched` mechanism — a per-row boolean flag with strict semantics for how it transitions.

### 30.1 The mechanism in one paragraph

Every row in a per-source table has a `matched BOOLEAN` column. New rows get `matched=false` at INSERT. After each cycle, the post-scrape orchestrator runs `UPDATE <table> SET matched=TRUE WHERE matched=FALSE RETURNING *` against all three tables in one transaction. The returned rows are the "claim batch" for this cycle's matching work. Re-scrapes of the same `job_url` silently no-op per CC-7 (do not reset `matched`).

### 30.2 Why this design (vs alternatives)

The mechanism was chosen after evaluating three options against the constraint "existing design wins" (CC-1 append-only, CC-7 silent re-scrape semantics). Options compared in `matched-mechanism-review.md`:

| Solution | Where `matched` lives | CC-1 preserved | CC-7 preserved |
|---|---|---|---|
| A | Column on per-source tables | ❌ amended | ❌ broken (re-scrapes don't trigger re-match) |
| B | Column on durable merged_jobs | ✅ | ⚠ requires upsert design |
| C | Separate `matching_state` table | ✅ | ✅ |

Initial recommendation was Solution C (separate table). The user pushed back: Solution A is conceptually simpler, and CC-1 was always "convention not enforcement," so amending it for one carve-out is acceptable. CC-7's re-scrape limitation is acceptable too — re-evaluating already-matched jobs has low expected value when hundreds of new jobs come in daily and only ~5% match.

CC-1 was therefore amended:

> **CC-1 (amended):** Append-only by convention, with two carve-outs: (a) the `matched` column transitions `false → true` once per row (never back to false), written by the post-scrape orchestrator; (b) the auto-expiration job DELETEs rows by `scrape_time + shelf_life`. No other UPDATE or DELETE.

### 30.3 The atomic claim-and-flag pattern

Documented as `step1-schema-design.md` §10.X. The canonical SQL:

```sql
-- Within a single transaction, run for each per-source table:
UPDATE linkedin_jobs SET matched = TRUE WHERE matched = FALSE RETURNING *;
UPDATE indeed_jobs SET matched = TRUE WHERE matched = FALSE RETURNING *;
UPDATE glassdoor_jobs SET matched = TRUE WHERE matched = FALSE RETURNING *;
```

**Why UPDATE-RETURNING and not SELECT-then-UPDATE.** The two-statement pattern has a race: a row inserted between the SELECT and the UPDATE could be claimed (matched=true) but not present in the SELECT result, so it never gets matched but also never gets retried. UPDATE-RETURNING is atomic — the row set returned is exactly the row set flagged. No race window.

**Why before matching, not after.** If the orchestrator crashed mid-matching with the flag flipped after, partially-processed rows would be in inconsistent state (some flagged, some not). Setting the flag first means a crash leaves rows flagged-but-unmatched — a known limitation per Known Limitations §15.2 and accepted per the user's philosophy (re-processing low value).

**Why one transaction across three tables.** If linkedin's UPDATE succeeds but indeed's fails (lock timeout, network hiccup), without a transaction wrap you have linkedin rows flagged matched=true with no downstream processing, and indeed rows still claimable next cycle. The transaction wrap rolls back all three together; next cycle re-claims everything cleanly.

### 30.4 The `claim_unmatched_rows` helper

`backend/auto_scrape/matching_claim.py`:

```python
async def claim_unmatched_rows(db: AsyncSession) -> dict[str, list[dict]]:
    claimed = {"linkedin": [], "indeed": [], "glassdoor": []}
    table_for_site = {
        "linkedin": "linkedin_jobs",
        "indeed": "indeed_jobs",
        "glassdoor": "glassdoor_jobs",
    }
    for site, table in table_for_site.items():
        result = await db.execute(
            text(f"UPDATE {table} SET matched = TRUE "
                 f"WHERE matched = FALSE "
                 f"RETURNING id, job_url, scan_run_id, scrape_time")
        )
        claimed[site] = [dict(r._mapping) for r in result]
    return claimed
```

The helper does NOT begin a transaction — the caller (post-scrape orchestrator) wraps it in `async with db.begin():` to get the three-table atomicity.

Returns the actual rows (not just counts). Currently the orchestrator uses only the counts (writes `claim_summary` to `cycle.match_results`), but the row payload is ready for when dedup/matching wire in — they'll consume the rows as their input.

### 30.5 Migration 028 and the production grandfather UPDATE

When migration 028 ran, every existing row in `linkedin_jobs`, `indeed_jobs`, and `glassdoor_jobs` got `matched=false` by default. On a fresh dev DB this is fine (tables are mostly empty). In production, the existing tables have thousands of rows, and the next cycle's claim batch would include all of them in one shot — potentially overwhelming the matching pipeline (which is currently a stub anyway, so it would just claim and discard the rows, but the precedent is bad).

The fix is a one-time grandfather UPDATE run AFTER migration 028 on production:

```sql
UPDATE linkedin_jobs SET matched = TRUE;
UPDATE indeed_jobs SET matched = TRUE;
UPDATE glassdoor_jobs SET matched = TRUE;
```

This treats all pre-mechanism rows as "already handled by the legacy path" (they got dedup/matching via the old `scraped_jobs.matched_at` flow). Future scrapes default to `matched=false` and flow through the new mechanism cleanly.

Recorded in the ship order as Step 3 (production-only, no commit). Skipped on dev.

### 30.6 Known limitations

Three documented in `step1-schema-design.md` §15:

- **§15.1 Re-scrapes don't trigger re-matching.** Per CC-7, re-scrape of a matched=true row no-ops. If the user's resume changes, or the matching algorithm gets upgraded, previously-matched jobs are NOT re-evaluated. Workaround if ever needed: manual `UPDATE linkedin_jobs SET matched=FALSE WHERE job_url='...'` then trigger a cycle.
- **§15.2 Crashed matching runs leave rows permanently flagged.** Setting matched=true BEFORE matching means a crash leaves rows in "claimed but not actually matched" state. Recovery is manual.
- **§15.4 Naming overlap with `scraped_jobs.matched_at`.** Different concepts: legacy `matched_at` is matching-pipeline-completion timestamp; new `matched` is orchestrator-claim flag. Don't conflate. Both will coexist until `scraped_jobs` is retired.

### 30.7 Verification

Smoke test `backend/smoke_test_matched_claim.py` has three tests:

1. **`test_basic_claim`** — inserts one row per table (with `mosaic_present=True` for indeed_jobs to satisfy its CHECK constraint), runs the helper, verifies the test rows came back claimed and `matched=TRUE` in the DB. Cleans up after.
2. **`test_idempotent_claim_scoped`** — verifies the SQL pattern is idempotent when scoped to test rows. Does NOT call the global helper twice (that would mass-mutate production data on shared/staging DBs). Instead runs scoped UPDATEs against test-only rows and verifies the second call returns zero affected rows.
3. **`test_atomic_three_table_claim`** — documented as a manual fault-injection test (kill the orchestrator process between table 1 and table 2 UPDATEs; verify rollback). Currently SKIP'd in automation.

All passing as of 2026-05-06.

The `_TABLE_EXTRAS` dict in the smoke test is worth understanding:

```python
_TABLE_EXTRAS = {
    "linkedin_jobs": {},
    "indeed_jobs": {"mosaic_present": True},  # satisfies CHECK constraint
    "glassdoor_jobs": {},
}
```

Without this, INSERTs into `indeed_jobs` would violate `indeed_jobs_surface_present CHECK (mosaic_present OR graphql_present)`. The dict drives test-row construction defensively. A `_column_exists` helper (also in the smoke test) introspects `information_schema` (scoped to `table_schema='public'`) at test start and fails fast with a clear message on schema drift.

---

## 31. Iterative conflict-scan workflow (six rounds)

The implementation of the `matched` mechanism is interesting not just for what it does but for HOW it got built. The plan went through **six rounds of conflict-scanning against the live codebase**, each catching real bugs that pure-design reading missed. Documenting the pattern is worthwhile.

### 31.1 What "conflict scan" means

After each major plan revision, the user (or a coding assistant tasked with verification) would walk through the plan against the actual repository state and produce a report listing mismatches: stale assumptions, wrong function signatures, missing files, broken assertions, etc. The plan author would then fold corrections into the source plan and another scan would happen.

The scans were progressively focused: v1 was broad baseline checking; v6 was hunting for residual drift after five rounds of corrections.

### 31.2 What each scan caught

| Scan | Bugs found | Examples |
|---|---|---|
| v1 | 13 baseline mismatches | Plan assumed migrations 025+ hadn't shipped (they had); orchestrator was assumed no-op stub (had real skeleton); ingest was assumed needing per-site routers (was already unified) |
| v2 | 8 hard/soft conflicts | `match_results == {}` smoke test assertion would break; indeed_jobs CHECK constraint missed in test inserts; orchestrator pseudocode signatures wrong; idempotent test mass-mutated production data; `scraped_jobs.matched_at` naming overlap; `DROP COLUMN` without `IF EXISTS`; `backend/scripts/` directory absent; DDL drift between 025 and post-027 |
| v3 | 3 critical fixes | Docker import path bug (`python scripts/...` doesn't add `/app` to `sys.path` — needs `python -m scripts.module`); orchestrator preamble missing (config + llm derivation, 3-arg matching call, exact failure message); Phase 4c assertion needed forward-compat for future dedup/matching keys |
| v4 | 2 hard async/concurrency bugs | `read_config_file()` is async — plan had it synchronous; `finally:` block needs `cancel()` THEN `await hb_task` with `CancelledError` handling — plan had bare `cancel()` |
| v5 | 2 string/structure bugs | Wrong heartbeat log message wording; `hb_task` creation belongs INSIDE `try:` with `if hb_task is not None:` finally guard, not before try |
| **v6** | **0 (converged)** + 1 optional enhancement | All previous corrections verified; one optional improvement (extend Phase 4c smoke test to also assert `cleanup_results` shape) |

Total: **28 issues** found across six scans. About half were critical; half were medium-or-low.

### 31.3 The pattern that emerged

Each scan caught fewer issues than the last (13 → 8 → 3 → 2 → 2 → 0), and the bugs got progressively narrower. The trajectory is a real signal:

- **v1 caught architectural assumptions.** The plan was written against an outdated mental model of the codebase. Reality had moved on.
- **v2-v3 caught ergonomic surface area.** Things like missing `IF EXISTS`, incorrect Docker invocations, smoke test assertion drift.
- **v4-v5 caught subtle concurrency/string contracts.** `await` vs sync calls, exact log message formats, structural placement of `try`/`finally`.
- **v6 confirmed convergence.** No new bugs; only an optional enhancement.

The lesson worth carrying forward: **plans written from design docs inherit the docs' simplifications and assumptions.** Verifying against actual function signatures, file paths, and test assertions is the cheap step that catches the highest-leverage errors. Specifically:

- Migration revision numbers
- Function signatures used in the plan
- Constraint names mentioned
- File paths the plan creates
- Smoke test assertions the plan changes

This isn't "verify everything is correct"; it's "verify the bridges between plan and code." Small surface to check, high-leverage errors caught.

### 31.4 Implications for future workstreams

For the next workstream (wiring dedup/matching into Phase 3), the cheapest path is probably: **open the actual `run_post_scrape_phase` function, copy it verbatim into the plan, and annotate inline with `# NEW` and `# UNCHANGED` markers.** That eliminates the entire class of "snippet vs real code drift" bugs.

The pattern of progressive convergence (13 → 0 in six scans) is acceptable for one-off plans but expensive in aggregate. Reducing the round count to 1-2 would be a real productivity gain.

### 31.5 The final converged plan

`matched-mechanism-codebase-changes-corrected.md` (1188 lines) is the final state. It records:

- The original plan
- All six rounds of corrections folded in
- Section-by-section "Existing-code lines that MUST be preserved" tables
- Forward-compat smoke test assertion patterns
- The exact wording of preserved log messages
- A "What scan v[N] added" trail for traceability

Anyone reading the plan today gets the converged version. The conflict-scan files (`matched-mechanism-codebase-conflicts.md` v1-v6) are historical artifacts — useful for understanding HOW the plan evolved but not needed for implementation.

---

## 32. Post-scrape orchestrator integration (Step 7)

Step 7 of the ship order is the centerpiece: modifying `backend/auto_scrape/post_scrape_orchestrator.py` to wire in auto-expiration and matched-claim. This section captures what the change looks like in detail and the specific care taken to avoid regressing the existing function.

### 32.1 What the orchestrator looked like before Step 7

`run_post_scrape_phase` did the following (still does — Step 7 is purely additive):

```python
async def run_post_scrape_phase(cycle_id):
    post_scrape_started_at = datetime.now(timezone.utc)
    hb_task = None
    try:
        hb_task = asyncio.create_task(_heartbeat_loop(cycle_id))
        _active_heartbeat_tasks[cycle_id] = hb_task
        
        config_data = await read_config_file()
        # ... build SearchConfigRead, derive llm_enabled, has_openai_key ...
        
        dedup_task_id = await _run_dedup_for_cycle(cycle_id)
        await _update_cycle(cycle_id, dedup_task_id=dedup_task_id)
        
        await _run_matching_for_cycle(cycle_id, llm_enabled, has_openai_key)
        
        match_results = await _compute_match_results(post_scrape_started_at)
        await _update_cycle(cycle_id, match_results=match_results)
        
        await _update_cycle(
            cycle_id,
            status="post_scrape_complete",
            completed_at=datetime.now(timezone.utc),
        )
    except Exception as e:
        logger.exception("Post-scrape cycle %s: failed", cycle_id)
        await _update_cycle(
            cycle_id,
            status="failed",
            error_message=f"Post-scrape phase failed: {type(e).__name__}: {e}",
            completed_at=datetime.now(timezone.utc),
        )
    finally:
        if hb_task is not None:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception(
                    "Post-scrape: heartbeat task for %s raised on cancel",
                    cycle_id,
                )
        _active_heartbeat_tasks.pop(cycle_id, None)
```

Both `_run_dedup_for_cycle` and `_run_matching_for_cycle` are stubs that return `None` / log and return. `_compute_match_results` returns `{}`.

### 32.2 What Step 7 changed

The change is a TARGETED INSERTION of two new phases at the top of the `try:` block, plus modification of the single `_update_cycle(match_results=...)` call to merge `claim_summary`. **Nothing else changes.**

```python
async def run_post_scrape_phase(cycle_id):
    post_scrape_started_at = datetime.now(timezone.utc)
    hb_task = None
    try:
        hb_task = asyncio.create_task(_heartbeat_loop(cycle_id))
        _active_heartbeat_tasks[cycle_id] = hb_task
        
        config_data = await read_config_file()
        # ... build SearchConfigRead, derive llm_enabled, has_openai_key ...
        
        # === NEW: Phase 1 — auto-expiration ===
        async with AsyncSessionLocal() as db:
            async with db.begin():
                expiration_results = await run_auto_expiration(db)
        await _update_cycle(cycle_id, cleanup_results=expiration_results)
        
        # === NEW: Phase 2 — matched-claim ===
        async with AsyncSessionLocal() as db:
            async with db.begin():
                claim_results = await claim_unmatched_rows(db)
        claim_summary = {site: len(rows) for site, rows in claim_results.items()}
        # claim_summary merged into match_results below.
        # claim_results (the actual rows) is logged then discarded;
        # Phase 3 will consume it when dedup/matching wire in.
        
        # === EXISTING (unchanged): dedup → match → compute ===
        dedup_task_id = await _run_dedup_for_cycle(cycle_id)
        await _update_cycle(cycle_id, dedup_task_id=dedup_task_id)
        
        await _run_matching_for_cycle(cycle_id, llm_enabled, has_openai_key)
        
        match_results = await _compute_match_results(post_scrape_started_at)
        
        # === MODIFIED: merge claim_summary into match_results ===
        await _update_cycle(cycle_id, match_results={
            "claim_summary": claim_summary,
            **match_results,  # empty dict from stub today
        })
        
        # === EXISTING (unchanged): final transition ===
        await _update_cycle(
            cycle_id,
            status="post_scrape_complete",
            completed_at=datetime.now(timezone.utc),
        )
    except Exception as e:
        # ... unchanged ...
    finally:
        # ... unchanged ...
```

The `except` and `finally` blocks are completely unchanged.

### 32.3 The "Existing-code lines that MUST be preserved" table

Before Step 7 went in, the plan listed every line in the existing function that an inattentive edit might drop. Each entry on this list was an actual bug an earlier draft of the plan had — the conflict-scan iterations forced each into the plan one at a time:

| Line / element | Why it matters |
|---|---|
| `hb_task = None` before `try:` | Required for `if hb_task is not None:` guard in finally |
| `hb_task = asyncio.create_task(...)` INSIDE `try:` | NOT before try; preserves crash-safety |
| `_active_heartbeat_tasks[cycle_id] = hb_task` | Module-level dict, used by cleanup elsewhere |
| `_active_heartbeat_tasks.pop(cycle_id, None)` in finally | Symmetric removal, prevents dict growth |
| `await read_config_file()` — async function | Calling without await returns a coroutine object |
| 3-arg `_run_matching_for_cycle(cycle_id, llm_enabled, has_openai_key)` | Single-arg call would TypeError |
| `_compute_match_results(post_scrape_started_at)` — datetime arg | Not cycle_id |
| `_update_cycle(...)` for status writes (no `_update_cycle_status` helper) | Wrong helper name = AttributeError |
| `_update_cycle(cycle_id, dedup_task_id=...)` line | Records dedup task UUID |
| `logger.exception("Post-scrape cycle %s: failed", cycle_id)` | Exact format; no `e` bound |
| `error_message=f"Post-scrape phase failed: {type(e).__name__}: {e}"` | Downstream alerts may match this string |
| `if hb_task is not None:` finally guard | Without guard: AttributeError masks original exception |
| Heartbeat log: `logger.exception("Post-scrape: heartbeat task for %s raised on cancel", cycle_id)` | EXACT wording in real code |
| Cancel-then-await pattern in finally | Bare `cancel()` leaks the heartbeat task |

The implementer's job is described as "TARGETED INSERTION, not function rewrite" — open the file, find the spots between (config/llm derivation) and (`_run_dedup_for_cycle` call), insert the two new phases, modify the single `_update_cycle(match_results=...)` call. Everything else stays.

### 32.4 The smoke test couple

**Critical:** the orchestrator change MUST commit together with `backend/smoke_test_auto_scrape.py` Phase 4c update. Reason: the existing Phase 4c assertion was `assert cycle["match_results"] == {}`. After Step 7, `match_results` contains `{"claim_summary": {...}}`. Shipping the orchestrator change without the smoke test update breaks CI.

The Phase 4c assertion was rewritten as forward-compatible (per scan v3 §3 + scan v6 §3.6):

```python
mr = cycle["match_results"] or {}
if "claim_summary" in mr:
    cs = mr["claim_summary"]
    assert isinstance(cs, dict)
    assert set(cs.keys()) == {"linkedin", "indeed", "glassdoor"}
    for site, count in cs.items():
        assert isinstance(count, int) and count >= 0
# Other keys are allowed (will populate when dedup/matching wire in).

# Also validate cleanup_results shape:
cr = cycle.get("cleanup_results") or {}
if cr:
    assert "deleted_per_table" in cr
    assert "shelf_life_days" in cr
    assert isinstance(cr["deleted_per_table"], dict)
    assert isinstance(cr["shelf_life_days"], int)
```

The forward-compat philosophy: validate structure if present, tolerate empty (e.g., dev DB with no aged rows produces `deleted_per_table = {linkedin_jobs: 0, indeed_jobs: 0, glassdoor_jobs: 0}` not absence). Future dedup/matching will add keys to `match_results` — the assertion permits that.

### 32.5 Implementation deviations worth recording

When Step 7 actually shipped (commit 25f03d3), one adaptation came from the implementation environment:

**AsyncSession transaction pattern.** The plan showed `async with db.begin():` wrapping the helper calls. In practice, the implementer found that AsyncSessions in this codebase enter a transaction implicitly, so `db.begin()` would have raised "transaction already begun." Adapted to `await db.commit()` after the helper call, which preserves the three-table atomicity (all UPDATEs run before any commit) without nested transaction errors.

This is a project-pattern note: in this codebase, `db.begin()` is for nesting savepoints, not starting transactions. New helpers that need transaction boundaries should use `await db.commit()` directly.

### 32.6 What's logged vs what's persisted

One subtle point: `logger.info(..., match_results)` after `_compute_match_results` logs the stub return value `{}`, NOT the merged payload that contains `claim_summary`. The merged payload is what `_update_cycle(match_results=...)` writes to the DB.

Acceptable under the "minimal edit" rule — changing the log call would be additional surface area. Worth a comment near that log line for future readers, since someone might assume the logged value matches the persisted value:

```python
# Note: this logs _compute_match_results' return value (currently {} from
# stub), NOT the merged payload that includes claim_summary. The merged
# payload is what's persisted via _update_cycle(match_results=...) above.
```

### 32.7 Verification at Step 7

After Step 7 lands, three smoke tests must all pass:

```bash
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_matched_claim.py
docker compose exec backend python smoke_test_auto_expiration.py
```

All three confirmed passing as of 2026-05-06 (commit 25f03d3). `smoke_test_auto_scrape` includes the new Phase 4c assertion that validates `match_results.claim_summary` and `cleanup_results` shape.

The 1-hour autonomous cycle test (Step 8) is the final acceptance gate. Validates that the integration holds across many cycles with real scraping.

---

## 33. Lessons learned & operating principles

These are the principles that emerged from building auto-scrape and the per-source / matched mechanism. Most are well-known patterns; each one was learned the hard way.

### From the auto-scrape rollout (April 2026)

**Halt and report; don't build elaborate in-flight recovery.** When something unexpected happens mid-cycle, the right response is usually to stop, persist the diagnostic, and let the next cycle start fresh. Trying to recover in-flight tends to spawn parallel orchestrators or leave half-completed state.

**Detection > recovery.** If you can detect a bad state cleanly, you can fix it from outside. If you can't detect it, no amount of recovery code will help. The `phase_heartbeat_at` column on `auto_scrape_cycles` is detection. The lifespan startup cleanup is recovery driven by detection.

**State transitions persist in DB; volatile state has heartbeats.** Anything that takes more than a few seconds and could be interrupted goes through DB state transitions. `cycle_phase`, `cycle.status`, run-log status — all persist. Anything volatile (alarms, in-memory state, content script counters) gets a heartbeat so something else can notice it died.

**Backend is source of truth for automation-readable state.** The state mirror in `chrome.storage.local` is for performance. The backend's `auto_scrape_state` JSONB is canonical. Diverge at your peril; when in doubt, fetch from the backend.

**Same mechanism serves multiple problems (no per-defect fragmentation).** When two bugs would both benefit from "watch for state X and clean it up," merge them into one cleanup mechanism. The lifespan stale-cycle sweep handles three different cases with the same `WHERE status IN (...) AND started_at < cutoff` query.

**Boolean flags need an explicit owner of the "set back to false" path.** For every flag you set to `true`, write down — in the same commit — what code sets it back to `false` and under what conditions. Bug #1 of auto-scrape (`config_change_pending` never cleared, 254/255 cycles aborted) was forgetting this.

**"Fallback constants" become live constants.** If your code has a defaults array meant for "when backend is unavailable" but you never actually exercise the dynamic path, the defaults become the only path. Fetch from the source of truth on every call; use constants only as initial defaults during a known-empty state.

**When force-stopping, enumerate ALL the resources.** Database row, Chrome popups, alarms, content script flags, in-memory state. SQL UPDATE only handles the database row. Bug #5 of auto-scrape (zombie popups left behind by force-stop) was forgetting this.

**State writes that signal "cycle is running" must execute IMMEDIATELY.** Bug #4 Revision 2 of auto-scrape was the lesson here. If anything else watches for "is a cycle running?" by reading state, that state must be written within milliseconds of cycle start.

**HTTP status codes are signals, not classifications.** A 403 means "forbidden." It does NOT mean "captcha." Whether it's captcha, rate-limit, geo-block, or generic anti-bot is in the response body, headers, and URL. Bug #3 of auto-scrape was conflating all 403s with captchas.

**Long runs find integration bugs that short tests can't.** Cycles 1-3 always pass. Bug #1 emerged at cycle 50+. Bug #4 emerged at cycle 12. The 5-hour validation run is now part of the standard release process.

### From the schema redesign (May 2026)

**Append-only by convention beats append-only by enforcement.** CC-1 chose convention not because enforcement is hard but because explicit carve-outs (`matched`, auto-expiration) are clearer when they're documented exceptions to a rule than when they're triggers/permissions overriding it.

**Existing design wins** when resolving conflicts between a new mechanism and existing decisions. The matched mechanism review (§30.2) had three solution options; Solution C (separate matching_state table) was technically cleaner, but Solution A (column on per-source tables, with CC-1 amended) was simpler and matched the user's mental model. Picking the simpler path with explicit carve-outs beat picking a "purer" design.

**Document the trade-off, don't avoid it.** Three Known Limitations in §15 of the schema design (re-scrapes don't trigger re-matching, crashed matching leaves rows flagged, no per-row TTL) are all things the design accepts as costs. Recording them in a "Known Limitations" section makes them explicit; future readers don't need to relitigate.

**Plans that read fine on paper still have async/concurrency bugs.** Six rounds of conflict scans found 28 issues. Most of the late-round bugs were exact-string and async-call contracts that pure design reading missed. The next workstream should reduce round count by reading actual code (not docs) before writing plan snippets.

**Forward-compat assertions over strict ones.** Smoke test Phase 4c v1 was `assert match_results == {}`. v2 was `set(keys) <= {"claim_summary"}`. v3 (current) is "validate claim_summary structure if present; tolerate other keys." Each iteration broke when the contract evolved. The forward-compat shape is robust against future dedup/matching wiring.

### From the implementation phase

**TARGETED INSERTION, not function rewrite.** When modifying complex existing functions like `run_post_scrape_phase`, the discipline is: open the file, find the exact insertion points, change only what's needed. The "Existing-code lines that MUST be preserved" table grew with each conflict scan as more invariants were discovered the hard way.

**Smoke test couples are critical.** Step 7 explicitly required orchestrator change and smoke test update in the SAME commit. Shipping them separately would have left a CI-failing window. This pattern generalizes: any change that mutates the contract a smoke test asserts on requires a coupled smoke test update.

**Adapt in implementation, document the deviation.** The `db.begin()` → `db.commit()` adaptation in Step 7 (32.5) wasn't in the plan; the implementer found it during execution and adapted. Recording it as a project-pattern note prevents future contributors from repeating the mistake.

---

## 34. Verification methodology — patterns that work

### The standard verification block

After every backend change, run this on the host:

```powershell
docker compose build backend
docker compose up -d backend
do { Start-Sleep 1; try { Invoke-RestMethod http://localhost:8000/health -TimeoutSec 2; break } catch {} } while ($true)

# All smoke tests
docker compose exec backend python smoke_test.py
docker compose exec backend python smoke_test_p1.py
docker compose exec backend python smoke_test_p2.py
docker compose exec backend python smoke_test_p4.py
docker compose exec backend python smoke_test_p5.py
docker compose exec backend python smoke_test_auto_scrape.py
docker compose exec backend python smoke_test_matched_claim.py
docker compose exec backend python smoke_test_auto_expiration.py
```

All eight must pass. If any fails, do not proceed to the next change — diagnose first.

### The autonomous validation pattern

For changes to the orchestrator itself, run a multi-hour validation:

1. Truncate state and tables to clean baseline
2. Reload extension
3. Click Enable
4. Walk away for 1+ hour (5+ hours for milestone validation)
5. Run the diagnostic queries
6. Look specifically for:
   - Concurrent cycles always 0 or 1 (never 2+)
   - No `[poll] self-bootstrap` events between adjacent cycles
   - Job attribution: every `scraped_jobs.scan_run_id` matches its run-log's `search_filters.website`
   - No stuck flags
   - `cleanup_results` populated on every completed cycle
   - `match_results.claim_summary` populated on every completed cycle
   - Per-source rows have `matched=true` after their cycle completes

### The clean-baseline reset

For any test that needs a clean state:

```powershell
$headers = @{ Authorization = "Bearer dev-token"; "Content-Type" = "application/json" }

# Truncate
docker compose exec postgres psql -U jha -d jha -c "
  TRUNCATE auto_scrape_cycles, extension_run_logs, scraped_jobs,
           linkedin_jobs, indeed_jobs, glassdoor_jobs RESTART IDENTITY CASCADE;"

# Reset state to baseline
$current = (Invoke-RestMethod -Headers $headers http://localhost:8000/admin/auto-scrape/state).state
$current.config_change_pending = $false
$current.consecutive_precheck_failures = 0
$current.cycle_phase = "idle"
$current.exit_requested = $false
$body = @{ state = $current } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Put -Headers $headers -Body $body http://localhost:8000/admin/auto-scrape/state | Out-Null

# Reload extension at chrome://extensions/
```

After reset: state should show `enabled=false, cycle_phase="idle", exit_requested=false, config_change_pending=false, consecutive_precheck_failures=0`. Per-source tables empty.

### The pre-flight verify pattern

For migrations that change schema, run a post-migration verify script. The pattern:

```python
async def verify_table(engine, table: str) -> list[str]:
    errors = []
    async with engine.connect() as conn:
        result = await conn.execute(text("""
            SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :t
              AND column_name = :col
        """), {"t": table, "col": "matched"})
        row = result.first()
    if row is None:
        return [f"{table}: matched column missing"]
    # ... check type, nullability, default ...
    return errors
```

Key points:
- Always scope to `table_schema='public'` (multi-schema deploys could match wrong table)
- Accept multiple acceptable representations of boolean defaults (`'false'`, `"'false'"`, `false::boolean`, etc.) — PostgreSQL surfaces them differently across paths
- Run via `python -m scripts.module_name` not `python scripts/file.py` (the former adds `/app` to sys.path; the latter doesn't)

### Verifying code deployment

Common failure mode: agent claims "implementation complete" but the change never made it into the running container/extension.

For backend:
```bash
docker compose exec backend python -c "
from auto_scrape.matching_claim import claim_unmatched_rows
print(claim_unmatched_rows.__module__)
"
# Expected: auto_scrape.matching_claim
```

For extension SW:
```javascript
// In SW DevTools console:
self.runOneCycle.toString().includes("expected substring from your change")
```

If it returns false, the running SW is stale. Reload at `chrome://extensions/`.

### The trace-diff pattern

When a bug is hard to reproduce: capture a full SW console trace from a known-good run, capture another from a failing run, diff them. The first divergence is usually within a few lines of the bug.

### The post-fix soak test

After fixing a bug, run a soak test long enough that the bug WOULD have surfaced if still present:

| Bug type | Soak duration |
|---|---|
| Per-cycle bug (e.g., flag not cleared) | 30 minutes |
| Cross-cycle bug (e.g., parallel cycles) | 1 hour |
| Long-tail bug (e.g., zombie popup) | 5+ hours |

### The conflict-scan pattern

For any plan that proposes code changes, before declaring it "ready":

1. Open the plan
2. For every claim about existing code, find that code in the actual repo
3. For every function signature mentioned, verify it matches
4. For every file path created, verify the parent directory exists
5. For every smoke test assertion changed, verify the assertion's current text
6. List mismatches; fold corrections into the plan
7. Repeat until you find nothing

The matched mechanism plan converged in 6 rounds. With this discipline applied earlier, 2 rounds would have sufficed.

---

## 35. Cycle 455 incident — false-fail accounting bug (2026-05-07)

Right after the matched mechanism shipped, a separate bug surfaced that had been corrupting cycle accounting since at least May 4. This section captures it because the diagnostic walkthrough is instructive and the fix pattern is reusable.

### 35.1 The presenting symptom

Cycle 455 ran for 43 minutes and reported `scans_attempted: 9, scans_succeeded: 0, scans_failed: 9` — every scan in the 3×3 matrix failed. SW console showed timeouts, `scanInProgress still true after 60s` warnings, and 409 `scan_in_progress` rejections cascading through the matrix.

But the cycle row itself told a contradictory story:

```
cycle 455:
  status: post_scrape_complete
  scans_succeeded: 0, scans_failed: 9
  match_results: {"claim_summary": {"linkedin": 949, "indeed": 0, "glassdoor": 0}}
```

**Cycle reports 0 succeeded but match_results.claim_summary.linkedin = 949.** The matched-claim phase claimed 949 LinkedIn rows. If 0 scrapes succeeded, where did 949 rows come from?

### 35.2 The diagnosis

Querying `extension_run_logs` revealed the contradiction:

```
546faf90 (cycle 455, scan 1, linkedin / "software engineer"):
  status:        completed     ← NOT failed
  duration:      33 minutes
  pages_scanned: 39
  scraped:       915
  errors[0]:     pagination_ended (no_cards_found, has_no_results_banner)
  error_message: "Scan exceeded 5 minutes without completion;
                  backend likely lost contact during scan. Please retry."
```

The scan succeeded — `status='completed'`, 915 jobs ingested, walked through 39 pages and stopped at LinkedIn's natural "no more results" banner. But it carried a misleading `error_message`. Same pattern on `377b03ca` (machine learning engineer): completed with 540 jobs, 11-minute duration, same misleading message.

### 35.3 The cascade traced

The bug is in `backend/routers/extension.py` at the top of `trigger_scan`:

```python
# Lazy cleanup of stale running run-logs (e.g. B-23: extension aborted while
# backend was down, so the final failed PUT never landed). Real single-site
# scans finish in minutes; anything still running after 5m is treated as stuck.
stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
await db.execute(
    update(ExtensionRunLog)
    .where(ExtensionRunLog.status == "running")
    .where(ExtensionRunLog.started_at < stale_cutoff)
    .values(
        status="failed",
        error_message="Scan exceeded 5 minutes without completion; ...",
        completed_at=datetime.now(timezone.utc),
    )
)
```

The 5-minute threshold predates the per-source schema redesign and the matrix-shaped multi-site scans. Once those landed, every cycle that ran a full LinkedIn keyword tripped the cleanup at minute 5+ on its own running scan.

The cascade in cycle 455:

1. **04:06:33** — Auto-scrape orchestrator triggered scan 1. Backend created run-log `546faf90`, status='running'.
2. **04:11:33+** — Scan crossed 5 minutes. Still running normally; nothing has fired the cleanup yet because nothing is calling `trigger_scan`.
3. **04:36:33** — SW orchestrator's `triggerScanAndWait` 30-minute timeout fired. SW gave up waiting and called `_triggerScanWithRetry` for scan 2. **That `trigger_scan` call ran the stale-cleanup**, saw `546faf90` running for 30 minutes (`> 5min`), marked it `failed`.
4. **04:36:33 → 04:39:38** — Content script for `546faf90` kept running (it doesn't know backend marked it failed). Pages 36-39 ingested normally.
5. **04:39:38** — Page 39 returned `no_cards_found`. Content script wrote final PUT: `status='completed'`, `scraped=915`. **Status overwrote `failed → completed`, but `error_message` stayed.**

Two writers raced; the later write won on `status` but didn't touch `error_message`.

### 35.4 The bug had been firing intermittently for 3+ days

Querying historical data found two earlier victims:

```
a0e84d33 — 2026-05-04 05:21 — status=failed — "Scan exceeded 5 minutes..."
8ebf1e68 — 2026-05-04 21:24 — status=failed — "Scan exceeded 5 minutes..."
546faf90 — 2026-05-07 04:06 — status=completed — same message (cycle 455)
377b03ca — 2026-05-07 04:39 — status=completed — same message (cycle 455)
```

Same 30-minute LinkedIn scrape pattern on May 4. The difference: those two stayed `failed` (the content script never wrote terminal-success, possibly because the popup tab was closed before the scrape finished). Cycle 455's scans got the false `failed` overwritten only because the user happened to leave the browser open long enough for them to finish naturally.

**Bug had been firing all along.** Cycle 455 just made it visible by hitting it on every scan in a single cycle.

### 35.5 The patch

Two surgical edits in one commit, both in `backend/routers/extension.py`:

**Fix 1: Raise the stale-cleanup threshold to 60 minutes.**

LinkedIn scans with full pagination take ~33 minutes legitimately. 60 minutes preserves the B-23 stuck-row cleanup case (extension crashed and final PUT never landed) while never firing on healthy scans. Error message text updated to match.

**Fix 2: Clear `error_message` on terminal-success.**

Whatever code path sets `t.status = "completed"` on a run-log now also sets `t.error_message = None`. Defense-in-depth: even if some future guard writes a misleading `error_message`, terminal-success scrubs it. Crucially does NOT clear on `failed` transitions — those legitimately have errors to report.

### 35.6 Six bugs identified, two fixed, four deferred

The diagnostic surfaced six related bugs:

| # | Bug | Status |
|---|---|---|
| 1 | Backend 5-min stale-cleanup threshold too aggressive | **FIXED** |
| 2 | SW orchestrator's 30-min timeout too short for legitimate long scans | Deferred (follow-up commit) |
| 3 | Run-log `status` is not a one-way state machine (can transition `failed → completed`) | Deferred indefinitely |
| 4 | `error_message` not cleared on terminal-success | **FIXED** |
| 5 | SW orchestrator's cycle accounting based on `triggerScanAndWait` belief, not run-log truth | Deferred |
| 6 | Cycle reaches `post_scrape_complete` even when scrape phase reports total failure | Deferred (design question) |

**Why Bug 3 stays deferred.** A CHECK constraint forcing one-way state transitions would have been correct in principle but would have lost cycle 455's data — the content script's terminal-success write that overwrote false `failed` is exactly what saved 1,455 successfully-scraped jobs from being thrown away. Lock down `status` only after upstream write paths are audited and the false `failed` writes are eliminated.

**Why Bug 2 ships separately.** With Fix 1+2 in place, the 30-min SW timeout no longer cascades catastrophically (the next `trigger_scan` won't poison the running scan). It still wastes a matrix slot on long scans, but that's an efficiency issue, not a data-integrity issue. Smaller commits are easier to revert if Fix 1+2 has unforeseen regressions.

### 35.7 Verification — what worked, what didn't

**The first three verifier attempts had bugs of their own.** This is worth noting because the same lessons will apply to future verification work.

| Round | Approach | Failure mode |
|---|---|---|
| v1 | PowerShell script with `docker compose exec` per check | Execution policy blocked unsigned `.ps1`; CRLF line endings broke bash piping |
| v2 | Bash script copied via `docker cp`, hardcoded smoke test names, SQL via bash positional args | Hardcoded test names didn't exist in container; SQL parameter substitution broke; HTTP-level test depended on production state |
| v3 | Auto-discover smoke tests via `ls`; SQL via stdin pipe (not bash args); test cleanup SQL directly (not via HTTP) | All checks pass cleanly |

**Lesson: test the unit, not the orchestration around it.** The HTTP endpoint has two earlier 409 guards (`stop_cooldown`, `scan_in_progress`) that fire BEFORE the cleanup. Production data state determined whether the cleanup actually executed. Going through HTTP coupled the test to production state. Testing the SQL cleanup directly (via the same logic pattern, scoped to test row IDs that won't collide with production) gave reliable PASS/FAIL signals.

### 35.8 End-to-end validation: cycle 481

The patch validation: run a full cycle post-patch with the same matrix shape as cycle 455 and see if the pattern recurs.

**Cycle 481 (post-patch, same 3×3 matrix):**

```
status: post_scrape_complete
scans_attempted: 9
scans_succeeded: 9       ← was 0 in cycle 455
scans_failed: 0          ← was 9 in cycle 455
claim_summary: {linkedin: 952, indeed: 197, glassdoor: 157}
cleanup_results: {linkedin_jobs: 0, indeed_jobs: 0, glassdoor_jobs: 0}
```

SW console log for cycle 481: zero warnings, zero `_asWarn` lines, zero `scanInProgress still true after 60s`. Every matrix entry shows the clean pattern:

```
matrix [N/3][M/3]: site / "keyword"
  → SW idle, triggering scan for site
  → run-log appeared: <uuid>
  → run-log <uuid> terminal: completed
matrix [N+1/3][M/3]: ...
```

Bug eradicated. 1,306 rows ingested, all transitioned `matched=false → true` after the cycle.

### 35.9 The principle worth carrying forward

**Observability lies are worse than runtime bugs.** The scraper had been working correctly for at least 3 days. The cycle accounting just lied about it. The user trusted the cycle status (`scans_failed: 9`) and didn't notice the data was actually being ingested.

When designing future systems: **status fields and observability surfaces should reflect reality, not the orchestrator's belief about reality at one point in time.** If two writers can update the same field, one should win definitively, and stale signals from the loser should be scrubbed.

Fix 2 (clear `error_message` on terminal-success) is a small instance of this principle. The full-fidelity version would be Bugs 3 + 5 fixes — making `status` a one-way state machine AND making the SW re-fetch run-log status before declaring failures. Those are deferred but the principle is now in the codebase as the documented direction.

### 35.10 Verification scripts for future regression detection

Two reusable scripts produced during this incident:

- **`verify-bugfix-v2.sh`** — source-level verification of the patch (14 checks: source patch present, container loaded, smoke tests pass, cleanup SQL behavior correct, matched mechanism still healthy).
- **`verify-cycle.sh`** — post-cycle health check (12 checks: cycle accounting matches run-log truth, no stale error messages, auto-expiration ran, claim phase ran, no stuck cycles).

Both designed to be re-runnable. Any future regression in this area will be caught by running `verify-cycle.sh` after a cycle. The full incident write-up is in `cycle-455-incident-report.md`.

### 35.11 Worth noting for new readers

This incident illustrates what the JHA codebase looks like in practice:
- Bugs that lurk for days in benign-looking metrics
- Fixes that need to be surgical (raising the threshold, not removing the guard)
- Verification methodology that itself takes iteration to get right
- The discipline of distinguishing "data is correct, accounting lies" from "data is corrupted"
- Strong preference for keeping fixes minimal and deferring deeper changes (Bug 3) until upstream is stable

If you're new to the project, this is a representative session. The next workstream (wiring dedup/matching into Phase 3) will look similar: start with a plan, conflict-scan against actual code, iterate on verification, ship with strict invariants documented.

---

## 36. What's deferred and what comes next

### Currently deferred (intentional)

| Item | Why | When to revisit |
|---|---|---|
| Dedup pipeline body in post-scrape orchestrator | Phase 4.5 stub; needs design pass on cumulative-vs-per-cycle dedup | Next workstream |
| Matching pipeline body in post-scrape orchestrator | Same; needs alignment with dedup output | After dedup |
| Phase 8 auto-apply | Requires both dedup and matching functional | After matching |
| Frontend UI for `shelf_life_days` setting | Backend supports it; frontend reads from `system_settings` | Whenever shelf life needs adjustment from the dashboard |
| Per-source ORM models | Raw SQL pattern is established; no immediate need | If the codebase shifts to ORM-everywhere |
| Retiring legacy `scraped_jobs` table | Still active; downstream consumers (matching, frontend) still read it | After dedup/matching wire into per-source path |

### Open low-priority issues

| Issue | Workaround |
|---|---|
| In-flight scan stop edge case | SQL UPDATE for stuck cycles (cosmetic; data integrity unaffected) |
| Add keyword UI flicker | Cosmetic only |
| Indeed 403 root cause unclear in this environment | System gracefully classifies as `rate_limited` |
| Step 8 (1-hour autonomous validation of matched mechanism) not yet run | Smoke tests pass; autonomous run is final acceptance |

### The next major workstream

**Wire dedup and matching pipelines into Phase 3** of the post-scrape orchestrator.

The plumbing is ready:
- `claim_unmatched_rows` returns the actual rows (not just counts) — ready to feed into a merge step
- `cycle.match_results` JSONB has space for additional keys beyond `claim_summary`
- Phase 4c smoke test assertion is forward-compatible

The work to do:
1. Design the merged_jobs ephemeral build from `claim_results`
2. Design the dedup contract (what gets dropped, what gets kept, how cosine TF-IDF interacts with content hashing)
3. Wire the matching pipeline (CPU work + LLM extraction gates + CPU pre-score + LLM hiring-manager judgment) to consume merged_jobs
4. Update Phase 4c assertions as `match_results` gains more keys

The recommended sequence is:
1. **Read** the existing matching pipeline code (`backend/matching/pipeline.py`) and dedup code in their entirety
2. **Copy** relevant function signatures into a plan doc with `# UNCHANGED` markers
3. **Annotate** with `# NEW` markers where the new code goes
4. **One** conflict scan pass to catch baseline issues
5. **Implement** with the same TARGETED INSERTION discipline as Step 7

If steps 1-4 are done well, steps 5 should require only one additional scan round (not six like the matched mechanism).

### Operational housekeeping

- Resolve in-flight scan stop edge case (~10 LOC in `handleGracefulExit`)
- Run Step 8 autonomous validation of matched mechanism (1-hour, then declare done)
- Track when production grandfather UPDATE for migration 028 happens
- Consider extending the smoke test suite with a manual fault-injection runner for the three-table atomic-claim test

### Source-of-truth files

Current set, kept synchronized:

| Doc | Purpose |
|---|---|
| `step1-schema-design.md` v12 | Per-source table CCs, columns, migrations, Known Limitations |
| `step1-auto-expiration.md` | Auto-expiration mechanism design |
| `scrape-fields-master.md` | Field-by-field source → target table mapping |
| `auto-scrape-design-v4.md` | Auto-scrape system design (Phase 1-7.1) |
| `matched-mechanism-codebase-changes-corrected.md` | The matched mechanism implementation plan (1188 lines, six conflict scans folded in) |
| `jha-onboarding.md` (this document) | Standalone reference for picking up the project in a fresh session |

### The line drawn at this milestone

The matched mechanism implementation completes the foundation for the post-scrape pipeline. Per-source tables exist with proper conventions; auto-expiration keeps them bounded; matched-claim provides a clean contract between scrape and matching; the orchestrator wires all three together with strict invariants documented and verified.

Anything beyond this point — wiring dedup, integrating matching, building auto-apply — is a separate workstream that operates on top of the now-stable foundation. None of it should require re-touching the auto-scrape orchestrator's structure.

---

## End

If you're reading this in a fresh session, you have the full picture:

- **§1-20** — how a single manual scan works (unchanged from original)
- **§21-22** — cleanup batch retrospective (April 2026) and B-31/32/33 verification
- **§23-27** — the auto-scrape system (Phases 1-7.1, validated 2026-04-29 with 5-hour run)
- **§28-30** — per-source schema redesign + auto-expiration + matched mechanism (May 2026)
- **§31-32** — the iterative conflict-scan workflow and Step 7 implementation
- **§33-34** — lessons and verification patterns
- **§35** — the cycle 455 incident (false-fail accounting bug, fixed 2026-05-07)
- **§36** — what's deferred and what comes next

The system is ready for the next workstream: wiring dedup and matching into Phase 3 of the post-scrape orchestrator. The plan/scan/correct/converge pattern from §31 is the recommended approach, with earlier code-reading discipline to reduce the round count. Operational health is verified — cycle 481 (post-cycle-455-fix) ran cleanly with all observability surfaces matching reality.
