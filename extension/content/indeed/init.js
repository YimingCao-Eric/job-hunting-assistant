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

  await chrome.storage.local.set({ scanConfig: config });

  await runScanPipeline({
    source: "indeed",
    bootedFlag: "__JHA_INDEED_SCAN_BOOTED",
    sessionCheck: checkSession,
    reportSessionError: async (status) => {
      await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "SESSION_ERROR", error: status }, resolve)
      );
    },
    onSessionFailure: null,
    extraSessionFields: () => ({
      has_indeed_session_cookies:
        document.cookie.includes("CTK") ||
        document.cookie.includes("INDEED_CSRF_TOKEN"),
    }),
    isContinuing: (cfg, meta) =>
      !!(meta && meta.runId === cfg.runId && meta.scanStartMs != null),
    buildScanStartData: (cfg) => ({
      keyword: cfg.indeed_keyword || cfg.keyword,
      location: cfg.indeed_location || cfg.location,
    }),
    skipScanComplete: (summary) => summary && summary.done === false,
    runScan: async (cfg, _tabId) => {
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

      return runSinglePage(cfg, state);
    },
  });
}

init();
