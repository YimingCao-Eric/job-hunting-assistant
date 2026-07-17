import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Table, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { formatDateTime, formatElapsed } from '@/lib/format/datetime'
import { CYCLE_TONE } from '@/lib/tokens/semantics'
import type { Cycle } from '@/types/autoScrape'

/**
 * FR-042: a cycle that FAILED after producing some results must show them,
 * LABELLED PARTIAL -- not hide them. These are the shapes that carry results.
 */
function hasPartialResults(cycle: Cycle): boolean {
  if (cycle.status !== 'failed') return false
  return (
    cycle.scans_succeeded > 0 ||
    cycle.cleanup_results !== null ||
    cycle.match_results !== null ||
    (cycle.run_log_ids?.length ?? 0) > 0
  )
}

export interface CycleHistoryProps {
  cycles: Cycle[]
}

/**
 * FR-041: newest-first with cycle NUMBER, start time, status, and scan
 * attempted/succeeded/failed counts, plus the failure reason for failed cycles.
 *
 * GET /cycles caps at limit 100 with NO offset param, so history cannot page
 * past 100. FR-041 says "recent cycles"; we request 10 and offer no paging.
 */
export function CycleHistory({ cycles }: CycleHistoryProps) {
  const columns: Column<Cycle>[] = [
    {
      key: 'cycle',
      header: 'Cycle',
      // cycle_id is the human-facing NUMBER; `id` is the uuid row key.
      render: (c) => <span className="font-medium tabular-nums">#{c.cycle_id}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={CYCLE_TONE[c.status] ?? 'neutral'} dot>
            {c.status}
          </Badge>
          {hasPartialResults(c) ? <Badge tone="warning">partial results</Badge> : null}
        </div>
      ),
    },
    { key: 'started', header: 'Started', render: (c) => formatDateTime(c.started_at) },
    {
      key: 'duration',
      header: 'Duration',
      render: (c) => formatElapsed(c.started_at, c.completed_at),
    },
    {
      key: 'scans',
      header: 'Scans (att/ok/fail)',
      align: 'right',
      render: (c) => (
        <span className="tabular-nums">
          {c.scans_attempted} / <span className="text-success-text">{c.scans_succeeded}</span> /{' '}
          <span className={c.scans_failed > 0 ? 'text-danger-text' : ''}>{c.scans_failed}</span>
        </span>
      ),
    },
    {
      key: 'detail',
      header: 'Outcome',
      render: (c) => {
        // FR-041: NEVER an unexplained "failed".
        if (c.status === 'failed') {
          const reasons = Object.entries(c.failures_by_reason ?? {})
          return (
            <div className="max-w-md space-y-1">
              <p className="text-danger-text">
                {c.error_message ?? 'Failed — no error message was recorded by the backend.'}
              </p>
              {reasons.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {reasons.map(([reason, count]) => (
                    <Badge key={reason} tone="danger">
                      {reason}: {count}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {hasPartialResults(c) ? (
                <p className="text-xs text-text-muted">
                  This cycle failed after producing results — the counts above are real, but the
                  cycle did not finish.
                </p>
              ) : null}
            </div>
          )
        }
        // Three shapes to serve (spec 010, contracts/cycle-output.md):
        //   {claim_summary: {...}}                     cycles from before the post-scrape
        //                                              claim was retired -- real counts,
        //                                              never rewritten (FR-008)
        //   {claim_summary: null, claim_retired: true} cycles since (FR-007). claim_summary
        //                                              is RETAINED as null -- "no counts
        //                                              produced", not "claimed zero".
        //   null                                       cycle failed before finalizing
        //
        // Counts FIRST. null is falsy so new cycles fall through correctly, but reversing
        // this order renders historical cycles as "claim retired" -- a false statement
        // about cycles that really did claim rows.
        const mr = c.match_results
        const claims = mr?.claim_summary as Record<string, number> | null | undefined
        if (claims) {
          const claimed = Object.values(claims).reduce((a, b) => a + b, 0)
          return <span className="text-text-secondary">{claimed} claimed</span>
        }
        if (mr?.claim_retired === true) {
          return <span className="text-text-secondary">claim retired</span>
        }
        return <span className="text-text-secondary">{c.notes ? c.notes : '—'}</span>
      },
    },
  ]

  return (
    <Card title="Recent cycles">
      <Table
        columns={columns}
        rows={cycles}
        rowKey={(c) => c.id}
        emptyState={
          <EmptyState
            kind="no-data"
            title="No cycles yet."
            body="Cycles appear here once the orchestrator has run at least one."
          />
        }
      />
    </Card>
  )
}
