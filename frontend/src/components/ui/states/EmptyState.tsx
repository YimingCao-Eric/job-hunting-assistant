import type { ReactNode } from 'react'

import { Button } from '@/components/ui/Button'

/**
 * FR-013 requires distinguishing "no data exists" from "no data matches the
 * current filters", and the filtered-empty state MUST offer a way to clear
 * filters.
 *
 * The prop shape ENFORCES the pairing: this is a discriminated union, so
 * `kind="no-match"` without `onClearFilters` is a TYPE ERROR, not a review
 * comment. `kind="no-data"` cannot accept one.
 */
export type EmptyStateProps =
  | {
      kind: 'no-data'
      title: string
      body?: ReactNode
      onClearFilters?: never
    }
  | {
      kind: 'no-match'
      title: string
      body?: ReactNode
      onClearFilters: () => void
    }

export function EmptyState(props: EmptyStateProps) {
  const { kind, title, body } = props

  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {body ? <div className="max-w-md text-sm text-text-secondary">{body}</div> : null}
      {kind === 'no-match' ? (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={props.onClearFilters}>
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  )
}
