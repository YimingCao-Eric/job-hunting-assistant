import { useState } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Table, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { formatAge } from '@/lib/format/datetime'
import { PROBE_TONE } from '@/lib/tokens/semantics'
import type { useAutoScrape } from '@/hooks/useAutoScrape'
import type { SiteSession } from '@/types/autoScrape'
import type { SourceSite } from '@/types/job'

const SITE_LABEL: Record<SourceSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

export interface SessionHealthProps {
  sessions: SiteSession[]
  mutations: ReturnType<typeof useAutoScrape>['mutations']
}

/**
 * FR-043: per-site probe status, consecutive failures and backoff, with a
 * per-site reset control (FR-011 -> gated by ConfirmDialog).
 */
export function SessionHealth({ sessions, mutations }: SessionHealthProps) {
  const [confirmSite, setConfirmSite] = useState<SourceSite | null>(null)
  const { resetSession } = mutations

  const columns: Column<SiteSession>[] = [
    {
      key: 'site',
      header: 'Site',
      // `site` IS the primary key -- there is no `id` field on this row.
      render: (s) => <span className="font-medium">{SITE_LABEL[s.site] ?? s.site}</span>,
    },
    {
      key: 'status',
      header: 'Probe status',
      // ONE LINE. This replaces the old SessionHealth.tsx:37-45 -- a 5-branch
      // inline ternary of raw classes that spent two near-identical reds on
      // captcha vs expired. Status -> tone now lives in lib/tokens/semantics.
      render: (s) => (
        <Badge tone={PROBE_TONE[s.last_probe_status] ?? 'neutral'} dot>
          {s.last_probe_status}
        </Badge>
      ),
    },
    { key: 'probed', header: 'Last probed', render: (s) => formatAge(s.last_probe_at) },
    {
      key: 'failures',
      header: 'Consecutive failures',
      align: 'right',
      render: (s) => (
        <span className={`tabular-nums ${s.consecutive_failures > 0 ? 'text-danger-text' : ''}`}>
          {s.consecutive_failures}
        </span>
      ),
    },
    {
      key: 'backoff',
      header: 'Backoff',
      align: 'right',
      render: (s) => (
        <span
          className={`tabular-nums ${s.backoff_multiplier > 1 ? 'text-warning-text' : 'text-text-secondary'}`}
          // rate_limited doubles it, capped at 64.0 -- so 64 means "maxed out".
          title={s.backoff_multiplier >= 64 ? 'Backoff is at its 64× maximum' : undefined}
        >
          {s.backoff_multiplier}×
        </span>
      ),
    },
    {
      key: 'notified',
      header: 'Notified',
      render: (s) => (s.notified_user ? <Badge tone="warning">yes</Badge> : <span className="text-text-muted">no</span>),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (s) => (
        <Button
          variant="destructive"
          size="sm"
          busy={resetSession.isPending && resetSession.variables === s.site}
          onClick={() => setConfirmSite(s.site)}
        >
          Reset
        </Button>
      ),
    },
  ]

  return (
    <Card title="Session health">
      <Table
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.site}
        emptyState={<EmptyState kind="no-data" title="No site sessions recorded." />}
      />

      {/* Mutation errors SURFACE (the old page swallowed them entirely). */}
      {resetSession.isError ? (
        <p role="alert" className="mt-3 text-xs text-danger-text">
          Could not reset the session: {resetSession.error.message}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmSite !== null}
        title={`Reset the ${confirmSite ? (SITE_LABEL[confirmSite] ?? confirmSite) : ''} session?`}
        body="This clears the failure counter and backoff, and sets the probe status back to unknown. It does not re-authenticate the site — the extension re-probes on its next cycle."
        confirmLabel="Reset session"
        tone="destructive"
        busy={resetSession.isPending}
        onConfirm={() => {
          if (confirmSite) {
            resetSession.mutate(confirmSite, { onSettled: () => setConfirmSite(null) })
          }
        }}
        onCancel={() => setConfirmSite(null)}
      />
    </Card>
  )
}
