import { useState, useMemo } from 'react'
import styles from './DebugTracePanel.module.css'

const PHASE_GROUPS = {
  lifecycle: [
    'scan_start',
    'session_check',
    'page_load',
    'page_start',
    'page_end',
    'scan_end',
    'heartbeat',
  ],
  cards: ['card_process', 'cards_found'],
  voyager: ['voyager'],
  ingest: ['ingest'],
  pagination: [
    'scroll',
    'next_poll',
    'navigate',
    'pagination_ended',
    'next_click',
    'spa_transition',
    'dom_mutations',
  ],
}

function summarize(events) {
  if (!events || !events.length) return 'no debug trace'
  const pages = new Set()
  let endedReason = null
  for (const e of events) {
    if (e.page != null) pages.add(e.page)
    if (e.phase === 'pagination_ended') {
      endedReason = e.data?.reason || 'pagination_ended'
    } else if (e.phase === 'page_end' && e.data?.done && !endedReason) {
      endedReason = e.data?.reason || 'page_end'
    } else if (e.phase === 'scan_end' && !endedReason) {
      endedReason = 'scan_end'
    }
  }
  return `${events.length} events · ${pages.size} pages · ended: ${endedReason || 'unknown'}`
}

function eventMatchesPhase(event, phaseFilter) {
  if (phaseFilter === 'all') return true
  if (phaseFilter === 'errors') {
    return event.level === 'error' || event.phase === 'error'
  }
  const group = PHASE_GROUPS[phaseFilter]
  return group ? group.includes(event.phase) : false
}

function eventMatchesLevel(event, levelFilter) {
  if (levelFilter === 'all') return true
  const order = { info: 0, warn: 1, error: 2 }
  const want = order[levelFilter] ?? 0
  const got = order[event.level] ?? 0
  return got >= want
}

