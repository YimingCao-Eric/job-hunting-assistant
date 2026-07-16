import { useCallback, useMemo, useState } from 'react'

import { DateRangeFilter } from '@/components/jobs/DateRangeFilter'
import { JobDetail } from '@/components/jobs/JobDetail'
import { JobsTable } from '@/components/jobs/JobsTable'
import { Pagination } from '@/components/jobs/Pagination'
import { RunProgress } from '@/components/jobs/RunProgress'
import { ScanControls } from '@/components/jobs/ScanControls'
import { SourceFilter } from '@/components/jobs/SourceFilter'
import { PageTitle } from '@/components/ui/PageTitle'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { ErrorState } from '@/components/ui/states/ErrorState'
import { LoadingState } from '@/components/ui/states/LoadingState'
import { useJobs } from '@/hooks/useJobs'
import { useRunProgress } from '@/hooks/useRunProgress'
import { useScanTrigger } from '@/hooks/useScanTrigger'
import { useSourceCounts } from '@/hooks/useSourceCounts'
import { isPageLevelFailure } from '@/lib/api/errors'
import { JOBS_PAGE_SIZE } from '@/lib/api/jobs'
import type { Job, JobFilters, SourceSite } from '@/types/job'

export function JobsPage() {
  const [source, setSource] = useState<SourceSite | undefined>(undefined)
  const [dateRange, setDateRange] = useState<Pick<JobFilters, 'scraped_from' | 'scraped_to'>>({})
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Job | null>(null)

  const filters: JobFilters = useMemo(
    () => ({ source_site: source, ...dateRange, limit: JOBS_PAGE_SIZE, offset }),
    [source, dateRange, offset],
  )

  const jobsQuery = useJobs(filters)
  const { counts, isPending: countsPending } = useSourceCounts(dateRange)
  const runQuery = useRunProgress()
  const trigger = useScanTrigger(runQuery.data)

  const hasFilters = source !== undefined || !!dateRange.scraped_from || !!dateRange.scraped_to

  const clearFilters = useCallback(() => {
    setSource(undefined)
    setDateRange({})
    setOffset(0)
  }, [])

  // Any filter change resets to the first page -- staying on page 4 of a
  // now-2-page result would render an empty list that reads as "no data".
  const changeSource = useCallback((site: SourceSite | undefined) => {
    setSource(site)
    setOffset(0)
  }, [])
  const changeDateRange = useCallback((range: Pick<JobFilters, 'scraped_from' | 'scraped_to'>) => {
    setDateRange(range)
    setOffset(0)
  }, [])

  // The composition rule: this page's only query that can fail page-wide is the
  // list (counts and run progress are supporting). If it failed with a network
  // error, the backend is unreachable -> ONE page-level error, not three.
  const pageLevel = isPageLevelFailure([jobsQuery.error, runQuery.error])

  const scanControls = <ScanControls trigger={trigger} run={runQuery.data} />

  return (
    <>
      <PageTitle title="Jobs" actions={scanControls} />

      {pageLevel && jobsQuery.error ? (
        <ErrorState
          error={jobsQuery.error}
          variant="page"
          onRetry={() => {
            void jobsQuery.refetch()
            void runQuery.refetch()
          }}
        />
      ) : (
        <div className="flex flex-col gap-4 pb-10">
          <RunProgress run={runQuery.data} pickup={trigger.pickup} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <SourceFilter
              value={source}
              onChange={changeSource}
              counts={counts}
              total={
                // Only meaningful with no site filter applied; otherwise the
                // envelope's total is the filtered count.
                source === undefined
                  ? (jobsQuery.data?.total ?? 0)
                  : counts.linkedin + counts.indeed + counts.glassdoor
              }
              countsPending={countsPending}
            />
            <DateRangeFilter
              from={dateRange.scraped_from}
              to={dateRange.scraped_to}
              onChange={changeDateRange}
            />
          </div>

          {/* FR-012: a loading state only while NEVER-RESOLVED. Refetches keep
              the previous rows on screen (placeholderData), so paging and
              filtering never flash empty. */}
          {jobsQuery.isPending ? (
            <LoadingState label="Loading jobs…" />
          ) : jobsQuery.isError ? (
            <ErrorState error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />
          ) : (
            <>
              <JobsTable
                jobs={jobsQuery.data.items}
                onSelect={setSelected}
                emptyState={
                  // FR-013: "no data exists" and "no data matches the filters"
                  // are DIFFERENT states, and the filtered one must offer a way out.
                  hasFilters ? (
                    <EmptyState
                      kind="no-match"
                      title="No jobs match these filters."
                      body="Try a different source site or widen the scraped-date range."
                      onClearFilters={clearFilters}
                    />
                  ) : (
                    <EmptyState
                      kind="no-data"
                      title="No jobs scraped yet."
                      body="Trigger a scan to collect jobs. Progress appears here as it runs."
                    />
                  )
                }
              />
              <Pagination
                total={jobsQuery.data.total}
                limit={jobsQuery.data.limit}
                offset={jobsQuery.data.offset}
                onOffsetChange={setOffset}
              />
            </>
          )}
        </div>
      )}

      {selected ? <JobDetail job={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}
