/* ── Shared scan lifecycle for LinkedIn / Indeed / Glassdoor init.js ───── */

/**
 * Canonical scan pipeline: storage wait, boot guard, debug, session, overlay,
 * heartbeat (first tick skips storage_keepalive_age_ms — BUG-5), SW watchdog (B-24).
 *
 * @param {object} opts
 * @param {"linkedin"|"indeed"|"glassdoor"} opts.source
 * @param {string} opts.bootedFlag - window key for duplicate-boot guard (B-9)
 * @param {() => string} opts.sessionCheck - returns "live" | "expired" | "captcha" | "redirected"
 * @param {(status: string) => Promise<void>|void} [opts.reportSessionError]
 * @param {(status: string) => void} [opts.onSessionFailure]
 * @param {boolean} [opts.abortOnNonLiveSession=true]
 * @param {(config: object, runMeta: object|undefined) => boolean} [opts.isContinuing]
 * @param {(config: object, tabId: number|undefined) => object} opts.buildScanStartData
 * @param {(config: object, tabId: number|undefined) => Promise<object>} opts.runScan
 * @param {(config: object, tabId: number|undefined) => Promise<object|null>} [opts.beforeShowOverlay]
 * @param {(summary: object) => boolean} [opts.skipScanComplete] - e.g. Indeed pagination
 * @param {(status: string) => object} [opts.extraSessionFields] - merged into session_check emit
 */
async function runScanPipeline(opts) {
  let storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
  if (!storage.scanInProgress) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      storage = await chrome.storage.local.get(["scanInProgress", "scanConfig"]);
      if (storage.scanInProgress) break;
    }
  }
  if (!storage.scanInProgress) {
    console.log(`[JHA-${opts.source}] init: scanInProgress not set after 3s — exiting`);
    return;
  }

  const config = storage.scanConfig;
  if (!config) {
    console.log(`[JHA-${opts.source}] init: no scanConfig — exiting`);
    return;
  }

  if (window[opts.bootedFlag]) {
    console.log(`[JHA-${opts.source}] init: duplicate boot in same document — exiting`);
    return;
  }
  window[opts.bootedFlag] = true;

  const tabResult = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, resolve)
  );
  const tabId = tabResult?.id;

  const { _jhaDebugRunMeta: dbgBefore } = await chrome.storage.local.get(
    "_jhaDebugRunMeta"
  );
  const continuing = opts.isContinuing
    ? opts.isContinuing(config, dbgBefore)
    : false;

  await JhaDebug.init(config.runId, Date.now());

  if (!continuing) {
    await JhaDebug.emit("scan_start", {
      runId: config.runId,
      tabId,
      source: opts.source,
      ...opts.buildScanStartData(config, tabId),
    });
  }

  const sessionStatus = opts.sessionCheck();
  const sessionPayload = {
    result: sessionStatus,
    cookie_length: document.cookie.length,
  };
  if (typeof opts.extraSessionFields === "function") {
    Object.assign(sessionPayload, opts.extraSessionFields(sessionStatus));
  }
  await JhaDebug.emit("session_check", sessionPayload);

  const abortSession =
    (opts.abortOnNonLiveSession !== false) && sessionStatus !== "live";
  if (abortSession) {
    if (opts.reportSessionError) await opts.reportSessionError(sessionStatus);
    await JhaDebug.emit(
      "error",
      { where: "session", message: String(sessionStatus) },
      "error"
    );
    await JhaDebug.finalize();
    if (opts.onSessionFailure) opts.onSessionFailure(sessionStatus);
    await chrome.storage.local.set({ scanInProgress: false });
    return;
  }

  const earlySummary = opts.beforeShowOverlay
    ? await opts.beforeShowOverlay(config, tabId)
    : null;

  let summary = null;

  if (earlySummary) {
    summary = earlySummary;
  } else {
    showScanOverlay();

    let firstHeartbeat = true;
    const heartbeatInterval = setInterval(async () => {
      try {
        if (firstHeartbeat) {
          firstHeartbeat = false;
          await JhaDebug.emit("heartbeat", { url: location.href });
          return;
        }
        const { _keepalive } = await chrome.storage.local.get("_keepalive");
        const ageMs = _keepalive ? Date.now() - _keepalive : null;
        await JhaDebug.emit("heartbeat", {
          url: location.href,
          storage_keepalive_age_ms: ageMs,
        });

        const swRaw = await chrome.storage.local.get("_swDeathCounter");
        const _swDeathCounter = Number(swRaw._swDeathCounter) || 0;
        if (ageMs != null && ageMs > 60000) {
          const next = _swDeathCounter + 1;
          await chrome.storage.local.set({ _swDeathCounter: next });
          if (next >= 3) {
            try {
              await chrome.runtime.sendMessage({ type: "PING" });
            } catch {
              /* ignore */
            }
          }
          if (next >= 4) {
            await JhaDebug.emit(
              "error",
              { where: "watchdog", message: "sw_died", age_ms: ageMs },
              "error"
            );
            await chrome.storage.local.set({ _watchdogTripped: true });
            await chrome.storage.local.remove("_swDeathCounter");
          }
        } else if (_swDeathCounter > 0) {
          await chrome.storage.local.remove("_swDeathCounter");
        }
      } catch (_) {
        /* logger guarantees no throw */
      }
    }, 10000);

    try {
      summary = await opts.runScan(config, tabId);
    } catch (e) {
      console.error(`[JHA-${opts.source}] Scan error:`, e);
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
        errors: [{ type: "init_crash", message: e.message }],
        error: e.message,
      };
    } finally {
      clearInterval(heartbeatInterval);
      const partial = opts.skipScanComplete && opts.skipScanComplete(summary);
      if (!partial) hideScanOverlay();
      await chrome.storage.local.remove("_swDeathCounter");
    }

    if (opts.skipScanComplete && opts.skipScanComplete(summary)) {
      return;
    }
  }

  if (opts.skipScanComplete && opts.skipScanComplete(summary)) {
    return;
  }

  const flagsEnd = await chrome.storage.local.get([
    "_watchdogTripped",
    "_backendDownDuringScan",
  ]);
  if (flagsEnd._backendDownDuringScan) {
    summary = summary || {};
    summary.error = "backend_unavailable";
    summary.aborted_reason = "backend_unavailable";
    await chrome.storage.local.remove("_backendDownDuringScan");
  }
  if (flagsEnd._watchdogTripped) {
    summary = summary || {};
    summary.error = "sw_died";
    summary.aborted_reason = "sw_died";
    await chrome.storage.local.remove("_watchdogTripped");
    await chrome.storage.local.remove("_swDeathCounter");
  }

  const pagesScanned = summary.pages_scanned ?? summary.pages ?? 0;
  await JhaDebug.emit("scan_end", {
    summary: {
      scraped: summary.scraped,
      new_jobs: summary.new_jobs,
      existing: summary.existing,
      stale_skipped: summary.stale_skipped,
      jd_failed: summary.jd_failed,
      pages_scanned: pagesScanned,
      errors_count: (summary.errors || []).length,
    },
  });
  await JhaDebug.finalize();

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
