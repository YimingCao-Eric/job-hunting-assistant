import { get, post, type RequestOptions } from '@/lib/api/client'
import type { SourceSite } from '@/types/job'
import type { ExtensionState } from '@/types/runLog'

/**
 * Scan control. See contracts/backend-bindings.md, Surface 2.
 *
 * ============================ FORBIDDEN ============================
 * GET /extension/pending, /extension/pending-scan, /extension/pending-stop
 * are NOT bound here and must never be called (FR-030). They are GETs that
 * MUTATE AND COMMIT: a single read clears the flag, steals the extension's
 * queued command, and the scan then SILENTLY NEVER RUNS -- no error, no log,
 * nothing to debug. They look like reads.
 *
 * getExtensionState() below is the safe substitute: it exposes scan_requested
 * and stop_requested WITHOUT consuming them. An ESLint rule fails the build on
 * the literal path strings, so this is enforced rather than trusted.
 * ===================================================================
 */

export interface TriggerScanRequest {
  website?: SourceSite | null
  scan_all?: boolean
  scan_all_position?: number | null
  scan_all_total?: number | null
}

export interface TriggerScanResponse {
  ok: boolean
  scan_requested: boolean
}

/**
 * A MAILBOX, not a request/response: returns NO run id and returns BEFORE any
 * scan starts. The extension collects the command on its own polling schedule
 * and may never collect it at all -- which is why correlation is by recency and
 * a bounded wait is mandatory (FR-027, research R7).
 *
 * ALWAYS send an explicit body: omitting it entirely clears all four state
 * fields server-side (routers/extension.py:156-160).
 *
 * 409s carry {reason, message, retry_after_ms} -- shape 4, normalized to
 * ApiError.reason/.retryAfterMs. The three reasons get three distinct
 * messages (SC-011).
 *
 * Side effect worth knowing: this first force-fails any `running` run-log older
 * than 60 MINUTES (the stuck-run reaper, extension.py:122-136). That is why a
 * run can go terminal with no user action.
 */
export function triggerScan(
  body: TriggerScanRequest,
  options?: RequestOptions,
): Promise<TriggerScanResponse> {
  return post<TriggerScanResponse>(
    '/extension/trigger-scan',
    {
      website: body.website ?? null,
      scan_all: body.scan_all ?? false,
      scan_all_position: body.scan_all_position ?? null,
      scan_all_total: body.scan_all_total ?? null,
    },
    options,
  )
}

/**
 * DESTRUCTIVE (FR-011 -> requires ConfirmDialog): immediately marks ALL running
 * run-logs `failed` with "Stopped by user", regardless of age
 * (extension.py:236-244).
 */
export function triggerStop(options?: RequestOptions): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/extension/trigger-stop', undefined, options)
}

/**
 * The NON-CONSUMING read of scan_requested / stop_requested.
 * This is the substitute for the forbidden pending* routes -- use it, always.
 */
export function getExtensionState(options?: RequestOptions): Promise<ExtensionState> {
  return get<ExtensionState>('/extension/state', options)
}
