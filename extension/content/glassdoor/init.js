/* ── Glassdoor content script entry — manual scan only (scanInProgress + scanConfig) ─ */

console.log("[JHA-Glassdoor] content script loaded", window.location.href);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function glassdoorBeforeShowOverlay(config, tabId) {
  const url = window.location.href;
  const u = url.toLowerCase();
  if (u.includes("srch_") || u.includes("/job/")) {
    await JhaDebug.emit("page_load", {
      url,
      state_source: "inline",
    });
    JhaDebug.setPage(1);
    return null;
  }
  await JhaDebug.emit(
    "error",
    {
      where: "glassdoor_manual_init",
      message: "not_a_job_search_page",
      url,
    },
    "error"
  );
  return {
    scraped: 0,
    new_jobs: 0,
    existing: 0,
    stale_skipped: 0,
    jd_failed: 0,
    pages_scanned: 0,
    errors: [],
    error: "not_a_job_search_page",
  };
}

async function glassdoorMain() {
  if (window.location.search.includes("jha_preview=1")) {
    console.log("[JHA-Glassdoor] preview mode — skipping scan");
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

  if (storage.scanInProgress && storage.scanConfig?.website === "glassdoor") {
    await runScanPipeline({
      source: "glassdoor",
      bootedFlag: "__JHA_GLASSDOOR_SCAN_BOOTED",
      sessionCheck: () => "live",
      reportSessionError: null,
      onSessionFailure: null,
      extraSessionFields: () => ({
        has_glassdoor_session_cookies:
          document.cookie.includes("GDSESSION") ||
          document.cookie.includes("gdId"),
      }),
      isContinuing: () => false,
      buildScanStartData: (config) => ({
        entry: "manual",
        url: location.href,
        keyword: config.glassdoor?.keyword || config.keyword,
        location: config.glassdoor?.location || config.location,
        filters: config.glassdoor || null,
      }),
      beforeShowOverlay: glassdoorBeforeShowOverlay,
      runScan: (config, tabId) => scanGlassdoorPage(config, config.runId),
    });
  }
}

glassdoorMain();
