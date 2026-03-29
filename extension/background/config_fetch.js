/* ── Config fetch & f_tpr computation ─────────────────────────────────────── */

async function fetchConfig() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/config`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

async function computeFtpr(fTprBound) {
  if (!fTprBound || fTprBound <= 0) return null;
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(
      `${backendUrl}/extension/run-log?limit=1&status=completed`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!res.ok) return `r${fTprBound * 3600}`;
    const logs = await res.json();
    if (!logs.length || !logs[0].completed_at) return `r${fTprBound * 3600}`;
    const lastScrapeTime = new Date(logs[0].completed_at).getTime();
    const hoursSinceLast = (Date.now() - lastScrapeTime) / (1000 * 60 * 60);
    let hoursToLookBack;
    if (hoursSinceLast < 0.5) {
      hoursToLookBack = fTprBound;
    } else {
      hoursToLookBack = Math.min(hoursSinceLast, fTprBound);
    }
    const seconds = Math.max(Math.round(hoursToLookBack * 3600), 3600);
    return `r${seconds}`;
  } catch {
    return `r${fTprBound * 3600}`;
  }
}
