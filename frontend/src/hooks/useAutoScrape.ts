import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import * as api from '@/lib/api/autoScrape'
import { isPageLevelFailure, type ApiError } from '@/lib/api/errors'
import type {
  AutoScrapeConfigLimits,
  AutoScrapeConfigRead,
  AutoScrapeConfigUpdate,
  AutoScrapeInstances,
  AutoScrapeStateRead,
  Cycle,
  SiteSession,
} from '@/types/autoScrape'
import type { SourceSite } from '@/types/job'

export const autoScrapeKeys = {
  all: ['autoScrape'] as const,
  state: ['autoScrape', 'state'] as const,
  instances: ['autoScrape', 'instances'] as const,
  config: ['autoScrape', 'config'] as const,
  limits: ['autoScrape', 'limits'] as const,
  cycles: ['autoScrape', 'cycles'] as const,
  sessions: ['autoScrape', 'sessions'] as const,
}

/** FR-047: externally-driven change (reapers, extension activity) arrives here.
 *  POLL-ONLY: no push channel reaches this page -- the WS broadcast fires only
 *  from PUT /extension/run-log/{id}. Well inside SC-009's 10s. */
const LIVE_POLL_MS = 5_000
const INSTANCE_POLL_MS = 30_000

/**
 * The Auto-Scrape console's server state.
 *
 * ONE QUERY PER SURFACE, not one Promise.all. The old page fetched all five in
 * a single Promise.all behind one error gate, so ONE transient 500 on `cycles`
 * blanked the whole UI until the next 5s tick (page.tsx:59-65). Independent
 * queries are what make per-section errors possible at all.
 *
 * config and config/limits are effectively STATIC -- they change only via our
 * own mutations, which invalidate them explicitly. The old page re-fetched all
 * five every 5 seconds forever, including these two.
 */
export function useAutoScrape() {
  const queryClient = useQueryClient()

  // The <_, ApiError> generic is load-bearing, not decoration: without it
  // TanStack types `error` as plain Error, `.kind` does not exist, and the
  // composition rule below cannot be expressed at all.
  const state = useQuery<AutoScrapeStateRead, ApiError>({
    queryKey: autoScrapeKeys.state,
    queryFn: ({ signal }) => api.fetchState({ signal }),
    refetchInterval: LIVE_POLL_MS,
  })

  const cycles = useQuery<Cycle[], ApiError>({
    queryKey: autoScrapeKeys.cycles,
    queryFn: ({ signal }) => api.fetchCycles(10, { signal }),
    refetchInterval: LIVE_POLL_MS,
  })

  const sessions = useQuery<SiteSession[], ApiError>({
    queryKey: autoScrapeKeys.sessions,
    queryFn: ({ signal }) => api.fetchSessions({ signal }),
    refetchInterval: LIVE_POLL_MS,
  })

  const config = useQuery<AutoScrapeConfigRead, ApiError>({
    queryKey: autoScrapeKeys.config,
    queryFn: ({ signal }) => api.fetchConfig({ signal }),
    staleTime: Infinity,
  })

  const limits = useQuery<AutoScrapeConfigLimits, ApiError>({
    queryKey: autoScrapeKeys.limits,
    queryFn: ({ signal }) => api.fetchConfigLimits({ signal }),
    staleTime: Infinity,
  })

  // FR-039. Errors SURFACE. The old fetchAutoScrapeInstances silently degraded
  // to { count: 1, instances: [] } on non-OK -- i.e. it FABRICATED THE HEALTHY
  // ANSWER on failure, which defeats the requirement's entire point.
  const instances = useQuery<AutoScrapeInstances, ApiError>({
    queryKey: autoScrapeKeys.instances,
    queryFn: ({ signal }) => api.fetchInstances({ signal }),
    refetchInterval: INSTANCE_POLL_MS,
  })

  const invalidateLive = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.state })
    void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.cycles })
    void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.sessions })
  }, [queryClient])

  // Every mutation writes the fresh server response straight into the cache, so
  // the UI reflects what the SERVER says rather than what we assumed it did.
  const mutationOpts = {
    onSuccess: (data: unknown) => {
      queryClient.setQueryData(autoScrapeKeys.state, data)
      invalidateLive()
    },
  }

  const enable = useMutation<unknown, ApiError, void>({ mutationFn: () => api.enableLoop(), ...mutationOpts })
  const pause = useMutation<unknown, ApiError, void>({ mutationFn: () => api.pauseLoop(), ...mutationOpts })
  const shutdown = useMutation<unknown, ApiError, void>({ mutationFn: () => api.shutdownLoop(), ...mutationOpts })
  const testCycle = useMutation<unknown, ApiError, void>({ mutationFn: () => api.requestTestCycle(), ...mutationOpts })

  const resetSession = useMutation<unknown, ApiError, SourceSite>({
    mutationFn: (site) => api.resetSession(site),
    onSuccess: () => {
      // Re-read rather than assume: FR-043's "status returns to unknown with
      // counters cleared" is the server's statement, not ours.
      void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.sessions })
    },
  })

  const saveConfig = useMutation<unknown, ApiError, AutoScrapeConfigUpdate>({
    mutationFn: (body) => api.saveConfig(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.config })
      void queryClient.invalidateQueries({ queryKey: autoScrapeKeys.state })
    },
  })

  const resetConfig = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.resetConfig(),
    onSuccess: (data) => {
      queryClient.setQueryData(autoScrapeKeys.config, data)
    },
  })

  /**
   * THE COMPOSITION RULE, at its hardest case (contracts/ui-primitives.md 5a).
   * This page has five queries, and it is BOTH the origin of the FR-015
   * anti-pattern AND the spec's "page-level error state" case -- which one
   * applies depends entirely on how many failed and why.
   *
   * All five failed with kind 'network' -> the backend is unreachable: ONE fact,
   * ONE page-level error. Otherwise (a subset, or any non-network failure) the
   * errors stay scoped to their own cards and the healthy sections keep rendering.
   */
  const errors = [state.error, cycles.error, sessions.error, config.error, limits.error]
  const isPageLevelError = isPageLevelFailure(errors)

  const retryAll = useCallback(() => {
    void state.refetch()
    void cycles.refetch()
    void sessions.refetch()
    void config.refetch()
    void limits.refetch()
    void instances.refetch()
  }, [state, cycles, sessions, config, limits, instances])

  return {
    state,
    cycles,
    sessions,
    config,
    limits,
    instances,
    isPageLevelError,
    /** The error to show page-level; all five are network failures, so any will do. */
    pageLevelError: (state.error ?? cycles.error) as ApiError | null,
    retryAll,
    mutations: { enable, pause, shutdown, testCycle, resetSession, saveConfig, resetConfig },
  }
}
