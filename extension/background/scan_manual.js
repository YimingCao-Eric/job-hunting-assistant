/* ── Manual scan handler ──────────────────────────────────────────────── */

async function handleManualScan(options = {}) {
  const { websiteOverride = null } = options;

  await chrome.storage.local.set({ stopRequested: false });
  await chrome.storage.local.remove("scanPageState");
  const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
  if (scanInProgress) return;

  const { backendUrl, authToken } = await getSettings();
  await fetch(`${backendUrl}/extension/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ current_page: 1, today_searches: 0 }),
  }).catch(() => {});

  const config = await fetchConfig();
  if (!config) {
    console.log("[JHA] Cannot fetch config — backend unreachable");
    return;
  }

  const effectiveWebsite =
    websiteOverride || config.website || "linkedin";

  let f_tpr = await computeFtpr(config.f_tpr_bound);
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

  const runRes = await fetch(`${backendUrl}/extension/run-log/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(runLogBody),
  });
  const { id: runId } = await runRes.json();

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

  const SCAN_TIMEOUT_MS = 90 * 60 * 1000;
  const scanTimeoutId = setTimeout(async () => {
    const { scanInProgress } = await chrome.storage.local.get("scanInProgress");
    if (!scanInProgress) return;
    console.warn("[JHA] Scan safety timeout (90min) — force-completing");
    const { scanConfig } = await chrome.storage.local.get("scanConfig");
    if (scanConfig?.runId) {
      await fetch(`${backendUrl}/extension/run-log/${scanConfig.runId}`, {
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
    stopKeepAlive();
  }, SCAN_TIMEOUT_MS);

  await chrome.storage.local.set({
    scanTimeoutId: scanTimeoutId.toString(),
  });
}
