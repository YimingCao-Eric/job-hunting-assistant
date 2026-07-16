/**
 * Fixed-row-height windowing math (research R13).
 *
 * SC-010 caps input blocking at 1s with the debug-trace ring at its 10,000-event
 * maximum. 10,000 DOM rows is far past that; a window renders ~40. No
 * virtualization library -- a trace event's columns (dt, phase, level, page) are
 * fixed-width-ish, so fixed row height is available and this is ~10 lines.
 *
 * Extracted as pure logic because it is what makes SC-010 hold: an off-by-one
 * here means missing rows or a jumping scrollbar, and neither is visible in a
 * type check.
 */

export interface WindowRange {
  /** First index to render (inclusive). */
  start: number
  /** Last index to render (exclusive). */
  end: number
  /** Pixel offset to translate the rendered slice by. */
  offsetY: number
  /** Full scrollable height, so the scrollbar reflects ALL rows. */
  totalHeight: number
}

/** Rows rendered above and below the viewport, so fast scrolling shows no gaps. */
export const OVERSCAN = 8

export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalRows: number,
  overscan: number = OVERSCAN,
): WindowRange {
  const totalHeight = totalRows * rowHeight

  if (totalRows === 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: Math.max(0, totalHeight) }
  }

  // Clamp: a bounced/over-scrolled container can report a negative scrollTop or
  // one past the end, and either would produce an empty window.
  const safeScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)))

  const firstVisible = Math.floor(safeScrollTop / rowHeight)
  const visibleCount = Math.ceil(viewportHeight / rowHeight)

  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(totalRows, firstVisible + visibleCount + overscan)

  return { start, end, offsetY: start * rowHeight, totalHeight }
}
