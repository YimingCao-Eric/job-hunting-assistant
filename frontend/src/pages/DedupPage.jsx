import { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import JobCard from '../components/JobCard'
import JobModal from '../components/JobModal'
import DedupSkipBadge from '../components/DedupSkipBadge'
import s from './DedupPage.module.css'
import j from './JobsPage.module.css'

const PER_PAGE = 25

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
    <div className={j.paginationNumbers}>
      {pages.map((p, i) =>
        p === '...'
          ? (
              <span key={`ellipsis-${i}`} className={j.pageEllipsis}>
                …
              </span>
            )
          : (
              <button
                key={p}
                type="button"
                className={`${j.pageBtn} ${p === page ? j.pageBtnActive : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ),
      )}
    </div>
  )
}

export default function DedupPage() {
  const [config, setConfig] = useState(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [resetSuccess, setResetSuccess] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [filter, setFilter] = useState('passed')
  const [totalAll, setTotalAll] = useState(0)
  const [totalPassed, setTotalPassed] = useState(0)
  const [totalRemoved, setTotalRemoved] = useState(0)

  const [jobs, setJobs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [listLoading, setListLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState(null)

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  const refreshCounts = useCallback(async () => {
    const [allRes, passedRes, removedRes] = await Promise.all([
      api.getJobsByDedupStatus('all', { limit: 1, offset: 0 }),
      api.getJobsByDedupStatus('passed', { limit: 1, offset: 0 }),
      api.getJobsByDedupStatus('removed', { limit: 1, offset: 0 }),
    ])
    setTotalAll(allRes.total ?? 0)
    setTotalPassed(passedRes.total ?? 0)
    setTotalRemoved(removedRes.total ?? 0)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const cfg = await api.getConfig()
      setConfig(cfg)
      await refreshCounts()
      setError(null)
    } catch {
      setError('Failed to load dedup data')
    } finally {
      setLoading(false)
    }
  }, [refreshCounts])

  useEffect(() => {
    refresh()
  }, [refresh])

  const fetchJobs = useCallback(async () => {
    setListLoading(true)
    setError(null)
    try {
      const data = await api.getJobsByDedupStatus(filter, {
        limit: PER_PAGE,
        offset: (page - 1) * PER_PAGE,
      })
      setJobs(data.items || [])
      setTotal(data.total ?? 0)
    } catch {
      setError('Failed to load jobs')
    } finally {
      setListLoading(false)
    }
  }, [filter, page])

  useEffect(() => {
    if (loading) return
    fetchJobs()
  }, [loading, fetchJobs])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [page])

  async function handleModeChange(mode) {
    try {
      await api.updateConfig({ dedup_mode: mode })
      setConfig((c) => ({ ...c, dedup_mode: mode }))
    } catch {
      setError('Failed to update dedup mode')
    }
  }

  const dedupBusy = isRunning || isResetting

  async function handleRunDedup() {
    setIsRunning(true)
    setError(null)
    setResetSuccess(null)
    try {
      await api.runDedup()
      await refreshCounts()
      await fetchJobs()
    } catch {
      setError('Dedup run failed')
    } finally {
      setIsRunning(false)
    }
  }

  async function handleConfirmReset() {
    setIsResetting(true)
    setError(null)
    setResetSuccess(null)
    try {
      const res = await api.resetDedup()
      const n = res?.reset_count ?? 0
      setResetSuccess(`Reset complete — ${n} jobs returned to passed`)
      setShowResetDialog(false)
      setFilter('passed')
      setPage(1)
      await refreshCounts()
    } catch {
      setError('Reset failed')
      setShowResetDialog(false)
    } finally {
      setIsResetting(false)
    }
  }

  const mode = config?.dedup_mode ?? 'manual'

  const showSkipBadge = filter === 'removed' || filter === 'all'

  if (loading) {
    return (
      <div>
        <PageTitle>Dedup</PageTitle>
        <div style={{ padding: '40px' }}><Spinner /></div>
      </div>
    )
  }

  return (
    <div>
      <PageTitle>Dedup</PageTitle>
      {error && <div className="error" style={{ color: 'coral', marginBottom: 12 }}>{error}</div>}

      <div className={s.row}>
        <div className={s.titleRow}>
          <div className={s.modeToggle} role="group" aria-label="Dedup mode">
            <button
              type="button"
              className={`${s.modeBtn} ${mode === 'manual' ? s.modeBtnActive : ''}`}
              onClick={() => handleModeChange('manual')}
            >
              Manual
            </button>
            <button
              type="button"
              className={`${s.modeBtn} ${mode === 'sync' ? s.modeBtnActive : ''}`}
              onClick={() => handleModeChange('sync')}
            >
              Sync
            </button>
          </div>
        </div>
      </div>

      {mode === 'manual' && (
        <div className={s.row}>
          <div className={s.dedupActions}>
            <button
              type="button"
              className={s.runBtn}
              onClick={handleRunDedup}
              disabled={dedupBusy}
            >
              {isRunning ? 'Running...' : 'Run Dedup'}
            </button>
            <button
              type="button"
              className={s.resetBtn}
              onClick={() => { setResetSuccess(null); setShowResetDialog(true) }}
              disabled={dedupBusy}
            >
              Reset Dedup
            </button>
          </div>
        </div>
      )}

      {resetSuccess && (
        <p className={s.successMsg} role="status">
          {resetSuccess}
        </p>
      )}

      {showResetDialog && (
        <div
          className={s.dialogOverlay}
          role="presentation"
          onClick={() => !dedupBusy && setShowResetDialog(false)}
        >
          <div
            className={s.dialog}
            role="dialog"
            aria-labelledby="reset-dedup-title"
            aria-modal="true"
            onClick={e => e.stopPropagation()}
          >
            <h2 id="reset-dedup-title" className={s.dialogTitle}>
              Reset Dedup?
            </h2>
            <p className={s.dialogBody}>
              This will clear skip_reason on all {totalRemoved} dedup-removed jobs, returning them to
              the passed set for re-evaluation.
            </p>
            <p className={s.dialogBody}>
              Ingest-time duplicates (url_duplicate, content_duplicate) are not affected.
            </p>
            <div className={s.dialogActions}>
              <button
                type="button"
                className={s.dialogBtnSecondary}
                onClick={() => setShowResetDialog(false)}
                disabled={dedupBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.dialogBtnDanger}
                onClick={handleConfirmReset}
                disabled={dedupBusy}
              >
                {isResetting ? 'Resetting...' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={j.filterBar} style={{ marginTop: 8 }}>
        <div className={j.filterTabs}>
          <button
            type="button"
            className={`${j.filterTab} ${filter === 'all' ? j.filterTabActive : ''}`}
            onClick={() => { setFilter('all'); setPage(1) }}
          >
            All ({totalAll})
          </button>
          <button
            type="button"
            className={`${j.filterTab} ${filter === 'passed' ? j.filterTabActive : ''}`}
            onClick={() => { setFilter('passed'); setPage(1) }}
          >
            Passed ({totalPassed})
          </button>
          <button
            type="button"
            className={`${j.filterTab} ${filter === 'removed' ? j.filterTabActive : ''}`}
            onClick={() => { setFilter('removed'); setPage(1) }}
          >
            Removed ({totalRemoved})
          </button>
        </div>
      </div>

      {listLoading && jobs.length === 0 && !error && (
        <div className={j.spinnerWrap}><Spinner /></div>
      )}

      {!listLoading && !error && jobs.length === 0 && (
        <p style={{ color: '#666' }}>No jobs for this filter.</p>
      )}

      {jobs.length > 0 && (
        <>
          <div className={j.jobGrid}>
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onClick={() => setSelectedJob(job)}
                footer={
                  showSkipBadge && job.skip_reason
                    ? <DedupSkipBadge job={job} />
                    : null
                }
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className={j.pagination}>
              <button
                type="button"
                className={j.pageBtn}
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Prev
              </button>
              <PageNumbers page={page} totalPages={totalPages} onPageChange={setPage} />
              <button
                type="button"
                className={j.pageBtn}
                disabled={page === totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
          <div className={j.paginationMeta}>
            Page {page} of {totalPages} · {total} jobs
          </div>
        </>
      )}

      {selectedJob && (
        <JobModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  )
}
