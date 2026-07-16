import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import * as api from '@/lib/api/config'
import type { ApiError } from '@/lib/api/errors'
import type { SearchConfig, SearchConfigUpdate } from '@/types/config'

export const configKeys = { all: ['config'] as const }

/**
 * FR-018: the four dead fields are never sent. This is the whole list, and the
 * form type (SearchConfig) already excludes them -- this constant exists so the
 * intent is greppable and so a future field addition has an obvious home.
 *
 * `llm` and `dedup_mode` are NOT here: feature 006 removed them from the
 * backend schema entirely, so there is nothing to omit.
 */
export const DEAD_CONFIG_FIELDS = [
  'dedup_fuzzy_threshold',
  'nth_bonus_weight',
  'cpu_strong_threshold',
  'cpu_binary_threshold',
] as const

export function useConfig() {
  const queryClient = useQueryClient()

  const config = useQuery<SearchConfig, ApiError>({
    queryKey: configKeys.all,
    queryFn: ({ signal }) => api.fetchConfig({ signal }),
    // It changes only via our own save. No poll.
    staleTime: Infinity,
  })

  const save = useMutation<SearchConfig, ApiError, SearchConfigUpdate>({
    mutationFn: (body) => api.saveConfig(body),
    onSuccess: (merged) => {
      // Re-seed from the SERVER'S MERGED RESULT, never from the local draft --
      // the response is authoritative and may contain another writer's changes
      // (the spec's "concurrent edit" edge case).
      queryClient.setQueryData(configKeys.all, merged)
    },
    // On failure the draft is left untouched by design (FR-021): the component
    // owns the draft and this mutation never writes to it on error.
  })

  return { config, save }
}
