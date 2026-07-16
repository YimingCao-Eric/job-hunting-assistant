import { SOURCE_SITES, type SourceCounts, type SourceSite } from '@/types/job'

export interface SourceFilterProps {
  value: SourceSite | undefined
  onChange: (site: SourceSite | undefined) => void
  counts: SourceCounts
  total: number
  countsPending: boolean
}

const LABEL: Record<SourceSite, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

/**
 * FR-023: filter by source site WITH per-site counts, and the active filter is
 * visually unambiguous.
 *
 * A closed set of three. `source_site` is NOT enum-validated server-side --
 * ?source_site=bogus returns 200 with an empty list rather than a 422 -- but
 * that is unreachable from a closed-set UI. Worth knowing: a typo would look
 * like "no jobs", not like an error.
 */
export function SourceFilter({
  value,
  onChange,
  counts,
  total,
  countsPending,
}: SourceFilterProps) {
  const options: Array<{ site: SourceSite | undefined; label: string; count: number }> = [
    { site: undefined, label: 'All sites', count: total },
    ...SOURCE_SITES.map((site) => ({ site, label: LABEL[site], count: counts[site] })),
  ]

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Source site">
      {options.map((opt) => {
        const isActive = value === opt.site
        return (
          <button
            key={opt.label}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(opt.site)}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'border-accent bg-accent text-text-inverse'
                : 'border-border bg-surface-card text-text-secondary hover:bg-surface-raised',
            ].join(' ')}
          >
            {opt.label}
            <span
              className={[
                'rounded-sm px-1 text-[11px] tabular-nums',
                isActive ? 'bg-white/20' : 'bg-surface-raised text-text-muted',
              ].join(' ')}
            >
              {countsPending ? '·' : opt.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}