export default function DebugTracePanel({ runLog }) {
  const [expanded, setExpanded] = useState(false)
  const [phaseFilter, setPhaseFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')
  const [pageFilter, setPageFilter] = useState('all')
  const [selectedEvent, setSelectedEvent] = useState(null)

  const events = runLog?.debug_log?.events || []
  const summary = useMemo(() => summarize(events), [events])

  const pagesAvailable = useMemo(() => {
    const s = new Set()
    for (const e of events) if (e.page != null) s.add(e.page)
    return Array.from(s).sort((a, b) => a - b)
  }, [events])

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (!eventMatchesPhase(e, phaseFilter)) return false
      if (!eventMatchesLevel(e, levelFilter)) return false
      if (pageFilter !== 'all' && e.page !== Number(pageFilter)) return false
      return true
    })
  }, [events, phaseFilter, levelFilter, pageFilter])

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `run-${runLog.id?.slice(0, 8) || 'unknown'}-debug.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(filtered, null, 2))
  }

  if (!events.length) {
    return (
      <div className={styles.panel}>
        <div className={styles.summary}>
          🔍 Debug trace — (no events)
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.summary}>
        <span>
          🔍 Debug trace —
          {' '}
          {summary}
        </span>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {expanded && (
        <div className={styles.expanded}>
          <div className={styles.filters}>
            <div className={styles.filterGroup}>
              <span className={styles.filterLabel}>Phase:</span>
              {['all', 'lifecycle', 'cards', 'voyager', 'ingest', 'pagination', 'errors'].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`${styles.chip} ${phaseFilter === p ? styles.chipActive : ''}`}
                  onClick={() => setPhaseFilter(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className={styles.filterGroup}>
              <span className={styles.filterLabel}>Level:</span>
              {['all', 'info', 'warn', 'error'].map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`${styles.chip} ${levelFilter === l ? styles.chipActive : ''}`}
                  onClick={() => setLevelFilter(l)}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className={styles.filterGroup}>
              <span className={styles.filterLabel}>Page:</span>
              <button
                type="button"
                className={`${styles.chip} ${pageFilter === 'all' ? styles.chipActive : ''}`}
                onClick={() => setPageFilter('all')}
              >
                all
              </button>
              {pagesAvailable.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`${styles.chip} ${String(pageFilter) === String(p) ? styles.chipActive : ''}`}
                  onClick={() => setPageFilter(p)}
                >
                  P
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.timeline}>
            {filtered.length === 0 && (
              <div className={styles.empty}>No events match filter</div>
            )}
            {filtered.map((e, i) => {
              const rowClass = [
                styles.row,
                e.level === 'error' ? styles.rowError : '',
                e.level === 'warn' ? styles.rowWarn : '',
                selectedEvent === e ? styles.rowSelected : '',
              ].filter(Boolean).join(' ')
              const lineSummary = renderDataSummary(e)
              return (
                <div key={`${e.t}-${e.phase}-${e.dt}-${i}`} className={rowClass}>
                  <div
                    className={styles.rowLine}
                    onClick={() => setSelectedEvent(selectedEvent === e ? null : e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        setSelectedEvent(selectedEvent === e ? null : e)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    title={new Date(e.t).toISOString()}
                  >
                    <span className={styles.dt}>
                      +
                      {e.dt}
                      ms
                    </span>
                    <span className={styles.page}>
                      {e.page != null ? `P${e.page}` : '—'}
                    </span>
                    <span className={styles.phase}>{e.phase}</span>
                    <span className={styles.dataSummary}>{lineSummary}</span>
                  </div>
                  {selectedEvent === e && (
                    <pre className={styles.json}>
                      {JSON.stringify(e.data, null, 2)}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>

          <div className={styles.toolbar}>
            <button type="button" onClick={handleDownload} className={styles.actionBtn}>
              Download .json
            </button>
            <button type="button" onClick={handleCopy} className={styles.actionBtn}>
              Copy filtered
            </button>
            <span className={styles.counter}>
              {filtered.length}
              {' '}
              /
              {' '}
              {events.length}
              {' '}
              events
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function renderDataSummary(event) {
  const d = event.data || {}
  switch (event.phase) {
    case 'scan_start':
      return `runId=${d.runId?.slice?.(0, 8) || '?'} src=${d.source}`
    case 'session_check':
      return `result=${d.result}`
    case 'page_start':
    case 'page_load':
      return `page=${d.current_page} url=${(d.url || '').slice(-50)}`
    case 'cards_found':
      return `count=${d.count} took=${d.took_ms}ms attempt=${d.attempt}`
    case 'card_process':
      return `job_id=${d.job_id} idx=${d.idx_on_page}${d.duplicate_in_set ? ' DUP' : ''}`
    case 'voyager':
      return `job_id=${d.job_id} http=${d.http_status} jd_len=${d.jd_len} ${d.error || ''}`
    case 'ingest':
      return `${d.result_type} http=${d.http_status} took=${d.took_ms}ms ${d.title || ''}`
    case 'heartbeat':
      return `keepaliveΔ=${d.storage_keepalive_age_ms ?? '—'} url=…${(d.url || '').slice(-40)}`
    case 'next_click':
      return `p=${d.page} sel=${d.selector_matched || ''}`
    case 'spa_transition':
      return `ok=${d.transitioned} ${d.took_ms}ms mutated=${d.url_mutated} +jobId=${d.added_currentJobId}`
    case 'dom_mutations':
      return `p=${d.page} n=${d.count}`
    case 'scroll':
      return `h=${d.scroll_height} vp=${d.viewport}`
    case 'next_poll':
      return `iter=${d.iter} ${d.found ? `found (${d.selector_matched})` : 'not found'} t=${d.elapsed_ms}ms`
    case 'navigate':
      return `offset=${d.next_offset} from_page=${d.from_page}`
    case 'pagination_ended':
      return `reason=${d.reason} cards=${d.cards_on_page} banner=${d.has_no_results_banner}`
    case 'page_end':
      return `done=${d.done} scraped=${d.counters?.scraped}`
    case 'scan_end':
      return `pages=${d.summary?.pages_scanned} scraped=${d.summary?.scraped}`
    case 'error':
      return `${d.where || ''}: ${d.message || ''}`
    default:
      return JSON.stringify(d).slice(0, 60)
  }
}
