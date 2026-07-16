import { useState } from 'react'

import { DebugTracePanel } from '@/components/logs/DebugTracePanel'
import { RunDetail } from '@/components/logs/RunDetail'
import { Badge } from '@/components/ui/Badge'
import { useRunTrace } from '@/hooks/useRunTrace'
import { formatDateTime, formatElapsed } from '@/lib/format/datetime'
import { runTone } from '@/lib/tokens/semantics'
import type { RunLog } from '@/types/runLog'

/** One expanded row. Its own component so the trace query mounts (and therefore
 *  FIRES) only when the row is actually open -- that is FR-035's mechanism, not
 *  a conditional inside a hook. */
function ExpandedRun({
  run,
  absoluteOffset,
  status,
}: {
  run: RunLog
  absoluteOffset: number
  status: string | undefined
}) {
  const [showTrace, setShowTrace] = useState(false)
  const trace = useRunTrace(showTrace ? run.id : null, absoluteOffset, status)

  return (
    <div className="space-y-3 border-t border-border bg-surface-raised/40 px-3 py-3">
      <RunDetail run={run} />

      <div>
        <button
          type="button"
          onClick={() => setShowTrace((v) => !v)}
          className="text-xs font-medium text-accent hover:underline"
        >
          {showTrace ? '▾ Hide debug trace' : '▸ Show debug trace'}
        </button>
        {/* Cached per run id, so collapse/re-expand does NOT refetch (FR-035). */}
        {showTrace ? (
          <div className="mt-2">
            <DebugTracePanel
              trace={trace.data}
              isPending={trace.isPending}
              error={trace.error}
              onRetry={() => void trace.refetch()}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export interface RunListProps {
  runs: RunLog[]
  /** The list's offset, so a row's absolute position can be computed. */
  pageOffset: number
  status: string | undefined
}

/**
 * FR-031: recent runs newest-first with status, start time, duration, search
 * keyword/location and outcome counts.
 * FR-033: expand IN PLACE -- there is no per-run GET to navigate to.
 */
export function RunList({ runs, pageOffset, status }: RunListProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-card">
      {runs.map((run, i) => {
        const isOpen = expanded === run.id
        return (
          <div key={run.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : run.id)}
              aria-expanded={isOpen}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-surface-raised"
            >
              <span className="w-4 shrink-0 text-text-muted">{isOpen ? '▾' : '▸'}</span>

              {/* status is FREE TEXT server-side -- runTone falls back to neutral. */}
              <span className="w-24 shrink-0">
                <Badge tone={runTone(run.status)} dot>
                  {run.status}
                </Badge>
              </span>

              <span className="w-44 shrink-0 whitespace-nowrap text-text-secondary">
                {formatDateTime(run.started_at)}
              </span>

              <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-text-muted">
                {formatElapsed(run.started_at, run.completed_at)}
              </span>

              {/* '(setup pending)' is a real backend value for a run whose
                  keyword was blank at start (extension.py:28-31). Rendered as-is. */}
              <span className="min-w-0 flex-1 truncate text-text-primary">
                {run.search_keyword ?? '—'}
                {run.search_location ? (
                  <span className="text-text-muted"> · {run.search_location}</span>
                ) : null}
              </span>

              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-secondary">
                <span title="Scraped">{run.scraped}</span>
                {' / '}
                <span className="text-success-text" title="New">
                  {run.new_jobs}
                </span>
                {' / '}
                <span className="text-text-muted" title="Existing">
                  {run.existing}
                </span>
              </span>

              {run.failure_reason ? (
                <span className="shrink-0">
                  <Badge tone="danger">{run.failure_reason}</Badge>
                </span>
              ) : null}
            </button>

            {isOpen ? (
              <ExpandedRun run={run} absoluteOffset={pageOffset + i} status={status} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
