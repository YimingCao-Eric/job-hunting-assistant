/* extension/background/auto_scrape.js
 * SW-side orchestrator for one auto-scrape cycle.
 *
 * Phase 3 entry point: self.runOneCycle()
 * Call from SW DevTools console for proof-of-life testing.
 */

const _AS_LOG_PREFIX = "[auto_scrape]";

function _asLog(...args) {
  console.log(_AS_LOG_PREFIX, ...args);
}

function _asWarn(...args) {
  console.warn(_AS_LOG_PREFIX, ...args);
}

function _asSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _asJitter(maxMs) {
  return Math.floor(Math.random() * (maxMs + 1));
}

async function _asFetchStateRow() {
  const { backendUrl, authToken } = await getSettings();
  const resp = await fetch(`${backendUrl}/admin/auto-scrape/state`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!resp.ok) throw new Error(`state HTTP ${resp.status}`);
  return resp.json();
}

async function _asPutStateMerged(patch) {
  const row = await _asFetchStateRow();
  const next = { ...(row.state || {}), ...patch };
  const { backendUrl, authToken } = await getSettings();
  const resp = await fetch(`${backendUrl}/admin/auto-scrape/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: next }),
  });
  if (!resp.ok) throw new Error(`put state HTTP ${resp.status}`);
  return resp.json();
}

async function _fetchOrchestratorConfig() {
  const { backendUrl, authToken } = await getSettings();
  const r = await fetch(`${backendUrl}/admin/auto-scrape/config`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!r.ok) throw new Error(`orchestrator config HTTP ${r.status}`);
  const row = await r.json();
  return row.config || {};
}

async function _waitForScanIdle(maxWaitMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { scanInProgress } = await chrome.storage.local.get(
      "scanInProgress"
    );
    if (!scanInProgress) return true;
    await _asSleep(2000);
  }
  return false;
}

/**
 * Returns:
 *   status: "live" | "expired" | "rate_limited" | "captcha" |
 *           "unknown_treat_as_live" | "unknown"
 */
async function _notifyCaptcha(sites) {
  const iconUrl =
    typeof chrome.runtime?.getURL === "function"
      ? chrome.runtime.getURL("icons/icon128.png")
      : "";
  for (const site of sites) {
    const notificationId = `jha-captcha-${site}`;
    try {
      const opts = {
        type: "basic",
        title: "Auto-Scrape: CAPTCHA detected",
        message: `${site} requires verification. Click to open and resolve.`,
        priority: 2,
        requireInteraction: true,
      };
      if (iconUrl) {
        opts.iconUrl = iconUrl;
      }
      await chrome.notifications.create(notificationId, opts);
      _asLog(`captcha notification fired for ${site}`);
    } catch (e) {
      _asWarn(`captcha notification failed for ${site}:`, e.message);
    }
  }
}

async function probeSiteSession(site) {
  const url = AS_PROBE_URLS[site];
  if (!url) {
    return { status: "unknown", reason: "no_probe_url" };
  }

  try {
    const resp = await fetch(url, {
      credentials: "include",
      redirect: "follow",
    });

    const finalUrl = resp.url || "";
    const httpStatus = resp.status;

    const urlLower = finalUrl.toLowerCase();
    const captchaUrlMarkers = [
      "/checkpoint/challenge",
      "/uas/login",
      "/account/login-challenge",
      "/member/captcha.htm",
      "/cdn-cgi/challenge",
    ];
    if (captchaUrlMarkers.some((m) => urlLower.includes(m))) {
      return {
        status: "captcha",
        reason: "url_marker",
        httpStatus,
        finalUrl,
      };
    }

    if (
      finalUrl.includes("/login") ||
      finalUrl.includes("/authwall") ||
      finalUrl.includes("/account/login") ||
      finalUrl.includes("/signin")
    ) {
      return {
        status: "expired",
        reason: "redirected_to_login_or_authwall",
        httpStatus,
        finalUrl,
      };
    }

    if (httpStatus === 429) {
      return {
        status: "rate_limited",
        reason: "http_429",
        httpStatus,
        finalUrl,
      };
    }

    if (httpStatus === 403) {
      return {
        status: "captcha",
        reason: "http_403",
        httpStatus,
        finalUrl,
      };
    }

    if (httpStatus >= 200 && httpStatus < 300) {
      try {
        const bodyText = await resp.clone().text();
        const bodySnippet = bodyText.slice(0, 8192).toLowerCase();
        const captchaBodyMarkers = [
          "cf-challenge-running",
          "g-recaptcha",
          "recaptcha-anchor",
          "are you a human",
          "verify you're human",
          "verify you are human",
          "please complete the security check",
          "security verification",
        ];
        if (captchaBodyMarkers.some((m) => bodySnippet.includes(m))) {
          return {
            status: "captcha",
            reason: "body_marker",
            httpStatus,
            finalUrl,
          };
        }
      } catch {
        /* fall through */
      }
      return {
        status: "live",
        reason: "http_2xx",
        httpStatus,
        finalUrl,
      };
    }

    if (httpStatus >= 500 && httpStatus < 600) {
      return {
        status: "unknown_treat_as_live",
        reason: `http_${httpStatus}_server_error`,
        httpStatus,
        finalUrl,
      };
    }

    return {
      status: "unknown",
      reason: `unexpected_http_${httpStatus}`,
      httpStatus,
      finalUrl,
    };
  } catch (e) {
    return {
      status: "unknown_treat_as_live",
      reason: "fetch_threw",
      errorName: e.name || null,
      errorMessage: e.message || null,
    };
  }
}

async function _updateSessionState(site, probeStatus) {
  const { backendUrl, authToken } = await getSettings();
  try {
    await fetch(`${backendUrl}/admin/auto-scrape/sessions/${site}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ last_probe_status: probeStatus }),
    });
  } catch (e) {
    _asWarn(`session state update failed for ${site}:`, e.message);
  }
}

