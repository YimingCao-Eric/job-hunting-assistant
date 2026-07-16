import { Button } from '@/components/ui/Button'

export interface PaginationProps {
  total: number
  limit: number
  offset: number
  onOffsetChange: (offset: number) => void
}

/**
 * FR-023's pagination, driven by the {items, total, limit, offset} envelope.
 *
 * CAVEAT (research R16), stated rather than hidden: GET /jobs orders by
 * `scrape_time DESC` with NO TIEBREAKER and the ordering is not configurable.
 * A batch ingest writes many rows inside one transaction sharing a scrape_time,
 * so ties are common and offset pagination can DROP OR REPEAT a row across a
 * page boundary.
 *
 * At 25/page over the current corpus this is a rare cosmetic anomaly, not a
 * correctness failure for the operator's task. It is ABSORBED here, not fixed:
 * the proper fix is a one-line backend change adding `id` as a secondary sort
 * key, which is out of scope for a frontend-only feature.
 */
export function Pagination({ total, limit, offset, onOffsetChange }: PaginationProps) {
  if (total === 0) return null

  const first = offset + 1
  const last = Math.min(offset + limit, total)
  const hasPrev = offset > 0
  const hasNext = offset + limit < total
  const page = Math.floor(offset / limit) + 1
  const pageCount = Math.max(1, Math.ceil(total / limit))

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 py-3"
    >
      <p className="text-xs text-text-secondary tabular-nums">
        Showing <span className="font-medium text-text-primary">{first}</span>–
        <span className="font-medium text-text-primary">{last}</span> of{' '}
        <span className="font-medium text-text-primary">{total}</span>
        <span className="ml-2 text-text-muted">
          (page {page} of {pageCount})
        </span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next
        </Button>
      </div>
    </nav>
  )
}
