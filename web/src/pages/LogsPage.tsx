import { useCallback, useState } from 'react'

import { RunList } from '@/components/logs/RunList'
import { Button } from '@/components/ui/Button'
import { PageTitle } from '@/components/ui/PageTitle'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { ErrorState } from '@/components/ui/states/ErrorState'
import { LoadingState } from '@/components/ui/states/LoadingState'
import { RUN_LOG_PAGE_SIZE, useRunLog } from '@/hooks/useRunLog'

/** FR-032. Free string server-side, exact ==; these are the real values. */
const STATUS_OPTIONS = [
  { value: undefined, label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
] as const

/**
 * Binds /extension/run-log AND NOTHING ELSE (SC-002).
 *
 * The old LogsPage also called /jobs/skipped, /jobs/reports, /dedup/reports and
 * /match/reports -- all deleted. /jobs/skipped is especially sharp: that path
 * now falls through to GET /jobs/{job_id} and fails UUID parse, so it returns
 * 422, not 404.
 */
export function LogsPage() {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [offset, setOffset] = useState(0)

  const runs = useRunLog(status, offset)

  const clearFilters = useCallback(() => {
    setStatus(undefined)
    setOffset(0)
  }, [])

  const changeStatus = useCallback((next: string | undefined) => {
    setStatus(next)
    setOffset(0)
  }, [])

  // No total count exists (the response is a bare array), so "page N of M" is
  // impossible. We can only know there is a next page if this one came back
  // full -- as-built.
  const hasNext = (runs.data?.length ?? 0) === RUN_LOG_PAGE_SIZE
  const hasPrev = offset > 0

  return (
    <>
      <PageTitle
        title="Logs"
        actions={
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
            {STATUS_OPTIONS.map((opt) => {
              const isActive = status === opt.value
              return (
                <button
                  key={opt.label}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => changeStatus(opt.value)}
                  className={[
                    'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-accent bg-accent text-text-inverse'
                      : 'border-border bg-surface-card text-text-secondary hover:bg-surface-raised',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        }
      />

      <div className="flex flex-col gap-3 pb-10">
        {/* FR-012: loading only while never-resolved. Paging keeps the previous
            rows on screen via placeholderData. */}
        {runs.isPending ? (
          <LoadingState label="Loading runs…" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} variant="page" onRetry={() => void runs.refetch()} />
        ) : runs.data.length === 0 ? (
          // FR-013: "no runs at all" and "none match this filter" are different.
          status ? (
            <EmptyState
              kind="no-match"
              title={`No ${status} runs.`}
              body="No runs on this page match that status."
              onClearFilters={clearFilters}
            />
          ) : (
            <EmptyState
              kind="no-data"
              title="No runs recorded yet."
              body="Runs appear here once a scan has been triggered from the Jobs page."
            />
          )
        ) : (
          <>
            <RunList runs={runs.data} pageOffset={offset} status={status} />

            {hasPrev || hasNext ? (
              <div className="flex items-center justify-between gap-3 py-1">
                <p className="text-xs text-text-muted tabular-nums">
                  Runs {offset + 1}–{offset + runs.data.length}
                  {/* Deliberately no "of N": the endpoint returns a bare array
                      with no total count. Claiming one would be a fiction. */}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasPrev}
                    onClick={() => setOffset(Math.max(0, offset - RUN_LOG_PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasNext}
                    onClick={() => setOffset(offset + RUN_LOG_PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
