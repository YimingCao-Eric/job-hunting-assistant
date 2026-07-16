import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { apiBaseUrl } from '@/lib/api/client'
import type { ApiError } from '@/lib/api/errors'
import { listRunLogs } from '@/lib/api/runLog'
import type { RunLog } from '@/types/runLog'

export const runProgressKey = ['runLog', 'latest'] as const

/** SC-009 budget is 10s; 3s leaves ample headroom even if the WS is dead. */
const POLL_INTERVAL_MS = 3_000
const WS_AUTH_REJECTED = 1008
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** Terminal states end polling. `status` is free text, so match, don't switch. */
export const isTerminal = (status: string | undefined): boolean =>
  status === 'completed' || status === 'failed'

function wsUrl(): string {
  const url = new URL(apiBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/run-log'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Live run progress: ONE WebSocket plus a poll, writing ONE cache entry.
 *
 * The old app is the anti-pattern: its WS handler and its poller BOTH called
 * setLastRun, racing, with a 15s `useScanGrace` window and a 5s debounce bolted
 * on to hide the resulting flicker. Here the poll owns the query and the WS
 * writes through setQueryData -- same key, one writer at a time, last-write-wins.
 *
 * The poll is MANDATORY, not defensive: WS subscribers live in an in-process
 * set() (run_log_ws.py:13), not Redis, so with >1 uvicorn worker a client
 * connected to worker A never sees updates written on worker B.
 */
export function useRunProgress() {
  const queryClient = useQueryClient()

  const query = useQuery<RunLog | null, ApiError>({
    queryKey: runProgressKey,
    queryFn: async ({ signal }) => {
      // include_debug_log=false: traces are a 10,000-event ring returned inline
      // and included BY DEFAULT. Progress needs counts, never the trace.
      const runs = await listRunLogs({ limit: 1, include_debug_log: false }, { signal })
      return runs[0] ?? null
    },
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : POLL_INTERVAL_MS),
  })

  const attemptRef = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let closedByUs = false

    const connect = () => {
      // Auth travels in the SUBPROTOCOL, not a header or query token: the
      // browser WebSocket API cannot set headers. The server requires
      // subprotocols[0] === 'bearer' and [1] === token, then accepts with
      // subprotocol 'bearer'. DEV_WS_TOKEN is a SECOND hardcoded constant
      // (run_log_ws.py:15), independent of core/auth.py -- preserved as-is.
      const token = import.meta.env.VITE_AUTH_TOKEN || 'dev-token'
      socket = new WebSocket(wsUrl(), ['bearer', token])

      socket.onopen = () => {
        attemptRef.current = 0
      }

      socket.onmessage = (event) => {
        try {
          // The payload is a FULL RunLog minus debug_log -- no envelope, no
          // event type. So it is ASSIGNED, never merged additively; that is
          // what makes last-write-wins safe and stops counts double-counting.
          const update = JSON.parse(String(event.data)) as RunLog
          if (!update?.id) return
          queryClient.setQueryData<RunLog | null>(runProgressKey, (prev) =>
            // Only adopt the run we are already tracking, or a newer one.
            !prev || prev.id === update.id || update.started_at >= prev.started_at ? update : prev,
          )
        } catch {
          // A malformed frame must not kill the socket; the poll still covers us.
        }
      }

      socket.onclose = (event) => {
        if (closedByUs) return
        // 1008 = auth rejected. Retrying with the same baked-in token is futile,
        // so stop and let the poll surface the 401 through the shell instead.
        if (event.code === WS_AUTH_REJECTED) return
        const attempt = (attemptRef.current += 1)
        const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
        const jitter = backoff * 0.25 * Math.random()
        reconnectTimer = setTimeout(connect, backoff + jitter)
      }
    }

    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [queryClient])

  return query
}
