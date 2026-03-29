import { useEffect, useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { formatAbsoluteTime, formatElapsed } from '../utils/time'
import { detectWebsiteFromRunLog } from '../utils/runLog'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import s from './JobsPage.module.css'

const PAGE_SIZE = 250
/** First-page fetch size for list + live polling during scan */
const JOBS_POLL_LIMIT = 250
const SCAN_HISTORY_LIMIT = 10

function formatScanRowDuration(started_at, completed_at) {
  if (!completed_at) return 'in progress'
  const diff = new Date(completed_at) - new Date(started_at)
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** Shorter than formatAbsoluteTime for compact history rows (no timezone suffix). */
function formatCompactRunTime(isoString) {
  if (!isoString) return '\u2014'
  const d = new Date(isoString)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatStartedTime(isoString) {
  if (!isoString) return ''
  const d = new Date(isoString)
  return d.toLocaleTimeString('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatLocation(location) {
  if (!location) return '\u2014'
  if (location.toLowerCase().includes('canada')) return location
  return `${location}, Canada`
}

function WebsiteBadge({ website }) {
  if (website === 'linkedin') {
    return <span className={`${s.websiteBadge} ${s.badgeLinkedIn}`}>🔵 LinkedIn</span>
  }
  if (website === 'indeed') {
    return <span className={`${s.websiteBadge} ${s.badgeIndeed}`}>🟢 Indeed</span>
  }
  if (website === 'glassdoor') {
    return <span className={`${s.websiteBadge} ${s.badgeGlassdoor}`}>🟢 Glassdoor</span>
  }
  return null
}

function JobModal({ job, onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const posted = job.post_datetime
    ? new Date(job.post_datetime).toLocaleDateString()
    : null

  const jdLines = (job.job_description || '').split('\n')

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '5vh',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '760px',
          margin: '0 16px 40px',
          padding: '32px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            background: 'none', border: 'none', fontSize: '22px',
            cursor: 'pointer', color: '#666', lineHeight: 1,
          }}
        >
          &times;
        </button>

        <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '4px' }}>
          {job.job_title || 'Unknown'}
        </h2>
        <div style={{ color: '#555', fontSize: '14px', marginBottom: '12px' }}>
          {[job.company, formatLocation(job.location), posted ? `Posted ${posted}` : null]
            .filter(Boolean).join(' \u00b7 ')}
        </div>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {(job.apply_url || job.job_url) && (
            <a
              href={job.apply_url || job.job_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: '#0a66c2', color: '#fff',
                padding: '9px 20px', borderRadius: '6px',
                textDecoration: 'none', fontSize: '14px', fontWeight: 600,
              }}
            >
              {job.easy_apply ? '\u26a1 Easy Apply' : 'Apply Now'}
            </a>
          )}
          {job.job_url && (
            <a
              href={job.job_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: '#f0f0f0', color: '#333',
                padding: '9px 20px', borderRadius: '6px',
                textDecoration: 'none', fontSize: '14px', fontWeight: 600,
              }}
            >
              View on LinkedIn
            </a>
          )}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #eee', marginBottom: '20px' }} />

        <div style={{ fontSize: '14px', lineHeight: '1.7', color: '#222' }}>
          {jdLines.map((line, i) => (
            line.trim() === ''
              ? <br key={i} />
              : <p key={i} style={{ margin: '0 0 4px' }}>{line}</p>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function JobsPage() {
  const [scanning, setScanning] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const pollRef = useRef(null)

  const scanStartTime = useRef(null)
  const [elapsed, setElapsed] = useState(0)

  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState(null)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [allTimeScraped, setAllTimeScraped] = useState(null)

  const [websiteFilter, setWebsiteFilter] = useState('all')
  const [linkedinCount, setLinkedinCount] = useState(0)
  const [indeedCount, setIndeedCount] = useState(0)
  const [glassdoorCount, setGlassdoorCount] = useState(0)
  const [selectedJob, setSelectedJob] = useState(null)

  const [scanHistoryOpen, setScanHistoryOpen] = useState(false)
  const [recentRunLogs, setRecentRunLogs] = useState([])

  const fetchJobs = useCallback(async () => {
    const data = await api.getJobs({
      dismissed: false,
      limit: JOBS_POLL_LIMIT,
      offset: 0,
      ...(websiteFilter !== 'all' && { website: websiteFilter }),
    })
    setJobs(data)
    setHasMore(data.length === JOBS_POLL_LIMIT)
    setJobsError(null)
    setPage(0)

    if (websiteFilter === 'all') {
      setLinkedinCount(data.filter(j => j.website === 'linkedin').length)
      setIndeedCount(data.filter(j => j.website === 'indeed').length)
      setGlassdoorCount(data.filter(j => j.website === 'glassdoor').length)
    } else {
      try {
        const all = await api.getJobs({
          dismissed: false,
          limit: JOBS_POLL_LIMIT,
          offset: 0,
        })
        setLinkedinCount(all.filter(j => j.website === 'linkedin').length)
        setIndeedCount(all.filter(j => j.website === 'indeed').length)
        setGlassdoorCount(all.filter(j => j.website === 'glassdoor').length)
      } catch {
        /* keep previous counts */
      }
    }
  }, [websiteFilter])

  const loadJobs = useCallback(async (offset = 0, append = false) => {
    setJobsLoading(true)
    setJobsError(null)
    try {
      const data = await api.getJobs({
        dismissed: false,
        limit: PAGE_SIZE,
        offset,
        ...(websiteFilter !== 'all' && { website: websiteFilter }),
      })
      setJobs(prev => append ? [...prev, ...data] : data)
      setHasMore(data.length === PAGE_SIZE)
    } catch {
      setJobsError('Failed to load jobs \u2014 is the backend running?')
    } finally {
      setJobsLoading(false)
    }
  }, [websiteFilter])

  const checkRunLog = useCallback(async () => {
    try {
      const logs = await api.getRunLogs(SCAN_HISTORY_LIMIT)
      setRecentRunLogs(Array.isArray(logs) ? logs : [])
      if (!logs.length) return null
      const run = logs[0]
      setLastRun(run)
      return run
    } catch {
      return null
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const fetchAllTimeTotal = useCallback(async () => {
    try {
      const logs = await api.getRunLogs(50)
      const total = logs
        .filter(l => l.status === 'completed')
        .reduce((sum, l) => sum + (l.new_jobs || 0), 0)
      setAllTimeScraped(total)
    } catch {}
  }, [])

  const startScanPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      const run = await checkRunLog()
      if (run && run.status !== 'running') {
        setScanning(false)
        stopPolling()
        setPage(0)
        fetchAllTimeTotal()
      }
    }, 5000)
  }, [checkRunLog, stopPolling, fetchAllTimeTotal])

  useEffect(() => {
    let timer = null
    if (scanning) {
      scanStartTime.current = Date.now()
      setElapsed(0)
      timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - scanStartTime.current) / 1000))
      }, 1000)
    } else {
      scanStartTime.current = null
    }
    return () => { if (timer) clearInterval(timer) }
  }, [scanning])

  const prevScanning = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setJobsLoading(true)
      setJobsError(null)
      try {
        await fetchJobs()
      } catch {
        if (!cancelled) {
          setJobsError('Failed to load jobs \u2014 is the backend running?')
        }
      } finally {
        if (!cancelled) setJobsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [websiteFilter, fetchJobs])

  useEffect(() => {
    fetchAllTimeTotal()
    checkRunLog().then(run => {
      if (run && run.status === 'running') {
        setScanning(true)
        startScanPolling()
      }
    })
    return () => stopPolling()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!scanning) return
    const interval = setInterval(() => {
      fetchJobs().catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [scanning, fetchJobs])

  useEffect(() => {
    if (prevScanning.current && !scanning) {
      setWebsiteFilter('all')
      fetchJobs().catch(() => {})
      checkRunLog().catch(() => {})
    }
    prevScanning.current = scanning
  }, [scanning, fetchJobs, checkRunLog])

  async function handleScanLinkedIn() {
    try {
      setScanning(true)
      await api.triggerScan('linkedin')
      startScanPolling()
    } catch {
      setScanning(false)
    }
  }

  async function handleScanIndeed() {
    try {
      setScanning(true)
      await api.triggerScan('indeed')
      startScanPolling()
    } catch {
      setScanning(false)
    }
  }

  async function handleScanGlassdoor() {
    try {
      setScanning(true)
      await api.triggerScan('glassdoor')
      startScanPolling()
    } catch {
      setScanning(false)
    }
  }

  const handleStop = async () => {
    try {
      await api.stopScan()
      setScanning(false)
      setTimeout(() => {
        checkRunLog().catch(() => {})
        fetchAllTimeTotal().catch(() => {})
      }, 1500)
    } catch {
      // ignore
    }
  }

  const handleLoadMore = () => {
    const nextOffset = (page + 1) * PAGE_SIZE
    setPage(p => p + 1)
    loadJobs(nextOffset, true)
  }

  const lastScanSite = lastRun ? detectWebsiteFromRunLog(lastRun) : null

  const totalUnfilteredShown = linkedinCount + indeedCount + glassdoorCount
  const jobsShownSuffix = (() => {
    if (jobs.length === 0) return null
    if (websiteFilter === 'linkedin') return 'LinkedIn jobs shown'
    if (websiteFilter === 'indeed') return 'Indeed jobs shown'
    if (websiteFilter === 'glassdoor') return 'Glassdoor jobs shown'
    return 'jobs shown'
  })()

  return (
    <div>
      <PageTitle>Scraped Jobs</PageTitle>

      {/* ── Session warning ─────────────────────────────────── */}
      {lastRun?.session_error && (
        <div className={s.warningBanner}>
          {lastRun.session_error === 'captcha' &&
            '\u26a0\ufe0f CAPTCHA detected on last scan. Open LinkedIn and solve it before scanning again.'}
          {lastRun.session_error === 'expired' &&
            '\u26a0\ufe0f LinkedIn session expired. Open LinkedIn and log in again.'}
          {lastRun.session_error === 'redirected' &&
            '\u26a0\ufe0f LinkedIn redirected the last scan. This may indicate a soft rate limit \u2014 wait 1\u20132 hours before scanning.'}
          {!['captcha', 'expired', 'redirected'].includes(lastRun.session_error) &&
            `\u26a0\ufe0f Session error: ${lastRun.session_error}`}
        </div>
      )}

      {/* ── Scan panel ──────────────────────────────────────── */}
      <div className={s.scanPanel}>
        <div className={s.scanButtons}>
          <button
            type="button"
            className={s.scanBtnLinkedIn}
            disabled={scanning || jobsLoading}
            onClick={handleScanLinkedIn}
          >
            🔵 Scan LinkedIn
          </button>
          <button
            type="button"
            className={s.scanBtnIndeed}
            disabled={scanning || jobsLoading}
            onClick={handleScanIndeed}
          >
            🟢 Scan Indeed
          </button>
          <button
            type="button"
            className={s.scanBtnGlassdoor}
            disabled={scanning || jobsLoading}
            onClick={handleScanGlassdoor}
          >
            🟢 Scan Glassdoor
          </button>
        </div>

        {scanning && (
          <button className={s.stopBtn} onClick={handleStop}>
            Stop Scan
          </button>
        )}

        {scanning && (
          <span className={s.scanStatus}>
            <span className={s.pulseDot} />
            Scan in progress...
            <span className={s.scanTimer}>
              {'\u23f1'} {formatElapsed(elapsed)}
            </span>
          </span>
        )}

        {!scanning && lastRun && lastRun.status !== 'running' && (
          <span className={s.lastRun}>
            Last scan:{' '}
            {lastScanSite === 'indeed' && '🟢 Indeed'}
            {lastScanSite === 'glassdoor' && '🟢 Glassdoor'}
            {lastScanSite === 'linkedin' && '🔵 LinkedIn'}
            {lastScanSite == null && '\u2014'}
            {' \u00b7 '}{lastRun.new_jobs ?? 0} new {'\u00b7'} {lastRun.existing ?? 0} existing
            {lastRun.started_at && (
              <> {'\u00b7'} started {formatStartedTime(lastRun.started_at)}</>
            )}
          </span>
        )}

        <span className={s.scanHint}>
          Scan is controlled via the Chrome extension. Install the extension and stay
          logged into LinkedIn (and Indeed Canada when using Indeed, and Glassdoor Canada when using Glassdoor).
        </span>
      </div>

      <div className={s.scanHistory}>
        <button
          type="button"
          className={s.scanHistoryToggle}
          onClick={() => setScanHistoryOpen(o => !o)}
          aria-expanded={scanHistoryOpen}
        >
          <span className={s.scanHistoryChevron}>{scanHistoryOpen ? '\u25b2' : '\u25bc'}</span>
          Scan History
        </button>
        {scanHistoryOpen && (
          <div className={s.scanHistoryList}>
            {recentRunLogs.length === 0 && (
              <div className={s.scanHistoryEmpty}>No runs yet.</div>
            )}
            {recentRunLogs.map(run => {
              const site = detectWebsiteFromRunLog(run) || 'linkedin'
              const dur = formatScanRowDuration(run.started_at, run.completed_at)
              return (
                <Link
                  key={run.id}
                  className={s.scanHistoryRow}
                  to="/search-report"
                >
                  <span className={s.scanHistorySite}>
                    {site === 'glassdoor'
                      ? '🟢 Glassdoor'
                      : site === 'indeed'
                        ? '🟢 Indeed'
                        : '🔵 LinkedIn'}
                  </span>
                  <span className={s.scanHistoryMeta}>
                    {formatCompactRunTime(run.started_at)}
                    {'  '}
                    {run.status}
                    {'  '}
                    {run.new_jobs ?? 0} new · {run.existing ?? 0} existing · {run.pages_scanned ?? 0} pages · {dur}
                  </span>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {jobsError && <div className={s.error}>{jobsError}</div>}

          {jobsLoading && jobs.length === 0 && !jobsError && (
            <div className={s.spinnerWrap}><Spinner /></div>
          )}

          {!jobsLoading && !jobsError && jobs.length === 0 && (
            <div className={s.empty}>
              <p className={s.emptyTitle}>No jobs scraped yet.</p>
              <p className={s.emptyHint}>Use Scan LinkedIn, Scan Indeed, or Scan Glassdoor to scrape jobs.</p>
            </div>
          )}

          {(!(jobsLoading && jobs.length === 0 && !jobsError) || websiteFilter !== 'all') && (
            <div className={s.filterTabs}>
              <button
                type="button"
                className={`${s.filterTab} ${websiteFilter === 'all' ? s.filterTabActive : ''}`}
                onClick={() => setWebsiteFilter('all')}
              >
                All ({totalUnfilteredShown})
              </button>
              <button
                type="button"
                className={`${s.filterTab} ${websiteFilter === 'linkedin' ? s.filterTabActive : ''}`}
                onClick={() => setWebsiteFilter('linkedin')}
              >
                🔵 LinkedIn ({linkedinCount})
              </button>
              <button
                type="button"
                className={`${s.filterTab} ${websiteFilter === 'indeed' ? s.filterTabActive : ''}`}
                onClick={() => setWebsiteFilter('indeed')}
              >
                🟢 Indeed ({indeedCount})
              </button>
              <button
                type="button"
                className={`${s.filterTab} ${websiteFilter === 'glassdoor' ? s.filterTabActive : ''}`}
                onClick={() => setWebsiteFilter('glassdoor')}
              >
                🟢 Glassdoor ({glassdoorCount})
              </button>
            </div>
          )}

          {jobs.length > 0 && jobsShownSuffix && (
            <div className={s.counters}>
              <span className={s.counter}>
                <strong>{jobs.length}</strong> {jobsShownSuffix}
              </span>
              {allTimeScraped !== null && (
                <span className={s.counter}>
                  <strong>{allTimeScraped}</strong> total scraped (all runs)
                </span>
              )}
            </div>
          )}

          {jobs.length > 0 && (
            <>
              <div className={s.grid}>
                {jobs.map(job => (
                  <div
                    key={job.id}
                    className={s.card}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedJob(job)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedJob(job)
                      }
                    }}
                  >
                    <WebsiteBadge website={job.website} />
                    <div className={s.cardTitle}>{job.job_title}</div>
                    <div className={s.cardCompany}>{job.company}</div>
                    <div className={s.cardLocation}>
                      <>{'\ud83d\udccd'} {formatLocation(job.location)}</>
                    </div>
                    <div className={s.cardTime}>
                      {formatAbsoluteTime(job.post_datetime)}
                    </div>
                  </div>
                ))}
              </div>

              {hasMore && jobs.length >= PAGE_SIZE && (
                <button className={s.loadMore} onClick={handleLoadMore}>
                  Load More
                </button>
              )}
            </>
          )}

      {selectedJob && (
        <JobModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  )
}
