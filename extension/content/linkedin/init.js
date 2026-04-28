/* ── LinkedIn content script entry (single long-running invocation) ──── */

async function init() {
  await runScanPipeline({
    source: "linkedin",
    bootedFlag: "__JHA_LINKEDIN_SCAN_BOOTED",
    sessionCheck: checkSession,
    reportSessionError,
    onSessionFailure: (status) => {
      if (status === "captcha") {
        console.log("[JHA] CAPTCHA detected — stopping scan, leaving page open");
      } else {
        window.location.href = "https://www.linkedin.com/login";
      }
    },
    extraSessionFields: () => ({
      has_li_at: document.cookie.includes("li_at"),
      has_jsessionid: document.cookie.includes("JSESSIONID"),
    }),
    isContinuing: () => false,
    buildScanStartData: (config, tabId) => ({
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
    }),
    runScan: (config, tabId) => runFullScan(config, tabId),
  });
}

init();
