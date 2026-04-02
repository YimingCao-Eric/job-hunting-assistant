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
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(
      "[JHA] handleIngest: non-JSON response:",
      res.status,
      text.slice(0, 200)
    );
    const errMsg = `Backend ${res.status}: ${text.slice(0, 100)}`;
    (async () => {
      await chrome.storage.local.set({ lastSessionError: errMsg });
      const { backendUrl, authToken } = await getSettings();
      try {
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
    })();
    return null;
  }
}
