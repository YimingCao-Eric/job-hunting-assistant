/* ── LinkedIn content script entry ─────────────────────────────────────── */

async function init() {
  let storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
  if (!storage.scanInProgress) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
      if (storage.scanInProgress) break;
    }
  }
  if (!storage.scanInProgress) {
    console.log("[JHA] init: scanInProgress not set after 3s — exiting");
    return;
  }

  const session = checkSession();
  if (session !== "live") {
    await reportSessionError(session);
    if (session === "captcha") {
      console.log("[JHA] CAPTCHA detected — stopping scan, leaving page open");
    } else {
      window.location.href = "https://www.linkedin.com/login";
    }
    await chrome.storage.local.set({ scanInProgress: false });
    return;
  }

  const config = storage.scanConfig;
  if (!config) {
    console.log("[JHA] init: no scanConfig — exiting duplicate");
    return;
  }

  showScanOverlay();

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  let summary = null;
  try {
    const { scanPageState } = await chrome.storage.local.get("scanPageState");
    const state =
      scanPageState ||
      (await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" }, resolve)
      ));

    const processedJobIds = new Set(
      Array.isArray(state.processed_job_ids) ? state.processed_job_ids : []
    );
    const processedTitleCompany = new Set(
      Array.isArray(state.processed_title_company)
        ? state.processed_title_company
        : []
    );
    summary = await runSinglePage(
      config,
      state,
      processedJobIds,
      processedTitleCompany
    );

    if (summary.done) {
      hideScanOverlay();
      await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
      await chrome.storage.local.set({
        scanInProgress: false,
        scanComplete: {
          tabId,
          summary,
          runId: config.runId,
          completedAt: Date.now(),
        },
      });
    }
  } catch (e) {
    console.error("[JHA] Scan error:", e);
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
          errors: [],
          error: e.message,
        },
        completedAt: Date.now(),
      },
    });
  }
}

init();
