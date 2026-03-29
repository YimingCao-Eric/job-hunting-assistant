/* ── Glassdoor content script entry ─────────────────────────────────────── */
/* Manual scan: same flow as Indeed — scanInProgress + scanConfig in storage. */
/* Auto scan: debounced visit without manual trigger (GET_CONFIG + SCAN_STARTED). */

console.log("[JHA-Glassdoor] content script loaded", window.location.href);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runManualGlassdoorScan(config) {
  const url = window.location.href;
  const u = url.toLowerCase();
  if (!u.includes("srch_") && !u.includes("/job/")) {
    console.warn("[JHA-Glassdoor] manual scan: not a job listing/search URL");
    await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
    await chrome.storage.local.set({
      scanInProgress: false,
      scanComplete: {
        tabId: null,
        runId: config.runId,
        summary: {
          scraped: 0,
          new_jobs: 0,
          existing: 0,
          stale_skipped: 0,
          jd_failed: 0,
          pages_scanned: 0,
          early_stop: false,
          error: "not_a_job_search_page",
        },
        completedAt: Date.now(),
      },
    });
    return;
  }

  const settings = await new Promise((resolve) =>
    chrome.storage.local.get(
      ["scanDelay", "backendUrl", "authToken"],
      resolve
    )
  );

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  console.log("[JHA-Glassdoor] manual scan starting", { url, runId: config.runId });

  try {
    const counters = await scanGlassdoorPage(config, settings, config.runId);

    await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
    await chrome.storage.local.set({
      scanInProgress: false,
      scanComplete: {
        tabId,
        summary: {
          scraped: counters.scraped,
          new_jobs: counters.new_jobs,
          existing: counters.existing,
          stale_skipped: counters.stale_skipped,
          jd_failed: counters.jd_failed,
          pages_scanned: counters.pages ?? 0,
          early_stop: !!counters.early_stop,
          errors: counters.errors || [],
        },
        runId: config.runId,
        completedAt: Date.now(),
      },
    });
  } catch (e) {
    console.error("[JHA-Glassdoor] Scan error:", e);
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

async function runAutoGlassdoorScan() {
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (scanInProgress) {
    console.log("[JHA-Glassdoor] skip auto-scan — manual scan in progress");
    return;
  }

  const url = window.location.href;
  const u = url.toLowerCase();
  if (!u.includes("srch_") && !u.includes("/job/")) {
    console.log("[JHA-Glassdoor] skip — not a job listing/search URL");
    return;
  }

  const settings = await new Promise((resolve) =>
    chrome.storage.local.get(
      ["autoScan", "scanDelay", "backendUrl", "authToken", "lastGlassdoorScanTime"],
      resolve
    )
  );

  if (settings.autoScan === false) {
    console.log("[JHA-Glassdoor] autoScan disabled in storage — skipping scan");
    return;
  }

  const DEBOUNCE_MS = 15 * 60 * 1000;
  const now = Date.now();
  const lastScan = settings.lastGlassdoorScanTime || 0;
  if (now - lastScan < DEBOUNCE_MS) {
    console.log("[JHA-Glassdoor] debounce active — skipping auto-scan");
    return;
  }

  chrome.storage.local.set({ lastGlassdoorScanTime: now });

  const config = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, resolve)
  );

  if (!config?.glassdoor) {
    console.warn("[JHA-Glassdoor] no glassdoor config found — skipping scan");
    return;
  }

  const startResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      {
        type: "SCAN_STARTED",
        source: "glassdoor",
        keyword: config.glassdoor.keyword,
        location: config.glassdoor.location,
        filters: config.glassdoor,
      },
      resolve
    )
  );
  const runId = startResult?.runId || null;
  config.runId = runId;

  console.log("[JHA-Glassdoor] starting auto-scan", { url, runId });

  const counters = await scanGlassdoorPage(config, settings, runId);

  console.log("[JHA-Glassdoor] auto-scan complete", counters);

  chrome.runtime.sendMessage({
    type: "SCAN_COMPLETE",
    source: "glassdoor",
    runId,
    counters,
  });
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
    await runManualGlassdoorScan(storage.scanConfig);
    return;
  }

  await runAutoGlassdoorScan();
}

glassdoorMain();
