/**
 * JHA chrome.storage.local key naming convention:
 *   - `_underscored` keys: SW-internal, not consumed by user-facing UI.
 *     Examples: `_keepalive`, `_swHeartbeat`, `_lastPollError`.
 *   - `camelCase` keys: read by content scripts, popup, or shared between
 *     SW and content scripts.
 *     Examples: `scanInProgress`, `scanConfig`, `liveProgress`.
 *
 * Existing keys may not all follow this convention. New keys should.
 */

/* ── Service worker keepalive ─────────────────────────────────────────── */

let keepAliveInterval = null;

function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
    chrome.storage.local.set({ _keepalive: Date.now() });
  }, 5000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}