async function preCycleCheck() {
  const results = {
    backend_reachable: false,
    config_loadable: false,
    sites_with_live_session: [],
    sites_probed: [],
  };

  const { backendUrl, authToken } = await getSettings();

  try {
    const r = await fetch(`${backendUrl}/health`);
    if (r.ok) {
      const j = await r.json();
      if (j.status === "ok") results.backend_reachable = true;
    }
  } catch {
    /* backend_reachable stays false */
  }
  if (!results.backend_reachable) {
    return { reason: "backend_down", details: results };
  }

  try {
    const c = await fetchConfig();
    if (c) results.config_loadable = true;
  } catch {
    /* config_loadable stays false */
  }
  if (!results.config_loadable) {
    return { reason: "config_unavailable", details: results };
  }

  for (const site of AS_DEFAULT_SITES) {
    const probeResult = await probeSiteSession(site);
    _asLog(`probe ${site}:`, probeResult);
    results.sites_probed.push({ site, ...probeResult });
    if (
      probeResult.status === "live" ||
      probeResult.status === "unknown_treat_as_live"
    ) {
      results.sites_with_live_session.push(site);
    }
    const dbStatus =
      probeResult.status === "unknown_treat_as_live"
        ? "unknown"
        : probeResult.status;
    await _updateSessionState(site, dbStatus);
  }

  if (results.sites_with_live_session.length === 0) {
    return { reason: "all_sessions_dead", details: results };
  }

  return { reason: "ok", details: results };
}

