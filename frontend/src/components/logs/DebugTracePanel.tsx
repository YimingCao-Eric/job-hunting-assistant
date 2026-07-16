import { useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/states/EmptyState'
import { LoadingState } from '@/components/ui/states/LoadingState'
import { ErrorState } from '@/components/ui/states/ErrorState'
import { computeWindow } from '@/lib/format/window'
import type { Tone } from '@/lib/tokens/semantics'
import type { ApiError } from '@/lib/api/errors'
import type { DebugEvent, DebugLog } from '@/types/runLog'

const ROW_HEIGHT = 28
const VIEWPORT_HEIGHT = 420

/** FR-034: error-level events must be VISUALLY DISTINCT. Live data carries
 *  info and warn; error is in the schema, so it is handled. Unknown levels
 *  fall back rather than crash -- `level` is a free string server-side. */
const LEVEL_TONE: Record<string, Tone> = {
  info: 'neutral',
  debug: 'neutral',
  warn: 'warning',
  error: 'danger',
}
const levelTone = (level: string): Tone => LEVEL_TONE[level] ?? 'neutral'

const ROW_CLASS: Record<string, string> = {
  error: 'bg-danger-subtle',
  warn: 'bg-warning-subtle',
}

/** dt is ms since run start -- THIS is the displayed relative timestamp, not t. */
function formatDt(dt: number): string {
  if (dt < 1000) return `${dt}ms`
  const s = dt / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`
}

/** The known columns. Everything else goes to the data panel -- the panel must
 *  never switch exhaustively on an event's shape (DebugEvent is extra="allow"). */
const KNOWN_KEYS = new Set(['t', 'dt', 'page', 'phase', 'level', 'data'])

export interface DebugTracePanelProps {
  trace: DebugLog | null | undefined
  isPending: boolean
  error: ApiError | null
  onRetry: () => void
}

export function DebugTracePanel({ trace, isPending, error, onRetry }: DebugTracePanelProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [levelFilter, setLevelFilter] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const allEvents: DebugEvent[] = useMemo(() => trace?.events ?? [], [trace])

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const e of allEvents) counts[e.level] = (counts[e.level] ?? 0) + 1
    return counts
  }, [allEvents])

  const events = useMemo(
    () => (levelFilter ? allEvents.filter((e) => e.level === levelFilter) : allEvents),
    [allEvents, levelFilter],
  )

  const win = computeWindow(scrollTop, VIEWPORT_HEIGHT, ROW_HEIGHT, events.length)
  const visible = events.slice(win.start, win.end)

  if (isPending) return <LoadingState label="Loading trace…" />
  if (error) return <ErrorState error={error} onRetry={onRetry} />

  // FR-036: an EXPLICIT state for a run with no recorded trace -- not an empty panel.
  if (!trace || allEvents.length === 0) {
    return (
      <EmptyState
        kind="no-data"
        title="No trace recorded for this run."
        body="The extension records a debug trace only when it is running with tracing on. This run has none — its counts above are still accurate."
      />
    )
  }

  const selectedEvent = selected !== null ? events[selected] : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted tabular-nums">
            {events.length.toLocaleString()}
            {levelFilter ? ` of ${allEvents.length.toLocaleString()}` : ''} events
          </span>
          {/* With 2,000+ events, finding the handful of warns IS the diagnostic
              task -- so the level filter is the page's point, not decoration. */}
          {Object.entries(levelCounts).map(([level, count]) => (
            <button
              key={level}
              type="button"
              aria-pressed={levelFilter === level}
              onClick={() => {
                setLevelFilter((f) => (f === level ? null : level))
                setScrollTop(0)
                setSelected(null)
                if (scrollRef.current) scrollRef.current.scrollTop = 0
              }}
              className={[
                'rounded-sm border px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                levelFilter === level
                  ? 'border-accent bg-accent text-text-inverse'
                  : 'border-border bg-surface-card text-text-secondary hover:bg-surface-raised',
              ].join(' ')}
            >
              {level} {count}
            </button>
          ))}
        </div>
        {/* Honest about the ring: at the maximum, older events are already gone. */}
        {allEvents.length >= 10_000 ? (
          <span className="text-[11px] text-text-muted">
            Ring buffer is full — only the most recent 10,000 events are retained.
          </span>
        ) : null}
      </div>

      {/* FR-006 / SC-012: the columns need ~640px, so at 360px this container
          scrolls HORIZONTALLY WITHIN ITSELF -- the page body never does. The
          header sits inside the same scroller as the rows so the two cannot
          drift apart when scrolled sideways. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <div className="min-w-[640px]">
          <div className="flex gap-2 border-b border-border bg-surface-raised px-2 py-1 text-[11px] font-semibold text-text-secondary">
            <span className="w-16 shrink-0 text-right">Time</span>
            <span className="w-10 shrink-0 text-right">Page</span>
            <span className="w-14 shrink-0">Level</span>
            <span className="w-40 shrink-0">Phase</span>
            <span className="min-w-0 flex-1">Data</span>
          </div>

          {/* The window. Only ~26 rows exist in the DOM regardless of trace size. */}
          <div
            ref={scrollRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            style={{ height: VIEWPORT_HEIGHT }}
            className="overflow-y-auto bg-surface-card"
          >
            <div style={{ height: win.totalHeight, position: 'relative' }}>
              <div style={{ transform: `translateY(${win.offsetY}px)` }}>
                {visible.map((event, i) => {
                  const index = win.start + i
                  const isSelected = selected === index
                  return (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setSelected(isSelected ? null : index)}
                      style={{ height: ROW_HEIGHT }}
                      className={[
                        'flex w-full items-center gap-2 border-b border-border/60 px-2 text-left text-[11px]',
                        'hover:bg-surface-raised',
                        ROW_CLASS[event.level] ?? '',
                        isSelected ? 'ring-1 ring-inset ring-accent' : '',
                      ].join(' ')}
                    >
                      <span className="w-16 shrink-0 text-right tabular-nums text-text-muted">
                        {formatDt(event.dt)}
                      </span>
                      <span className="w-10 shrink-0 text-right tabular-nums text-text-muted">
                        {event.page ?? '—'}
                      </span>
                      <span className="w-14 shrink-0">
                        <Badge tone={levelTone(event.level)}>{event.level}</Badge>
                      </span>
                      <span className="w-40 shrink-0 truncate font-medium text-text-primary">
                        {event.phase}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
                        {JSON.stringify(event.data)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Rows are fixed-height (that is what makes the window work), so the full
          payload opens here instead of expanding a row. Unknown top-level keys
          are rendered too -- DebugEvent is extra="allow" server-side and an
          event may legitimately carry fields we do not model. */}
      {selectedEvent ? (
        <div className="rounded-md border border-border bg-surface-raised p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-primary">
              {selectedEvent.phase} · {formatDt(selectedEvent.dt)}
            </p>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              Close
            </button>
          </div>
          {Object.keys(selectedEvent).filter((k) => !KNOWN_KEYS.has(k)).length > 0 ? (
            <p className="mt-1 text-[11px] text-text-muted">
              Extra fields:{' '}
              {Object.keys(selectedEvent)
                .filter((k) => !KNOWN_KEYS.has(k))
                .join(', ')}
            </p>
          ) : null}
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-text-secondary">
            {JSON.stringify(selectedEvent, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
