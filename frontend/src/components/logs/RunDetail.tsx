import { Badge } from '@/components/ui/Badge'
import type { RunLog } from '@/types/runLog'

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div>
      <p className="text-[11px] text-text-muted">{label}</p>
      <p
        className={[
          'text-sm font-semibold tabular-nums',
          tone === 'danger' && value > 0 ? 'text-danger-text' : 'text-text-primary',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  )
}

export interface RunDetailProps {
  run: RunLog
}

/**
 * FR-033: the run's FULL counts and any session error, expanded IN PLACE --
 * there is no per-run GET to navigate to, which is why this is inline.
 * For failed runs: the error message AND failure reason, never a bare "failed".
 */
export function RunDetail({ run }: RunDetailProps) {
  const filters = run.search_filters ?? {}

  return (
    <div className="space-y-3">
      {/* FR-033: never an unexplained "failed". Live data carries
          failure_reason="lazy_cleanup_timeout", category="transient". */}
      {run.status === 'failed' || run.error_message || run.failure_reason ? (
        <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {run.failure_reason ? <Badge tone="danger">{run.failure_reason}</Badge> : null}
            {run.failure_category ? <Badge tone="neutral">{run.failure_category}</Badge> : null}
          </div>
          <p className="mt-1.5 text-xs text-danger-text">
            {run.error_message ?? 'Failed — the backend recorded no error message.'}
          </p>
        </div>
      ) : null}

      {run.session_error ? (
        <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2">
          <p className="text-[11px] font-medium text-warning-text">Session error</p>
          <p className="mt-0.5 text-xs text-warning-text">{run.session_error}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Stat label="Pages scanned" value={run.pages_scanned} />
        <Stat label="Scraped" value={run.scraped} />
        <Stat label="New" value={run.new_jobs} />
        <Stat label="Existing" value={run.existing} />
        <Stat label="Stale skipped" value={run.stale_skipped} />
        <Stat label="JD failed" value={run.jd_failed} tone="danger" />
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
        <div className="flex gap-1.5">
          <dt className="text-text-muted">Strategy:</dt>
          <dd className="text-text-secondary">{run.strategy}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-text-muted">Early stop:</dt>
          <dd className="text-text-secondary">{run.early_stop === null ? '—' : String(run.early_stop)}</dd>
        </div>
        {run.scan_all ? (
          <div className="flex gap-1.5">
            <dt className="text-text-muted">Scan-all:</dt>
            <dd className="text-text-secondary">
              site {run.scan_all_position ?? '?'} of {run.scan_all_total ?? '?'}
            </dd>
          </div>
        ) : null}
        {Object.keys(filters).length > 0 ? (
          <div className="flex gap-1.5">
            <dt className="text-text-muted">Filters:</dt>
            <dd className="max-w-xl truncate font-mono text-text-secondary" title={JSON.stringify(filters)}>
              {JSON.stringify(filters)}
            </dd>
          </div>
        ) : null}
      </dl>

      {run.errors && run.errors.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium text-text-muted">Errors ({run.errors.length})</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-raised p-2 text-[11px] text-text-secondary">
            {JSON.stringify(run.errors, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
