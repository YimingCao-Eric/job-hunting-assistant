import { Outlet } from 'react-router-dom'

import { TopNav } from '@/components/layout/TopNav'
import { UnauthorizedState } from '@/components/ui/states/UnauthorizedState'
import { useUnauthorized } from '@/hooks/useUnauthorized'

/**
 * The shared shell: TopNav + the routed page.
 *
 * Page content keeps the FULL viewport width (FR-002) -- no max-width container
 * and no side rail, because every page is horizontally dense.
 *
 * T039: the app-wide 401 state is handled HERE, once. The spec's edge case is
 * explicit that the shell shows "a single, consistent 'not authorized' state
 * ... rather than each page rendering its own empty or error variant."
 *
 * The nav stays mounted while unauthorized: the pages are all equally broken,
 * so hiding navigation would strand the operator with no way to move around,
 * and the failure is global rather than page-specific.
 */
export function App() {
  const isUnauthorized = useUnauthorized()

  return (
    <div className="min-h-screen bg-surface-page">
      <TopNav />
      <main className="w-full px-4 sm:px-6">
        {isUnauthorized ? <UnauthorizedState /> : <Outlet />}
      </main>
    </div>
  )
}
