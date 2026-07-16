import type { ComponentType } from 'react'

import { AutoScrapePage } from '@/pages/AutoScrapePage'
import { ConfigPage } from '@/pages/ConfigPage'
import { JobsPage } from '@/pages/JobsPage'
import { LogsPage } from '@/pages/LogsPage'

export interface NavItem {
  /** Route path. Kept as-built so existing bookmarks keep working. */
  readonly path: string
  readonly label: string
  readonly Component: ComponentType
  /** The single backend surface this page binds to (contracts/backend-bindings.md). */
  readonly surface: string
}

/**
 * THE single source of the page set (FR-003).
 *
 * router.tsx builds its routes from this array and TopNav.tsx renders its links
 * from it, so the navigation and the routes it points at CANNOT drift -- that is
 * structural, not a convention. FR-001 ("exactly four pages") is then a property
 * of this array's length, and FR-004 ("no dedup/matching/skills/profile surface")
 * a property of its contents.
 *
 * Legacy paths (/profile, /skills, /matching, /dedup, /search-report,
 * /dedup/passed, /dedup/removed) are deliberately absent: they fall through to
 * the `*` route and land on NotFoundPage (FR-005). They are NOT redirected --
 * a redirect would misrepresent removed functionality as relocated.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Config', Component: ConfigPage, surface: '/config' },
  { path: '/jobs', label: 'Jobs', Component: JobsPage, surface: '/jobs' },
  { path: '/logs', label: 'Logs', Component: LogsPage, surface: '/extension/run-log' },
  {
    path: '/dashboard/auto-scrape',
    label: 'Auto-Scrape',
    Component: AutoScrapePage,
    surface: '/admin/auto-scrape/*',
  },
]
