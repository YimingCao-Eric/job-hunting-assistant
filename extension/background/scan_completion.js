/* ── Scan completion via storage.onChanged ────────────────────────────── */

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
