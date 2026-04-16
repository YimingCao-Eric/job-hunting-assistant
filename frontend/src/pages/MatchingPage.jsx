import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import JobCard from '../components/JobCard'
import JobModal from '../components/JobModal'
import DedupSkipBadge from '../components/DedupSkipBadge'
import MatchBadge from '../components/MatchBadge'
import MatchSkipBadge from '../components/MatchSkipBadge'
import s from './MatchingPage.module.css'
import j from './JobsPage.module.css'

const PER_PAGE = 25

const INITIAL_REPORT_FORM = {
  report_type: 'match_level',
  suggested_level: '',
  actual_yoe: '',
  missing_skills: '',
  gate_name: '',
  note: '',
}

const GATE_REASONS = [
  'language',
  'yoe_gate',
  'salary_gate',
  'education_gate',
  'visa_gate',
  'extraction_failed',
  'scoring_failed',
]

const LLM_GATE_REASONS = ['education_gate', 'visa_gate']

const BLACKLIST_REASONS = [
  'blacklisted_company',
  'blacklisted_location',
  'title_blacklisted',
  'job_type',
  'agency',
  'remote',
  'contract',
  'sponsorship',
  'dismissed',
]

function reasonLabel(reason) {
  const map = {
    language: 'Language',
    yoe_gate: 'YOE',
    salary_gate: 'Salary',
    education_gate: 'Education',
    visa_gate: 'Visa',
    extraction_failed: 'Extract failed',
    scoring_failed: 'Score failed',
  }
  return map[reason] || reason
}

function blacklistReasonLabel(r) {
  const map = {
    blacklisted_company: 'Company blocklist',
    blacklisted_location: 'Location blocklist',
    title_blacklisted: 'Title blocklist',
    job_type: 'Job type',
    agency: 'Agency',
    remote: 'Remote',
    contract: 'Contract',
    sponsorship: 'Sponsorship',
    dismissed: 'Dismissed',
  }
  return map[r] || r
}

function levelLabel(level) {
  const map = {
    strong_match: 'Strong',
    possible_match: 'Possible',
    stretch_match: 'Stretch',
    weak_match: 'Weak',
  }
  return map[level] || level
}

async function waitForMatchReportCountAbove(
  previousCount,
  { timeoutMs = 300_000, intervalMs = 3000, onLogLine = null } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const [reports, logs] = await Promise.all([
      api.getMatchReports(),
      onLogLine ? api.getMatchLogs().catch(() => null) : Promise.resolve(null),
    ])
    const n = Array.isArray(reports) ? reports.length : 0
    if (onLogLine) {
      const lines = logs?.lines || []
      const lastLine = lines[lines.length - 1] || ''
      const trimmed = lastLine.replace(
        /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d+\s+/,
        '',
      ).slice(0, 120)
      onLogLine(trimmed)
    }
    if (n > previousCount) return
  }
  throw new Error('Matching run timed out after 5 minutes')
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

function buildMatchFooter(job, mainFilter) {
  if (mainFilter === 'removed' || mainFilter === 'all') {
    if (job.skip_reason) return <DedupSkipBadge job={job} />
    if (job.dismissed) {
      return <span style={{ fontSize: 13, color: '#666' }}>Dismissed by you</span>
    }
    if (job.match_skip_reason && !job.match_level) {
      return <MatchSkipBadge reason={job.match_skip_reason} job={job} />
    }
    return null
  }
  if (job.match_skip_reason && !job.match_level) {
    return <MatchSkipBadge reason={job.match_skip_reason} job={job} />
  }
  if (job.match_level) {
    return <MatchBadge job={job} />
  }
  return null
}

function undoConfirmMessage(button, pipelineState) {
  if (button === 'button1') {
    return 'This will clear all pipeline results — dedup, blacklist, extraction, gates, and scores. All jobs return to unprocessed state. Continue?'
  }
  if (button === 'button2') {
    return 'This will clear LLM extraction results, LLM gate decisions, and CPU scores. CPU extraction data is preserved. Continue?'
  }
  if (button === 'button3') {
    return pipelineState?.button4Done
      ? 'This will clear LLM scores and CPU scores for all jobs. Continue?'
      : 'This will clear CPU scores for all jobs. Extraction and gate results are preserved. Continue?'
  }
  if (button === 'button4') {
    return 'This will clear all LLM scoring results. Jobs return to their CPU-scored state (stretch/weak). Continue?'
  }
  return ''
}

