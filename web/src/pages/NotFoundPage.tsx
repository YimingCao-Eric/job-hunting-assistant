import { Link, useLocation } from 'react-router-dom'

import { NAV_ITEMS } from '@/lib/nav'

/**
 * FR-005: a stated "page removed / not found" state that NAMES the four
 * available pages. Serves every legacy URL (/profile, /skills, /matching,
 * /dedup, /search-report, /dedup/passed, /dedup/removed) and any unknown URL.
 *
 * Deliberately NOT a redirect: those pages' backing endpoints were deleted by
 * the search-only split, and a redirect would misrepresent removed
 * functionality as merely relocated.
 */
const REMOVED_PATHS = new Set([
  '/profile',
  '/skills',
  '/matching',
  '/dedup',
  '/dedup/passed',
  '/dedup/removed',
  '/search-report',
])

export function NotFoundPage() {
  const { pathname } = useLocation()
  const wasRemoved = REMOVED_PATHS.has(pathname)

  return (
    <div className="mx-auto max-w-2xl py-16">
      <p className="text-sm font-medium text-text-muted">
        {wasRemoved ? 'Page removed' : 'Page not found'}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
        {wasRemoved ? (
          <>
            <code className="rounded-sm bg-surface-raised px-1.5 py-0.5 text-xl">{pathname}</code>{' '}
            no longer exists
          </>
        ) : (
          <>
            Nothing at{' '}
            <code className="rounded-sm bg-surface-raised px-1.5 py-0.5 text-xl">{pathname}</code>
          </>
        )}
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-secondary">
        {wasRemoved
          ? 'This page was removed when the backend was reduced to search-only. Its data and the endpoints behind it are gone — it has not moved somewhere else.'
          : 'That address does not match any page in this application.'}
      </p>

      <p className="mt-8 text-sm font-medium text-text-primary">The four available pages are:</p>
      <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-surface-card">
        {NAV_ITEMS.map((item) => (
          <li key={item.path}>
            <Link
              to={item.path}
              className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm transition-colors hover:bg-surface-raised"
            >
              <span className="font-medium text-accent">{item.label}</span>
              <code className="text-xs text-text-muted">{item.path}</code>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
