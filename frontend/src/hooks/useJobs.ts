import { useQuery } from '@tanstack/react-query'

import { JOBS_PAGE_SIZE, getJob, listJobs } from '@/lib/api/jobs'
import type { ApiError } from '@/lib/api/errors'
import type { Job, JobFilters, JobsPage } from '@/types/job'

export const jobKeys = {
  all: ['jobs'] as const,
  list: (filters: JobFilters) => ['jobs', 'list', filters] as const,
  detail: (id: string) => ['jobs', 'detail', id] as const,
  count: (site: string) => ['jobs', 'count', site] as const,
}

/**
 * FR-022/FR-023. `placeholderData: keepPreviousData` is inherited from the
 * QueryClient defaults, which is what satisfies FR-015: paging or changing a
 * filter keeps the current rows on screen instead of flashing a loading state.
 */
export function useJobs(filters: JobFilters) {
  return useQuery<JobsPage, ApiError>({
    queryKey: jobKeys.list(filters),
    queryFn: ({ signal }) => listJobs({ ...filters, limit: filters.limit ?? JOBS_PAGE_SIZE }, { signal }),
  })
}

/** FR-024. The list row already carries `description`; this backs deep-link/reload. */
export function useJob(id: string | null) {
  return useQuery<Job, ApiError>({
    queryKey: jobKeys.detail(id ?? ''),
    queryFn: ({ signal }) => getJob(id as string, { signal }),
    enabled: id !== null,
  })
}
