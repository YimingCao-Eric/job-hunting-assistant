import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import { router } from '@/router'

import '@/index.css'

/**
 * QueryClient defaults are where several cross-cutting requirements are answered
 * structurally rather than per page (research R1):
 *
 *  - placeholderData: keepPreviousData -> FR-015. A background refresh must NOT
 *    replace rendered content with a loading state; refreshes update in place.
 *    This is the standing answer, set once.
 *  - refetchIntervalInBackground: false -> polling pauses on a hidden tab. The
 *    old auto-scrape page fired 5 requests every 5s forever, ungated.
 *  - retry -> FR-014's retry, before the user ever sees an error.
 *
 * Per-query options (refetchInterval, staleTime) are set by each hook.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      placeholderData: keepPreviousData,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
      retry: 2,
      staleTime: 5_000,
    },
  },
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found in index.html')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
