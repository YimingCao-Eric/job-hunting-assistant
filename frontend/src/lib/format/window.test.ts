import { describe, expect, it } from 'vitest'

import { computeWindow, OVERSCAN } from '@/lib/format/window'

const ROW = 28
const VIEW = 480
// The ring maximum -- the case SC-010 is written about.
const MAX_EVENTS = 10_000

describe('computeWindow -- SC-010: a 10,000-event trace renders ~40 rows', () => {
  it('renders a small window at the top, not 10,000 rows', () => {
    const w = computeWindow(0, VIEW, ROW, MAX_EVENTS)
    expect(w.start).toBe(0)
    // ceil(480/28)=18 visible, +8 overscan
    expect(w.end).toBe(18 + OVERSCAN)
    expect(w.end - w.start).toBeLessThan(40)
  })

  it('renders a bounded window ANYWHERE in the trace', () => {
    for (const scrollTop of [0, 1_000, 50_000, 139_000, 279_000]) {
      const w = computeWindow(scrollTop, VIEW, ROW, MAX_EVENTS)
      expect(w.end - w.start).toBeLessThanOrEqual(18 + 2 * OVERSCAN + 1)
    }
  })

  it('reports the FULL height so the scrollbar reflects all 10,000 rows', () => {
    expect(computeWindow(0, VIEW, ROW, MAX_EVENTS).totalHeight).toBe(MAX_EVENTS * ROW)
  })

  it('offsetY always aligns the slice to its true position', () => {
    const w = computeWindow(50_000, VIEW, ROW, MAX_EVENTS)
    expect(w.offsetY).toBe(w.start * ROW)
  })
})

describe('computeWindow -- boundaries', () => {
  it('never starts below 0 (overscan must not underflow)', () => {
    expect(computeWindow(0, VIEW, ROW, 100).start).toBe(0)
    expect(computeWindow(10, VIEW, ROW, 100).start).toBe(0)
  })

  it('never ends past the row count', () => {
    const w = computeWindow(999_999, VIEW, ROW, 100)
    expect(w.end).toBe(100)
    expect(w.start).toBeGreaterThanOrEqual(0)
  })

  it('scrolled to the very bottom still includes the LAST row', () => {
    const total = 2_096 // the largest real trace observed
    const maxScroll = total * ROW - VIEW
    const w = computeWindow(maxScroll, VIEW, ROW, total)
    expect(w.end).toBe(total)
    expect(w.start).toBeLessThan(total)
  })

  it('a trace shorter than the viewport renders every row', () => {
    const w = computeWindow(0, VIEW, ROW, 5)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
  })

  it('handles an empty trace without producing a negative height', () => {
    const w = computeWindow(0, VIEW, ROW, 0)
    expect(w).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
  })

  it('clamps a negative scrollTop (over-scroll bounce)', () => {
    const w = computeWindow(-200, VIEW, ROW, 100)
    expect(w.start).toBe(0)
    expect(w.offsetY).toBe(0)
  })

  it('clamps a scrollTop past the end rather than windowing past the data', () => {
    const w = computeWindow(10_000_000, VIEW, ROW, 100)
    expect(w.end).toBe(100)
  })

  it('a zero rowHeight cannot divide-by-zero into Infinity', () => {
    expect(computeWindow(0, VIEW, 0, 100)).toEqual({
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
    })
  })
})

describe('computeWindow -- continuity while scrolling', () => {
  // The regression that matters: a gap between consecutive windows would show
  // blank rows mid-scroll.
  it('consecutive scroll positions produce overlapping windows (no gaps)', () => {
    let prev = computeWindow(0, VIEW, ROW, MAX_EVENTS)
    for (let scrollTop = ROW; scrollTop < 5_000; scrollTop += ROW) {
      const next = computeWindow(scrollTop, VIEW, ROW, MAX_EVENTS)
      expect(next.start).toBeLessThanOrEqual(prev.end)
      prev = next
    }
  })

  it('the window advances monotonically as you scroll down', () => {
    const a = computeWindow(0, VIEW, ROW, MAX_EVENTS)
    const b = computeWindow(5_000, VIEW, ROW, MAX_EVENTS)
    const c = computeWindow(50_000, VIEW, ROW, MAX_EVENTS)
    expect(a.start).toBeLessThan(b.start)
    expect(b.start).toBeLessThan(c.start)
  })
})
