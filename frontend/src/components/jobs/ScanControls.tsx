import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { scanRejectionMessage, type useScanTrigger } from '@/hooks/useScanTrigger'
import { SOURCE_SITES, type SourceSite } from '@/types/job'
import type { RunLog } from '@/types/runLog'

const SITE_LABEL: Record<SourceSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

export interface ScanControlsProps {
  trigger: ReturnType<typeof useScanTrigger>
  run: RunLog | null | undefined
}

/**
 * FR-025: a scan trigger per site plus a sequential "scan all sites".
 * FR-028: a Stop control while a run is active, gated by ConfirmDialog (FR-011).
 *
 * Scan STATUS comes from the run-log (useRunProgress) and, where pending flags
 * matter, from GET /extension/state -- NEVER from GET /extension/pending*,
 * which are read-once mailboxes that would steal the extension's command
 * (FR-030). An ESLint rule enforces this.
 */
export function ScanControls({ trigger, run }: ScanControlsProps) {
  const [confirmStop, setConfirmStop] = useState(false)
  const { scan, stop, pickup } = trigger

  const isRunning = run?.status === 'running'
  const isBusy = scan.isPending || pickup === 'waiting'

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {SOURCE_SITES.map((site) => (
          <Button
            key={site}
            variant="secondary"
            size="sm"
            busy={scan.isPending && scan.variables?.website === site}
            disabled={isBusy || isRunning}
            onClick={() => scan.mutate({ website: site })}
          >
            Scan {SITE_LABEL[site]}
          </Button>
        ))}

        <Button
          variant="primary"
          size="sm"
          busy={scan.isPending && scan.variables?.scan_all === true}
          disabled={isBusy || isRunning}
          onClick={() =>
            scan.mutate({ scan_all: true, scan_all_position: 1, scan_all_total: SOURCE_SITES.length })
          }
        >
          Scan all sites
        </Button>

        {isRunning ? (
          <Button variant="destructive" size="sm" busy={stop.isPending} onClick={() => setConfirmStop(true)}>
            Stop scan
          </Button>
        ) : null}
      </div>

      {/* SC-011: each of the three rejection reasons produces a DISTINCT,
          actionable message quoting its retry delay. Zero generic failures. */}
      {scan.isError ? (
        <p role="alert" className="max-w-md text-right text-xs text-danger-text">
          {scanRejectionMessage(scan.error)}
        </p>
      ) : null}
      {stop.isError ? (
        <p role="alert" className="max-w-md text-right text-xs text-danger-text">
          {stop.error.message}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmStop}
        title="Stop the running scan?"
        body={
          <>
            This ends the current run immediately and marks it failed. Any jobs already scraped are
            kept — but the rest of this run&apos;s pages will not be collected.
          </>
        }
        confirmLabel="Stop scan"
        tone="destructive"
        busy={stop.isPending}
        onConfirm={() => {
          stop.mutate(undefined, { onSettled: () => setConfirmStop(false) })
        }}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  )
}
