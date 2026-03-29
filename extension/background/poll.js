/* ── Poll backend for frontend-triggered scans / stops ───────────────── */

async function pollForScanTrigger() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/extension/pending-scan`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pending) {
        console.log("[JHA] Scan triggered from frontend");
        await handleManualScan({
          websiteOverride: data.website || null,
        });
      }
    }
  } catch {
    // Backend unreachable — silently skip
  }
}

setInterval(pollForScanTrigger, 3000);

async function pollForStopTrigger() {
  const { backendUrl, authToken } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/extension/pending-stop`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.pending) {
        await chrome.storage.local.set({ stopRequested: true });

        const { scanConfig } = await chrome.storage.local.get("scanConfig");
        if (scanConfig?.tabId != null) {
          try {
            await chrome.tabs.remove(scanConfig.tabId);
          } catch {
            // tab may already be gone
          }
        }

        const { scanTimeoutId } = await chrome.storage.local.get("scanTimeoutId");
        if (scanTimeoutId) {
          clearTimeout(Number(scanTimeoutId));
        }

        await chrome.storage.local.remove([
          "scanInProgress",
          "scanConfig",
          "scanPageState",
          "liveProgress",
          "scanComplete",
          "scanTimeoutId",
        ]);

        stopKeepAlive();
        console.log("[JHA] Force-stopped scan");
      }
    }
  } catch {}
}

setInterval(pollForStopTrigger, 3000);
