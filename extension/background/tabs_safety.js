/* ── Tab force-close safety ───────────────────────────────────────────── */

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("scanComplete", ({ scanComplete }) => {
    if (!scanComplete) {
      chrome.storage.local.set({ scanInProgress: false, liveProgress: null });
    }
  });
});
