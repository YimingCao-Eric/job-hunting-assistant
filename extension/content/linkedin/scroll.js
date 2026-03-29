/* ── LinkedIn scroll pacing (virtual DOM / infinite list) ─────────────── */

async function scrollDelay(scanDelay = "normal") {
  const [min, max] = SCAN_DELAYS[scanDelay]?.scroll || SCAN_DELAYS.normal.scroll;
  await sleep(Math.random() * (max - min) + min);
}
