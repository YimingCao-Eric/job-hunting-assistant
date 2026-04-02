import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api'
import { normaliseLocation } from '../utils/location'
import { detectWebsiteFromRunLog } from '../utils/runLog'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
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

function formatDateOnly(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
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

function linkedInIsPromoted(job) {
  if (job.website !== 'linkedin' || !job.post_datetime || !job.created_at) return false
  const gapDays = Math.floor(
    (new Date(job.created_at) - new Date(job.post_datetime)) / (1000 * 60 * 60 * 24)
  )
  return gapDays > 2
}

function jobIsPromotedGap(job) {
  if (!job.post_datetime || !job.created_at) return false
  return (
    Math.floor(
      (new Date(job.created_at) - new Date(job.post_datetime)) / (1000 * 60 * 60 * 24)
    ) > 2
  )
}

function jobIsRemote(job) {
  const title = (job.job_title || '').toLowerCase()
  const loc = (job.location || '').toLowerCase()
  return loc.includes('remote') || title.includes('remote')
}

function jobIsInternship(job) {
  const title = (job.job_title || '').toLowerCase()
  return /intern|co-op|coop|co op|internship/.test(title)
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

function JobModal({ job, onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const isPromoted = linkedInIsPromoted(job)

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
          {[job.company, normaliseLocation(job.location) ?? '\u2014']
            .filter((x) => x != null && x !== '')
            .join(' \u00b7 ')}
        </div>

        {job.website === 'linkedin' && job.post_datetime && (
          <div className={s.modalDates}>
            <div>
              <span className={s.modalDateLabel}>
                {isPromoted ? 'Originally posted:' : 'Posted:'}
              </span>{' '}
              {formatDateOnly(job.post_datetime)}
            </div>
          </div>
        )}

        <div className={s.applyRow}>
          <a
            href={job.job_url}
            target="_blank"
            rel="noopener noreferrer"
            className={s.applyManualBtn}
          >
            Apply Manually
          </a>
          <button type="button" disabled className={s.autoApplyBtn}>
            Auto Apply
          </button>
        </div>
        {(job.website === 'glassdoor' || job.website === 'indeed') && !job.easy_apply && (
          <div className={s.applyNote}>
            Opens the job listing page — click the apply button there to apply
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid #eee', marginBottom: '20px' }} />

        <div className={s.jobDescription}>{job.job_description}</div>
      </div>
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
  const scanTriggerGraceRef = useRef(0)
  const prevScanningRef = useRef(false)
  const scanAllStartRef = useRef(null)

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
    const GRACE_MS = 15000

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
            scanTriggerGraceRef.current = 0
          }
          setScanning(true)
        } else {
          const inGrace = Date.now() - scanTriggerGraceRef.current < GRACE_MS
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
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
      clearTimeout(scanningTimeoutRef.current)
    }
  }, [fetchJobsList, refreshTabCounts, scanAllActive])

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
      scanTriggerGraceRef.current = Date.now()
      setScanning(true)
      await api.triggerScan('linkedin')
    } catch {
      setScanning(false)
      scanTriggerGraceRef.current = 0
    }
  }

  async function handleScanIndeed() {
    try {
      scanTriggerGraceRef.current = Date.now()
      setScanning(true)
      await api.triggerScan('indeed')
    } catch {
      setScanning(false)
      scanTriggerGraceRef.current = 0
    }
  }

  async function handleScanGlassdoor() {
    try {
      scanTriggerGraceRef.current = Date.now()
      setScanning(true)
      await api.triggerScan('glassdoor')
    } catch {
      setScanning(false)
      scanTriggerGraceRef.current = 0
    }
  }

  const handleScanAll = async () => {
    if (scanning || scanAllActive) return
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

      for (let i = 0; i < SCAN_WEBSITES.length; i++) {
        const website = SCAN_WEBSITES[i]
        setCurrentScanWebsite(website)
        setScanAllWebsiteIdx(i)
        await api.triggerScan(website)
        await new Promise((r) => setTimeout(r, 3000))
        const deadline = Date.now() + 30 * 60 * 1000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000))
          try {
            const runs = await api.getRunLogs(5)
            if (!Array.isArray(runs)) continue
            const latest = runs.find((r) => r.search_filters?.website === website)
            if (latest?.status === 'completed' || latest?.status === 'failed') break
          } catch {
            /* ignore poll errors */
          }
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
      scanTriggerGraceRef.current = 0
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
            {jobs.map(job => {
              const isRemote = jobIsRemote(job)
              const isIntern = jobIsInternship(job)
              const isPromoted = jobIsPromotedGap(job)

              return (
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
                  <div className={s.badgeRow}>
                    <WebsiteBadge website={job.website} />
                    {isRemote && <span className={s.remoteBadge}>Remote</span>}
                    {isIntern && <span className={s.internBadge}>Co-op/Intern</span>}
                    {job.easy_apply && <span className={s.easyApplyBadge}>{'\u26a1'} Easy Apply</span>}
                    {isPromoted && <span className={s.promotedBadge}>Promoted</span>}
                  </div>
                  <div className={s.cardTitle}>{job.job_title}</div>
                  <div className={s.cardCompany}>{job.company}</div>
                  <div className={s.cardLocation}>
                    <>{'\ud83d\udccd'} <span className={s.location}>{normaliseLocation(job.location) ?? '\u2014'}</span></>
                  </div>
                  {job.website === 'linkedin' && job.post_datetime && (
                    <div className={s.dateRow}>
                      <span className={s.dateLabel}>
                        {linkedInIsPromoted(job)
                          ? <>Originally posted: {formatDateOnly(job.post_datetime)}</>
                          : <>Posted: {formatDateOnly(job.post_datetime)}</>}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
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
