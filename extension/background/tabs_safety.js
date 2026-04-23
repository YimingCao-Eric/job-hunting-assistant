/* ── Tab force-close safety (scoped to scan tab only) ─────────────────── */

/**
 * Only clear scan state when (1) no scanComplete yet (scan still in progress) and
 * (2) the closed tab is the tracked scan tab. Any other tab close is ignored.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { scanComplete, scanConfig } = await chrome.storage.local.get([
    "scanComplete",
    "scanConfig",
  ]);
  if (scanComplete) return;
  if (!scanConfig || scanConfig.tabId !== tabId) return;
  console.log("[JHA] Scan tab closed mid-scan — clearing state");
  await chrome.storage.local.set({ scanInProgress: false, liveProgress: null });
  await chrome.storage.local.remove(["scanConfig", "scanPageState", "debugLog"]);
});
