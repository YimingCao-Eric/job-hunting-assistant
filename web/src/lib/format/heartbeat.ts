import type { HeartbeatGrade } from '@/types/autoScrape'

/**
 * FR-038: extension heartbeat freshness, GRADED BY AGE.
 *
 * The hard rule this exists to serve: a STALE HEARTBEAT and a DELIBERATE PAUSE
 * must not look the same. They are independent facts --
 *   enabled: false + fresh  = the operator paused it        (neutral)
 *   enabled: true  + stale  = it is supposed to be running and ISN'T (alarming)
 * The grade below says nothing about `enabled`; the caller combines them.
 */

/** The extension reports in on its own schedule; 90s tolerates a missed beat. */
export const FRESH_MS = 90_000
export const AGING_MS = 5 * 60_000

export function heartbeatGrade(
  lastHeartbeatAt: string | null | undefined,
  now: number = Date.now(),
): HeartbeatGrade {
  // Never reported at all -- distinct from "reported, but long ago".
  if (!lastHeartbeatAt) return 'never'

  const t = new Date(lastHeartbeatAt).getTime()
  if (Number.isNaN(t)) return 'never'

  // A clock skew (heartbeat in the future) is still a live signal, not stale.
  const age = now - t
  if (age < FRESH_MS) return 'fresh'
  if (age < AGING_MS) return 'aging'
  return 'stale'
}

const LABEL: Record<HeartbeatGrade, string> = {
  fresh: 'Extension reporting',
  aging: 'Extension slow to report',
  stale: 'Extension not reporting',
  never: 'Extension has never reported',
}

export const heartbeatLabel = (grade: HeartbeatGrade): string => LABEL[grade]

/** Is this a malfunction the operator should act on, regardless of enabled? */
export const isHeartbeatUnhealthy = (grade: HeartbeatGrade): boolean =>
  grade === 'stale' || grade === 'never'
