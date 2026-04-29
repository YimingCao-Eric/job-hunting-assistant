/* ── Manual scan handler ──────────────────────────────────────────────── */

function classifySetupError(e) {
  const msg = String(e?.message ?? e ?? "");
  if (msg.includes("config")) return "setup_config_unavailable";
  if (msg.includes("popup")) return "setup_popup_failed";
  if (msg.includes("timeout")) return "setup_timeout";
  if (msg.includes("permission")) return "setup_permission_denied";
  if (msg.includes("run_log_update")) return "setup_run_log_update_failed";
  return "setup_unknown";
}

async function markManualScanSetupFailed(
  backendUrl,
  authToken,
  runId,
  e,
  reason
) {
  try {
    await fetch(`${backendUrl}/extension/run-log/${runId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "failed",
        failure_reason: reason,
        failure_category: "transient",
        error_message: `Setup failed: ${e?.message ?? e}`,
        completed_at: new Date().toISOString(),
      }),
    });
  } catch {
    /* best effort */
  }
}

async function handleManualScan(options = {}) {
  const {
    websiteOverride = null,
    scan_all = false,
    scan_all_position = null,
    scan_all_total = null,
  } = options;

  await chrome.storage.local.set({ stopRequested: false });
  await chrome.storage.local.remove("scanPageState");
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (scanInProgress) {
    console.warn(
      "[JHA] handleManualScan: scanInProgress is true; trigger ignored. " +
        "If this happens during an auto-scrape cycle, the orchestrator " +
        "should have called _waitForScanIdle before triggering."
    );
    return;
  }

  const { backendUrl, authToken } = await getSettings();

  const preliminaryWebsite = websiteOverride || "linkedin";

  let runId;
  try {
    const initBody = {
      strategy: "C",
      search_filters: { website: preliminaryWebsite },
      scan_all: !!scan_all,
    };
    if (scan_all) {
      initBody.scan_all_position = scan_all_position;
      initBody.scan_all_total = scan_all_total;
    }
    const initRes = await fetch(`${backendUrl}/extension/run-log/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    });
    if (!initRes.ok) {
      console.error(
        "[JHA] Cannot create initial run-log:",
        initRes.status,
        await initRes.text().catch(() => "")
      );
      return;
    }
    runId = (await initRes.json()).id;
  } catch (e) {
    console.error("[JHA] Cannot create run-log; backend unreachable:", e);
    return;
  }

  try {
    try {
      await fetch(`${backendUrl}/extension/state`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stop_requested: false }),
      });
    } catch (e) {
      console.warn("[JHA] Could not clear stop_requested:", e.message);
    }

    try {
      await fetch(`${backendUrl}/extension/state`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          current_page: 1,
          today_searches: 0,
        }),
      });
    } catch (e) {
      console.warn("[JHA] scan_manual: could not reset extension state:", e.message);
    }

    const config = await fetchConfig();
    if (!config) throw new Error("config_unavailable");

    const effectiveWebsite =
      websiteOverride || config.website || "linkedin";

    let f_tpr = await computeFtpr(config.f_tpr_bound, effectiveWebsite);
    const liHours = parseInt(String(config.linkedin_f_tpr ?? "").trim(), 10);
    if (!Number.isNaN(liHours) && liHours > 0) {
      f_tpr = `r${liHours * 3600}`;
    }

    const isIndeed = effectiveWebsite === "indeed";
    const isGlassdoor = effectiveWebsite === "glassdoor";
    let runLogBody;
    if (isIndeed) {
      runLogBody = {
        strategy: "C",
        search_keyword: config.indeed_keyword || config.keyword,
        search_location: config.indeed_location || config.location,
        search_filters: {
          website: effectiveWebsite,
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
      };
    } else if (isGlassdoor) {
      const g = config.glassdoor || {};
      runLogBody = {
        strategy: "C",
        search_keyword: g.keyword || config.keyword,
        search_location: g.location || config.location,
        search_filters: {
          website: effectiveWebsite,
          ...(config.glassdoor || {}),
          general_date_posted: config.general_date_posted ?? null,
          general_internship_only:
            config.general_internship_only === true ? true : null,
          general_remote_only:
            config.general_remote_only === true ? true : null,
        },
      };
    } else {
      runLogBody = {
        strategy: "C",
        search_keyword: config.keyword,
        search_location: config.location,
        search_filters: {
          website: effectiveWebsite,
          f_tpr,
          linkedin_f_tpr: config.linkedin_f_tpr,
          f_experience: config.f_experience,
          f_job_type: config.f_job_type,
          f_remote: config.f_remote,
          salary_min: config.salary_min,
          general_date_posted: config.general_date_posted ?? null,
          general_internship_only:
            config.general_internship_only === true ? true : null,
          general_remote_only:
            config.general_remote_only === true ? true : null,
        },
      };
    }

    if (scan_all) {
      runLogBody.scan_all = true;
      runLogBody.scan_all_position = scan_all_position;
      runLogBody.scan_all_total = scan_all_total;
    }

    const updateRes = await fetch(
      `${backendUrl}/extension/run-log/${runId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          search_keyword: runLogBody.search_keyword,
          search_location: runLogBody.search_location,
          search_filters: runLogBody.search_filters,
        }),
      }
    );
    if (!updateRes.ok) {
      throw new Error(
        `run_log_update_failed: ${updateRes.status} ${await updateRes.text().catch(() => "")}`
      );
    }

    let searchUrl;
    if (effectiveWebsite === "indeed") {
      searchUrl = buildIndeedSearchUrl(config, 0);
    } else if (effectiveWebsite === "glassdoor") {
      searchUrl = buildGlassdoorSearchUrl(config);
    } else {
      searchUrl = buildSearchUrl(config, f_tpr, 0);
    }

    const win = await chrome.windows.create({
      url: searchUrl,
      type: "popup",
      width: 1280,
      height: 800,
      focused: false,
    });
    const tabId = win.tabs[0].id;

    await chrome.storage.local.set({
      scanInProgress: true,
      scanConfig: {
        ...config,
        f_tpr,
        runId,
        website: effectiveWebsite,
        tabId,
      },
      liveProgress: {
        scraped: 0,
        new_jobs: 0,
        existing: 0,
        stale_skipped: 0,
        jd_failed: 0,
        page: 1,
      },
    });

    startKeepAlive();
    startActivePolling();

    const SCAN_TIMEOUT_MS = 90 * 60 * 1000;
    const scanTimeoutId = setTimeout(async () => {
      const { scanInProgress: sip } = await chrome.storage.local.get(
        "scanInProgress"
      );
      if (!sip) return;
      console.warn("[JHA] Scan safety timeout (90min) — force-completing");
      const { scanConfig: sc } = await chrome.storage.local.get("scanConfig");
      const tabIdToClose = sc?.tabId;
      if (sc?.runId) {
        await fetch(`${backendUrl}/extension/run-log/${sc.runId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            status: "failed",
            error_message: "Scan timeout — exceeded 90 minutes",
          }),
        }).catch(() => {});
      }
      await chrome.storage.local.set({
        scanInProgress: false,
        liveProgress: null,
      });
      await chrome.storage.local.remove(["scanConfig", "scanPageState"]);
      if (tabIdToClose != null) {
        try {
          await chrome.tabs.remove(tabIdToClose);
        } catch {
          /* tab may already be gone */
        }
      }
      stopKeepAlive();
      stopActivePolling();
    }, SCAN_TIMEOUT_MS);

    await chrome.storage.local.set({
      scanTimeoutId,
    });
  } catch (e) {
    const reason = classifySetupError(e);
    console.error(`[JHA] Setup failed: ${reason}`, e);
    await markManualScanSetupFailed(
      backendUrl,
      authToken,
      runId,
      e,
      reason
    );
    await chrome.storage.local.set({ scanInProgress: false });
  }
}
