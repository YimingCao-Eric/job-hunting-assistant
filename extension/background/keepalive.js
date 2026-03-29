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
