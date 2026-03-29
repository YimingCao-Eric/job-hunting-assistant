const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = ["backendUrl", "authToken", "scanDelay"];
const CONFIG_FIELDS = [
  "keyword",
  "location",
  "f_tpr_bound",
  "f_experience",
  "f_job_type",
  "f_remote",
  "salary_min",
];

let pollTimer = null;

// ── helpers ──────────────────────────────────────────────────────────────

function getBackend() {
  return ($("backendUrl").value || "http://localhost:8000").replace(/\/+$/, "");
}

function authHeaders() {
  return {
    Authorization: `Bearer ${$("authToken").value || "dev-token"}`,
    "Content-Type": "application/json",
  };
}

function showToast(msg, ms = 1500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), ms);
}

function setStatus(html) {
  $("status-area").innerHTML = html;
}

const WARNING_MESSAGES = {
  captcha: "\u26a0\ufe0f CAPTCHA detected. Solve it on the LinkedIn tab, then clear this warning.",
  expired: "\u26a0\ufe0f LinkedIn session expired. Log in again on LinkedIn.",
  banned: "\ud83d\udeab Account may be restricted. Check LinkedIn directly.",
  redirected: "\u26a0\ufe0f LinkedIn redirected the scan away from jobs. May be a soft warning.",
};

function showWarningBanner(errorType) {
  const banner = $("warning-banner");
  $("warning-text").textContent =
    WARNING_MESSAGES[errorType] || `\u26a0\ufe0f Session error: ${errorType}`;
  banner.style.display = "block";
}

function clearWarning() {
  chrome.storage.local.remove("lastSessionError");
  $("warning-banner").style.display = "none";
}

// ── load saved settings from chrome.storage ─────────────────────────────

async function loadSettings() {
  const data = await chrome.storage.local.get([
    ...STORAGE_KEYS,
    "scanInProgress",
    "lastRunSummary",
    "lastSessionError",
  ]);

  if (data.backendUrl) $("backendUrl").value = data.backendUrl;
  if (data.authToken) $("authToken").value = data.authToken;
  if (data.scanDelay) $("scanDelay").value = data.scanDelay;

  if (data.lastSessionError) {
    showWarningBanner(data.lastSessionError);
  }

  if (data.scanInProgress) {
    $("btn-scan").style.display = "none";
    $("btn-stop").style.display = "";
    setStatus('<span class="live">Scanning…</span>');
    startPolling();
  } else if (data.lastRunSummary) {
    renderSummary(data.lastRunSummary);
  }
}

// ── load config from backend ────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch(`${getBackend()}/config`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const cfg = await res.json();
    for (const key of CONFIG_FIELDS) {
      const el = $(key);
      if (!el) continue;
      const val = cfg[key];
      el.value = val != null ? val : "";
    }
  } catch {
    /* backend offline — fields keep defaults */
  }
}

// ── save ─────────────────────────────────────────────────────────────────

async function saveSettings() {
  const storageData = {};
  for (const key of STORAGE_KEYS) {
    storageData[key] = $(key).value;
  }
  await chrome.storage.local.set(storageData);

  const configBody = {};
  for (const key of CONFIG_FIELDS) {
    const el = $(key);
    if (!el) continue;
    const raw = el.value.trim();
    if (el.type === "number") {
      configBody[key] = raw === "" ? null : Number(raw);
    } else {
      configBody[key] = raw === "" ? null : raw;
    }
  }

  try {
    const res = await fetch(`${getBackend()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(configBody),
    });
    if (res.ok) {
      showToast("Saved");
    } else {
      showToast("Save failed", 2000);
    }
  } catch {
    showToast("Backend unreachable", 2000);
  }
}

// ── scan ─────────────────────────────────────────────────────────────────

function startScan() {
  $("btn-scan").style.display = "none";
  $("btn-stop").style.display = "";
  setStatus('<span class="live">Starting scan…</span>');
  chrome.runtime.sendMessage({ type: "MANUAL_SCAN" });
  startPolling();
}

function stopScan() {
  chrome.runtime.sendMessage({ type: "STOP_SCAN" });
  $("btn-stop").style.display = "none";
  $("btn-scan").style.display = "";
  $("btn-scan").disabled = true;
  setStatus('<span class="live">Stopping…</span>');
}

// ── live progress polling ────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollProgress, 2000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollProgress() {
  const data = await chrome.storage.local.get([
    "scanInProgress",
    "liveProgress",
    "lastRunSummary",
  ]);

  if (data.scanInProgress && data.liveProgress) {
    const p = data.liveProgress;
    setStatus(
      `<span class="live">Scanning… Page ${p.page || "?"}</span><br>` +
        `Scraped: ${p.scraped ?? 0} · New: ${p.new_jobs ?? 0} · ` +
        `Existing: ${p.existing ?? 0} · Stale: ${p.stale_skipped ?? 0} · ` +
        `Failed: ${p.jd_failed ?? 0}`
    );
  } else if (!data.scanInProgress) {
    stopPolling();
    $("btn-scan").style.display = "";
    $("btn-scan").disabled = false;
    $("btn-stop").style.display = "none";
    if (data.lastRunSummary) {
      renderSummary(data.lastRunSummary);
    } else {
      setStatus("Ready");
    }
  }
}

function renderSummary(s) {
  setStatus(
    `<span class="done">Last run: ${s.status || "done"}</span><br>` +
      `Pages: ${s.pages_scanned ?? 0} · Scraped: ${s.scraped ?? 0} · ` +
      `New: ${s.new_jobs ?? 0} · Existing: ${s.existing ?? 0} · ` +
      `Stale: ${s.stale_skipped ?? 0} · Failed: ${s.jd_failed ?? 0}` +
      (s.session_error
        ? `<br><span class="err">Session: ${s.session_error}</span>`
        : "")
  );
}

// ── init ─────────────────────────────────────────────────────────────────

$("btn-save").addEventListener("click", saveSettings);
$("btn-scan").addEventListener("click", startScan);
$("btn-stop").addEventListener("click", stopScan);
$("btn-clear-warning").addEventListener("click", clearWarning);

loadSettings();
loadConfig();
