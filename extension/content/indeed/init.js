/* ── Indeed content script entry ───────────────────────────────────────── */

async function ensureIndeedRunLog(config) {
  if (config.runId) return config;
  const { backendUrl, authToken } = await chrome.storage.local.get([
    "backendUrl",
    "authToken",
  ]);
  if (!backendUrl || !authToken) {
    console.error("[JHA-Indeed] ensureIndeedRunLog: missing backendUrl/authToken");
    return config;
  }
  const runRes = await fetch(`${backendUrl}/extension/run-log/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      strategy: "C",
      search_keyword: config.indeed_keyword || config.keyword || "software engineer",
      search_location: config.indeed_location || config.location || "Canada",
      search_filters: {
        website: "indeed",
        indeed_fromage: config.indeed_fromage,
        indeed_jt: config.indeed_jt,
        indeed_remotejob: config.indeed_remotejob,
        indeed_sort: "relevance",
        indeed_explvl: config.indeed_explvl,
        indeed_lang: config.indeed_lang,
        general_date_posted: config.general_date_posted ?? null,
        general_internship_only:
          config.general_internship_only === true ? true : null,
        general_remote_only:
          config.general_remote_only === true ? true : null,
      },
    }),
  });
  if (!runRes.ok) {
    console.warn("[JHA-Indeed] ensureIndeedRunLog: HTTP", runRes.status);
    return config;
  }
  let data;
  try {
    data = await runRes.json();
  } catch {
    return config;
  }
  const runId = data?.id;
  if (!runId) return config;
  const next = { ...config, runId };
  await chrome.storage.local.set({ scanConfig: next });
  return next;
}

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

  let config = storage.scanConfig;
  if (!config) {
    console.log("[JHA-Indeed] no scanConfig — exiting");
    return;
  }

  config = await ensureIndeedRunLog(config);

  if (!config.tabId) {
    console.error("[JHA-Indeed] init: missing tabId, aborting");
    if (config.runId) {
      await new Promise((resolve) =>
        chrome.runtime.sendMessage(
          {
            type: "SCAN_COMPLETE",
            runId: config.runId,
            counters: {
              scraped: 0,
              new_jobs: 0,
              existing: 0,
              stale_skipped: 0,
              jd_failed: 0,
              pages: 0,
              pages_scanned: 0,
              errors: [],
            },
          },
          resolve
        )
      );
    }
    await chrome.storage.local.set({ scanInProgress: false });
    await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
    return;
  }

  if (!config.runId) {
    console.error("[JHA-Indeed] init: missing runId after ensureIndeedRunLog");
    await chrome.storage.local.set({ scanInProgress: false });
    await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
    return;
  }

  showScanOverlay();

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  const { debugLog: dbgBefore } = await chrome.storage.local.get("debugLog");
  const continuing =
    dbgBefore &&
    dbgBefore.runId === config.runId &&
    dbgBefore.scanStartMs != null;
  await JhaDebug.init(config.runId, Date.now());

  if (!continuing) {
    await JhaDebug.emit("scan_start", {
      runId: config.runId,
      tabId,
      source: "indeed",
      keyword: config.indeed_keyword || config.keyword,
      location: config.indeed_location || config.location,
    });
  }

  const session = checkSession();
  await JhaDebug.emit("session_check", {
    result: session,
    cookie_length: document.cookie.length,
    has_indeed_session_cookies:
      document.cookie.includes("CTK") ||
      document.cookie.includes("INDEED_CSRF_TOKEN"),
  });
  if (session !== "live") {
    await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "SESSION_ERROR", error: session }, resolve)
    );
    await JhaDebug.emit(
      "error",
      { where: "indeed_session", message: String(session) },
      "error"
    );
    await JhaDebug.finalize();
    hideScanOverlay();
    await chrome.storage.local.set({ scanInProgress: false });
    return;
  }

  const heartbeatInterval = setInterval(async () => {
    try {
      const { _keepalive } = await chrome.storage.local.get("_keepalive");
      await JhaDebug.emit("heartbeat", {
        url: location.href,
        storage_keepalive_age_ms: _keepalive ? Date.now() - _keepalive : null,
      });
    } catch (_) {
      /* never throw */
    }
  }, 10000);

  try {
    const { scanPageState } = await chrome.storage.local.get("scanPageState");
    const state =
      scanPageState ||
      (await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" }, resolve)
      ));

    await JhaDebug.emit("page_load", {
      url: location.href,
      current_page: state.current_page,
      state_source: scanPageState ? "storage" : "backend",
    });
    JhaDebug.setPage(state.current_page || 1);

    const summary = await runSinglePage(config, state);

    if (summary.done) {
      hideScanOverlay();
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
      await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
      await chrome.storage.local.set({
        scanInProgress: false,
        scanComplete: { tabId, summary, runId: config.runId, completedAt: Date.now() },
      });
    }
  } catch (e) {
    console.error("[JHA-Indeed] Scan error:", e);
    hideScanOverlay();
    await JhaDebug.emit(
      "error",
      {
        where: "indeed_init",
        message: e.message,
        stack: e.stack,
      },
      "error"
    );
    await JhaDebug.finalize();
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
  } finally {
    clearInterval(heartbeatInterval);
  }
}

init();
