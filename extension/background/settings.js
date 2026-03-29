/* ── Settings cache (30s TTL) ──────────────────────────────────────────── */

let settingsCache = null;
let settingsCacheTime = 0;

async function getSettings() {
  if (settingsCache && Date.now() - settingsCacheTime < 30000) return settingsCache;
  settingsCache = await chrome.storage.local.get([
    "backendUrl",
    "authToken",
    "scanDelay",
  ]);
  if (!settingsCache.backendUrl) settingsCache.backendUrl = "http://localhost:8000";
  if (!settingsCache.authToken) settingsCache.authToken = "dev-token";
  if (!settingsCache.scanDelay) settingsCache.scanDelay = "normal";
  settingsCacheTime = Date.now();
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.backendUrl || changes.authToken)) {
    settingsCache = null;
  }
});
