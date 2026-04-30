/* extension/background/auto_scrape_init.js
 * Initializes _autoScrape state on SW startup.
 * Per Q4 (Yiming): explicit Start button required; never auto-resume.
 */

async function initAutoScrape() {
  const stored = await chrome.storage.local.get("_autoScrape");
  let state = stored._autoScrape || {};

  let isNewInstance = false;
  if (!state.instance_id) {
    state.instance_id = crypto.randomUUID();
    isNewInstance = true;
  }

  state.enabled = false;
  state.cycle_phase = "idle";

  await chrome.storage.local.set({ _autoScrape: state });

  await _cleanupOrphanScrapePopups();

  if (isNewInstance) {
    try {
      const { backendUrl, authToken } = await getSettings();
      await fetch(`${backendUrl}/admin/auto-scrape/cleanup-orphan-cycles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ current_instance_id: state.instance_id }),
      });
    } catch {
      /* best effort — backend may be unreachable on first boot */
    }
  }
}

chrome.runtime.onStartup.addListener(initAutoScrape);
chrome.runtime.onInstalled.addListener(initAutoScrape);

self.initAutoScrape = initAutoScrape;

async function _cleanupOrphanScrapePopups() {
  try {
    const stored = await chrome.storage.local.get("_autoScrape");
    const cycle_phase = stored._autoScrape?.cycle_phase || "idle";
    if (
      cycle_phase === "scrape_running" ||
      cycle_phase === "postscrape_running"
    ) {
      return;
    }
    if (typeof self._closeScrapePopupWindows !== "function") return;
    const closed = await self._closeScrapePopupWindows();
    if (closed > 0) {
      console.log(
        `[auto_scrape_init] closed ${closed} orphan scrape popup window(s)`
      );
    }
  } catch (e) {
    console.warn("[auto_scrape_init] orphan popup cleanup failed:", e.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto_scrape_next_cycle") {
    if (typeof self.onAutoScrapeAlarm === "function") {
      self.onAutoScrapeAlarm().catch((e) => {
        console.error("[auto_scrape] onAutoScrapeAlarm threw:", e);
      });
    }
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("jha-captcha-")) {
    const site = notificationId.replace("jha-captcha-", "");
    const openUrl =
      typeof self.AS_PROBE_URLS === "object" && self.AS_PROBE_URLS
        ? self.AS_PROBE_URLS[site]
        : null;
    if (openUrl) {
      chrome.tabs.create({ url: openUrl });
    }
    chrome.notifications.clear(notificationId);
  }
});