export default function MatchingPage() {
  const [config, setConfig] = useState(null)
  const [pipelineState, setPipelineState] = useState({
    button1Done: false,
    button2Done: false,
    button3Done: false,
    button4Done: false,
  })

  const [mainFilter, setMainFilter] = useState('passed')
  const [subFilter, setSubFilter] = useState('all')
  const [dupSubFilter, setDupSubFilter] = useState('all')
  const [blacklistSubFilter, setBlacklistSubFilter] = useState('all')
  const [matchLevelFilter, setMatchLevelFilter] = useState(null)

  const [passedTotal, setPassedTotal] = useState(0)
  const [removedTotal, setRemovedTotal] = useState(0)
  const [unscoredTotal, setUnscoredTotal] = useState(0)
  const [scoredTotal, setScoredTotal] = useState(0)
  const [duplicatesTotal, setDuplicatesTotal] = useState(0)
  const [blacklistTotal, setBlacklistTotal] = useState(0)
  const [reasonCounts, setReasonCounts] = useState({})
  const [blacklistReasonCounts, setBlacklistReasonCounts] = useState({})
  const [levelCounts, setLevelCounts] = useState({})

  const [jobs, setJobs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(true)
  const [error, setError] = useState(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [confirmDismiss, setConfirmDismiss] = useState(null)
  const [confirmUndismiss, setConfirmUndismiss] = useState(null)
  const [confirmUndo, setConfirmUndo] = useState(null)
  const [confirmReport, setConfirmReport] = useState(null)
  const [reportForm, setReportForm] = useState(() => ({ ...INITIAL_REPORT_FORM }))
  const [reportSubmitting, setReportSubmitting] = useState(false)

  const [running, setRunning] = useState(null)
  const [undoing, setUndoing] = useState(null)
  const [runElapsedSec, setRunElapsedSec] = useState(0)
  const [latestLogLine, setLatestLogLine] = useState('')
  const elapsedTimerRef = useRef(null)

  const [selectedJob, setSelectedJob] = useState(null)

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  const detectPipelineState = useCallback(async () => {
    try {
      const [anyRemoved, extracted, llmRes, scoredRes, stepDRes] = await Promise.all([
        api.getJobs({ dedup_status: 'removed', limit: 1, offset: 0 }),
        api.getMatchExtractedCount().catch(() => ({ count: 0 })),
        api.getJobs({ matching_mode: 'llm', limit: 1, offset: 0 }).catch(() => ({ total: 0 })),
        api.getJobs({
          dedup_status: 'passed',
          match_status: 'scored',
          limit: 1,
          offset: 0,
        }),
        api.getJobs({
          dedup_status: 'passed',
          match_status: 'scored',
          llm_step_d: true,
          limit: 1,
          offset: 0,
        }).catch(() => ({ total: 0 })),
      ])
      const button4Done = (stepDRes.total ?? 0) > 0
      setPipelineState({
        button1Done:
          (anyRemoved.total ?? 0) > 0 || (extracted.count ?? 0) > 0,
        button2Done: (llmRes.total ?? 0) > 0,
        button3Done: (scoredRes.total ?? 0) > 0,
        button4Done,
      })
    } catch (e) {
      console.error('detectPipelineState', e)
    }
  }, [])

  const loadTotals = useCallback(async () => {
    try {
      const [
        passedRes,
        removedRes,
        unscoredRes,
        scoredRes,
        dupRes,
        blRes,
      ] = await Promise.all([
        api.getJobs({ dedup_status: 'passed', limit: 1, offset: 0 }),
        api.getJobs({ dedup_status: 'removed', limit: 1, offset: 0 }),
        api.getJobs({ dedup_status: 'passed', match_status: 'unscored', limit: 1, offset: 0 }),
        api.getJobs({ dedup_status: 'passed', match_status: 'scored', limit: 1, offset: 0 }),
        api.getJobs({
          dedup_status: 'removed',
          skip_reason_filter: 'already_scraped',
          limit: 1,
          offset: 0,
        }),
        api.getJobs({ dedup_status: 'removed', blacklist_filter: true, limit: 1, offset: 0 }),
      ])

      const gateSlice = await Promise.all(
        GATE_REASONS.map((reason) =>
          api.getJobs({
            dedup_status: 'removed',
            match_skip_reason_filter: reason,
            limit: 1,
            offset: 0,
          }).then((d) => [reason, d.total ?? 0])
        ),
      )

      const blSlice = await Promise.all(
        BLACKLIST_REASONS.map((r) =>
          api.getJobs({
            dedup_status: 'removed',
            blacklist_reason: r,
            limit: 1,
            offset: 0,
          }).then((d) => [r, d.total ?? 0])
        ),
      )

      setPassedTotal(passedRes.total ?? 0)
      setRemovedTotal(removedRes.total ?? 0)
      setUnscoredTotal(unscoredRes.total ?? 0)
      setScoredTotal(scoredRes.total ?? 0)
      setDuplicatesTotal(dupRes.total ?? 0)
      setBlacklistTotal(blRes.total ?? 0)

      setReasonCounts(Object.fromEntries(gateSlice))
      setBlacklistReasonCounts(Object.fromEntries(blSlice))

      const levels = ['strong_match', 'possible_match', 'stretch_match', 'weak_match']
      const lcEntries = await Promise.all(
        levels.map((level) =>
          api.getJobs({
            dedup_status: 'passed',
            match_level: level,
            limit: 1,
            offset: 0,
          }).then((d) => [level, d.total ?? 0])
        )
      )
      setLevelCounts(Object.fromEntries(lcEntries))
    } catch (e) {
      console.error('loadTotals', e)
    }
  }, [])

  const loadJobs = useCallback(async () => {
    setListLoading(true)
    setError(null)
    try {
      const params = {
        limit: PER_PAGE,
        offset: (page - 1) * PER_PAGE,
      }

      if (mainFilter === 'passed') {
        params.dedup_status = 'passed'
        if (subFilter === 'unscored') params.match_status = 'unscored'
        if (subFilter === 'scored') {
          params.match_status = 'scored'
          params.order_by = 'fit_score'
        }
        if (matchLevelFilter) params.match_level = matchLevelFilter
      } else if (mainFilter === 'removed') {
        params.dedup_status = 'removed'

        if (subFilter === 'duplicates') {
          params.skip_reason_filter = 'already_scraped'
          if (dupSubFilter === 'hash_exact') params.dedup_type = 'hash_exact'
          if (dupSubFilter === 'cosine') params.dedup_type = 'cosine'
        } else if (subFilter === 'blacklist') {
          if (blacklistSubFilter && blacklistSubFilter !== 'all') {
            if (blacklistSubFilter === 'dismissed') {
              params.blacklist_reason = 'dismissed'
            } else {
              params.blacklist_reason = blacklistSubFilter
            }
          } else {
            params.blacklist_filter = true
          }
        } else if (GATE_REASONS.includes(subFilter)) {
          params.match_skip_reason_filter = subFilter
        }
      }

      const result = await api.getJobs(params)
      setJobs(result.items || [])
      setTotal(result.total ?? 0)
    } catch {
      setError('Failed to load jobs')
    } finally {
      setListLoading(false)
    }
  }, [
    mainFilter,
    subFilter,
    dupSubFilter,
    blacklistSubFilter,
    matchLevelFilter,
    page,
  ])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const cfg = await api.getConfig()
      setConfig(cfg)
      await detectPipelineState()
      await loadTotals()
      setError(null)
    } catch {
      setError('Failed to load matching data')
    } finally {
      setLoading(false)
    }
  }, [detectPipelineState, loadTotals])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (loading) return
    loadJobs()
  }, [loading, loadJobs])

  useEffect(() => {
    const jid = searchParams.get('job')
    if (!jid) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const job = await api.getJob(jid)
        if (!cancelled) setSelectedJob(job)
      } catch {
        /* ignore */
      }
      if (!cancelled) {
        const next = new URLSearchParams(searchParams)
        next.delete('job')
        setSearchParams(next, { replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [page])

  useEffect(() => {
    if (running) {
      setRunElapsedSec(0)
      setLatestLogLine('')
      elapsedTimerRef.current = setInterval(() => {
        setRunElapsedSec((s) => s + 1)
      }, 1000)
    } else {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
      setRunElapsedSec(0)
      setLatestLogLine('')
    }
    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
    }
  }, [running])

  async function handleRun(button) {
    setRunning(button)
    setError(null)
    try {
      if (button === 'button1') {
        await api.runDedup()
        const beforeReports = (await api.getMatchReports()).length
        await api.runMatching({ mode: 'cpu_only' })
        await waitForMatchReportCountAbove(beforeReports)
      } else if (button === 'button2') {
        const beforeReports = (await api.getMatchReports()).length
        await api.runMatching({ mode: 'llm_extraction_gates' })
        await waitForMatchReportCountAbove(beforeReports, {
          onLogLine: (line) => setLatestLogLine(line),
        })
      } else if (button === 'button3') {
        const beforeReports = (await api.getMatchReports()).length
        await api.runMatching({ mode: 'cpu_score' })
        await waitForMatchReportCountAbove(beforeReports)
      } else if (button === 'button4') {
        const beforeReports = (await api.getMatchReports()).length
        await api.runMatching({ mode: 'llm_score' })
        await waitForMatchReportCountAbove(beforeReports, {
          timeoutMs: 300_000,
          onLogLine: (line) => setLatestLogLine(line),
        })
      }
      await detectPipelineState()
      await loadTotals()
      await loadJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(null)
    }
  }

  async function handleUndo(button) {
    setUndoing(button)
    setError(null)
    try {
      if (button === 'button1') await api.undoButton1()
      else if (button === 'button2') await api.undoButton2()
      else if (button === 'button3') {
        if (pipelineState.button4Done) await api.undoButton4()
        await api.undoButton3()
      } else if (button === 'button4') await api.undoButton4()
      await detectPipelineState()
      await loadTotals()
      await loadJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Undo failed')
    } finally {
      setUndoing(null)
      setConfirmUndo(null)
    }
  }

  async function handleDismiss(jobId) {
    try {
      await api.dismissJob(jobId)
      setConfirmDismiss(null)
      await loadTotals()
      await loadJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed')
    }
  }

  async function handleUndismiss(jobId) {
    try {
      await api.undismissJob(jobId)
      setConfirmUndismiss(null)
      await detectPipelineState()
      await loadTotals()
      await loadJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    }
  }

  function resetReportForm() {
    setReportForm({ ...INITIAL_REPORT_FORM })
  }

  async function handleSubmitReport() {
    if (!confirmReport) return
    setReportSubmitting(true)
    try {
      const detail = {}
      if (reportForm.report_type === 'match_level') {
        if (reportForm.suggested_level) detail.suggested_level = reportForm.suggested_level
      } else if (reportForm.report_type === 'yoe') {
        if (reportForm.actual_yoe !== '' && reportForm.actual_yoe != null) {
          const n = parseFloat(String(reportForm.actual_yoe), 10)
          if (!Number.isNaN(n)) detail.actual_yoe = n
        }
      } else if (
        reportForm.report_type === 'missing_skills'
        || reportForm.report_type === 'false_skills'
      ) {
        detail.skills = reportForm.missing_skills.split(',').map((x) => x.trim()).filter(Boolean)
      } else if (reportForm.report_type === 'wrong_gate') {
        if (reportForm.gate_name) detail.gate_name = reportForm.gate_name
      }
      if (reportForm.note.trim()) detail.note = reportForm.note.trim()

      await api.createJobReport(confirmReport.jobId, {
        report_type: reportForm.report_type,
        detail,
      })
      setConfirmReport(null)
      resetReportForm()
      await loadJobs()
    } catch (e) {
      console.error('Report failed:', e)
      setError(e instanceof Error ? e.message : 'Report failed')
    } finally {
      setReportSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageTitle>Matching</PageTitle>
        <div style={{ padding: '40px' }}><Spinner /></div>
      </div>
    )
  }

  return (
    <div>
      <PageTitle>Matching</PageTitle>
      {error && <div className="error" style={{ color: 'coral', marginBottom: 12 }}>{error}</div>}

      <div className={s.buttonBar}>
        <div className={s.buttonGroup}>
          <button
            type="button"
            className={s.runBtn}
            onClick={() => handleRun('button1')}
            disabled={running !== null}
          >
            {running === 'button1' ? 'Running…' : '1. All CPU Work'}
          </button>
          <button
            type="button"
            className={s.undoIconBtn}
            onClick={() => setConfirmUndo('button1')}
            disabled={
              !pipelineState.button1Done || running !== null || undoing !== null
            }
            title="Undo all pipeline work"
          >
            {'\u21ba'}
          </button>
        </div>

        <div className={s.buttonGroup}>
          <button
            type="button"
            className={s.runBtn}
            onClick={() => handleRun('button2')}
            disabled={
              !pipelineState.button1Done
              || !config?.llm
              || running !== null
            }
            title={
              !config?.llm
                ? 'LLM mode is off'
                : !pipelineState.button1Done
                  ? 'Run button 1 first'
                  : ''
            }
          >
            {running === 'button2' ? 'Running…' : '2. LLM Extraction + Gates'}
          </button>
          <button
            type="button"
            className={s.undoIconBtn}
            onClick={() => setConfirmUndo('button2')}
            disabled={
              !pipelineState.button2Done || running !== null || undoing !== null
            }
            title="Undo LLM stage and scores"
          >
            {'\u21ba'}
          </button>
        </div>

        <div className={s.buttonGroup}>
          <button
            type="button"
            className={s.runBtn}
            onClick={() => handleRun('button3')}
            disabled={!pipelineState.button1Done || running !== null}
          >
            {running === 'button3' ? 'Running…' : '3. CPU Score'}
          </button>
          <button
            type="button"
            className={s.undoIconBtn}
            onClick={() => setConfirmUndo('button3')}
            disabled={
              !pipelineState.button3Done || running !== null || undoing !== null
            }
            title="Undo CPU scores"
          >
            {'\u21ba'}
          </button>
        </div>

        <div className={s.buttonGroup}>
          <button
            type="button"
            className={s.runBtn}
            onClick={() => handleRun('button4')}
            disabled={
              !pipelineState.button3Done
              || !(config && config.llm === true)
              || running !== null
            }
            title={
              !(config && config.llm === true)
                ? 'Enable LLM mode in Config first'
                : !pipelineState.button3Done
                  ? 'Run CPU Score first'
                  : ''
            }
          >
            {running === 'button4' ? 'Running…' : '4. LLM Score'}
          </button>
          <button
            type="button"
            className={s.undoIconBtn}
            onClick={() => setConfirmUndo('button4')}
            disabled={
              !pipelineState.button4Done || running !== null || undoing !== null
            }
            title="Undo LLM scoring"
          >
            {'\u21ba'}
          </button>
        </div>
      </div>

      {running && (
        <div className={s.runningStatus} aria-live="polite">
          <div>
            {running === 'button4'
              ? '4. LLM Score'
              : running === 'button2'
                ? '2. LLM Extraction + Gates'
                : running === 'button3'
                  ? '3. CPU Score'
                  : running === 'button1'
                    ? '1. All CPU Work'
                    : 'Pipeline'}
            {' '}
            running…
            {' '}
            {runElapsedSec}
            s
            {runElapsedSec > 10 && (
              <span className={s.runningHint}> — processing in background</span>
            )}
          </div>
          {latestLogLine
            ? (
                <div className={s.logLine} title={latestLogLine}>
                  {latestLogLine}
                </div>
              )
            : null}
        </div>
      )}

      <div className={s.filterBar}>
        <div className={j.filterTabs}>
          <button
            type="button"
            className={`${j.filterTab} ${mainFilter === 'passed' ? j.filterTabActive : ''}`}
            onClick={() => {
              setMainFilter('passed')
              setSubFilter('all')
              setMatchLevelFilter(null)
              setPage(1)
            }}
          >
            Passed (
            {passedTotal}
            )
          </button>
          <button
            type="button"
            className={`${j.filterTab} ${mainFilter === 'removed' ? j.filterTabActive : ''}`}
            onClick={() => {
              setMainFilter('removed')
              setSubFilter('all')
              setDupSubFilter('all')
              setBlacklistSubFilter('all')
              setPage(1)
            }}
          >
            Removed (
            {removedTotal}
            )
          </button>
        </div>

        {mainFilter === 'passed' && (
          <div className={s.subFilters}>
            {['all', 'unscored', 'scored'].map((f) => (
              <button
                key={f}
                type="button"
                className={`${s.subFilter} ${subFilter === f ? s.subFilterActive : ''}`}
                onClick={() => {
                  setSubFilter(f)
                  setMatchLevelFilter(null)
                  setPage(1)
                }}
              >
                {f === 'all'
                  ? `All (${passedTotal})`
                  : f === 'unscored'
                    ? `Unscored (${unscoredTotal})`
                    : `Scored (${scoredTotal})`}
              </button>
            ))}
            {subFilter === 'scored' && pipelineState.button4Done && (
              <div className={s.matchLevelPills}>
                {['strong_match', 'possible_match', 'stretch_match', 'weak_match'].map(
                  (level) => (
                    <button
                      key={level}
                      type="button"
                      className={`${s.levelPill} ${matchLevelFilter === level ? s.levelPillActive : ''}`}
                      onClick={() => {
                        setMatchLevelFilter(matchLevelFilter === level ? null : level)
                        setPage(1)
                      }}
                    >
                      {levelLabel(level)}
                      {' '}
                      (
                      {levelCounts[level] || 0}
                      )
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {mainFilter === 'removed' && (
          <div className={s.subFilters}>
            {['all', 'duplicates', 'blacklist'].map((f) => (
              <button
                key={f}
                type="button"
                className={`${s.subFilter} ${subFilter === f ? s.subFilterActive : ''}`}
                onClick={() => {
                  setSubFilter(f)
                  setDupSubFilter('all')
                  setBlacklistSubFilter('all')
                  setPage(1)
                }}
              >
                {f === 'all'
                  ? `All (${removedTotal})`
                  : f === 'duplicates'
                    ? `Duplicates (${duplicatesTotal})`
                    : `Blacklist (${blacklistTotal})`}
              </button>
            ))}
            {GATE_REASONS.filter((r) => (reasonCounts[r] || 0) > 0).map((reason) => (
              <button
                key={reason}
                type="button"
                className={`${s.subFilter} ${subFilter === reason ? s.subFilterActive : ''}`}
                onClick={() => {
                  setSubFilter(reason)
                  setPage(1)
                }}
              >
                {reasonLabel(reason)}
                {' '}
                (
                {reasonCounts[reason]}
                )
                <span
                  className={
                    LLM_GATE_REASONS.includes(reason)
                      ? s.stageBadgeLLM
                      : s.stageBadgeCPU
                  }
                >
                  {LLM_GATE_REASONS.includes(reason) ? 'LLM' : 'CPU'}
                </span>
              </button>
            ))}

            {subFilter === 'duplicates' && (
              <div className={s.subSubFilters}>
                {['all', 'hash_exact', 'cosine'].map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`${s.subSubFilter} ${dupSubFilter === f ? s.subSubFilterActive : ''}`}
                    onClick={() => {
                      setDupSubFilter(f)
                      setPage(1)
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}

            {subFilter === 'blacklist' && (
              <div className={s.subSubFilters}>
                <button
                  type="button"
                  className={`${s.subSubFilter} ${blacklistSubFilter === 'all' ? s.subSubFilterActive : ''}`}
                  onClick={() => {
                    setBlacklistSubFilter('all')
                    setPage(1)
                  }}
                >
                  All
                </button>
                {BLACKLIST_REASONS.filter((r) => (blacklistReasonCounts[r] || 0) > 0).map(
                  (r) => (
                    <button
                      key={r}
                      type="button"
                      className={`${s.subSubFilter} ${blacklistSubFilter === r ? s.subSubFilterActive : ''}`}
                      onClick={() => {
                        setBlacklistSubFilter(r)
                        setPage(1)
                      }}
                    >
                      {blacklistReasonLabel(r)}
                      {' '}
                      (
                      {blacklistReasonCounts[r]}
                      )
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
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
              <div key={job.id} className={s.cardWrap}>
                {job.skip_reason !== 'already_scraped'
                  && ((mainFilter === 'passed' && job.match_level != null)
                    || mainFilter === 'removed') && (
                  <button
                    type="button"
                    className={`${s.flagBtn} ${job.has_report ? s.flagBtnActive : ''} ${
                      !(mainFilter === 'passed' && job.match_level != null)
                        ? s.flagBtnSolo
                        : ''
                    }`}
                    title={job.has_report ? 'Report submitted' : 'Report an issue'}
                    onClick={(e) => {
                      e.stopPropagation()
                      const matchLevel = job.match_level
                      const isRemoved = mainFilter === 'removed'
                      const canWrongGate = isRemoved
                        && (job.match_skip_reason != null || job.removal_stage != null)
                      const defaultType = matchLevel
                        ? 'match_level'
                        : canWrongGate
                          ? 'wrong_gate'
                          : 'yoe'
                      setReportForm({
                        ...INITIAL_REPORT_FORM,
                        report_type: defaultType,
                      })
                      setConfirmReport({
                        jobId: job.id,
                        jobTitle: job.job_title,
                        isRemoved,
                        matchLevel,
                        matchSkipReason: job.match_skip_reason,
                        removalStage: job.removal_stage,
                      })
                    }}
                  >
                    {'\u2691'}
                  </button>
                )}
                {mainFilter === 'passed' && job.match_level != null && (
                  <button
                    type="button"
                    className={s.dismissBtn}
                    title="Dismiss this job"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDismiss(job.id)
                    }}
                  >
                    ×
                  </button>
                )}
                {mainFilter === 'removed'
                  && job.dismissed
                  && subFilter === 'blacklist'
                  && blacklistSubFilter === 'dismissed' && (
                  <button
                    type="button"
                    className={s.restoreBtn}
                    title="Restore job"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmUndismiss(job.id)
                    }}
                  >
                    Restore
                  </button>
                )}
                {mainFilter === 'removed' && job.removal_stage && (
                  <span
                    className={
                      job.removal_stage === 'llm_extraction'
                        ? s.stageCornerLLM
                        : s.stageCornerCPU
                    }
                  >
                    {job.removal_stage === 'llm_extraction' ? 'LLM' : 'CPU'}
                  </span>
                )}
                <JobCard
                  job={job}
                  onClick={() => setSelectedJob(job)}
                  footer={buildMatchFooter(job, mainFilter)}
                />
              </div>
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
            Page            {' '}
            {page}
            {' '}
            of
            {' '}
            {totalPages}
            {' '}
            ·
            {' '}
            {total}
            {' '}
            jobs
          </div>
        </>
      )}

      {confirmReport && (
        <div
          className={s.dialogOverlay}
          role="presentation"
          onClick={() => {
            if (reportSubmitting) return
            setConfirmReport(null)
            resetReportForm()
          }}
        >
          <div
            className={s.reportBox}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={s.reportTitle}>Report an issue</h3>
            <p className={s.reportJobName}>{confirmReport.jobTitle?.slice(0, 50)}</p>

            <div className={s.reportTypes}>
              {[
                ...(confirmReport.matchLevel
                  ? [{ value: 'match_level', label: 'Match level is wrong' }]
                  : []),
                { value: 'yoe', label: 'YOE extracted incorrectly' },
                { value: 'missing_skills', label: 'Missing required skills' },
                { value: 'false_skills', label: 'Skills are wrong / irrelevant' },
                ...(confirmReport.isRemoved
                  && (confirmReport.matchSkipReason != null
                    || confirmReport.removalStage != null)
                  ? [{ value: 'wrong_gate', label: 'Gate failure was wrong' }]
                  : []),
                { value: 'other', label: 'Other' },
              ].map((opt) => (
                <label key={opt.value} className={s.reportTypeLabel}>
                  <input
                    type="radio"
                    name="report_type"
                    value={opt.value}
                    checked={reportForm.report_type === opt.value}
                    onChange={(e) => setReportForm((f) => ({ ...f, report_type: e.target.value }))}
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            {reportForm.report_type === 'match_level' && (
              <select
                className={s.reportSelect}
                value={reportForm.suggested_level}
                onChange={(e) => setReportForm((f) => ({ ...f, suggested_level: e.target.value }))}
              >
                <option value="">Should be... (optional)</option>
                <option value="strong_match">⭐ Strong</option>
                <option value="possible_match">{'\u2713'} Possible</option>
                <option value="stretch_match">~ Stretch</option>
                <option value="weak_match">{'\u2717'} Weak</option>
              </select>
            )}

            {reportForm.report_type === 'yoe' && (
              <input
                type="number"
                className={s.reportInput}
                placeholder="Actual years required (e.g. 2)"
                value={reportForm.actual_yoe}
                onChange={(e) => setReportForm((f) => ({ ...f, actual_yoe: e.target.value }))}
              />
            )}

            {(reportForm.report_type === 'missing_skills'
              || reportForm.report_type === 'false_skills') && (
              <input
                type="text"
                className={s.reportInput}
                placeholder="Skills, comma-separated (e.g. React, Node.js)"
                value={reportForm.missing_skills}
                onChange={(e) => setReportForm((f) => ({ ...f, missing_skills: e.target.value }))}
              />
            )}

            {reportForm.report_type === 'wrong_gate' && (
              <select
                className={s.reportSelect}
                value={reportForm.gate_name}
                onChange={(e) => setReportForm((f) => ({ ...f, gate_name: e.target.value }))}
              >
                <option value="">Which gate? (optional)</option>
                <option value="yoe_gate">YOE gate</option>
                <option value="language">Language gate</option>
                <option value="education_gate">Education gate</option>
                <option value="salary_gate">Salary gate</option>
                <option value="visa_gate">Visa gate</option>
              </select>
            )}

            <textarea
              className={s.reportNote}
              placeholder="Additional notes (optional, max 200 chars)"
              maxLength={200}
              value={reportForm.note}
              onChange={(e) => setReportForm((f) => ({ ...f, note: e.target.value }))}
            />

            <div className={s.reportActions}>
              <button
                type="button"
                className={s.dialogBtnSecondary}
                onClick={() => {
                  setConfirmReport(null)
                  resetReportForm()
                }}
                disabled={reportSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.submitReportBtn}
                onClick={() => handleSubmitReport()}
                disabled={reportSubmitting}
              >
                {reportSubmitting ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDismiss && (
        <div
          className={s.dialogOverlay}
          role="presentation"
          onClick={() => setConfirmDismiss(null)}
        >
          <div
            className={s.dialog}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={s.dialogTitle}>Dismiss job?</h2>
            <p className={s.dialogBody}>
              It will move to Removed → Blacklist → Dismissed.
            </p>
            <div className={s.dialogActions}>
              <button
                type="button"
                className={s.dialogBtnSecondary}
                onClick={() => setConfirmDismiss(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.dialogBtnDanger}
                onClick={() => handleDismiss(confirmDismiss)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmUndismiss && (
        <div
          className={s.dialogOverlay}
          role="presentation"
          onClick={() => setConfirmUndismiss(null)}
        >
          <div
            className={s.dialog}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={s.dialogTitle}>Restore job?</h2>
            <p className={s.dialogBody}>
              All extraction and scoring data will be cleared. The job will return to
              Passed → Unscored for re-processing.
            </p>
            <div className={s.dialogActions}>
              <button
                type="button"
                className={s.dialogBtnSecondary}
                onClick={() => setConfirmUndismiss(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.dialogBtnDanger}
                onClick={() => handleUndismiss(confirmUndismiss)}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmUndo && (
        <div
          className={s.dialogOverlay}
          role="presentation"
          onClick={() => !undoing && setConfirmUndo(null)}
        >
          <div
            className={s.dialog}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={s.dialogTitle}>Confirm undo</h2>
            <p className={s.dialogBody}>{undoConfirmMessage(confirmUndo, pipelineState)}</p>
            <div className={s.dialogActions}>
              <button
                type="button"
                className={s.dialogBtnSecondary}
                onClick={() => setConfirmUndo(null)}
                disabled={undoing !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.dialogBtnDanger}
                onClick={() => handleUndo(confirmUndo)}
                disabled={undoing !== null}
              >
                {undoing ? 'Undoing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedJob && (
        <JobModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  )
}
