import type { CycleStatus, HeartbeatGrade, ProbeStatus } from '@/types/autoScrape'

/**
 * Status -> tone. This lives NEXT TO THE TOKEN SET, not inside components,
 * which is what makes SC-007 ("visual treatment maps to consequence")
 * checkable in one place.
 *
 * It replaces the old SessionHealth.tsx:37-45 -- a 5-branch inline ternary of
 * raw Tailwind classes that spent two near-identical reds on captcha vs expired.
 */

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export const PROBE_TONE: Record<ProbeStatus, Tone> = {
  live: 'success',
  expired: 'danger',
  captcha: 'danger',
  rate_limited: 'warning',
  unknown: 'neutral',
}

/**
 * RunLog.status is FREE TEXT with no DB constraint -- five code paths write it.
 * Use runTone(), which falls back rather than assuming the union holds.
 */
const RUN_TONE: Record<string, Tone> = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
}

export const runTone = (status: string): Tone => RUN_TONE[status] ?? 'neutral'

/** CycleStatus IS a real Literal server-side, so an exhaustive map is honest.
 *  Note the as-built underscore inconsistency: scrape_complete vs post_scrape_complete. */
export const CYCLE_TONE: Record<CycleStatus, Tone> = {
  scrape_running: 'info',
  scrape_complete: 'success',
  postscrape_running: 'info',
  post_scrape_complete: 'success',
  failed: 'danger',
}

/**
 * FR-038's rule is a TONE rule: a stale heartbeat (danger) and a deliberate
 * pause (neutral) must never share a treatment. They are independent --
 * `enabled: true` + `stale` is the alarming combination.
 */
export const HEARTBEAT_TONE: Record<HeartbeatGrade, Tone> = {
  fresh: 'success',
  aging: 'warning',
  stale: 'danger',
  never: 'neutral',
}
