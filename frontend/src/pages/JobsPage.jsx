import { useEffect, useState, useRef, useCallback } from 'react'
import { useScanGrace } from '../hooks/useScanGrace'
import { api } from '../api'
import { detectWebsiteFromRunLog } from '../utils/runLog'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import JobCard from '../components/JobCard'
import JobModal from '../components/JobModal'
import s from './JobsPage.module.css'

const JOBS_PER_PAGE = 10

const SCAN_WEBSITES = ['linkedin', 'indeed', 'glassdoor']
const SLICE = 100 / SCAN_WEBSITES.length

function getScanProgressPct(scraped, totalJobsInDB) {
  if (totalJobsInDB > 0 && scraped > 0) {
    return Math.min(99, Math.round((scraped / totalJobsInDB) * 100))
  }
  return 0
}

function getScanAllPct(websiteIdx, scraped, totals, website) {
  const total = totals[website] || 1
  const completedPct = websiteIdx * SLICE
  const withinSlice =
    scraped > 0
      ? Math.min(SLICE - 0.5, (scraped / total) * SLICE)
      : 0
  return Math.min(99, Math.round(completedPct + withinSlice))
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

function buildPageList(page, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages = []
  const seen = new Set()
  const pushNum = (n) => {
    if (typeof n === 'number' && n >= 1 && n <= totalPages && !seen.has(n)) {
      seen.add(n)
      pages.push(n)
    }
  }
  pushNum(1)
  if (page > 3) pages.push('...')
  for (
    let i = Math.max(2, page - 1);
    i <= Math.min(totalPages - 1, page + 1);
    i++
  ) {
    pushNum(i)
  }
  if (page < totalPages - 2) pages.push('...')
  pushNum(totalPages)
  const out = []
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    if (p === '...' && out[out.length - 1] === '...') continue
    out.push(p)
  }
  return out
}

