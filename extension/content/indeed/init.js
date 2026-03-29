/* ── Indeed content script entry ───────────────────────────────────────── */

async function init() {
  if (window.location.search.includes("jha_preview=1")) {
    console.log("[JHA-Indeed] preview mode — skipping scan");
    return;
  }
  let storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
  if (!storage.scanInProgress) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
      if (storage.scanInProgress) break;
    }
  }
  if (!storage.scanInProgress) return;

  const session = checkSession();
  if (session !== "live") {
    await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "SESSION_ERROR", error: session }, resolve)
    );
    await chrome.storage.local.set({ scanInProgress: false });
    return;
  }

  const config = storage.scanConfig;
  if (!config) {
    console.log("[JHA-Indeed] no scanConfig — exiting");
    return;
  }

  showScanOverlay();

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  try {
    const { scanPageState } = await chrome.storage.local.get("scanPageState");
    const state =
      scanPageState ||
      (await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" }, resolve)
      ));

    const summary = await runSinglePage(config, state);

    if (summary.done) {
      hideScanOverlay();
      await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
      await chrome.storage.local.set({
        scanInProgress: false,
        scanComplete: { tabId, summary, runId: config.runId, completedAt: Date.now() },
      });
    }
  } catch (e) {
    console.error("[JHA-Indeed] Scan error:", e);
    hideScanOverlay();
    await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
    await chrome.storage.local.set({
      scanInProgress: false,
      scanComplete: {
        tabId,
        runId: config?.runId,
        summary: {
          scraped: 0,
          new_jobs: 0,
          existing: 0,
          stale_skipped: 0,
          jd_failed: 0,
          pages_scanned: 0,
          early_stop: false,
          errors: [],
          error: e.message,
        },
        completedAt: Date.now(),
      },
    });
  }
}

init();
