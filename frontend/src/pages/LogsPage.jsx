import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api'
import { formatAbsoluteTime } from '../utils/time'
import { detectWebsiteFromRunLog } from '../utils/runLog'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import s from './LogsPage.module.css'
import j from './JobsPage.module.css'

const SKIP_LABELS = {
  jd_failed: 'JD extraction failed',
  stale: 'Stale (> 48h old)',
  no_id: 'No job ID',
  url_duplicate: 'Duplicate URL',
  content_duplicate: 'Duplicate content',
  blacklisted: 'Blacklisted',
  title_blacklisted: 'Title blacklisted',
  job_type: 'Intern / co-op / student',
  agency: 'Agency posting',
  language: 'Language',
  title_mismatch: 'Title mismatch',
  contract_mismatch: 'Contract role',
  remote_mismatch: 'Not remote',
  sponsorship: 'No sponsorship',
  already_scraped: 'Already scraped (dedup)',
}

function formatDuration(started_at, completed_at) {
  if (!completed_at) return 'in progress'
  const diff = new Date(completed_at) - new Date(started_at)
  const secs = Math.floor(diff / 1000)
  if (secs < 1) return '< 1s'
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function jobsPerMinute(scraped, started_at, completed_at) {
  if (!started_at || !completed_at) return null
  const ms = new Date(completed_at) - new Date(started_at)
  if (ms <= 0) return null
  const min = ms / 60000
  if (min <= 0) return null
  const n = Number(scraped) || 0
  return (n / min).toFixed(1)
}

const HIDDEN_FILTER_KEYS = new Set([
  'website',
  'general_date_posted',
  'general_internship_only',
  'general_remote_only',
])

function linkedinFilterRows(f) {
  if (!f || typeof f !== 'object') return []
  const entries = Object.entries(f).filter(
    ([k, value]) =>
      value !== null && value !== undefined && !HIDDEN_FILTER_KEYS.has(k)
  )
  const rows = []
  const rest = new Map(entries)

  if (rest.has('f_tpr')) {
    const value = rest.get('f_tpr')
    rest.delete('f_tpr')
    const raw = String(value).trim()
    const hours = Math.round(parseInt(raw.replace(/^r/i, ''), 10) / 3600)
    if (!Number.isNaN(hours)) {
      rows.push({
        label: 'Date filter',
        value: `Last ${hours} hour${hours === 1 ? '' : 's'}`,
      })
    } else {
      rows.push({ label: 'f_tpr', value: String(value) })
    }
  }

  const restKeys = [...rest.keys()].sort()
  for (const k of restKeys) {
    rows.push({ label: k, value: String(rest.get(k)) })
  }
  return rows
}

function indeedFilterRows(f) {
  if (!f || typeof f !== 'object') return []
  const entries = Object.entries(f).filter(
    ([k, value]) =>
      value !== null && value !== undefined && !HIDDEN_FILTER_KEYS.has(k)
  )
  const rows = []
  const rest = new Map(entries.filter(([k]) => k.startsWith('indeed_')))

  if (rest.has('indeed_fromage')) {
    const value = rest.get('indeed_fromage')
    rest.delete('indeed_fromage')
    const days = Number(value)
    rows.push({
      label: 'Date filter',
      value: `Last ${days} day${days === 1 ? '' : 's'}`,
    })
  }

  const restKeys = [...rest.keys()].sort()
  for (const k of restKeys) {
    rows.push({ label: k, value: String(rest.get(k)) })
  }
  return rows
}

function truncateUrl(u, max = 60) {
  if (!u) return ''
  if (u.length <= max) return u
  return `${u.slice(0, max - 1)}\u2026`
}

function runStatusClass(status) {
  if (status === 'completed') return s.runStatus
  if (status === 'failed') return s.runStatusFailed
  if (status === 'crashed') return s.runStatusCrashed
  if (status === 'running') return s.runStatusRunning
  return s.runStatus
}

/** Fixed order; url_exact omitted (removed from service). Only render keys present in gate_results. */
const GATE_ORDER = [
  { key: 'pass_0', label: 'Pass 0' },
  { key: 'language', label: 'Language' },
  { key: 'title_mismatch', label: 'Title Mismatch' },
  { key: 'contract_mismatch', label: 'Contract' },
  { key: 'remote_mismatch', label: 'Remote' },
  { key: 'sponsorship', label: 'Sponsorship' },
  { key: 'agency_jd', label: 'Agency (JD)' },
  { key: 'hash_exact', label: 'Hash Exact' },
  { key: 'cosine', label: 'Cosine' },
]

function formatGateTimeMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatDedupTrigger(t) {
  if (t === 'manual') return 'Manual'
  if (t === 'post_scan') return 'Post-scan'
  if (t === 'sync_pass2') return 'Sync'
  return t || '\u2014'
}

function DedupReportCard({ report, open, onToggle }) {
  const gr = report.gate_results || {}
  const counts = report.skip_reason_counts || {}
  const reasonEntries = Object.entries(counts).sort((a, b) => b[1] - a[1])

  return (
    <div className={s.runCard}>
      <div
        className={s.runHeader}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className={s.runSite}>🔁 Dedup</span>
        <span className={s.runTime}>
          {report.created_at ? formatAbsoluteTime(report.created_at) : '\u2014'}
        </span>
        <span className={s.dedupTriggerPill}>{formatDedupTrigger(report.trigger)}</span>
        <span className={s.runStatus}>completed</span>
        <span className={s.chevron}>{open ? '\u25bc' : '\u25b6'}</span>
      </div>

      {open && (
        <div className={s.runBody}>
          <div className={s.dedupTreeLine}>
            {'\u251c\u2500 '}
            {report.total_processed ?? 0} processed · {report.total_flagged ?? 0} removed ·{' '}
            {report.total_passed ?? 0} passed · {formatGateTimeMs(report.duration_ms)}
          </div>
          <div className={s.dedupSectionTitle}>GATE PERFORMANCE</div>
          <table className={s.dedupGateTable}>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Checked</th>
                <th>Flagged</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {GATE_ORDER.map(({ key, label }) => {
                const g = gr[key]
                if (!g) return null
                const muted = (g.checked ?? 0) === 0
                return (
                  <tr key={key} className={muted ? s.gateRowMuted : undefined}>
                    <td>{label}</td>
                    <td>{g.checked}</td>
                    <td>{g.flagged}</td>
                    <td>{formatGateTimeMs(g.duration_ms)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className={s.dedupSectionTitle}>REMOVED BY REASON</div>
          <div className={s.dedupReasonBlock}>
            {reasonEntries.length === 0 ? (
              <span className={s.scanMuted}>No removals recorded.</span>
            ) : (
              reasonEntries.map(([reason, n]) => (
                <div key={reason} className={s.dedupReasonLine}>
                  <span className={s.dedupReasonKey}>{reason}</span>
                  <span className={s.dedupReasonVal}>{n}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function RunCard({
  run,
  open,
  onToggle,
  site,
  skippedJobs,
  loadingSkipped,
  onLoadSkipped,
  originalById,
}) {
  const f = run.search_filters || {}
  const filterRows = site === 'indeed' ? indeedFilterRows(f) : linkedinFilterRows(f)
  const showLoadBtn = (run.jd_failed || 0) + (run.stale_skipped || 0) > 0
  const filteredCountBeforeLoad = (run.jd_failed || 0) + (run.stale_skipped || 0)
  const loaded = skippedJobs !== undefined
  const rows = skippedJobs || []

  return (
    <div className={s.runCard}>
      <div
        className={s.runHeader}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className={s.runSite}>
          {site === 'glassdoor'
            ? '🟢 Glassdoor'
            : site === 'indeed'
              ? '🟢 Indeed'
              : '🔵 LinkedIn'}
        </span>
        <span className={s.runTime}>
          {run.started_at ? formatAbsoluteTime(run.started_at) : '\u2014'}
        </span>
        <span className={runStatusClass(run.status)}>
          {run.status}
        </span>
        <span className={s.chevron}>{open ? '\u25bc' : '\u25b6'}</span>
      </div>

      {open && (
        <div className={s.runBody}>
          <div className={s.section}>
            <div className={s.sectionTitle}>Search config</div>
            <div className={s.configLine}>
              <span className={s.configLabel}>Website:</span>
              {site === 'glassdoor' ? 'Glassdoor' : site === 'indeed' ? 'Indeed' : 'LinkedIn'}
            </div>
            <div className={s.configLine}>
              <span className={s.configLabel}>Keyword:</span>
              {run.search_keyword ?? '\u2014'}
            </div>
            <div className={s.configLine}>
              <span className={s.configLabel}>Location:</span>
              {run.search_location ?? '\u2014'}
            </div>
            {filterRows.length > 0 ? (
              filterRows.map((row, i) => (
                <div key={`${row.label}-${i}`} className={s.configLine}>
                  <span className={s.configLabel}>{row.label}:</span>
                  {row.value}
                </div>
              ))
            ) : (
              <div className={s.configLine}>
                <span className={s.configLabel}>Filters:</span>
                {'\u2014'}
              </div>
            )}
            {(() => {
              const gd = f.general_date_posted
              const gi = f.general_internship_only
              const gr = f.general_remote_only
              const hasGeneral = gd != null || gi || gr
              if (!hasGeneral) return null
              return (
                <>
                  <div className={s.configLine} style={{ marginTop: 8 }}>
                    <span className={s.configLabel} style={{ fontWeight: 600 }}>
                      General:
                    </span>
                  </div>
                  {gd != null && (
                    <div className={s.configLine}>
                      <span className={s.configLabel}>Date posted:</span>
                      {`Last ${gd} day${gd === 1 ? '' : 's'}`}
                    </div>
                  )}
                  {gi && (
                    <div className={s.configLine}>
                      <span className={s.configLabel}>Internship only:</span>
                      yes
                    </div>
                  )}
                  {gr && (
                    <div className={s.configLine}>
                      <span className={s.configLabel}>Remote only:</span>
                      yes
                    </div>
                  )}
                </>
              )
            })()}
          </div>

          <div className={s.section}>
            <div className={s.sectionTitle}>Results</div>
            <div className={s.statRow}>
              <div className={s.statItem}>
                <span className={s.statLabel}>Scraped</span>
                <span className={s.statValue}>{run.scraped ?? 0}</span>
              </div>
              <div className={s.statItem}>
                <span className={s.statLabel}>New</span>
                <span className={s.statValue}>{run.new_jobs ?? 0}</span>
              </div>
              <div className={s.statItem}>
                <span className={s.statLabel}>Existing</span>
                <span className={s.statValue}>{run.existing ?? 0}</span>
              </div>
              <div className={s.statItem}>
                <span className={s.statLabel}>Pages</span>
                <span className={s.statValue}>{run.pages_scanned ?? 0}</span>
              </div>
            </div>
            <div className={s.statRow} style={{ marginTop: 10 }}>
              <div className={s.statItem}>
                <span className={s.statLabel}>Stale skipped</span>
                <span className={s.statValue}>{run.stale_skipped ?? 0}</span>
              </div>
              <div className={s.statItem}>
                <span className={s.statLabel}>JD failed</span>
                <span className={s.statValue}>{run.jd_failed ?? 0}</span>
              </div>
              <div className={s.statItem}>
                <span className={s.statLabel}>Duration</span>
                <span className={s.statValue}>
                  {formatDuration(run.started_at, run.completed_at)}
                </span>
              </div>
            </div>
          </div>

          <details className={s.scanEvents}>
            <summary className={s.scanEventsSummary}>Scan events</summary>
            <div className={s.scanEventsBody}>
              {run.session_error && (
                <div className={s.scanWarn}>
                  Session error: {run.session_error}
                </div>
              )}
              {Array.isArray(run.errors) && run.errors.length > 0 ? (
                <ul className={s.scanErrorList}>
                  {run.errors.map((e, i) => (
                    <li key={i} className={s.scanErrorItem}>
                      <span className={s.scanErrorType}>{e.type || 'event'}</span>
                      {e.jl != null && <span className={s.scanMeta}> jl={e.jl}</span>}
                      {e.job_id != null && <span className={s.scanMeta}> job={e.job_id}</span>}
                      {e.jk != null && <span className={s.scanMeta}> jk={e.jk}</span>}
                      {e.message ? `: ${e.message}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={s.scanMuted}>No per-card error log stored for this run.</p>
              )}
              {(run.jd_failed ?? 0) > 0 && (
                <div className={s.scanNote}>
                  ⚠ {run.jd_failed} job(s) failed JD fetch
                </div>
              )}
              {(run.stale_skipped ?? 0) > 0 && (
                <div className={s.scanNote}>
                  ℹ {run.stale_skipped} phantom cards skipped
                </div>
              )}
              {(run.jd_failed ?? 0) === 0 &&
                (run.stale_skipped ?? 0) === 0 &&
                !run.session_error &&
                !(Array.isArray(run.errors) && run.errors.length > 0) && (
                  <div className={s.scanOk}>✓ Clean scan — no errors</div>
                )}
              {(() => {
                const rate = jobsPerMinute(
                  run.scraped,
                  run.started_at,
                  run.completed_at
                )
                if (rate == null) return null
                return (
                  <div className={s.scanPace}>
                    Scraped {run.scraped ?? 0} jobs in{' '}
                    {formatDuration(run.started_at, run.completed_at)} ({rate} jobs/min)
                  </div>
                )
              })()}
            </div>
          </details>

          {showLoadBtn && (
            <div className={s.section}>
              <div className={s.filteredHeader}>
                <span className={s.sectionTitle} style={{ marginBottom: 0 }}>
                  Filtered jobs ({loaded ? rows.length : filteredCountBeforeLoad})
                </span>
                {!loaded && (
                  <button
                    type="button"
                    className={s.loadBtn}
                    disabled={loadingSkipped}
                    onClick={e => {
                      e.stopPropagation()
                      onLoadSkipped()
                    }}
                  >
                    {loadingSkipped ? 'Loading\u2026' : 'Load filtered jobs'}
                  </button>
                )}
              </div>
              {loaded && rows.length > 0 && (
                <table className={s.filterTable}>
                  <thead>
                    <tr>
                      <th>Skip reason</th>
                      <th>URL</th>
                      <th>Original job</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(job => (
                      <tr key={job.id}>
                        <td>{SKIP_LABELS[job.skip_reason] || job.skip_reason}</td>
                        <td>
                          {job.job_url ? (
                            <a
                              className={s.jobLink}
                              href={job.job_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {truncateUrl(job.job_url)}
                            </a>
                          ) : (
                            '\u2014'
                          )}
                        </td>
                        <td>
                          {job.original_job_id ? (() => {
                            const oid = String(job.original_job_id)
                            const orig = originalById[oid]
                            if (orig && orig.job_url) {
                              return (
                                <a
                                  className={s.jobLink}
                                  href={orig.job_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {truncateUrl(orig.job_url)}
                                </a>
                              )
                            }
                            if (orig === null) {
                              return <span className={s.monoUuid}>{oid}</span>
                            }
                            return '\u2014'
                          })() : '\u2014'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {loaded && rows.length === 0 && (
                <p style={{ fontSize: 13, color: '#666' }}>No skipped rows returned.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function LogsPage() {
  const [logSource, setLogSource] = useState('search')
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openIds, setOpenIds] = useState(() => new Set())
  const [skippedByRunId, setSkippedByRunId] = useState({})
  const [loadingSkip, setLoadingSkip] = useState({})
  const [originalById, setOriginalById] = useState({})
  const originalByIdRef = useRef({})

  const [dedupReports, setDedupReports] = useState([])
  const [dedupLoading, setDedupLoading] = useState(false)
  const [dedupError, setDedupError] = useState(null)
  const [openDedupIds, setOpenDedupIds] = useState(() => new Set())

  useEffect(() => {
    originalByIdRef.current = originalById
  }, [originalById])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await api.getRunLogs(50)
        if (!cancelled) setRuns(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setError('Failed to load run logs.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (logSource !== 'dedup') return undefined
    let cancelled = false
    ;(async () => {
      setDedupLoading(true)
      setDedupError(null)
      try {
        const data = await api.getDedupReports()
        if (!cancelled) setDedupReports(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setDedupError('Failed to load dedup reports.')
      } finally {
        if (!cancelled) setDedupLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [logSource])

  useEffect(() => {
    if (!runs.length) return
    setOpenIds(prev => {
      if (prev.size > 0) return prev
      const next = new Set()
      next.add(String(runs[0].id))
      return next
    })
  }, [runs])

  const toggle = useCallback(id => {
    setOpenIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleDedup = useCallback(id => {
    setOpenDedupIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const loadSkippedForRun = useCallback(async runId => {
    const rid = String(runId)
    setLoadingSkip(prev => ({ ...prev, [rid]: true }))
    try {
      const jobs = await api.getSkippedJobs(runId, { limit: 200 })
      setSkippedByRunId(prev => ({ ...prev, [rid]: jobs }))

      const ids = [...new Set(jobs.map(j => j.original_job_id).filter(Boolean).map(String))]
      const missing = ids.filter(id => originalByIdRef.current[id] === undefined)
      const pairs = await Promise.all(
        missing.map(async id => {
          try {
            return [String(id), await api.getJob(id)]
          } catch {
            return [String(id), null]
          }
        })
      )
      const merged = { ...originalByIdRef.current }
      for (const [id, job] of pairs) merged[id] = job
      originalByIdRef.current = merged
      setOriginalById(merged)
    } catch {
      setSkippedByRunId(prev => ({ ...prev, [rid]: [] }))
    } finally {
      setLoadingSkip(prev => ({ ...prev, [rid]: false }))
    }
  }, [])

  return (
    <div className={s.page}>
      <PageTitle>Logs</PageTitle>

      <div className={j.filterBar}>
        <div className={j.filterTabs}>
          <button
            type="button"
            className={`${j.filterTab} ${logSource === 'search' ? j.filterTabActive : ''}`}
            onClick={() => setLogSource('search')}
          >
            Search
          </button>
          <button
            type="button"
            className={`${j.filterTab} ${logSource === 'dedup' ? j.filterTabActive : ''}`}
            onClick={() => setLogSource('dedup')}
          >
            Dedup
          </button>
        </div>
      </div>

      {logSource === 'search' && (
        <>
          {loading && (
            <div style={{ padding: '2rem 0' }}>
              <Spinner />
            </div>
          )}

          {error && <p style={{ color: '#c0392b' }}>{error}</p>}

          {!loading && !error && runs.length === 0 && (
            <p style={{ color: '#666' }}>No scan runs yet.</p>
          )}

          {!loading &&
            runs.map(run => {
              const site = detectWebsiteFromRunLog(run) || 'linkedin'
              return (
                <RunCard
                  key={run.id}
                  run={run}
                  site={site}
                  open={openIds.has(String(run.id))}
                  onToggle={() => toggle(String(run.id))}
                  skippedJobs={skippedByRunId[String(run.id)]}
                  loadingSkipped={loadingSkip[String(run.id)]}
                  onLoadSkipped={() => loadSkippedForRun(run.id)}
                  originalById={originalById}
                />
              )
            })}
        </>
      )}

      {logSource === 'dedup' && (
        <>
          {dedupLoading && (
            <div style={{ padding: '2rem 0' }}>
              <Spinner />
            </div>
          )}
          {dedupError && <p style={{ color: '#c0392b' }}>{dedupError}</p>}
          {!dedupLoading && !dedupError && dedupReports.length === 0 && (
            <p style={{ color: '#666' }}>No dedup reports yet.</p>
          )}
          {!dedupLoading &&
            dedupReports.map(report => (
              <DedupReportCard
                key={report.id}
                report={report}
                open={openDedupIds.has(String(report.id))}
                onToggle={() => toggleDedup(String(report.id))}
              />
            ))}
        </>
      )}
    </div>
  )
}
