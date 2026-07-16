import { Badge } from '@/components/ui/Badge'
import { Table, type Column } from '@/components/ui/Table'
import { formatDate, formatDateTime } from '@/lib/format/datetime'
import { formatRemote, remoteTitle } from '@/lib/format/remote'
import { formatSalary } from '@/lib/format/salary'
import type { Job, SourceSite } from '@/types/job'

const SITE_LABEL: Record<SourceSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

/**
 * FR-051 / the spec's "A job's description or company is missing" edge case:
 * the row still renders and the missing field is MARKED ABSENT rather than
 * blank. `company` can be "" as well as null (an empty mosaic company wins over
 * a populated graphql employer_name -- projection.py:217, research R19 #2), so
 * this tests emptiness, not just nullishness. The live corpus has one such row.
 */
function Absent() {
  return (
    <span className="text-text-muted" title="Not provided by the source site">
      —
    </span>
  )
}

const present = (v: string | null | undefined) => (v !== null && v !== undefined && v.trim() !== '')

export interface JobsTableProps {
  jobs: Job[]
  onSelect: (job: Job) => void
  emptyState?: React.ReactNode
}

/** FR-022: newest-scraped first (the backend's scrape_time DESC), showing
 *  title, company, location, source site, posting date and scraped date. */
export function JobsTable({ jobs, onSelect, emptyState }: JobsTableProps) {
  const columns: Column<Job>[] = [
    {
      key: 'title',
      header: 'Title',
      render: (job) =>
        present(job.title) ? (
          <span className="font-medium text-text-primary">{job.title}</span>
        ) : (
          <Absent />
        ),
    },
    {
      key: 'company',
      header: 'Company',
      render: (job) => (present(job.company) ? job.company : <Absent />),
    },
    {
      key: 'location',
      header: 'Location',
      render: (job) =>
        present(job.location_text) ? (
          <span className="text-text-secondary">{job.location_text}</span>
        ) : (
          <Absent />
        ),
    },
    {
      key: 'remote',
      header: 'Remote',
      // TRI-STATE. null renders "—", NEVER "On-site" (research R4).
      render: (job) => (
        <span
          className={job.remote === null ? 'text-text-muted' : 'text-text-secondary'}
          title={remoteTitle(job.remote)}
        >
          {formatRemote(job.remote)}
        </span>
      ),
    },
    {
      key: 'salary',
      // Plain-notation strings, rendered in the period AS GIVEN. Never annualized.
      header: 'Salary',
      render: (job) => (
        <span className="whitespace-nowrap text-text-secondary tabular-nums">
          {formatSalary(job)}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      render: (job) => <Badge tone="neutral">{SITE_LABEL[job.source_site] ?? job.source_site}</Badge>,
    },
    {
      key: 'posted',
      header: 'Posted',
      render: (job) => (
        <span className="whitespace-nowrap text-text-secondary">{formatDate(job.posted_at)}</span>
      ),
    },
    {
      key: 'scraped',
      header: 'Scraped',
      render: (job) => (
        <span className="whitespace-nowrap text-text-muted" title={formatDateTime(job.scrape_time)}>
          {formatDate(job.scrape_time)}
        </span>
      ),
    },
  ]

  return (
    <Table columns={columns} rows={jobs} rowKey={(job) => job.id} onRowClick={onSelect} emptyState={emptyState} />
  )
}
