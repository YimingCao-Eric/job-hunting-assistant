/* ── Debug event emitter (in-memory buffer; SW flushes to backend) ─────── */

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

const _buffer = [];

/** D-14: warn once per scan when client buffer is trimmed */
let _jhaDebugCappedWarningEmitted = false;

const MAX_DEBUG_EVENTS = 5000;

const JhaDebug = {
  _inited: false,
  _runId: null,
  _scanStartMs: 0,
  _currentPage: null,
  _lastFlushAtMs: 0,

  async init(runId, scanStartMs) {
    if (this._inited && this._runId === runId) {
      return;
    }
    this._inited = true;
    this._runId = runId;
    this._scanStartMs = scanStartMs || Date.now();
    this._lastFlushAtMs = 0;
    _jhaDebugCappedWarningEmitted = false;
    _buffer.length = 0;
    await chrome.storage.local.set({
      _jhaDebugRunMeta: { runId, scanStartMs: this._scanStartMs },
    });
  },

  setPage(page) {
    this._currentPage = page;
  },

  emit(phase, data = {}, level = "info") {
    if (!this._inited || !this._runId) return;
    try {
      const now = Date.now();
      _buffer.push({
        t: now,
        dt: this._scanStartMs ? now - this._scanStartMs : 0,
        page: this._currentPage,
        phase,
        level,
        data: jhaRedact(data),
      });

      if (_buffer.length > MAX_DEBUG_EVENTS) {
        const dropped = _buffer.length - MAX_DEBUG_EVENTS;
        _buffer.splice(0, dropped);
        if (!_jhaDebugCappedWarningEmitted) {
          console.warn(
            `[JhaDebug] Buffer capped at ${MAX_DEBUG_EVENTS} events; ${dropped} oldest discarded`
          );
          _jhaDebugCappedWarningEmitted = true;
        }
      }

      if (
        _buffer.length >= 100 ||
        (this._lastFlushAtMs > 0 && now - this._lastFlushAtMs > 5000)
      ) {
        this._flush();
      } else if (this._lastFlushAtMs === 0) {
        this._lastFlushAtMs = now;
      }
    } catch (e) {
      console.warn("[JHA-Debug] emit failed:", e.message);
    }
  },

  async _flush() {
    if (_buffer.length === 0) return;
    const events = _buffer.splice(0);
    this._lastFlushAtMs = Date.now();
    const runId = this._runId;
    try {
      await new Promise((resolve) =>
        chrome.runtime.sendMessage(
          { type: "FLUSH_DEBUG_LOG", runId, events },
          resolve
        )
      );
    } catch (_) {
      /* lossy path — same class of loss as old storage RMW */
    }
  },

  async finalize() {
    for (let i = 0; i < 6; i++) {
      if (_buffer.length === 0) break;
      await this._flush();
    }
    this._inited = false;
    this._runId = null;
    this._currentPage = null;
    await chrome.storage.local.remove("_jhaDebugRunMeta");
  },
};
