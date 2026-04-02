/* ── LinkedIn scroll pacing (virtual DOM / infinite list) ─────────────── */

async function scrollDelay() {
  const [min, max] = SCAN_DELAYS.normal.scroll;
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}
