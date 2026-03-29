/* ── LinkedIn scan overlay (inline styles — distinct from Indeed CSS class) ── */

function showScanOverlay() {
  const existing = document.getElementById("jha-overlay");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.id = "jha-overlay";
  div.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0;
    background: rgba(0,100,200,0.92); color: white;
    padding: 10px 20px; font-size: 14px; font-family: sans-serif;
    z-index: 999999; text-align: center; letter-spacing: 0.02em;
  `;
  div.innerText =
    "\ud83d\udd0d JHA Scan in progress \u2014 do not scroll or interact with this tab";
  document.body.appendChild(div);
}

function hideScanOverlay() {
  document.getElementById("jha-overlay")?.remove();
}