async function _updateConfigKeyword(keyword, site) {
  const { backendUrl, authToken } = await getSettings();
  const hdrs = { Authorization: `Bearer ${authToken}` };
  const gr = await fetch(`${backendUrl}/config`, { headers: hdrs });
  if (!gr.ok) throw new Error(`config get failed: ${gr.status}`);
  const cfg = await gr.json();
  const patch = {};
  if (site === "linkedin") {
    patch.keyword = keyword;
  } else if (site === "indeed") {
    patch.indeed_keyword = keyword;
  } else if (site === "glassdoor") {
    patch.glassdoor = { ...(cfg.glassdoor || {}), keyword };
  }
  const pu = await fetch(`${backendUrl}/config`, {
    method: "PUT",
    headers: { ...hdrs, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!pu.ok) throw new Error(`config put failed: ${pu.status}`);
}

async function _fetchRunLog(runId) {
  const { backendUrl, authToken } = await getSettings();
  const lr = await fetch(`${backendUrl}/extension/run-log?limit=30`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!lr.ok) throw new Error(`run-log list failed: ${lr.status}`);
  const list = await lr.json();
  const idStr = String(runId);
  const found = list.find((x) => String(x.id) === idStr);
  if (!found) throw new Error(`run-log ${runId} not found`);
  return found;
}

async function _triggerScanWithRetry(site) {
  const idle = await _waitForScanIdle(60_000);
  if (!idle) {
    _asWarn(
      `scanInProgress still true after 60s wait for ${site}; ` +
        "proceeding anyway. Backend's scan_in_progress 409 will catch " +
        "persistent stuck state."
    );
  } else {
    _asLog(`SW idle, triggering scan for ${site}`);
  }

  const body = {
    website: site,
    scan_all: true,
    scan_all_position: 1,
    scan_all_total: 2,
  };

  const { backendUrl, authToken } = await getSettings();
  const retryStartMs = Date.now();
  const deadline = retryStartMs + AS_TRIGGER_RETRY_TOTAL_DEADLINE_MS;
  let attempt = 0;

  while (attempt < AS_TRIGGER_RETRY_MAX_ATTEMPTS && Date.now() < deadline) {
    attempt++;
    let resp;
    try {
      resp = await fetch(`${backendUrl}/extension/trigger-scan`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw { code: "trigger_failed", message: `network: ${e.message}` };
    }

    if (resp.ok) {
      return;
    }

    if (resp.status === 409) {
      const payload = await resp.json().catch(() => ({}));
      const detail = payload.detail || {};
      const reason = detail.reason || "unknown";
      const retryAfterMs = detail.retry_after_ms ?? 3000;

      if (reason === "scan_in_progress") {
        throw {
          code: "scan_in_progress",
          message: detail.message || "stuck",
        };
      }
      if (reason === "scan_pending" || reason === "stop_cooldown") {
        const sleepMs =
          retryAfterMs + _asJitter(AS_TRIGGER_RETRY_JITTER_MAX_MS);
        _asLog(
          `trigger 409 ${reason}, attempt ${attempt}/${AS_TRIGGER_RETRY_MAX_ATTEMPTS}, sleeping ${sleepMs}ms`
        );
        await _asSleep(sleepMs);
        continue;
      }
      throw {
        code: "trigger_failed",
        message: `unknown 409 reason: ${reason}`,
      };
    }

    throw { code: "trigger_failed", message: `HTTP ${resp.status}` };
  }

  throw {
    code: "trigger_failed",
    message: `retry exhausted: ${attempt} attempts over ${Date.now() - retryStartMs}ms`,
  };
}

async function triggerScanAndWait(site, timeoutMs) {
  const startMs = Date.now();
  const triggerStartedAt = startMs;

  await _triggerScanWithRetry(site);

  if (typeof self.startActivePolling === "function") {
    self.startActivePolling();
  }

  const { backendUrl, authToken } = await getSettings();
  let runId = null;

  const phaseADeadline = startMs + 60000;
  while (Date.now() < phaseADeadline && !runId) {
    await _asSleep(2000);
    try {
      const r = await fetch(`${backendUrl}/extension/run-log?limit=10`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) continue;
      const list = await r.json();
      const candidate = list.find((x) => {
        if (!x.search_filters || x.search_filters.website !== site) {
          return false;
        }
        const startedAt = new Date(x.started_at).getTime();
        return startedAt >= triggerStartedAt - 5000;
      });
      if (candidate) {
        runId = candidate.id;
        _asLog(`run-log appeared: ${runId} (${site})`);
      }
    } catch {
      /* keep trying */
    }
  }

  if (!runId) {
    throw {
      code: "timeout",
      message:
        "no run-log appeared within 60s (SW may not be polling)",
    };
  }

  const phaseBDeadline = startMs + timeoutMs;
  while (Date.now() < phaseBDeadline) {
    await _asSleep(5000);
    try {
      const log = await _fetchRunLog(runId);
      if (log.status !== "running") {
        _asLog(`run-log ${runId} terminal: ${log.status}`);
        return runId;
      }
    } catch (e) {
      _asWarn(`fetch run-log ${runId} failed:`, e.message);
    }
  }

  throw {
    code: "timeout",
    message: `run-log ${runId} did not reach terminal status within ${timeoutMs}ms`,
  };
}

async function _createCycleRow() {
  const { backendUrl, authToken } = await getSettings();
  const r = await fetch(`${backendUrl}/admin/auto-scrape/cycle`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ started_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`create cycle failed: ${r.status}`);
  return r.json();
}

async function _updateCycle(cycleRowId, fields) {
  const { backendUrl, authToken } = await getSettings();
  const body = { ...fields, phase_heartbeat_at: new Date().toISOString() };
  await fetch(`${backendUrl}/admin/auto-scrape/cycle/${cycleRowId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function _wakeOrchestrator(cycleId) {
  const { backendUrl, authToken } = await getSettings();
  try {
    await fetch(`${backendUrl}/admin/auto-scrape/wake-orchestrator`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cycle_id: cycleId }),
    });
  } catch (e) {
    _asWarn("wake-orchestrator failed (non-fatal):", e.message);
  }
}

async function _cleanupInvalidEntries() {
  const { backendUrl, authToken } = await getSettings();
  try {
    await fetch(`${backendUrl}/admin/cleanup-invalid-entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch (e) {
    _asWarn("cleanup-invalid-entries failed (non-fatal):", e.message);
  }
}

async function _checkAbortFlags() {
  const flags = await chrome.storage.local.get([
    "_autoScrape_exit_requested",
    "stopRequested",
    "_backendDownDuringScan",
    "_watchdogTripped",
    "_autoScrape_config_change_pending",
  ]);
  if (flags._autoScrape_exit_requested) {
    return { abort: "cycle", reason: "exit_requested" };
  }
  if (flags.stopRequested) {
    return { abort: "cycle", reason: "user_stopped" };
  }
  if (flags._backendDownDuringScan) {
    return { abort: "cycle", reason: "backend_unavailable" };
  }
  if (flags._watchdogTripped) {
    return { abort: "cycle", reason: "sw_died" };
  }
  if (flags._autoScrape_config_change_pending) {
    return { abort: "matrix", reason: "config_changed" };
  }
  return null;
}

async function runScrapeMatrix(liveSites, keywords, cycleRowId) {
  const cycleResults = {
    scans_attempted: 0,
    scans_succeeded: 0,
    scans_failed: 0,
    failures_by_reason: {},
    run_log_ids: [],
    aborted: null,
  };

  outer: for (let siteIdx = 0; siteIdx < liveSites.length; siteIdx++) {
    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      const abortCheck = await _checkAbortFlags();
      if (abortCheck) {
        cycleResults.aborted = abortCheck.reason;
        _asLog(
          `matrix aborted: ${abortCheck.reason} (scope: ${abortCheck.abort})`
        );
        break outer;
      }

      const site = liveSites[siteIdx];
      const keyword = keywords[kwIdx];

      _asLog(
        `matrix [${siteIdx + 1}/${liveSites.length}][${kwIdx + 1}/${keywords.length}]: ${site} / "${keyword}"`
      );

      try {
        await _updateConfigKeyword(keyword, site);
      } catch (e) {
        _asWarn("config keyword update failed:", e.message);
        cycleResults.scans_attempted++;
        cycleResults.scans_failed++;
        const rr = "config_update_failed";
        cycleResults.failures_by_reason[rr] =
          (cycleResults.failures_by_reason[rr] || 0) + 1;
        continue;
      }

      let result;
      try {
        const runId = await triggerScanAndWait(site, AS_DEFAULT_SCAN_TIMEOUT_MS);
        const log = await _fetchRunLog(runId);
        result = {
          ok: log.status === "completed",
          reason:
            log.failure_reason ||
            (log.status === "failed" ? "unknown" : null),
          runId,
        };
        cycleResults.run_log_ids.push(runId);
      } catch (e) {
        result = {
          ok: false,
          reason: e.code || "unexpected_error",
          runId: null,
        };
        _asWarn("scan failed:", e);
      }

      cycleResults.scans_attempted++;
      if (result.ok) {
        cycleResults.scans_succeeded++;
      } else {
        cycleResults.scans_failed++;
        const r = result.reason || "unknown";
        cycleResults.failures_by_reason[r] =
          (cycleResults.failures_by_reason[r] || 0) + 1;
      }

      await _updateCycle(cycleRowId, {
        scans_attempted: cycleResults.scans_attempted,
        scans_succeeded: cycleResults.scans_succeeded,
        scans_failed: cycleResults.scans_failed,
        failures_by_reason: cycleResults.failures_by_reason,
        run_log_ids: cycleResults.run_log_ids,
      });

      await _asSleep(AS_DEFAULT_INTER_SCAN_DELAY_MS);
    }
  }

  return cycleResults;
}

async function runOneCycle(opts = {}) {
  const isTestCycle = opts.isTestCycle === true;
  _asLog(`runOneCycle started (testCycle=${isTestCycle})`);

  const storedInit = await chrome.storage.local.get("_autoScrape");
  const stateInit = storedInit._autoScrape || {};
  if (!stateInit.instance_id) {
    throw new Error("no instance_id; initAutoScrape did not run");
  }

  await chrome.storage.local.set({ stopRequested: false });
  await chrome.storage.local.remove([
    "_backendDownDuringScan",
    "_watchdogTripped",
    "_autoScrape_exit_requested",
    "_autoScrape_config_change_pending",
  ]);
  _asLog("cleared stale abort flags");

  if (isTestCycle) {
    await chrome.storage.local.set({
      _autoScrape: { ...stateInit, test_cycle_pending: true },
    });
  }

  try {
    _asLog("pre-cycle check...");
    const preCheck = await preCycleCheck();
    const precheckStatus = preCheck.reason;
    const precheckDetails = preCheck.details || {};
    _asLog(`pre-check result: ${precheckStatus}`, precheckDetails);

    const captchaSites = (precheckDetails.sites_probed || [])
      .filter((s) => s.status === "captcha")
      .map((s) => s.site);
    if (captchaSites.length > 0) {
      await _notifyCaptcha(captchaSites);
    }

    if (precheckStatus !== "ok") {
      let maxAllowed = 3;
      try {
        const orchCfg = await _fetchOrchestratorConfig();
        if (typeof orchCfg.max_consecutive_precheck_failures === "number") {
          maxAllowed = orchCfg.max_consecutive_precheck_failures;
        }
      } catch (e) {
        _asWarn(
          "orchestrator config unavailable; using default precheck threshold 3:",
          e.message
        );
      }

      const storedPre = await chrome.storage.local.get("_autoScrape");
      const currentCount =
        storedPre._autoScrape?.consecutive_precheck_failures ?? 0;
      const newCount = currentCount + 1;

      _asWarn(
        `precheck failed (${precheckStatus}); ` +
          `consecutive_precheck_failures: ${currentCount} → ${newCount} ` +
          `(threshold=${maxAllowed})`
      );

      try {
        await _asPutStateMerged({ consecutive_precheck_failures: newCount });
      } catch (e) {
        _asWarn("precheck counter PUT failed:", e.message);
      }

      await chrome.storage.local.set({
        _autoScrape: {
          ...(storedPre._autoScrape || {}),
          consecutive_precheck_failures: newCount,
        },
      });

      try {
        const failCycle = await _createCycleRow();
        await _updateCycle(failCycle.id, {
          status: "failed",
          precheck_status: precheckStatus,
          precheck_details: precheckDetails,
          completed_at: new Date().toISOString(),
          error_message: `Pre-cycle check failed: ${precheckStatus}`,
        });
      } catch (e) {
        _asWarn(`failed to write precheck-failure cycle row: ${e.message}`);
      }

      if (newCount >= maxAllowed) {
        _asWarn(
          `auto-pausing: ${newCount} consecutive pre-check failures ` +
            `(threshold ${maxAllowed} reached)`
        );
        try {
          await _asPutStateMerged({ enabled: false });
        } catch (e) {
          _asWarn("auto-pause state PUT failed:", e.message);
        }
        return {
          ok: false,
          results: { scans_succeeded: 0, scans_attempted: 0 },
          autopaused: true,
          reason: precheckStatus,
        };
      }

      return {
        ok: false,
        results: { scans_succeeded: 0, scans_attempted: 0 },
        reason: precheckStatus,
      };
    }

    const storedOk = await chrome.storage.local.get("_autoScrape");
    const precheckOkCount =
      storedOk._autoScrape?.consecutive_precheck_failures ?? 0;
    if (precheckOkCount > 0) {
      _asLog(
        `precheck ok; resetting consecutive_precheck_failures: ${precheckOkCount} → 0`
      );
      try {
        await _asPutStateMerged({ consecutive_precheck_failures: 0 });
      } catch (e) {
        _asWarn("precheck counter reset PUT failed:", e.message);
      }
      await chrome.storage.local.set({
        _autoScrape: {
          ...(storedOk._autoScrape || {}),
          consecutive_precheck_failures: 0,
        },
      });
    }

    const cycleRow = await _createCycleRow();
    _asLog(
      `cycle row created: id=${cycleRow.id} cycle_id=${cycleRow.cycle_id}`
    );

    await _updateCycle(cycleRow.id, {
      precheck_status: "ok",
      precheck_details: precheckDetails,
    });

    let maxDead = 24;
    try {
      const orchCfg2 = await _fetchOrchestratorConfig();
      if (typeof orchCfg2.max_consecutive_dead_session_cycles === "number") {
        maxDead = orchCfg2.max_consecutive_dead_session_cycles;
      }
    } catch (e) {
      _asWarn(
        "orchestrator config unavailable; using default dead-session threshold 24:",
        e.message
      );
    }

    let sessionStates = [];
    try {
      const { backendUrl, authToken } = await getSettings();
      const resp = await fetch(`${backendUrl}/admin/auto-scrape/sessions`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (resp.ok) {
        sessionStates = await resp.json();
      }
    } catch (e) {
      _asWarn(`failed to fetch session states: ${e.message}`);
    }

    const liveSites = precheckDetails.sites_with_live_session || [];

    const eligibleSites = liveSites.filter((site) => {
      const ss = sessionStates.find((s) => s.site === site);
      if (ss && ss.consecutive_failures >= maxDead) {
        _asWarn(
          `site ${site} suspended ` +
            `(${ss.consecutive_failures} consecutive failures >= ${maxDead}); ` +
            `excluding from matrix`
        );
        return false;
      }
      if (ss && ss.last_probe_status === "captcha") {
        _asWarn(
          `site ${site} suspended (CAPTCHA pending resolution); excluding from matrix`
        );
        return false;
      }
      return true;
    });

    if (eligibleSites.length === 0) {
      _asWarn(
        "all eligible sites suspended due to dead sessions; cycle is no-op"
      );
      try {
        await _updateCycle(cycleRow.id, {
          status: "failed",
          error_message:
            "All eligible sites suspended (consecutive dead-session threshold reached)",
          completed_at: new Date().toISOString(),
        });
      } catch (e) {
        _asWarn(`failed to update all-suspended cycle row: ${e.message}`);
      }
      return {
        ok: false,
        cycle_id: cycleRow.cycle_id,
        cycle_row_id: cycleRow.id,
        results: {
          scans_attempted: 0,
          scans_succeeded: 0,
          scans_failed: 0,
          failures_by_reason: {},
        },
      };
    }

    const keywords = AS_DEFAULT_KEYWORDS;
    const cycleResults = await runScrapeMatrix(
      eligibleSites,
      keywords,
      cycleRow.id
    );

    _asLog("post-cycle cleanup-invalid-entries...");
    await _cleanupInvalidEntries();

    const finalStatus = cycleResults.aborted ? "failed" : "scrape_complete";
    await _updateCycle(cycleRow.id, {
      status: finalStatus,
      scans_attempted: cycleResults.scans_attempted,
      scans_succeeded: cycleResults.scans_succeeded,
      scans_failed: cycleResults.scans_failed,
      failures_by_reason: cycleResults.failures_by_reason,
      run_log_ids: cycleResults.run_log_ids,
      ...(cycleResults.aborted
        ? {
            completed_at: new Date().toISOString(),
            error_message: `Cycle aborted: ${cycleResults.aborted}`,
          }
        : {
            completed_at: new Date().toISOString(),
          }),
    });

    await _wakeOrchestrator(cycleRow.cycle_id);

    _asLog(`cycle done: status=${finalStatus}`, cycleResults);
    return {
      ok: !cycleResults.aborted,
      cycle_id: cycleRow.cycle_id,
      cycle_row_id: cycleRow.id,
      results: cycleResults,
    };
  } finally {
    const sFin = await chrome.storage.local.get("_autoScrape");
    const stFin = { ...(sFin._autoScrape || {}) };
    stFin.test_cycle_pending = false;
    await chrome.storage.local.set({ _autoScrape: stFin });
  }
}

let _handleGracefulExitInFlight = null;

async function handleGracefulExit() {
  if (_handleGracefulExitInFlight) {
    return _handleGracefulExitInFlight;
  }
  _handleGracefulExitInFlight = (async () => {
    try {
      _asLog("graceful exit started");

      await chrome.storage.local.set({ _backendDownDuringScan: true });

      await _asSleep(5000);

      try {
        await chrome.alarms.clear("auto_scrape_next_cycle");
      } catch (e) {
        _asWarn("clear alarm failed:", e.message);
      }

      try {
        await _asPutStateMerged({
          enabled: false,
          exit_requested: false,
          test_cycle_pending: false,
          next_cycle_at: 0,
        });
      } catch (e) {
        _asWarn("graceful exit: state update failed:", e.message);
      }

      await chrome.storage.local.remove([
        "_autoScrape_exit_requested",
        "_autoScrape_config_change_pending",
        "_backendDownDuringScan",
      ]);

      const stored = await chrome.storage.local.get("_autoScrape");
      const autoScrape = stored._autoScrape || {};
      autoScrape.enabled = false;
      autoScrape.test_cycle_pending = false;
      autoScrape.cycle_phase = "idle";
      autoScrape.next_cycle_at = 0;
      await chrome.storage.local.set({ _autoScrape: autoScrape });

      _asLog("graceful exit complete");
    } finally {
      _handleGracefulExitInFlight = null;
    }
  })();

  return _handleGracefulExitInFlight;
}

async function scheduleNextCycle(cycleResult, elapsedMs) {
  const succeededCount = cycleResult?.results?.scans_succeeded ?? 0;

  let minIntervalMs = AS_DEFAULT_MIN_CYCLE_INTERVAL_MS;
  try {
    const row = await _asFetchStateRow();
    const live = (row.state || {}).min_cycle_interval_ms;
    if (typeof live === "number" && live > 0) {
      minIntervalMs = live;
    }
  } catch {
    /* use default */
  }

  let sleepMs = Math.max(0, minIntervalMs - elapsedMs);

  if (succeededCount === 0 && elapsedMs < 30_000) {
    const trivialCooldownMs = 5 * 60 * 1000;
    if (sleepMs < trivialCooldownMs) {
      _asLog(
        `SC-4: trivially-short cycle (${elapsedMs}ms, 0 succeeded); ` +
          `extending sleep from ${sleepMs}ms to ${trivialCooldownMs}ms`
      );
      sleepMs = trivialCooldownMs;
    }
  }

  const nextAt = Date.now() + sleepMs;

  await chrome.alarms.create("auto_scrape_next_cycle", { when: nextAt });
  _asLog(
    `next cycle scheduled at ${new Date(nextAt).toISOString()} ` +
      `(sleep ${sleepMs}ms; succeeded=${succeededCount}, elapsed=${elapsedMs}ms)`
  );

  try {
    await _asPutStateMerged({ next_cycle_at: nextAt });
  } catch (e) {
    _asWarn("scheduleNextCycle: next_cycle_at PUT failed:", e.message);
  }
}

async function onAutoScrapeAlarm() {
  _asLog("auto_scrape_next_cycle alarm fired");

  let state;
  try {
    const row = await _asFetchStateRow();
    state = row.state || {};
  } catch (e) {
    _asWarn(`auto-scrape state fetch error: ${e.message}`);
    return;
  }

  if (state.exit_requested === true) {
    _asLog("alarm: exit_requested=true; entering graceful exit");
    await handleGracefulExit();
    return;
  }

  const isTestCycle = state.test_cycle_pending === true;
  const isContinuous = state.enabled === true;

  if (!isContinuous && !isTestCycle) {
    _asLog("alarm: neither enabled nor test_cycle_pending; not running");
    return;
  }

  const cycleStartedAt = Date.now();
  let cycleResult;
  try {
    cycleResult = await runOneCycle({ isTestCycle });
  } catch (e) {
    _asWarn("alarm: runOneCycle threw:", e);
    cycleResult = {
      ok: false,
      results: { scans_succeeded: 0, scans_attempted: 0 },
    };
  }

  const elapsedMs = Date.now() - cycleStartedAt;

  if (isTestCycle) {
    try {
      await _asPutStateMerged({ test_cycle_pending: false });
    } catch (e) {
      _asWarn("alarm: failed to clear test_cycle_pending:", e.message);
    }
  }

  if (isContinuous) {
    try {
      const row2 = await _asFetchStateRow();
      const s2 = row2.state || {};
      if (s2.exit_requested === true) {
        _asLog("alarm: exit_requested set during cycle; not rescheduling");
        await handleGracefulExit();
        return;
      }
      if (s2.enabled !== true) {
        _asLog("alarm: enabled=false (paused during cycle); not rescheduling");
        return;
      }
      await scheduleNextCycle(cycleResult, elapsedMs);
    } catch (e) {
      _asWarn("alarm: state recheck failed; not rescheduling:", e.message);
    }
  } else {
    _asLog(
      "alarm: test cycle complete; not rescheduling (continuous mode off)"
    );
  }
}

self.runOneCycle = runOneCycle;
self.handleGracefulExit = handleGracefulExit;
self.scheduleNextCycle = scheduleNextCycle;
self.onAutoScrapeAlarm = onAutoScrapeAlarm;
self.preCycleCheck = preCycleCheck;
self.probeSiteSession = probeSiteSession;
self._notifyCaptcha = _notifyCaptcha;
