import { useMemo } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatDateTime } from '@/lib/format/datetime'
import { isSanitizerAvailable, sanitizeDescription, stripTags } from '@/lib/format/description'
import { formatRemote, remoteTitle } from '@/lib/format/remote'
import { formatSalary } from '@/lib/format/salary'
import type { Job, SourceSite } from '@/types/job'

const SITE_LABEL: Record<SourceSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-text-primary">{children}</dd>
    </div>
  )
}

const Absent = () => (
  <span className="text-text-muted" title="Not provided by the source site">
    —
  </span>
)

const present = (v: string | null | undefined) => v !== null && v !== undefined && v.trim() !== ''

export interface JobDetailProps {
  job: Job
  onClose: () => void
}

/**
 * FR-024: the full description plus a working link to the original posting.
 *
 * Renders from the LIST ROW -- `description` is returned inline by GET /jobs,
 * so opening a job costs no extra request. (getJob exists and backs
 * deep-link/reload, not this.)
 */
export function JobDetail({ job, onClose }: JobDetailProps) {
  /**
   * The description is UNTRUSTED third-party HTML. It is SANITIZED here and the
   * sanitized output is the ONLY thing ever handed to dangerouslySetInnerHTML.
   *
   * The `available` check is not ceremony: with no DOM, DOMPurify.sanitize()
   * returns its input UNCHANGED. sanitizeDescription() returns '' in that case,
   * and we fall back to rendering stripped TEXT -- so the failure mode is
   * "loses formatting", never "injects unsanitized HTML".
   */
  const description = useMemo(() => {
    const available = isSanitizerAvailable()
    return {
      available,
      html: available ? sanitizeDescription(job.description) : '',
      text: available ? '' : stripTags(job.description),
    }
  }, [job.description])

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-surface-overlay/40"
      onClick={onClose}
      role="presentation"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={job.title ?? 'Job detail'}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-surface-card shadow-overlay"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary">
              {present(job.title) ? job.title : <Absent />}
            </h2>
            <p className="mt-0.5 truncate text-sm text-text-secondary">
              {present(job.company) ? job.company : <Absent />}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Location">
              {present(job.location_text) ? job.location_text : <Absent />}
            </Field>
            <Field label="Remote">
              <span title={remoteTitle(job.remote)}>{formatRemote(job.remote)}</span>
            </Field>
            <Field label="Salary">{formatSalary(job)}</Field>
            <Field label="Source">
              <Badge tone="neutral">{SITE_LABEL[job.source_site] ?? job.source_site}</Badge>
            </Field>
            <Field label="Posted">
              {job.posted_at ? formatDateTime(job.posted_at) : <Absent />}
            </Field>
            <Field label="Scraped">{formatDateTime(job.scrape_time)}</Field>
          </dl>

          <div className="mt-6">
            <h3 className="text-xs font-medium text-text-muted">Description</h3>
            {description.html ? (
              // SAFE: `html` is the output of sanitizeDescription(), never the
              // raw field. `prose-jd` styles the allowed tags (index.css).
              <div
                className="prose-jd mt-2 text-sm leading-relaxed text-text-primary"
                dangerouslySetInnerHTML={{ __html: description.html }}
              />
            ) : description.text ? (
              <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
                {description.text}
              </div>
            ) : (
              <p className="mt-2 text-sm text-text-muted">
                No description was captured for this posting.
              </p>
            )}
          </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
          {/* FR-024: a WORKING link to the original posting. The field is
              job_url, not url. noopener/noreferrer because it is a third-party
              destination we do not control. */}
          <a
            href={job.job_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-md border border-transparent bg-accent px-4 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover"
          >
            Open original posting ↗
          </a>
          {job.apply_url && job.apply_url !== job.job_url ? (
            <a
              href={job.apply_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-md border border-border-strong bg-surface-card px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-raised"
            >
              Apply ↗
            </a>
          ) : null}
        </footer>
      </aside>
    </div>
  )
}
