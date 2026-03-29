/* ── Startup cleanup (clears stale scanInProgress from Chrome crash) ─── */

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ scanInProgress: false, liveProgress: null });
});
