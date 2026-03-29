/* ── Service worker entry — loads all background modules (shared global scope) ── */

importScripts(
  "keepalive.js",
  "settings.js",
  "config_fetch.js",
  "search_urls.js",
  "scan_manual.js",
  "ingest.js",
  "runtime_messages.js",
  "scan_completion.js",
  "tabs_safety.js",
  "poll.js",
  "startup.js"
);
