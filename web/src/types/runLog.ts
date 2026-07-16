/**
 * Mirrors `RunLogRead` (backend/schemas/run_log.py:37-64).
 *
 * GET /extension/run-log returns a BARE ARRAY -- no {items,total} envelope and
 * no total count. So Logs cannot show "page N of M"; it pages by limit/offset
 * and stops on a short page.
 */

/** The DISPLAY vocabulary only -- see RunLog.status. */
export type RunStatus = 'running' | 'completed' | 'failed'

export interface RunLog {
  id: string
  strategy: string
  /**
   * Typed `string`, NOT RunStatus, deliberately. The column is free text with
   * no DB constraint and no Pydantic enum (models/extension_run_log.py:25), and
   * five different code paths write it. An unrecognized value must render as
   * itself rather than crash an exhaustive switch.
   */
  status: string
  /** ISO. Sort key, DESC, no tiebreaker. */
  started_at: string
  completed_at: string | null
  pages_scanned: number
  scraped: number
  new_jobs: number
  existing: number
  stale_skipped: number
  jd_failed: number
  early_stop: boolean | null
  session_error: string | null
  /** May be the literal '(setup pending)' -- the backend substitutes it for a
   *  blank keyword/location (routers/extension.py:28-31). Render as-is; it
   *  resolves on the next update. */
  search_keyword: string | null
  search_location: string | null
  search_filters: Record<string, unknown> | null
  error_message: string | null
  errors: unknown[] | null
  created_at: string
  scan_all: boolean
  scan_all_position: number | null
  scan_all_total: number | null
  /** null when include_debug_log=false, and ALWAYS absent on WS payloads. */
  debug_log: DebugLog | null
  failure_reason: string | null
  failure_category: string | null
}

/**
 * Mirrors `DebugEvent` (backend/schemas/debug_log.py:4-12).
 * Ring buffer of the last 10,000 events (DEBUG_LOG_RING_SIZE) -- oldest are
 * dropped, so a trace may legitimately not start at dt: 0.
 */
export interface DebugEvent {
  /** epoch ms */
  t: number
  /** ms since run start -- THIS is the displayed relative timestamp (FR-034). */
  dt: number
  page: number | null
  phase: string
  /** default 'info'; seen: info | warn | error | debug */
  level: string
  data: Record<string, unknown>
  /**
   * LOAD-BEARING. The type-level expression of the server's
   * `model_config = ConfigDict(extra="allow")`: events legitimately carry keys
   * we do not model, and the trace panel must render them rather than break.
   */
  [key: string]: unknown
}

/** An OBJECT WRAPPING the array, not a bare array. */
export interface DebugLog {
  events: DebugEvent[]
}

/**
 * Mirrors `ExtensionStateRead` (backend/schemas/extension.py:13-29).
 * The NON-CONSUMING read of scan_requested/stop_requested -- the /extension/pending*
 * routes clear the flag on GET and are forbidden (FR-030).
 */
export interface ExtensionState {
  id: number
  /** Strings, not datetimes, as built. */
  current_search_date: string | null
  last_search_time: string | null
  current_page: number
  search_exhausted: boolean
  consecutive_empty_runs: number
  today_searches: number
  scan_requested: boolean
  stop_requested: boolean
  scan_website: string | null
  scan_all: boolean
  scan_all_position: number | null
  scan_all_total: number | null
  updated_at: string
}
