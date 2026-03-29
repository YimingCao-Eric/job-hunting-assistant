/* ── Indeed scan overlay (uses shared CSS class from content_style.css) ─ */

function showScanOverlay() {
  const existing = document.getElementById("jha-overlay");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.id = "jha-overlay";
  div.className = "jha-scanning-overlay";
  div.innerText = "🔍 JHA Scan in progress — do not scroll or interact";
  document.body.appendChild(div);
}

function hideScanOverlay() {
  document.getElementById("jha-overlay")?.remove();
}
