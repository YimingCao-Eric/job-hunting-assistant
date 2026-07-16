import { get, type RequestOptions } from '@/lib/api/client'
import type { Job, JobFilters, JobsPage } from '@/types/job'

/**
 * /jobs -- the canonical merged listing delivered by FEATURE 008.
 * FR-048–FR-052 are out of this feature's scope; this module only reads it.
 */

/** The backend default. `limit` is ge=1, le=500 -- and limit=0 is a 422. */
export const JOBS_PAGE_SIZE = 25

/**
 * Exact path is `/jobs` -- `/jobs/` 307-redirects.
 *
 * Ordering is scrape_time DESC, not configurable, with NO TIEBREAKER: a batch
 * ingest writes many rows in one transaction sharing a scrape_time, so offset
 * pagination can drop/repeat a row across a page boundary on ties. Absorbed,
 * not fixed (research R16) -- the fix is a backend secondary sort key.
 *
 * `dismissed` is deliberately never sent: omitting it means `dismissed == false`,
 * which is what we want, and NO value returns both (research R15).
 *
 * `date_from`/`date_to` are deliberately never sent: they filter posted_at (a
 * timestamptz) against bare-date midnight, so date_to=2026-07-15 excludes nearly
 * all of that day. FR-023 needs a SCRAPED-date range, so the correct pair
 * (scraped_from/scraped_to, which does the +1-day math) is also the required one.
 */
export function listJobs(filters: JobFilters = {}, options?: RequestOptions): Promise<JobsPage> {
  return get<JobsPage>('/jobs', {
    ...options,
    query: {
      source_site: filters.source_site,
      scraped_from: filters.scraped_from,
      scraped_to: filters.scraped_to,
      limit: filters.limit ?? JOBS_PAGE_SIZE,
      offset: filters.offset ?? 0,
    },
  })
}

/**
 * Takes the CANONICAL id (`job.id`), not `source_row_id` -- they are different
 * id spaces and POST /jobs/ingest returns the other one.
 *
 * The list response already carries `description`, so detail can render from the
 * row; this backs deep-link/reload correctness. 404 -> {"detail": "Job not found"}.
 */
export function getJob(id: string, options?: RequestOptions): Promise<Job> {
  return get<Job>(`/jobs/${id}`, options)
}
