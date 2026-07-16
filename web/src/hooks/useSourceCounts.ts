import { useQueries } from '@tanstack/react-query'

import { jobKeys } from '@/hooks/useJobs'
import { listJobs } from '@/lib/api/jobs'
import { SOURCE_SITES, type JobFilters, type SourceCounts } from '@/types/job'

/**
 * FR-023's per-site counts.
 *
 * THERE IS NO FACET ENDPOINT. No /jobs/count, no aggregate -- confirmed by
 * reading the full /jobs router. Reading `total` from a limit=1 envelope is the
 * only available mechanism (research R3), so Jobs' initial load is 4 requests:
 * 1 list + 3 counts.
 *
 * limit=1 rather than 0 because Query(25, ge=1, le=500) rejects 0 with a 422.
 *
 * These MUST carry the same `dismissed` state as the list (both omit it, so
 * both get the `dismissed == false` default) or the counts will not sum to the
 * list's total. Verified against the live corpus: 606 + 63 + 68 = 737.
 *
 * Cost, stated plainly: source_site is deliberately unindexed (cardinality 3,
 * CC-12), so each count is a sequential scan. Acceptable at current row counts;
 * this is the first thing to revisit if Jobs gets slow, and the fix is a
 * backend facet endpoint, not an index added here.
 *
 * The date range is passed through so the counts track the active filter --
 * counts that ignored it would contradict the list.
 */
export function useSourceCounts(dateRange: Pick<JobFilters, 'scraped_from' | 'scraped_to'>) {
  const results = useQueries({
    queries: SOURCE_SITES.map((site) => ({
      queryKey: [...jobKeys.count(site), dateRange] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listJobs({ ...dateRange, source_site: site, limit: 1 }, { signal }),
      select: (page: { total: number }) => page.total,
    })),
  })

  const counts = Object.fromEntries(
    SOURCE_SITES.map((site, i) => [site, results[i].data ?? 0]),
  ) as SourceCounts

  return {
    counts,
    isPending: results.some((r) => r.isPending),
    /** Counts are a nicety: a failure here must not blank the list. */
    isError: results.some((r) => r.isError),
  }
}
