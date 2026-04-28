/* ── Debounced PUT of liveProgress → run-log (B-14 layer B) ─────────────── */

let liveProgressDebounceTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.liveProgress?.newValue) return;
  if (liveProgressDebounceTimer) return;
  liveProgressDebounceTimer = setTimeout(async () => {
    liveProgressDebounceTimer = null;
    await mirrorProgress();
  }, 10000);
});

async function mirrorProgress() {
  const { scanConfig, liveProgress, scanInProgress } =
    await chrome.storage.local.get(["scanConfig", "liveProgress", "scanInProgress"]);
  if (!scanInProgress || !scanConfig?.runId || !liveProgress) return;

  const { backendUrl, authToken } = await getSettings();
  try {
    await fetch(`${backendUrl}/extension/run-log/${scanConfig.runId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scraped: liveProgress.scraped ?? 0,
        new_jobs: liveProgress.new_jobs ?? 0,
        existing: liveProgress.existing ?? 0,
        stale_skipped: liveProgress.stale_skipped ?? 0,
        jd_failed: liveProgress.jd_failed ?? 0,
        pages_scanned: liveProgress.page ?? 1,
      }),
    });
  } catch (e) {
    console.warn("[JHA] Progress mirror failed:", e.message);
  }
}
