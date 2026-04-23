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

async function computeFtpr(fTprBound, website) {
  if (!fTprBound || fTprBound <= 0) return null;
  const { backendUrl, authToken } = await getSettings();
  try {
    // Fetch a larger batch and filter client-side so we can find the most
    // recent completed run for THIS website specifically. Cross-source contamination
    // previously produced incorrect f_tpr values (e.g. LinkedIn using Indeed's last
    // completed_at).
    const res = await fetch(
      `${backendUrl}/extension/run-log?limit=20&status=completed`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!res.ok) return `r${fTprBound * 3600}`;
    const raw = await res.json();
    const logs = Array.isArray(raw) ? raw : raw.items || [];
    const w = website || "linkedin";
    const matching = logs.filter(
      (l) => (l.search_filters?.website || "linkedin") === w
    );
    if (!matching.length || !matching[0].completed_at)
      return `r${fTprBound * 3600}`;
    const lastScrapeTime = new Date(matching[0].completed_at).getTime();
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
