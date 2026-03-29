/* ── Shared timing helpers (content scripts) ───────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
