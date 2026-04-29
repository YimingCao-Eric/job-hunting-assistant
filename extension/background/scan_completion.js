/* ── Scan completion via storage.onChanged ────────────────────────────── */

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.scanComplete) return;
  if (!changes.scanComplete.newValue) return;

  const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
  if (scanTimeoutId != null) {
    clearTimeout(scanTimeoutId);
    chrome.storage.local.remove("scanTimeoutId");
  }

  const { tabId, summary, runId, completedAt } = changes.scanComplete.newValue;
  const { backendUrl, authToken } = await getSettings();

  let status = "completed";
  let errorMessage = null;
  let failureReason = null;
  let failureCategory = null;

  if (summary?.aborted_reason === "backend_unavailable") {
    status = "failed";
    errorMessage = "Backend was unavailable during scan; please retry";
    failureReason = "backend_unavailable";
    failureCategory = "transient";
  } else if (summary?.aborted_reason === "sw_died") {
    status = "failed";
    errorMessage = "Service worker died during scan; please retry";
    failureReason = "sw_died";
    failureCategory = "transient";
  } else if (summary?.aborted_reason === "stop_requested") {
    status = "failed";
    errorMessage = "Scan stopped by user";
    failureReason = "user_stopped";
    failureCategory = "coordination";
  } else if (summary?.aborted_reason === "session") {
    status = "failed";
    errorMessage = "Session expired during scan";
    failureReason = "session_expired";
    failureCategory = "persistent";
  } else if (summary?.aborted_reason === "captcha") {
    status = "failed";
    errorMessage = "CAPTCHA challenge during scan";
    failureReason = "captcha";
    failureCategory = "persistent";
  } else if (summary?.aborted_reason === "rate_limited") {
    status = "failed";
    errorMessage = "Rate limited during scan";
    failureReason = "rate_limited";
    failureCategory = "transient";
  }

  const pagesScanned =
    summary?.pages_scanned ?? summary?.pages ?? 1;

  try {
    await fetch(`${backendUrl}/extension/run-log/${runId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status,
        completed_at: new Date().toISOString(),
        pages_scanned: pagesScanned,
        scraped: summary.scraped ?? 0,
        new_jobs: summary.new_jobs ?? 0,
        existing: summary.existing ?? 0,
        stale_skipped: summary.stale_skipped ?? 0,
        jd_failed: summary.jd_failed ?? 0,
        errors: summary.errors ?? null,
        ...(errorMessage ? { error_message: errorMessage } : {}),
        ...(failureReason ? { failure_reason: failureReason } : {}),
        ...(failureCategory ? { failure_category: failureCategory } : {}),
      }),
    });
  } catch (e) {
    console.error("[JHA] Failed to update run log:", e);
  }

  stopKeepAlive();
  stopActivePolling();
  chrome.storage.local.remove(["scanComplete", "scanPageState"]);
  chrome.storage.local.set({
    lastRunSummary: { ...summary, completedAt: completedAt ?? null },
    liveProgress: null,
  });
  if (tabId) chrome.tabs.remove(tabId);
});
