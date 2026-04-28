/* ── Debug log flush handler ──────────────────────────────────────────── */

async function handleDebugLogFlush(runId, events) {
  try {
    const { backendUrl, authToken } = await getSettings();
    const normalized = (events || []).map((e) => ({
      t: e.t,
      dt: e.dt ?? 0,
      page: e.page ?? null,
      phase: e.phase,
      level: e.level ?? "info",
      data: e.data && typeof e.data === "object" ? e.data : {},
    }));
    const res = await fetch(`${backendUrl}/extension/run-log/${runId}/debug`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: normalized }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function emitBackgroundEvent(runId, phase, data = {}, level = "info") {
  try {
    if (!runId) return;
    const { backendUrl, authToken } = await getSettings();
    const ev = {
      t: Date.now(),
      dt: 0,
      page: null,
      phase: `bg_${phase}`,
      level,
      data,
    };
    await fetch(`${backendUrl}/extension/run-log/${runId}/debug`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: [ev] }),
    });
  } catch (_) {
    /* never throw into caller */
  }
}
