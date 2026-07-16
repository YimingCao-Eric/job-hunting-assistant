import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { runProgressKey, isTerminal } from '@/hooks/useRunProgress'
import type { ApiError, ScanRejectionReason } from '@/lib/api/errors'
import { triggerScan, triggerStop, type TriggerScanRequest } from '@/lib/api/scan'
import { jobKeys } from '@/hooks/useJobs'
import type { RunLog } from '@/types/runLog'

/**
 * A UI-level bound (FR-027), NOT the backend's 60-MINUTE stuck-run reaper.
 * Comfortably longer than the extension's poll interval, still bounded.
 * It is a DISPLAY timeout only: nothing cancels the trigger, because nothing
 * can -- the command sits in the mailbox until collected. (research R7)
 */
const PICKUP_TIMEOUT_MS = 60_000

/** SC-011: three distinct, actionable messages. Zero generic failures. */
const REJECTION_MESSAGE: Record<ScanRejectionReason, string> = {
  scan_pending: "A scan request is already queued — the scraper hasn't picked it up yet.",
  stop_cooldown: 'A scan just finished. Wait a moment before starting another.',
  scan_in_progress: 'A scan is already running. Stop it first, or wait for it to finish.',
}

export function scanRejectionMessage(error: ApiError): string {
  if (error.reason && error.reason in REJECTION_MESSAGE) {
    const base = REJECTION_MESSAGE[error.reason]
    const retry = error.retryAfterMs
    return retry ? `${base} Try again in ${Math.ceil(retry / 1000)}s.` : base
  }
  // Not a known rejection -- surface the backend's own words (FR-016).
  return error.message
}

export type PickupState = 'idle' | 'waiting' | 'picked-up' | 'not-responding'

export function useScanTrigger(latestRun: RunLog | null | undefined) {
  const queryClient = useQueryClient()
  const [pickup, setPickup] = useState<PickupState>('idle')
  const triggeredAtRef = useRef<number | null>(null)

  const scan = useMutation<unknown, ApiError, TriggerScanRequest>({
    mutationFn: (body) => triggerScan(body),
    onSuccess: () => {
      // The trigger returns NO run id and returns BEFORE any scan starts, so
      // correlation is by RECENCY: the first run started after this instant is
      // ours. Nothing else links the two.
      triggeredAtRef.current = Date.now()
      setPickup('waiting')
      void queryClient.invalidateQueries({ queryKey: runProgressKey })
    },
  })

  const stop = useMutation<unknown, ApiError, void>({
    mutationFn: () => triggerStop(),
    onSuccess: () => {
      setPickup('idle')
      triggeredAtRef.current = null
      void queryClient.invalidateQueries({ queryKey: runProgressKey })
    },
  })

  // Did the scraper pick the command up?
  useEffect(() => {
    if (pickup !== 'waiting') return
    const since = triggeredAtRef.current
    if (since === null) return

    if (latestRun && new Date(latestRun.started_at).getTime() >= since - 2_000) {
      setPickup('picked-up')
      return
    }

    const remaining = PICKUP_TIMEOUT_MS - (Date.now() - since)
    // FR-027: a bounded wait, then a stated "not responding" -- never an
    // indefinite "in progress" when the extension simply isn't running.
    const timer = setTimeout(() => setPickup('not-responding'), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [pickup, latestRun])

  // FR-029: refresh the list when a run reaches a terminal state.
  const lastStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const status = latestRun?.status
    if (status && status !== lastStatusRef.current && isTerminal(status)) {
      void queryClient.invalidateQueries({ queryKey: jobKeys.all })
      setPickup('idle')
    }
    lastStatusRef.current = status
  }, [latestRun?.status, queryClient])

  const reset = useCallback(() => {
    setPickup('idle')
    triggeredAtRef.current = null
    scan.reset()
  }, [scan])

  return { scan, stop, pickup, reset }
}
