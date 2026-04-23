/* ── LinkedIn content script entry (single long-running invocation) ──── */

async function getStorageKeepaliveAge() {
  const { _keepalive } = await chrome.storage.local.get("_keepalive");
  return _keepalive ? Date.now() - _keepalive : null;
}

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

  const config = storage.scanConfig;
  if (!config) {
    console.log("[JHA] init: no scanConfig — exiting duplicate");
    return;
  }

  if (window.__JHA_LINKEDIN_SCAN_BOOTED) {
    console.log("[JHA] init: duplicate boot in same document — exiting");
    return;
  }
  window.__JHA_LINKEDIN_SCAN_BOOTED = true;

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  await JhaDebug.init(config.runId, Date.now());

  await JhaDebug.emit("scan_start", {
    runId: config.runId,
    tabId,
    source: "linkedin",
    keyword: config.keyword,
    location: config.location,
    filters: {
      f_tpr: config.f_tpr,
      f_experience: config.f_experience,
      f_job_type: config.f_job_type,
      f_remote: config.f_remote,
      salary_min: config.salary_min,
    },
    entry_url: location.href,
  });

  const session = checkSession();
  await JhaDebug.emit("session_check", {
    result: session,
    cookie_length: document.cookie.length,
    has_li_at: document.cookie.includes("li_at"),
    has_jsessionid: document.cookie.includes("JSESSIONID"),
  });
  if (session !== "live") {
    await reportSessionError(session);
    await JhaDebug.emit(
      "error",
      { where: "session", message: String(session) },
      "error"
    );
    await JhaDebug.finalize();
    if (session === "captcha") {
      console.log("[JHA] CAPTCHA detected — stopping scan, leaving page open");
    } else {
      window.location.href = "https://www.linkedin.com/login";
    }
    await chrome.storage.local.set({ scanInProgress: false });
    return;
  }

  showScanOverlay();

  const heartbeatInterval = setInterval(async () => {
    try {
      await JhaDebug.emit("heartbeat", {
        url: location.href,
        storage_keepalive_age_ms: await getStorageKeepaliveAge(),
      });
    } catch (_) {
      /* logger guarantees no throw */
    }
  }, 10000);

  let summary = null;
  try {
    summary = await runFullScan(config, tabId);
  } catch (e) {
    console.error("[JHA] Scan error:", e);
    await JhaDebug.emit(
      "error",
      { where: "init", message: e.message, stack: e.stack },
      "error"
    );
    summary = {
      scraped: 0,
      new_jobs: 0,
      existing: 0,
      stale_skipped: 0,
      jd_failed: 0,
      pages_scanned: 0,
      errors: [],
      error: e.message,
    };
  } finally {
    clearInterval(heartbeatInterval);
    hideScanOverlay();
  }

  await JhaDebug.emit("scan_end", {
    summary: {
      scraped: summary.scraped,
      new_jobs: summary.new_jobs,
      existing: summary.existing,
      stale_skipped: summary.stale_skipped,
      jd_failed: summary.jd_failed,
      pages_scanned: summary.pages_scanned,
      errors_count: (summary.errors || []).length,
    },
  });
  await JhaDebug.finalize();

  await chrome.storage.local.remove(["scanConfig"]);
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

init();
