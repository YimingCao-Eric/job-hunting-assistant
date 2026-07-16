import { useQuery } from '@tanstack/react-query'

import { runLogKeys } from '@/hooks/useRunLog'
import type { ApiError } from '@/lib/api/errors'
import { listRunLogs } from '@/lib/api/runLog'
import type { DebugLog } from '@/types/runLog'

/**
 * One run's debug trace, fetched ONLY when the row is expanded (FR-035).
 *
 * ============================ THE CONSTRAINT ============================
 * There is NO `GET /extension/run-log/{id}` and NO id filter -- the only
 * params are limit / offset / status / include_debug_log. So a single run's
 * trace can only be reached POSITIONALLY: ask for limit=1 at the run's absolute
 * offset, with the SAME status filter the list used.
 *
 * That absence is also exactly why FR-033 is expand-in-place rather than a
 * detail route: there is no detail route to navigate to.
 * =======================================================================
 *
 * The positional read has one hazard: ordering is started_at DESC, so a NEW RUN
 * STARTING between the list fetch and this fetch shifts every offset by one and
 * we would silently show the WRONG RUN'S TRACE -- the worst possible outcome on
 * a diagnostic page. So the id is verified, and on a mismatch we widen the
 * window and find the run by id rather than trusting the position.
 */
async function fetchTrace(
  runId: string,
  absoluteOffset: number,
  status: string | undefined,
  signal: AbortSignal,
): Promise<DebugLog | null> {
  const exact = await listRunLogs(
    { limit: 1, offset: absoluteOffset, status, include_debug_log: true },
    { signal },
  )

  // The happy path: the row is still where the list said it was.
  if (exact[0]?.id === runId) return exact[0].debug_log

  // Offsets shifted underneath us. Widen and match by id -- never assume.
  const WINDOW = 20
  const from = Math.max(0, absoluteOffset - 5)
  const widened = await listRunLogs(
    { limit: WINDOW, offset: from, status, include_debug_log: true },
    { signal },
  )
  const found = widened.find((r) => r.id === runId)
  // If it is still not here the run has moved far (many new runs) -- return
  // null rather than a neighbour's trace. The panel shows "no trace" and the
  // list refetch will resettle it.
  return found?.debug_log ?? null
}

export function useRunTrace(
  runId: string | null,
  absoluteOffset: number,
  status: string | undefined,
) {
  return useQuery<DebugLog | null, ApiError>({
    // Keyed per run id and CACHED, so collapse/re-expand does not refetch (FR-035).
    queryKey: runLogKeys.trace(runId ?? ''),
    queryFn: ({ signal }) => fetchTrace(runId as string, absoluteOffset, status, signal),
    // The one thing that makes this on-demand: nothing is fetched until expanded.
    enabled: runId !== null,
    // A completed run's trace is immutable -- never refetch it.
    staleTime: Infinity,
  })
}
