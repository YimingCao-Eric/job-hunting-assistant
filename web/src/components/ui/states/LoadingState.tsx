import { Spinner } from '@/components/ui/Spinner'

export interface LoadingStateProps {
  label?: string
}

/**
 * FR-012: shown while `isPending` -- i.e. NEVER RESOLVED, which is distinct
 * from RESOLVED EMPTY. Rendering an empty state before the first result
 * resolves is the specific bug this forbids. (The old code's
 * `if (!state) return <div>Loading…</div>` could not tell the two apart.)
 *
 * FR-015: NOT rendered on a background refetch. Refetches update in place --
 * `placeholderData: keepPreviousData` keeps the previous data on screen. A page
 * that flips to LoadingState on a poll tick is an FR-015 violation.
 */
export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div className="flex items-center justify-center gap-3 px-4 py-16 text-text-muted">
      <Spinner size="md" label={label} />
      <span className="text-sm">{label}</span>
    </div>
  )
}
