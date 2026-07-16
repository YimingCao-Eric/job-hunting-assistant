import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'

import { isApiError } from '@/lib/api/errors'

/**
 * True when ANY query or mutation has failed with a 401 (T039).
 *
 * Subscribing to the caches is what lets the shell own the 401 state without
 * every page having to report upward -- which is how you end up with four
 * per-page variants, the thing the spec explicitly forbids.
 *
 * Mutations are watched too: a 401 on a Config save is just as much an auth
 * failure as a 401 on a read.
 */
export function useUnauthorized(): boolean {
  const queryClient = useQueryClient()

  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubQueries = queryClient.getQueryCache().subscribe(onChange)
      const unsubMutations = queryClient.getMutationCache().subscribe(onChange)
      return () => {
        unsubQueries()
        unsubMutations()
      }
    },
    [queryClient],
  )

  // Returns a boolean, so the snapshot is referentially stable by definition.
  const getSnapshot = useCallback(() => {
    const is401 = (error: unknown) => isApiError(error) && error.kind === 'unauthorized'
    return (
      queryClient.getQueryCache().getAll().some((q) => is401(q.state.error)) ||
      queryClient.getMutationCache().getAll().some((m) => is401(m.state.error))
    )
  }, [queryClient])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
