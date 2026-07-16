import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { formatElapsed } from '@/lib/format/datetime'
import { CYCLE_TONE } from '@/lib/tokens/semantics'
import type { AutoScrapeState, Cycle } from '@/types/autoScrape'

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  )
}

export interface CurrentCycleProps {
  state: AutoScrapeState
  cycles: Cycle[]
}

/** The in-flight cycle, with an explicit "no active cycle" empty state --
 *  a per-component empty state is part of what makes the old decomposition
 *  the quality bar. */
export function CurrentCycle({ state, cycles }: CurrentCycleProps) {
  const active = cycles.find((c) => c.cycle_id === state.cycle_id && c.completed_at === null)
  const results = state.cycle_results

  if (!active) {
    return (
      <Card title="Current cycle">
        <EmptyState
          kind="no-data"
          title="No active cycle."
          body={
            state.enabled
              ? 'The loop is enabled and waiting for its next scheduled cycle.'
              : 'The loop is paused, so no cycle is scheduled.'
          }
        />
      </Card>
    )
  }

  return (
    <Card
      title={`Current cycle #${active.cycle_id}`}
      actions={<Badge tone={CYCLE_TONE[active.status] ?? 'neutral'} dot>{active.status}</Badge>}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Attempted" value={results.scans_attempted} />
        <Stat label="Succeeded" value={results.scans_succeeded} />
        <Stat label="Failed" value={results.scans_failed} />
        <div>
          <p className="text-xs text-text-muted">Elapsed</p>
          <p className="text-lg font-semibold tabular-nums text-text-primary">
            {formatElapsed(active.started_at, null)}
          </p>
        </div>
      </div>

      {Object.keys(results.failures_by_reason).length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-text-muted">Failures by reason</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(results.failures_by_reason).map(([reason, count]) => (
              <Badge key={reason} tone="danger">
                {reason}: {count}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  )
}
