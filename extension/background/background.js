/* ── Service worker entry — loads all background modules (shared global scope) ── */

importScripts(
  "keepalive.js",
  "settings.js",
  "progress_mirror.js",
  "debug_flush.js",
  "config_fetch.js",
  "search_urls.js",
  "poll.js",
  "scan_manual.js",
  "ingest.js",
  "runtime_messages.js",
  "scan_completion.js",
  "tabs_safety.js",
  "startup.js"
);
