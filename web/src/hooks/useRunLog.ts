import { useQuery } from '@tanstack/react-query'

import type { ApiError } from '@/lib/api/errors'
import { listRunLogs } from '@/lib/api/runLog'
import type { RunLog } from '@/types/runLog'

export const runLogKeys = {
  all: ['runLog'] as const,
  list: (status: string | undefined, offset: number) => ['runLog', 'list', status, offset] as const,
  trace: (id: string) => ['runLog', 'trace', id] as const,
}

/**
 * GET /extension/run-log returns a BARE ARRAY -- no {items,total} envelope and
 * no total count. So there is no "page N of M": we page by limit/offset and
 * stop when a page comes back short. That is as-built, and it is why the spec's
 * Assumptions say "no total count".
 */
export const RUN_LOG_PAGE_SIZE = 20

export function useRunLog(status: string | undefined, offset: number) {
  return useQuery<RunLog[], ApiError>({
    queryKey: runLogKeys.list(status, offset),
    queryFn: ({ signal }) =>
      listRunLogs(
        {
          limit: RUN_LOG_PAGE_SIZE,
          offset,
          status,
          // FR-035. NOT optional: traces are a ring of up to 10,000 events
          // returned INLINE and included BY DEFAULT. Measured against the live
          // backend, 10 runs cost 8 KB with this false and 537 KB without it --
          // a 66x difference on every page load.
          include_debug_log: false,
        },
        { signal },
      ),
  })
}
