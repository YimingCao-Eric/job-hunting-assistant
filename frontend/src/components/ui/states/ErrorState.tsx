import { Button } from '@/components/ui/Button'
import type { ApiError } from '@/lib/api/errors'

export interface ErrorStateProps {
  error: ApiError
  /** REQUIRED (FR-014) -- a retry-less error state cannot be written. */
  onRetry: () => void
  /**
   * THE COMPOSITION RULE (contracts/ui-primitives.md, rule 5a). Decide with
   * `isPageLevelFailure(errors)` from lib/api/errors:
   *
   *  - ALL of a page's queries failed with kind 'network' -> 'page'.
   *    The backend is unreachable: ONE fact, ONE statement. N stacked identical
   *    "could not reach the backend" cards would be noise, and the spec's
   *    "Backend unreachable" edge case asks for a page-level state here.
   *  - A SUBSET failed, or any failure is NON-network (422/409/404/500)
   *    -> 'section' (the default). The rest of the page keeps rendering, and
   *    the specific reason FR-016 requires survives.
   *
   * Validation errors surface as fieldErrors ON THE FIELD and never reach here.
   */
  variant?: 'page' | 'section'
}

/**
 * The ONLY error presentation in the app -- identical on all four pages
 * (FR-009, SC-005), because it is literally the same component.
 *
 * `error.message` is always human-readable and always safe to render; the
 * normalizer guarantees it on every branch, including the fallbacks.
 *
 * 401 does NOT reach here: kind === 'unauthorized' is handled once in the shell.
 *
 * SC-008 (unreachable -> stated error + retry within 10s on 100% of pages,
 * none hanging, none showing a misleading empty state) follows from
 * kind: 'network' reaching this component on every page.
 */
export function ErrorState({ error, onRetry, variant = 'section' }: ErrorStateProps) {
  const isPage = variant === 'page'

  return (
    <div
      role="alert"
      className={[
        'flex flex-col items-center justify-center gap-3 rounded-lg border text-center',
        'border-danger/30 bg-danger-subtle px-4',
        isPage ? 'py-16' : 'py-8',
      ].join(' ')}
    >
      <div>
        <p className={['font-semibold text-danger-text', isPage ? 'text-base' : 'text-sm'].join(' ')}>
          {isPage ? 'Could not load this page' : 'Could not load this section'}
        </p>
        <p className="mt-1 max-w-lg text-sm text-text-secondary">{error.message}</p>
        {error.status > 0 ? (
          <p className="mt-1 text-xs text-text-muted">HTTP {error.status}</p>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
