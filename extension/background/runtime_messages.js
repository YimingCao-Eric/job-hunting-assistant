/* ── chrome.runtime message router ─────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof startKeepAlive === "function") {
    stopKeepAlive();
    startKeepAlive();
  }
  if (message.type === "MANUAL_SCAN") {
    handleManualScan();
    return false;
  }
  if (message.type === "INGEST_JOB") {
    if (message.correlationId && sender.tab?.id) {
      sendResponse({
        ack: true,
        correlationId: message.correlationId,
      });
      const tabId = sender.tab.id;
      const cid = message.correlationId;
      (async () => {
        try {
          const result = await handleIngest(message.job);
          chrome.tabs
            .sendMessage(tabId, {
              type: "INGEST_JOB_RESULT",
              correlationId: cid,
              result,
            })
            .catch(() => {});
        } catch (e) {
          console.error("[JHA] handleIngest failed:", e.message);
          chrome.tabs
            .sendMessage(tabId, {
              type: "INGEST_JOB_RESULT",
              correlationId: cid,
              result: {
                id: null,
                already_exists: false,
                content_duplicate: false,
                error: e.message,
              },
            })
            .catch(() => {});
        }
      })();
      return false;
    }
    (async () => {
      try {
        const result = await handleIngest(message.job);
        sendResponse(result);
      } catch (e) {
        console.error("[JHA] handleIngest failed:", e.message);
        sendResponse({
          id: null,
          already_exists: false,
          content_duplicate: false,
          error: e.message,
        });
      }
    })();
    return true;
  }
  if (message.type === "GET_TAB_ID") {
    sendResponse({ id: sender.tab?.id });
    return false;
  }
  if (message.type === "GET_EXTENSION_STATE") {
    (async () => {
      const { backendUrl, authToken } = await getSettings();
      try {
        const res = await fetch(`${backendUrl}/extension/state`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        sendResponse(
          res.ok
            ? await res.json()
            : { current_page: 1, today_searches: 0 }
        );
      } catch {
        sendResponse({ current_page: 1, today_searches: 0 });
      }
    })();
    return true;
  }
  if (message.type === "PUT_EXTENSION_STATE") {
    (async () => {
      const { backendUrl, authToken } = await getSettings();
      try {
        await fetch(`${backendUrl}/extension/state`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message.data),
        });
      } catch {}
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.type === "STOP_SCAN") {
    chrome.storage.local.set({ stopRequested: true });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "TRIGGER_STOP") {
    chrome.storage.local.set({ stopRequested: true });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "NAVIGATE_SCAN_TAB") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId) {
          await chrome.tabs.update(tabId, { url: message.url });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.type === "SESSION_ERROR") {
    (async () => {
      await chrome.storage.local.set({ lastSessionError: message.error });
      const { backendUrl, authToken } = await getSettings();
      try {
        await fetch(`${backendUrl}/extension/session-error`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ error: message.error }),
        });
      } catch {}
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.type === "GET_CONFIG") {
    (async () => {
      try {
        const config = await fetchConfig();
        sendResponse(config);
      } catch (e) {
        console.error("[JHA] GET_CONFIG error:", e.message);
        sendResponse(null);
      }
    })();
    return true;
  }
  if (message.type === "CHECK_STOP") {
    (async () => {
      const { stopRequested } = await chrome.storage.local.get("stopRequested");
      sendResponse({ stop: !!stopRequested });
    })();
    return true;
  }
  if (message.type === "SCAN_STARTED") {
    (async () => {
      try {
        const { backendUrl, authToken } = await getSettings();
        const runRes = await fetch(`${backendUrl}/extension/run-log/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strategy: "C",
            search_keyword: message.keyword || "software engineer",
            search_location: message.location || "Canada",
            search_filters: {
              website: message.source || "glassdoor",
              ...(message.filters || {}),
            },
          }),
        });
        const { id: runId } = await runRes.json();
        sendResponse({ runId });
      } catch (e) {
        console.error("[JHA] SCAN_STARTED error:", e.message);
        sendResponse({ runId: null });
      }
    })();
    return true;
  }
  if (message.type === "SCAN_COMPLETE") {
    (async () => {
      try {
        if (!message.runId) { sendResponse({ ok: false }); return; }
        const { backendUrl, authToken } = await getSettings();
        await fetch(`${backendUrl}/extension/run-log/${message.runId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            status: "completed",
            completed_at: new Date().toISOString(),
            pages_scanned: message.counters?.pages ?? 0,
            scraped: message.counters?.scraped || 0,
            new_jobs: message.counters?.new_jobs || 0,
            existing: message.counters?.existing || 0,
            stale_skipped: message.counters?.stale_skipped || 0,
            jd_failed: message.counters?.jd_failed || 0,
            early_stop: !!message.counters?.early_stop,
            errors: message.counters?.errors || [],
          }),
        });
        sendResponse({ ok: true });
      } catch (e) {
        console.error("[JHA] SCAN_COMPLETE error:", e.message);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (message.type === "GET_MAIN_WORLD_VALUE") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ value: null });
          return;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const key =
              window?._initialData?.oneGraphApiKey ||
              window?.mosaic?.providerData?.["mosaic-provider-jobcards"]?.oneGraphApiKey ||
              window?.mosaic?.providerData?.["js-match-insights-provider-job-details"]
                ?.oneGraphApiKey ||
              null;
            return key;
          },
        });

        const value = results?.[0]?.result || null;
        sendResponse({ value });
      } catch (e) {
        console.error("[JHA] GET_MAIN_WORLD_VALUE error:", e.message);
        sendResponse({ value: null });
      }
    })();
    return true;
  }
});
