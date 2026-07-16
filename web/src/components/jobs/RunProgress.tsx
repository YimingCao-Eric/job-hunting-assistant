import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { formatElapsed } from '@/lib/format/datetime'
import { runTone } from '@/lib/tokens/semantics'
import type { PickupState } from '@/hooks/useScanTrigger'
import type { RunLog } from '@/types/runLog'

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  )
}

export interface RunProgressProps {
  run: RunLog | null | undefined
  pickup: PickupState
  actions?: React.ReactNode
}

/**
 * FR-026: live progress -- status, pages scanned, jobs scraped -- updating
 * without operator action. FR-028/029: resolves to a terminal state.
 */
export function RunProgress({ run, pickup, actions }: RunProgressProps) {
  // FR-027: a bounded, EXPLAINED state when a scan is triggered but the scraper
  // never begins -- never an indefinite "in progress". The trigger is a mailbox:
  // it returns before any scan starts and may never be collected at all.
  if (pickup === 'not-responding') {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone="warning">Not responding</Badge>
              <p className="text-sm font-medium text-text-primary">
                The scraper hasn&apos;t picked this scan up
              </p>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              The request was accepted and is still queued, but no run started within 60 seconds —
              the Chrome extension is most likely not running. The request is not lost: it stays
              queued and will run as soon as the extension collects it.
            </p>
          </div>
          {actions}
        </div>
      </Card>
    )
  }

  if (pickup === 'waiting' && !run) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge tone="info">Queued</Badge>
            <p className="text-sm text-text-secondary">
              Waiting for the scraper to pick this scan up…
            </p>
          </div>
          {actions}
        </div>
      </Card>
    )
  }

  if (!run) return null

  const isRunning = run.status === 'running'

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* status is FREE TEXT server-side -- runTone falls back to neutral. */}
            <Badge tone={runTone(run.status)} dot>
              {run.status}
            </Badge>
            <p className="text-sm text-text-secondary">
              {/* '(setup pending)' is real backend behaviour for a just-started
                  run (extension.py:28-31) -- rendered as-is; it resolves. */}
              {run.search_keyword ?? '—'}
              {run.search_location ? ` · ${run.search_location}` : ''}
            </p>
            {run.scan_all && run.scan_all_total ? (
              <Badge tone="neutral">
                Site {run.scan_all_position ?? '?'} of {run.scan_all_total}
              </Badge>
            ) : null}
          </div>

          {run.error_message || run.failure_reason ? (
            <p className="mt-2 max-w-2xl text-sm text-danger-text">
              {run.failure_reason ? `${run.failure_reason}: ` : ''}
              {run.error_message}
            </p>
          ) : null}
        </div>
        {actions}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Pages scanned" value={run.pages_scanned} />
        <Stat label="Jobs scraped" value={run.scraped} />
        <Stat label="New" value={run.new_jobs} />
        <Stat label="Existing" value={run.existing} />
        <div>
          <p className="text-xs text-text-muted">{isRunning ? 'Elapsed' : 'Duration'}</p>
          <p className="text-lg font-semibold tabular-nums text-text-primary">
            {formatElapsed(run.started_at, run.completed_at)}
          </p>
        </div>
      </div>
    </Card>
  )
}
