/* ── Debug event emitter (batched flush to backend) ──────────────────── */

const JHA_DEBUG_CREDENTIAL_KEY_RE =
  /token|auth|bearer|csrf|api.?key|cookie|password|secret/i;
const JHA_DEBUG_MAX_STRING = 2000;

function jhaRedact(obj, depth = 0) {
  if (depth > 6) return "[depth_limit]";
  if (obj == null) return obj;
  if (typeof obj === "string") {
    return obj.length > JHA_DEBUG_MAX_STRING
      ? obj.slice(0, JHA_DEBUG_MAX_STRING) + "…[truncated]"
      : obj;
  }
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => jhaRedact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (JHA_DEBUG_CREDENTIAL_KEY_RE.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = jhaRedact(v, depth + 1);
    }
  }
  return out;
}

const JhaDebug = {
  _scanStart: null,
  _currentPage: null,

  async init(runId, scanStartMs) {
    const { debugLog } = await chrome.storage.local.get("debugLog");
    if (debugLog && debugLog.runId === runId) {
      this._scanStart = debugLog.scanStartMs || Date.now();
      return;
    }
    const start = scanStartMs || Date.now();
    this._scanStart = start;
    await chrome.storage.local.set({
      debugLog: {
        runId,
        events: [],
        lastFlushAt: Date.now(),
        scanStartMs: start,
      },
    });
  },

  setPage(page) {
    this._currentPage = page;
  },

  async emit(phase, data = {}, level = "info") {
    try {
      const now = Date.now();
      const ev = {
        t: now,
        dt: this._scanStart ? now - this._scanStart : 0,
        page: this._currentPage,
        phase,
        level,
        data: jhaRedact(data),
      };
      const { debugLog } = await chrome.storage.local.get("debugLog");
      if (!debugLog || !debugLog.runId) return;
      debugLog.events.push(ev);
      await chrome.storage.local.set({ debugLog });

      const shouldFlush =
        debugLog.events.length >= 100 ||
        now - (debugLog.lastFlushAt || 0) >= 5000;
      if (shouldFlush) {
        await this.flush();
      }
    } catch (e) {
      console.warn("[JHA-Debug] emit failed:", e.message);
    }
  },

  async flush() {
    try {
      const { debugLog } = await chrome.storage.local.get("debugLog");
      if (!debugLog || !debugLog.runId) return;
      if (!debugLog.events.length) return;

      const eventsToSend = debugLog.events.slice();
      const runId = debugLog.runId;

      const ack = await new Promise((resolve) =>
        chrome.runtime.sendMessage(
          { type: "DEBUG_LOG_FLUSH", runId, events: eventsToSend },
          resolve
        )
      );

      if (ack && ack.ok) {
        const { debugLog: latest } = await chrome.storage.local.get("debugLog");
        if (latest && latest.runId === runId) {
          latest.events = latest.events.slice(eventsToSend.length);
          latest.lastFlushAt = Date.now();
          await chrome.storage.local.set({ debugLog: latest });
        }
      }
    } catch (e) {
      console.warn("[JHA-Debug] flush failed:", e.message);
    }
  },

  /** Flush until empty or max attempts; then clear buffer. */
  async finalize() {
    for (let i = 0; i < 6; i++) {
      const { debugLog } = await chrome.storage.local.get("debugLog");
      if (!debugLog?.events?.length) break;
      await this.flush();
    }
    await chrome.storage.local.remove("debugLog");
    this._scanStart = null;
    this._currentPage = null;
  },
};
