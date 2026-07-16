import { useState } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatAge, formatDateTime } from '@/lib/format/datetime'
import { heartbeatGrade, heartbeatLabel, isHeartbeatUnhealthy } from '@/lib/format/heartbeat'
import { HEARTBEAT_TONE } from '@/lib/tokens/semantics'
import type { useAutoScrape } from '@/hooks/useAutoScrape'
import type { AutoScrapeInstances, AutoScrapeStateRead } from '@/types/autoScrape'

/** 0 | '0' | null all mean "unscheduled" -- the sentinel is polymorphic
 *  (auto_scrape.py:88-98). Epoch MILLISECONDS. */
function nextCycleLabel(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (!n || Number.isNaN(n)) return 'Not scheduled'
  return formatDateTime(new Date(n).toISOString())
}

export interface StatusHeaderProps {
  state: AutoScrapeStateRead
  instances: AutoScrapeInstances | undefined
  instancesError: boolean
  mutations: ReturnType<typeof useAutoScrape>['mutations']
}

/**
 * FR-037: enabled/paused, cycle phase, cycle number, next-cycle time.
 * FR-038: heartbeat graded by age, with STALE PRESENTED AS A WARNING DISTINCT
 *         FROM A DELIBERATE PAUSE.
 * FR-039: warn when more than one extension instance reports in.
 * FR-040: every control is a REQUEST the extension acts on asynchronously.
 *
 * Ported from the old StatusHeader, minus its 1s cosmetic clock and the
 * `<span className="sr-only" aria-hidden>{tick}</span>` re-render hack -- the
 * 5s poll already re-renders this, so a second timer bought nothing.
 */
export function StatusHeader({ state, instances, instancesError, mutations }: StatusHeaderProps) {
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const s = state.state

  const grade = heartbeatGrade(state.last_sw_heartbeat_at)
  const unhealthy = isHeartbeatUnhealthy(grade)
  const { enable, pause, shutdown, testCycle } = mutations
  const busy = enable.isPending || pause.isPending || shutdown.isPending || testCycle.isPending

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* FR-038: `enabled` is an OPERATOR DECISION (neutral/success);
                the heartbeat is a MALFUNCTION signal (danger). Two independent
                badges, two different tones -- they can never be confused. */}
            <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
              {s.enabled ? 'Loop enabled' : 'Loop paused'}
            </Badge>
            <Badge tone={HEARTBEAT_TONE[grade]} dot>
              {heartbeatLabel(grade)}
            </Badge>
            <Badge tone="neutral">Phase: {s.cycle_phase}</Badge>
            <Badge tone="neutral">Cycle #{s.cycle_id}</Badge>
            {s.exit_requested ? <Badge tone="warning">Stop-and-exit pending</Badge> : null}
            {s.test_cycle_pending ? <Badge tone="info">Test cycle pending</Badge> : null}
            {s.config_change_pending ? <Badge tone="info">Config change pending</Badge> : null}
          </div>

          {/* enabled:true + unhealthy heartbeat is THE alarming combination:
              it is supposed to be running and it is not. Say so explicitly. */}
          {s.enabled && unhealthy ? (
            <p className="max-w-2xl rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-text">
              The loop is enabled but the extension is not reporting in
              {state.last_sw_heartbeat_at ? ` (last seen ${formatAge(state.last_sw_heartbeat_at)})` : ''}
              . Unattended scraping is not running. This is not the same as a pause — nobody turned
              it off.
            </p>
          ) : null}

          {/* FR-039: concurrent instances corrupt cycle accounting. */}
          {instances && instances.count > 1 ? (
            <p className="max-w-2xl rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning-text">
              {instances.count} extension instances are reporting in. Concurrent instances corrupt
              cycle accounting — close all but one.
            </p>
          ) : null}
          {instancesError ? (
            <p className="max-w-2xl text-xs text-text-muted">
              Could not read extension instances — the multi-instance warning is unavailable.
            </p>
          ) : null}

          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Next cycle:</dt>
              <dd className="text-text-secondary">{nextCycleLabel(s.next_cycle_at)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Last heartbeat:</dt>
              <dd className="text-text-secondary">{formatAge(state.last_sw_heartbeat_at)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Precheck failures:</dt>
              <dd className="text-text-secondary tabular-nums">{s.consecutive_precheck_failures}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Clean cycles:</dt>
              <dd className="text-text-secondary tabular-nums">{s.clean_cycles_count}</dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {s.enabled ? (
              <Button variant="secondary" size="sm" busy={pause.isPending} disabled={busy} onClick={() => pause.mutate()}>
                Pause loop
              </Button>
            ) : (
              <Button variant="primary" size="sm" busy={enable.isPending} disabled={busy} onClick={() => enable.mutate()}>
                Enable loop
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              busy={testCycle.isPending}
              disabled={busy || s.test_cycle_pending}
              onClick={() => testCycle.mutate()}
            >
              Run test cycle
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || s.exit_requested}
              onClick={() => setConfirmShutdown(true)}
            >
              Stop &amp; exit
            </Button>
          </div>

          {/* FR-040: these are REQUESTS, not completed actions. */}
          <p className="max-w-xs text-right text-xs text-text-muted">
            Controls are requests — the extension acts on them on its next check-in, not
            immediately.
          </p>

          {/* Mutation errors SURFACE. The old ConfigEditor had try/finally with
              NO catch, so a failed action was completely invisible. */}
          {[enable, pause, shutdown, testCycle]
            .filter((m) => m.isError)
            .map((m, i) => (
              <p key={i} role="alert" className="max-w-xs text-right text-xs text-danger-text">
                {m.error?.message}
              </p>
            ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmShutdown}
        title="Request stop-and-exit?"
        body="This asks the extension to finish what it is doing and shut the loop down. The extension acts on the request asynchronously — it will not stop the instant you confirm."
        confirmLabel="Request stop & exit"
        tone="destructive"
        busy={shutdown.isPending}
        onConfirm={() => shutdown.mutate(undefined, { onSettled: () => setConfirmShutdown(false) })}
        onCancel={() => setConfirmShutdown(false)}
      />
    </Card>
  )
}
