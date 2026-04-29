/* extension/background/poll.js — two-tier polling design */

let activeIntervalId = null;

async function pollAutoScrapeState() {
  try {
    const { backendUrl, authToken } = await getSettings();
    const resp = await fetch(`${backendUrl}/admin/auto-scrape/state`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) return;
    const payload = await resp.json();
    const state = payload.state || {};

    const updates = {};
    if (state.exit_requested === true) {
      updates._autoScrape_exit_requested = true;
    }
    if (state.config_change_pending === true) {
      updates._autoScrape_config_change_pending = true;
    }

    const stored = await chrome.storage.local.get("_autoScrape");
    const autoScrape = stored._autoScrape || {};
    autoScrape.enabled = state.enabled === true;
    autoScrape.test_cycle_pending = state.test_cycle_pending === true;
    autoScrape.next_cycle_at = state.next_cycle_at || 0;
    const defMin =
      (typeof self.AS_DEFAULT_MIN_CYCLE_INTERVAL_MS === "number" &&
        self.AS_DEFAULT_MIN_CYCLE_INTERVAL_MS) ||
      60000;
    autoScrape.min_cycle_interval_ms =
      typeof state.min_cycle_interval_ms === "number" && state.min_cycle_interval_ms > 0
        ? state.min_cycle_interval_ms
        : defMin;
    autoScrape.consecutive_precheck_failures =
      typeof state.consecutive_precheck_failures === "number"
        ? state.consecutive_precheck_failures
        : 0;

    await chrome.storage.local.set({ _autoScrape: autoScrape, ...updates });

    const shouldBootstrap =
      (state.enabled === true || state.test_cycle_pending === true) &&
      state.exit_requested !== true;

    if (shouldBootstrap) {
      const scanStored = await chrome.storage.local.get("scanInProgress");
      const scanInProgress = scanStored.scanInProgress === true;

      if (!scanInProgress) {
        const existing = await chrome.alarms.get("auto_scrape_next_cycle");
        if (!existing) {
          await chrome.alarms.create("auto_scrape_next_cycle", {
            when: Date.now() + 1000,
          });
          console.log(
            "[poll] self-bootstrap: alarm auto_scrape_next_cycle scheduled"
          );
        }
      }
    }

    if (state.exit_requested === true && typeof self.handleGracefulExit === "function") {
      self.handleGracefulExit().catch((e) => {
        console.error("[JHA] handleGracefulExit:", e);
      });
    }
  } catch {
    /* best effort — backend may be unreachable */
  }
}

async function pollPending() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/extension/pending`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    await chrome.storage.local.remove("_lastPollError");

    if (data.scan?.pending) {
      console.log("[JHA] Scan triggered from frontend");
      await handleManualScan({
        websiteOverride: data.scan.website || null,
        scan_all: !!data.scan.scan_all,
        scan_all_position:
          data.scan.scan_all_position != null
            ? data.scan.scan_all_position
            : null,
        scan_all_total:
          data.scan.scan_all_total != null ? data.scan.scan_all_total : null,
      });
    }

    if (data.stop?.pending) {
      await handleStopRequest();
    }
  } catch (e) {
    await chrome.storage.local.set({
      _lastPollError: {
        message: e.message,
        ts: Date.now(),
        endpoint: "/extension/pending",
      },
    });
  }
}

async function handleStopRequest() {
  await chrome.storage.local.set({ stopRequested: true });

  const { scanConfig } = await chrome.storage.local.get("scanConfig");
  if (scanConfig?.tabId != null) {
    try {
      await chrome.tabs.remove(scanConfig.tabId);
    } catch {
      /* tab may already be gone */
    }
  }

  const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
  if (scanTimeoutId != null) {
    clearTimeout(scanTimeoutId);
  }

  await chrome.storage.local.remove([
    "scanInProgress",
    "scanConfig",
    "scanPageState",
    "liveProgress",
    "scanComplete",
    "scanTimeoutId",
  ]);

  stopActivePolling();
  stopKeepAlive();
  console.log("[JHA] Force-stopped scan");
}

chrome.alarms.create("jha_poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "jha_poll") {
    await chrome.storage.local.set({ _keepalive: Date.now() });
    await pollPending();

    try {
      const stored = await chrome.storage.local.get("_autoScrape");
      const state = stored._autoScrape || {};
      if (state.enabled || state.test_cycle_pending) {
        const { backendUrl, authToken } = await getSettings();
        await fetch(`${backendUrl}/admin/auto-scrape/heartbeat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            extension_instance_id: state.instance_id || null,
          }),
        });
      }
    } catch {
      /* Heartbeat is best-effort; backend cleanup will catch dead SW */
    }

    await pollAutoScrapeState();
  }
});

function startActivePolling() {
  if (activeIntervalId) return;
  activeIntervalId = setInterval(pollPending, 3000);
}

function stopActivePolling() {
  if (activeIntervalId) {
    clearInterval(activeIntervalId);
    activeIntervalId = null;
  }
}

self.startActivePolling = startActivePolling;
self.stopActivePolling = stopActivePolling;
