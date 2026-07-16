import { NavLink } from 'react-router-dom'

import { NAV_ITEMS } from '@/lib/nav'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'relative shrink-0 whitespace-nowrap px-3 py-4 text-sm font-medium transition-colors',
    'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t',
    isActive
      ? 'text-accent after:bg-accent'
      : 'text-text-secondary hover:text-text-primary after:bg-transparent',
  ].join(' ')

/**
 * FR-002: horizontal, top of every page, current destination unambiguous.
 * Page content retains the full viewport width -- no side rail consumes it,
 * because every page is horizontally dense.
 *
 * FR-003: renders NAV_ITEMS, the same array router.tsx builds routes from.
 * SC-003 (any page reachable from any other in one click) holds by construction.
 * FR-006: the nav scrolls WITHIN ITSELF at 360px; the page body never scrolls.
 */
export function TopNav() {
  return (
    <header className="border-b border-border bg-surface-card">
      <div className="flex items-center gap-4 px-4 sm:px-6">
        <span className="shrink-0 text-sm font-semibold tracking-tight text-text-primary">
          JHA
        </span>
        <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              // `end` on '/' only -- otherwise Config would match every route.
              end={item.path === '/'}
              className={linkClass}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  )
}
