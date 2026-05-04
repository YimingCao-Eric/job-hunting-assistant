/* ── chrome.runtime messaging for job ingest (content → background) ─────
 *
 * Never call fetch() to the backend (e.g. localhost:8000) from a content script.
 * Other extensions (e.g. Adobe Acrobat) may wrap window.fetch on the page and
 * corrupt API responses. INGEST_JOB is handled in the service worker only.
 *
 * LinkedIn / Indeed / Glassdoor: INGEST_JOB uses correlationId + immediate ack +
 * INGEST_JOB_RESULT via tabs.sendMessage so slow backend fetch does not hit the
 * sendMessage channel timeout.
 */

const _ingestResultWaiters = new Map();

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INGEST_JOB_RESULT" && msg.correlationId) {
      const resolve = _ingestResultWaiters.get(msg.correlationId);
      if (resolve) {
        _ingestResultWaiters.delete(msg.correlationId);
        resolve(msg.result);
      }
    }
  });
}

function newCorrelationId() {
  return `ing_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

async function ingestJob(jobData) {
  await new Promise((resolve) =>
    chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
  );
  await new Promise((r) => setTimeout(r, 150));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const correlationId = newCorrelationId();

    const result = await new Promise((resolve) => {
      let finished = false;
      const localTimeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        _ingestResultWaiters.delete(correlationId);
        resolve(undefined);
      }, 12000);

      const settle = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(localTimeout);
        _ingestResultWaiters.delete(correlationId);
        resolve(r);
      };

      _ingestResultWaiters.set(correlationId, settle);

      try {
        chrome.runtime.sendMessage(
          { type: "INGEST_JOB", job: jobData, correlationId },
          (ack) => {
            if (chrome.runtime.lastError || !ack?.ack) {
              settle(undefined);
            }
          }
        );
      } catch (e) {
        clearTimeout(localTimeout);
        settle(undefined);
      }
    });

    // Treat backend-error responses as failures that should retry.
    // SW sends { id: null, error: "..." } when fetch throws; we want
    // the retry loop to see this as failure, not success.
    if (result !== undefined && !result?.error && result?.id != null) {
      return result;
    }

    const delay = attempt * 1000;
    console.warn(
      `[JHA] Ingest: no response (attempt ${attempt}/3) for: ${jobData?.job_title}, retrying in ${delay}ms`
    );
    await new Promise((resolve) =>
      chrome.storage.local.set({ _swRetry: attempt }, resolve)
    );
    await new Promise((r) => setTimeout(r, delay));
    await new Promise((resolve) =>
      chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
    );
    await new Promise((r) => setTimeout(r, 150));
  }
  console.error(
    "[JHA] Ingest: all attempts failed for:",
    jobData?.job_title ?? "(no title)"
  );
  console.warn("[JHA] ingest failed after 3 retries — marking backend-down");
  await chrome.storage.local.set({ _backendDownDuringScan: true });
  return undefined;
}

async function recordSkip(website, cardData, reason, runId) {
  const job = {
    job_title: cardData.job_title || "Unknown",
    company: cardData.company || null,
    location: cardData.location || null,
    job_url: null,
    skip_reason: reason,
    scan_run_id: runId,
    website: website,
  };

  await new Promise((resolve) =>
    chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
  );
  await new Promise((r) => setTimeout(r, 150));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const correlationId = newCorrelationId();

    const result = await new Promise((resolve) => {
      let finished = false;
      const localTimeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        _ingestResultWaiters.delete(correlationId);
        resolve(undefined);
      }, 12000);

      const settle = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(localTimeout);
        _ingestResultWaiters.delete(correlationId);
        resolve(r);
      };

      _ingestResultWaiters.set(correlationId, settle);

      try {
        chrome.runtime.sendMessage(
          { type: "INGEST_JOB", job, correlationId },
          (ack) => {
            if (chrome.runtime.lastError || !ack?.ack) {
              settle(undefined);
            }
          }
        );
      } catch (e) {
        clearTimeout(localTimeout);
        settle(undefined);
      }
    });

    if (result !== undefined && !result?.error && result?.id != null) {
      return result;
    }

    await new Promise((resolve) =>
      chrome.storage.local.set({ _swRetry: attempt }, resolve)
    );
    await new Promise((r) => setTimeout(r, attempt * 1000));
    await new Promise((resolve) =>
      chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
    );
    await new Promise((r) => setTimeout(r, 150));
  }
  return undefined;
}
