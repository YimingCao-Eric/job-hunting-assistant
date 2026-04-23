/* ── Ingest job handler (background only — never fetch backend from content scripts) ── */

async function handleIngest(job) {
  const { backendUrl, authToken } = await getSettings();

  let safeJob;
  try {
    safeJob = JSON.parse(JSON.stringify(job));
  } catch (e) {
    console.warn("[JHA] Job serialization failed, stripping voyager_raw:", e.message);
    const { voyager_raw, ...jobWithoutRaw } = job;
    safeJob = JSON.parse(JSON.stringify(jobWithoutRaw));
  }

  const res = await fetch(`${backendUrl}/jobs/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(safeJob),
  });

  const text = await res.text();
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parseError = e;
  }

  if (!res.ok) {
    const errMsg = `Backend ${res.status}: ${(text || parseError?.message || "").slice(0, 200)}`;
    console.warn("[JHA] Ingest HTTP error:", errMsg);
    if (res.status >= 500) {
      try {
        await chrome.storage.local.set({ lastSessionError: errMsg });
        await fetch(`${backendUrl}/extension/session-error`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ error: errMsg }),
        });
      } catch {
        /* ignore */
      }
    }
    return { id: null, error: errMsg, http_status: res.status };
  }

  if (parseError) {
    const errMsg = `Non-JSON response (${res.status}): ${text.slice(0, 100)}`;
    console.error("[JHA] handleIngest:", errMsg);
    try {
      await chrome.storage.local.set({ lastSessionError: errMsg });
      await fetch(`${backendUrl}/extension/session-error`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: errMsg }),
      });
    } catch {
      /* ignore */
    }
    return { id: null, error: errMsg, http_status: res.status };
  }

  return { ...parsed, http_status: res.status };
}
