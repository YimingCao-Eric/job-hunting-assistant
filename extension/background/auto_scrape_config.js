/* extension/background/auto_scrape_config.js
 * Constants and probe URLs for auto-scrape orchestrator.
 * Phase 6 will replace these with values from auto_scrape_config table.
 */

const AS_DEFAULT_SITES = ["linkedin", "indeed", "glassdoor"];
const AS_DEFAULT_KEYWORDS = [
  "software engineer",
  "AI engineer",
  "machine learning engineer",
];

const AS_PROBE_URLS = {
  linkedin: "https://www.linkedin.com/feed/",
  indeed: "https://ca.indeed.com/notifications",
  glassdoor: "https://www.glassdoor.ca/Job/index.htm",
};

const AS_DEFAULT_INTER_SCAN_DELAY_MS = 30 * 1000;
const AS_DEFAULT_SCAN_TIMEOUT_MS = 30 * 60 * 1000;
const AS_DEFAULT_MIN_CYCLE_INTERVAL_MS = 60 * 1000;
const AS_DEFAULT_PRE_CHECK_TIMEOUT_MS = 30 * 1000;

const AS_TRIGGER_RETRY_MAX_ATTEMPTS = 5;
const AS_TRIGGER_RETRY_TOTAL_DEADLINE_MS = 60 * 1000;
const AS_TRIGGER_RETRY_JITTER_MAX_MS = 500;

self.AS_DEFAULT_SITES = AS_DEFAULT_SITES;
self.AS_DEFAULT_KEYWORDS = AS_DEFAULT_KEYWORDS;
self.AS_PROBE_URLS = AS_PROBE_URLS;
self.AS_DEFAULT_INTER_SCAN_DELAY_MS = AS_DEFAULT_INTER_SCAN_DELAY_MS;
self.AS_DEFAULT_SCAN_TIMEOUT_MS = AS_DEFAULT_SCAN_TIMEOUT_MS;
self.AS_DEFAULT_MIN_CYCLE_INTERVAL_MS = AS_DEFAULT_MIN_CYCLE_INTERVAL_MS;
self.AS_DEFAULT_PRE_CHECK_TIMEOUT_MS = AS_DEFAULT_PRE_CHECK_TIMEOUT_MS;
self.AS_TRIGGER_RETRY_MAX_ATTEMPTS = AS_TRIGGER_RETRY_MAX_ATTEMPTS;
self.AS_TRIGGER_RETRY_TOTAL_DEADLINE_MS = AS_TRIGGER_RETRY_TOTAL_DEADLINE_MS;
self.AS_TRIGGER_RETRY_JITTER_MAX_MS = AS_TRIGGER_RETRY_JITTER_MAX_MS;
