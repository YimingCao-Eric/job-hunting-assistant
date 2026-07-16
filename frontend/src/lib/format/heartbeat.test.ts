import { describe, expect, it } from 'vitest'

import { AGING_MS, FRESH_MS, heartbeatGrade, isHeartbeatUnhealthy } from '@/lib/format/heartbeat'
import { HEARTBEAT_TONE } from '@/lib/tokens/semantics'

const NOW = new Date('2026-07-15T22:30:00.000Z').getTime()
const agoBy = (ms: number) => new Date(NOW - ms).toISOString()

describe('heartbeatGrade -- boundaries', () => {
  it('just now -> fresh', () => {
    expect(heartbeatGrade(agoBy(0), NOW)).toBe('fresh')
    expect(heartbeatGrade(agoBy(30_000), NOW)).toBe('fresh')
  })

  it('the fresh/aging boundary is exclusive at FRESH_MS', () => {
    expect(heartbeatGrade(agoBy(FRESH_MS - 1), NOW)).toBe('fresh')
    expect(heartbeatGrade(agoBy(FRESH_MS), NOW)).toBe('aging')
  })

  it('the aging/stale boundary is exclusive at AGING_MS', () => {
    expect(heartbeatGrade(agoBy(AGING_MS - 1), NOW)).toBe('aging')
    expect(heartbeatGrade(agoBy(AGING_MS), NOW)).toBe('stale')
  })

  it('hours ago -> stale', () => {
    expect(heartbeatGrade(agoBy(3 * 3600_000), NOW)).toBe('stale')
  })

  it('null / undefined -> never (distinct from "reported long ago")', () => {
    expect(heartbeatGrade(null, NOW)).toBe('never')
    expect(heartbeatGrade(undefined, NOW)).toBe('never')
  })

  it('an unparseable timestamp -> never, not a crash', () => {
    expect(heartbeatGrade('not-a-date', NOW)).toBe('never')
  })

  it('clock skew (heartbeat in the future) is still a live signal', () => {
    expect(heartbeatGrade(new Date(NOW + 5_000).toISOString(), NOW)).toBe('fresh')
  })
})

describe('heartbeatGrade -- the live backend value', () => {
  // Real /admin/auto-scrape/state at the time of writing.
  it('a heartbeat from ~9 minutes ago grades stale', () => {
    const observed = '2026-07-15T22:21:27.170978Z'
    expect(heartbeatGrade(observed, NOW)).toBe('stale')
  })
})

describe('FR-038 -- stale must never look like a deliberate pause', () => {
  // The grade says nothing about `enabled`; the tones must differ so that the
  // two facts cannot be confused at a glance.
  it('stale and never map to alarming tones; a pause does not', () => {
    expect(HEARTBEAT_TONE[heartbeatGrade(agoBy(AGING_MS), NOW)]).toBe('danger')
    expect(HEARTBEAT_TONE[heartbeatGrade(null, NOW)]).toBe('neutral')
    expect(HEARTBEAT_TONE[heartbeatGrade(agoBy(0), NOW)]).toBe('success')
    expect(HEARTBEAT_TONE[heartbeatGrade(agoBy(FRESH_MS), NOW)]).toBe('warning')
  })

  it('a stale heartbeat is unhealthy whether or not the loop is enabled', () => {
    expect(isHeartbeatUnhealthy(heartbeatGrade(agoBy(AGING_MS), NOW))).toBe(true)
    expect(isHeartbeatUnhealthy(heartbeatGrade(null, NOW))).toBe(true)
    expect(isHeartbeatUnhealthy(heartbeatGrade(agoBy(0), NOW))).toBe(false)
  })

  it('the danger tone for stale is not reused for the paused (neutral) case', () => {
    // enabled:true + stale is the alarming combination; it must not share a
    // treatment with enabled:false + fresh.
    const stale = HEARTBEAT_TONE[heartbeatGrade(agoBy(AGING_MS), NOW)]
    const freshWhilePaused = HEARTBEAT_TONE[heartbeatGrade(agoBy(0), NOW)]
    expect(stale).not.toBe(freshWhilePaused)
  })
})
