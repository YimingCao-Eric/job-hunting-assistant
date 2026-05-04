/* ── Indeed SERP mosaic_job lookup (MAIN world via background scripting) ─
 *
 * Mosaic payloads live on window.mosaic.providerData in the page MAIN world;
 * content scripts cannot read them directly. We snapshot once per page load.
 */

let _indeedMosaicMapPromise = null;

function loadIndeedMosaicJobMap() {
  if (!_indeedMosaicMapPromise) {
    _indeedMosaicMapPromise = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_INDEED_MOSAIC_JOB_MAP" }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          const m = resp?.jobsByJk;
          resolve(m && typeof m === "object" ? m : {});
        });
      } catch {
        resolve({});
      }
    });
  }
  return _indeedMosaicMapPromise;
}

/** Per-card mosaic_job object for this jk, or null if not found / invalid. */
async function getIndeedMosaicJobForJk(jk) {
  if (!jk) return null;
  const map = await loadIndeedMosaicJobMap();
  const row = map[jk];
  return row && typeof row === "object" && !Array.isArray(row) ? row : null;
}
