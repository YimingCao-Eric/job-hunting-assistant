# Phase 5 entry triggers

The `auto_scrape_next_cycle` alarm is the central loop driver. Three ways to bootstrap it:

## A. POST /admin/auto-scrape/enable

Sets `state.enabled=true`. The SW’s `pollAutoScrapeState` mirrors this to `chrome.storage.local._autoScrape.enabled` within ~30s. With enable alone, no alarm has fired yet — nothing runs until the first alarm is scheduled, e.g.:

```javascript
// Service Worker DevTools console
await chrome.alarms.create("auto_scrape_next_cycle", { when: Date.now() + 1000 });
```

After the first cycle, `scheduleNextCycle` re-arms the alarm. Continuous mode is self-sustaining until paused.

## B. POST /admin/auto-scrape/test-cycle

Sets `state.test_cycle_pending=true`. Same caveat: schedule the first `auto_scrape_next_cycle` alarm manually. When the cycle ends, the SW clears `test_cycle_pending` on the backend (merged `PUT /admin/auto-scrape/state` with `{ state: { ...full merged state... } }`). If continuous mode is also on, `scheduleNextCycle` runs after the cycle.

## C. Manual SW DevTools call

For debugging, `await self.runOneCycle()` runs one cycle immediately and bypasses the alarm. Options like `runOneCycle({ isTestCycle: true })` align behavior with test-cycle semantics; the alarm path is not used.

## Phase 6

The dashboard will provide a “Start Now” that bundles enable + first alarm create. Until then, bootstrap the first alarm from DevTools after enabling.

---

## Backend `PUT /admin/auto-scrape/state`

The API replaces the entire JSON `state` document. The extension always **GET**s the row, **merges** patches into `state`, and **PUT**s `{ state: merged }`. Do not send a partial top-level body without the rest of the keys — that would wipe fields.

## Shutdown between cycles

`pollAutoScrapeState` runs on the same cadence as `jha_poll` (~30s). When the backend has `exit_requested: true` (e.g. after `POST /admin/auto-scrape/shutdown`), the poll path invokes `handleGracefulExit` so alarms and backend flags are cleared without waiting for the next `auto_scrape_next_cycle` fire.
