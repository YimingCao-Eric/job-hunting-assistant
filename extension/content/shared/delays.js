/* ── Randomized delays between card actions (LinkedIn + Indeed card pacing) ── */

const SCAN_DELAYS = {
  fast: { card: [500, 1000], scroll: [1000, 2000] },
  normal: { card: [1000, 3000], scroll: [2000, 4000] },
  slow: { card: [3000, 5000], scroll: [4000, 7000] },
};

async function cardDelay(scanDelay = "normal") {
  const [min, max] = SCAN_DELAYS[scanDelay]?.card || SCAN_DELAYS.normal.card;
  await sleep(Math.random() * (max - min) + min);
}
