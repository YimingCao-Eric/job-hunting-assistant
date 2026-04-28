import { useRef, useCallback } from 'react'

export function useScanGrace(graceMs = 15000) {
  const ref = useRef(0)
  const start = useCallback(() => {
    ref.current = Date.now()
  }, [])
  const isInGrace = useCallback(
    () => Date.now() - ref.current < graceMs,
    [graceMs],
  )
  const clear = useCallback(() => {
    ref.current = 0
  }, [])
  return { start, isInGrace, clear }
}
