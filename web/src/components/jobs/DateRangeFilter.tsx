export interface DateRangeFilterProps {
  from: string | undefined
  to: string | undefined
  onChange: (range: { scraped_from?: string; scraped_to?: string }) => void
}

/**
 * FR-023's SCRAPED-date range, combinable with the source filter.
 *
 * Binds scraped_from/scraped_to -- NEVER date_from/date_to. The latter filter
 * posted_at (a timestamptz) against bare-date midnight, so date_to=2026-07-15
 * compiles to `posted_at <= 2026-07-15T00:00:00` and excludes nearly the whole
 * named day. scraped_from/scraped_to do the +1-day math correctly and are
 * inclusive of the whole end day (routers/jobs.py:897-903). FR-023 asks for a
 * scraped-date range, so the correct pair is also the required one.
 */
export function DateRangeFilter({ from, to, onChange }: DateRangeFilterProps) {
  const input =
    'rounded-md border border-border bg-surface-card px-2 py-1.5 text-xs text-text-primary ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="text-xs text-text-muted" htmlFor="scraped-from">
        Scraped
      </label>
      <input
        id="scraped-from"
        type="date"
        aria-label="Scraped from"
        value={from ?? ''}
        max={to}
        onChange={(e) => onChange({ scraped_from: e.target.value || undefined, scraped_to: to })}
        className={input}
      />
      <span className="text-xs text-text-muted">to</span>
      <input
        id="scraped-to"
        type="date"
        aria-label="Scraped to"
        value={to ?? ''}
        min={from}
        onChange={(e) => onChange({ scraped_from: from, scraped_to: e.target.value || undefined })}
        className={input}
      />
    </div>
  )
}