function PageNumbers({ page, totalPages, onPageChange }) {
  const pages = buildPageList(page, totalPages)
  return (
    <div className={s.paginationNumbers}>
      {pages.map((p, i) =>
        p === '...'
          ? (
              <span key={`ellipsis-${i}`} className={s.pageEllipsis}>
                …
              </span>
            )
          : (
              <button
                key={p}
                type="button"
                className={`${s.pageBtn} ${p === page ? s.pageBtnActive : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ),
      )}
    </div>
  )
}

export default function JobsPage() {
  const [scanning, setScanning] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const [progressOverride, setProgressOverride] = useState(null)
  const [scanAllActive, setScanAllActive] = useState(false)
  const [scanAllTotals, setScanAllTotals] = useState({
    linkedin: 0,
    indeed: 0,
    glassdoor: 0,
  })
  const [currentScanWebsite, setCurrentScanWebsite] = useState(null)
  const [scanAllWebsiteIdx, setScanAllWebsiteIdx] = useState(0)
  const [, progressTick] = useState(0)
  const scanningTimeoutRef = useRef(null)
  const wasRunningRef = useRef(false)
  const grace = useScanGrace()
  const prevScanningRef = useRef(false)
  const scanAllStartRef = useRef(null)
  const [wsConnected, setWsConnected] = useState(false)

  const pollIntervalMs = wsConnected ? 10000 : 2000

  const currentRunLog =
    lastRun?.status === 'running' ? lastRun : null

  const liveProgress =
    progressOverride != null
      ? lastRun
      : (scanning && lastRun?.status === 'running') ||
          (scanAllActive && lastRun)
        ? lastRun
        : null

  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState(null)
  const [jobsPage, setJobsPage] = useState(1)
  const [totalJobs, setTotalJobs] = useState(0)

  const [websiteFilter, setWebsiteFilter] = useState('all')
  const [scrapedFrom, setScrapedFrom] = useState('')
  const [linkedinCount, setLinkedinCount] = useState(0)
  const [indeedCount, setIndeedCount] = useState(0)
  const [glassdoorCount, setGlassdoorCount] = useState(0)
  const [selectedJob, setSelectedJob] = useState(null)

  const buildListParams = useCallback((website, pageNum) => {
    const params = {
      dismissed: false,
      limit: JOBS_PER_PAGE,
      offset: (pageNum - 1) * JOBS_PER_PAGE,
    }
    if (website && website !== 'all') params.website = website
    if (scrapedFrom) {
      params.scraped_from = scrapedFrom
      params.scraped_to = scrapedFrom
    }
    return params
  }, [scrapedFrom])

  const refreshTabCounts = useCallback(async () => {
    const base = { dismissed: false, limit: 1, offset: 0 }
    if (scrapedFrom) {
      base.scraped_from = scrapedFrom
      base.scraped_to = scrapedFrom
    }
    try {
      const [, liD, inD, gdD] = await Promise.all([
        api.getJobs(base),
        api.getJobs({ ...base, website: 'linkedin' }),
        api.getJobs({ ...base, website: 'indeed' }),
        api.getJobs({ ...base, website: 'glassdoor' }),
      ])
      setLinkedinCount(liD.total ?? 0)
      setIndeedCount(inD.total ?? 0)
      setGlassdoorCount(gdD.total ?? 0)
    } catch {
      /* keep */
    }
  }, [scrapedFrom])

  const fetchJobsList = useCallback(async (pageNum) => {
    const data = await api.getJobs(buildListParams(websiteFilter, pageNum))
    setJobs(data.items || [])
    setTotalJobs(data.total ?? 0)
    setJobsError(null)
  }, [websiteFilter, buildListParams])

  const checkRunLog = useCallback(async () => {
    try {
      const logs = await api.getRunLogs(1)
      if (!Array.isArray(logs) || !logs.length) return null
      const run = logs[0]
      setLastRun(run)
      return run
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    let wsUrl
    try {
      const u = new URL(base)
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.pathname = '/ws/run-log'
      u.search = ''
      u.hash = ''
      wsUrl = u.toString()
    } catch {
      wsUrl = 'ws://localhost:8000/ws/run-log'
    }
    const token = import.meta.env.VITE_AUTH_TOKEN || 'dev-token'

    let cancelled = false
    let ws = null

    function connect() {
      if (cancelled) return
      ws = new WebSocket(wsUrl, ['bearer', token])
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => {
        setWsConnected(false)
        if (!cancelled) {
          setTimeout(connect, 5000)
        }
      }
      ws.onmessage = (e) => {
        try {
          const update = JSON.parse(e.data)
          setLastRun((prev) => {
            if (prev && String(prev.id) === String(update.id)) {
              return { ...prev, ...update }
            }
            return prev
          })
        } catch (err) {
          console.warn('WS parse error:', err)
        }
      }
    }

    connect()
    return () => {
      cancelled = true
      if (ws) ws.close()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setJobsLoading(true)
      setJobsError(null)
      try {
        await fetchJobsList(jobsPage)
        await refreshTabCounts()
      } catch {
        if (!cancelled) {
          setJobsError('Failed to load jobs \u2014 is the backend running?')
        }
      } finally {
        if (!cancelled) setJobsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [websiteFilter, scrapedFrom, jobsPage, fetchJobsList, refreshTabCounts])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [jobsPage])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        const [logs, state] = await Promise.all([
          api.getRunLogs(1),
          api.getExtensionState(),
        ])
        if (cancelled) return
        const run = Array.isArray(logs) && logs.length ? logs[0] : null
        if (run) setLastRun(run)

        const isCurrentlyRunning =
          run?.status === 'running' || state?.scan_requested === true

        if (isCurrentlyRunning) {
          clearTimeout(scanningTimeoutRef.current)
          scanningTimeoutRef.current = null
          if (run?.status === 'running') {
            grace.clear()
          }
          setScanning(true)
        } else {
          const inGrace = grace.isInGrace()
          if (!inGrace) {
            setScanning(prev => {
              if (!prev) return prev
              if (!scanningTimeoutRef.current) {
                scanningTimeoutRef.current = setTimeout(() => {
                  setScanning(false)
                  scanningTimeoutRef.current = null
                }, 5000)
              }
              return prev
            })
          }
        }

        const running = run?.status === 'running'
        if (wasRunningRef.current && !running && !scanAllActive) {
          setJobsPage(1)
          fetchJobsList(1).catch(() => {})
          refreshTabCounts().catch(() => {})
        }
        wasRunningRef.current = !!running
      } catch {
        /* ignore */
      }
    }

    tick()
    const id = setInterval(tick, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
      clearTimeout(scanningTimeoutRef.current)
    }
  }, [fetchJobsList, refreshTabCounts, scanAllActive, grace.isInGrace, grace.clear, pollIntervalMs])

  useEffect(() => {
    if (!scanning && !scanAllActive) return undefined
    const interval = setInterval(() => {
      fetchJobsList(jobsPage).catch(() => {})
      refreshTabCounts().catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [scanning, scanAllActive, fetchJobsList, refreshTabCounts, jobsPage])

  useEffect(() => {
    const wasScanning = prevScanningRef.current
    prevScanningRef.current = scanning
    if (wasScanning && !scanning && !scanAllActive) {
      setWebsiteFilter('all')
      setScrapedFrom('')
      setJobsPage(1)
      fetchJobsList(1).catch(() => {})
      checkRunLog().catch(() => {})
      setProgressOverride(100)
      const t = setTimeout(() => setProgressOverride(null), 1500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [scanning, scanAllActive, fetchJobsList, checkRunLog])

  useEffect(() => {
    if (!scanning && !scanAllActive && progressOverride === null) return undefined
    const id = setInterval(() => progressTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [scanning, scanAllActive, progressOverride])

  async function handleScanLinkedIn() {
    try {
      grace.start()
      setScanning(true)
      await api.triggerScan('linkedin')
    } catch (e) {
      setScanning(false)
      grace.clear()
      if (e?.status === 409) {
        window.alert(e.message || 'Scan rejected — please wait and retry.')
        return
      }
    }
  }

  async function handleScanIndeed() {
    try {
      grace.start()
      setScanning(true)
      await api.triggerScan('indeed')
    } catch (e) {
      setScanning(false)
      grace.clear()
      if (e?.status === 409) {
        window.alert(e.message || 'Scan rejected — please wait and retry.')
        return
      }
    }
  }

  async function handleScanGlassdoor() {
    try {
      grace.start()
      setScanning(true)
      await api.triggerScan('glassdoor')
    } catch (e) {
      setScanning(false)
      grace.clear()
      if (e?.status === 409) {
        window.alert(e.message || 'Scan rejected — please wait and retry.')
        return
      }
    }
  }

  const handleScanAll = async () => {
    if (scanning || scanAllActive) return
    grace.start()
    setScanAllActive(true)
    scanAllStartRef.current = Date.now()
    try {
      try {
        const [liD, indD, gdD] = await Promise.all([
          api.getJobs({ website: 'linkedin', limit: 1, dismissed: false }),
          api.getJobs({ website: 'indeed', limit: 1, dismissed: false }),
          api.getJobs({ website: 'glassdoor', limit: 1, dismissed: false }),
        ])
        setScanAllTotals({
          linkedin: liD.total || 0,
          indeed: indD.total || 0,
          glassdoor: gdD.total || 0,
        })
      } catch (e) {
        console.warn('[JHA] Scan All: could not fetch totals:', e?.message)
      }

      const scanAllTotal = SCAN_WEBSITES.length
      for (let i = 0; i < SCAN_WEBSITES.length; i++) {
        const website = SCAN_WEBSITES[i]
        setCurrentScanWebsite(website)
        setScanAllWebsiteIdx(i)
        try {
          await api.triggerScan(website, {
            scan_all: true,
            scan_all_position: i + 1,
            scan_all_total: scanAllTotal,
          })
        } catch (e) {
          if (e?.status === 409) {
            grace.clear()
            window.alert(e.message || 'Scan rejected — please wait and retry.')
            break
          }
          throw e
        }
        await new Promise((r) => setTimeout(r, 3000))
        const deadline = Date.now() + 30 * 60 * 1000
        let foundCompletion = false
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000))
          try {
            const runs = await api.getRunLogs(5, { includeDebugLog: false })
            if (!Array.isArray(runs)) continue
            const latest = runs.find((r) => r.search_filters?.website === website)
            if (latest?.status === 'completed' || latest?.status === 'failed') {
              foundCompletion = true
              break
            }
          } catch {
            /* ignore poll errors */
          }
        }
        if (!foundCompletion) {
          window.alert(
            `Scan All: ${website} exceeded 30 minutes without completing — stopping scan and continuing.`,
          )
          await api.stopScan().catch(() => {})
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    } finally {
      setScanAllActive(false)
      setCurrentScanWebsite(null)
      setProgressOverride(100)
      setTimeout(() => setProgressOverride(null), 1500)
      refreshTabCounts().catch(() => {})
      fetchJobsList(1).catch(() => {})
    }
  }

  const handleStop = async () => {
    try {
      await api.stopScan()
      grace.clear()
      setTimeout(() => {
        checkRunLog().catch(() => {})
      }, 1500)
    } catch {
      // ignore
    }
  }

  const lastScanSite = lastRun ? detectWebsiteFromRunLog(lastRun) : null

  const totalUnfilteredShown = linkedinCount + indeedCount + glassdoorCount
  const totalPages = Math.max(1, Math.ceil(totalJobs / JOBS_PER_PAGE))

  return (
    <div>
      <PageTitle>Scraped Jobs</PageTitle>

      <div className={s.scanPanel}>
        <div className={s.scanButtons}>
          <button
            type="button"
            className={s.scanBtnLinkedIn}
            disabled={scanning || scanAllActive || jobsLoading}
            onClick={handleScanLinkedIn}
          >
            🔵 Scan LinkedIn
          </button>
          <button
            type="button"
            className={s.scanBtnIndeed}
            disabled={scanning || scanAllActive || jobsLoading}
            onClick={handleScanIndeed}
          >
            🟢 Scan Indeed
          </button>
          <button
            type="button"
            className={s.scanBtnGlassdoor}
            disabled={scanning || scanAllActive || jobsLoading}
            onClick={handleScanGlassdoor}
          >
            🟢 Scan Glassdoor
          </button>
          <button
            type="button"
            className={`${s.scanAllBtn} ${(scanning || scanAllActive) ? s.scanBtnDisabled : ''}`}
            onClick={handleScanAll}
            disabled={scanning || scanAllActive || jobsLoading}
          >
            {scanAllActive ? '⏳ Scanning All...' : '▶▶ Scan All'}
          </button>
        </div>

        {(scanning || scanAllActive) && (
          <button className={s.stopBtn} onClick={handleStop}>
            Stop Scan
          </button>
        )}

        {(scanning || scanAllActive) && (
          <span className={s.scanStatus}>
            <span className={s.pulseDot} />
            Scan in progress...
          </span>
        )}

        {(scanning || scanAllActive || progressOverride !== null) && (() => {
          const scraped = liveProgress?.scraped ?? 0
          const pct = progressOverride ?? (
            scanAllActive
              ? getScanAllPct(
                  scanAllWebsiteIdx,
                  scraped,
                  scanAllTotals,
                  currentScanWebsite || 'linkedin',
                )
              : getScanProgressPct(scraped, totalJobs)
          )
          const elapsed = (scanAllActive && scanAllStartRef.current != null)
            ? Math.floor((Date.now() - scanAllStartRef.current) / 1000)
            : currentRunLog?.started_at
              ? Math.floor(
                  (Date.now() - new Date(currentRunLog.started_at).getTime()) / 1000,
                )
              : 0
          const elapsedStr = `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`
          return (
            <div className={s.scanProgressWrap}>
              <div className={s.scanProgressTrack}>
                <div className={s.scanProgressFill} style={{ width: `${pct}%` }} />
              </div>
              <div className={s.scanProgressMeta}>
                <span className={s.scanProgressPct}>{pct}%</span>
                <span className={s.scanProgressTime}>{elapsedStr}</span>
                {scraped > 0 && (
                  <span className={s.scanProgressCount}>
                    {scraped} scraped · {liveProgress?.new_jobs ?? 0} new
                    {(liveProgress?.jd_failed ?? 0) > 0 && ` · ${liveProgress.jd_failed} failed`}
                  </span>
                )}
                {scanAllActive && currentScanWebsite && progressOverride === null && (
                  <span className={s.scanProgressSite}>
                    Scanning {currentScanWebsite}…
                  </span>
                )}
                {progressOverride === 100 && (
                  <span className={s.scanProgressDone}>✓ Done</span>
                )}
              </div>
            </div>
          )
        })()}

        {!scanning && !scanAllActive && lastRun && lastRun.status !== 'running' && (
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

      <div className={s.filterBar}>
        <div className={s.filterTabs}>
          <button
            type="button"
            className={`${s.filterTab} ${websiteFilter === 'all' ? s.filterTabActive : ''}`}
            onClick={() => { setWebsiteFilter('all'); setJobsPage(1) }}
          >
            All ({totalUnfilteredShown})
          </button>
          <button
            type="button"
            className={`${s.filterTab} ${websiteFilter === 'linkedin' ? s.filterTabActive : ''}`}
            onClick={() => { setWebsiteFilter('linkedin'); setJobsPage(1) }}
          >
            🔵 LinkedIn ({linkedinCount})
          </button>
          <button
            type="button"
            className={`${s.filterTab} ${websiteFilter === 'indeed' ? s.filterTabActive : ''}`}
            onClick={() => { setWebsiteFilter('indeed'); setJobsPage(1) }}
          >
            🟢 Indeed ({indeedCount})
          </button>
          <button
            type="button"
            className={`${s.filterTab} ${websiteFilter === 'glassdoor' ? s.filterTabActive : ''}`}
            onClick={() => { setWebsiteFilter('glassdoor'); setJobsPage(1) }}
          >
            🟢 Glassdoor ({glassdoorCount})
          </button>
        </div>
        <div className={s.filterGroup}>
          <label className={s.filterLabel} htmlFor="scraped-from">Scraped from</label>
          <input
            id="scraped-from"
            type="date"
            className={s.filterDateInput}
            value={scrapedFrom}
            onChange={e => { setScrapedFrom(e.target.value); setJobsPage(1) }}
          />
        </div>
      </div>

      {jobs.length > 0 && (
        <>
          <div className={s.jobGrid}>
            {jobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                onClick={() => setSelectedJob(job)}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className={s.pagination}>
              <button
                type="button"
                className={s.pageBtn}
                disabled={jobsPage === 1}
                onClick={() => setJobsPage(p => p - 1)}
              >
                ← Prev
              </button>
              <PageNumbers
                page={jobsPage}
                totalPages={totalPages}
                onPageChange={setJobsPage}
              />
              <button
                type="button"
                className={s.pageBtn}
                disabled={jobsPage === totalPages}
                onClick={() => setJobsPage(p => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
          <div className={s.paginationMeta}>
            Page {jobsPage} of {totalPages} · {totalJobs} jobs
          </div>
        </>
      )}

      {selectedJob && (
        <JobModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  )
}
