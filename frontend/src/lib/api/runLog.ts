import { get, type RequestOptions } from '@/lib/api/client'
import type { RunLog } from '@/types/runLog'

/**
 * /extension/run-log. FOUNDATIONAL, not story-owned: US1 polls it for scan
 * progress and US4 lists it, so placing it here keeps both stories
 * independently buildable.
 *
 * There is NO `GET /extension/run-log/{id}`. That absence is why FR-033 is
 * expand-in-place rather than a detail route, and why fetching one run's trace
 * means a filtered list call.
 */

export interface ListRunLogsParams {
  /** Default 10 server-side. ge=1, le=200. */
  limit?: number
  offset?: number
  /** Free string, exact ==, no enum server-side (FR-032). */
  status?: string
  /**
   * THE PARAM IS `include_debug_log`, NOT `include_trace`. Consumed verbatim
   * per the no-drive-by-renames constraint.
   *
   * It defaults to TRUE server-side, and traces are a ring of up to 10,000
   * events returned INLINE with each run -- a default list of 10 runs can carry
   * 100,000 events. Logs must always pass false (FR-035).
   *
   * Honest limit: this does NOT skip the DB read. The handler fetches the rows
   * then nulls the field in Python (routers/extension.py:433-437). The payload
   * shrinks -- which is what FR-035/SC-010 are about -- backend work does not.
   */
  include_debug_log?: boolean
}

/**
 * Returns a BARE ARRAY -- no {items,total} envelope and no total count, so
 * there is no "page N of M". Page by limit/offset and stop on a short page.
 * Ordered started_at DESC, no tiebreaker.
 */
export function listRunLogs(
  params: ListRunLogsParams = {},
  options?: RequestOptions,
): Promise<RunLog[]> {
  return get<RunLog[]>('/extension/run-log', {
    ...options,
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      include_debug_log: params.include_debug_log,
    },
  })
}
