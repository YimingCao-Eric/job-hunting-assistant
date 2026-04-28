/* extension/background/poll.js — two-tier polling design */

let activeIntervalId = null;

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
