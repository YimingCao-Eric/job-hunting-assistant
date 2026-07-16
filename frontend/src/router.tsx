import { createBrowserRouter, type RouteObject } from 'react-router-dom'

import { App } from '@/App'
import { NAV_ITEMS } from '@/lib/nav'
import { NotFoundPage } from '@/pages/NotFoundPage'

/**
 * A DATA ROUTER (createBrowserRouter), not <BrowserRouter> -- this is
 * structural, not stylistic. FR-020 ("warn before navigation that would
 * discard edits") needs useBlocker, which ONLY works under a data router;
 * under <BrowserRouter> the hook throws. Retrofitting it later would mean
 * rewriting routing, so it is decided at the root on day one. (research R14)
 *
 * Routes are built from NAV_ITEMS, the same array TopNav renders (FR-003),
 * so nav and routes cannot drift.
 */
const pageRoutes: RouteObject[] = NAV_ITEMS.map(({ path, Component }) =>
  path === '/'
    ? { index: true, element: <Component /> }
    : { path: path.replace(/^\//, ''), element: <Component /> },
)

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      ...pageRoutes,
      // Every legacy and unknown URL (FR-005). No redirects.
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
