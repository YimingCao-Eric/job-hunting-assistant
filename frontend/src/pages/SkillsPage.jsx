import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import s from './SkillsPage.module.css'

function StatusBadge({ status }) {
  const key = (status || 'pending').toLowerCase()
  const cls = s[`status${key}`] || s.statuspending
  return <span className={`${s.statusBadge} ${cls}`}>{status}</span>
}

function getActionState(actionInputs, row) {
  const st = actionInputs[row.id] || {}
  return {
    canonical: st.canonical ?? row.suggested_canonical ?? '',
    mergeTarget: st.mergeTarget ?? '',
  }
}

export default function SkillsPage() {
  const [tab, setTab] = useState('all')
  const [stats, setStats] = useState(null)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)
  const [actionInputs, setActionInputs] = useState({})
  const [selected, setSelected] = useState(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [actingId, setActingId] = useState(null)

  const loadStats = useCallback(async () => {
    try {
      const d = await api.getSkillCandidateStats()
      setStats(d)
    } catch {
      /* ignore */
    }
  }, [])

  const loadItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = { sort_by: 'count', limit: 5000, offset: 0 }
      if (tab === 'candidates') {
        params.in_aliases = false
        if (statusFilter !== 'all') params.status = statusFilter
      }
      const data = await api.getSkillCandidates(params)
      setItems(data.items || [])
      setTotal(data.total ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [tab, statusFilter])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  useEffect(() => {
    setExpandedId(null)
    setSelected(new Set())
  }, [tab, statusFilter])

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((r) => String(r.skill_name).toLowerCase().includes(q))
  }, [items, search])

  const setField = (id, field, value) => {
    setActionInputs((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }))
  }

  const onRefreshAliases = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const r = await api.refreshSkillAliases()
      await loadStats()
      await loadItems()
      window.alert(`Updated in_aliases for ${r.updated} row(s).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const reloadAll = async () => {
    await loadStats()
    await loadItems()
  }

  const handleApprove = async (row) => {
    const { canonical } = getActionState(actionInputs, row)
    setActingId(row.id)
    setError(null)
    try {
      await api.approveSkillCandidate(row.id, canonical.trim() || null)
      await reloadAll()
      setExpandedId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setActingId(null)
    }
  }

  const handleMerge = async (row) => {
    const { mergeTarget } = getActionState(actionInputs, row)
    if (!mergeTarget.trim()) {
      setError('Merge target required')
      return
    }
    setActingId(row.id)
    setError(null)
    try {
      await api.mergeSkillCandidate(row.id, mergeTarget.trim())
      await reloadAll()
      setExpandedId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    } finally {
      setActingId(null)
    }
  }

  const handleReject = async (row) => {
    setActingId(row.id)
    setError(null)
    try {
      await api.rejectSkillCandidate(row.id)
      await reloadAll()
      setExpandedId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed')
    } finally {
      setActingId(null)
    }
  }

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulkReject = async () => {
    if (selected.size === 0) return
    setError(null)
    setActingId(-1)
    try {
      for (const id of selected) {
        await api.rejectSkillCandidate(id)
      }
      setSelected(new Set())
      await reloadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk reject failed')
    } finally {
      setActingId(null)
    }
  }

  const showStatusCol = tab === 'all'
  const showAliasCol = tab === 'all'

  return (
    <div>
      <PageTitle>Skills</PageTitle>

      {stats && (
        <div className={s.summaryBar}>
          <span>
            {stats.total_unique_skills} unique skills · {stats.total_in_aliases} in aliases ·{' '}
            {stats.total_unknown} candidates · {stats.pending_review} pending review
          </span>
        </div>
      )}

      {error && <div className={s.error}>{error}</div>}

      <div className={s.tabBar}>
        <button
          type="button"
          className={`${s.tabBtn} ${tab === 'all' ? s.tabBtnActive : ''}`}
          onClick={() => setTab('all')}
        >
          All Skills ({stats?.total_unique_skills ?? '—'})
        </button>
        <button
          type="button"
          className={`${s.tabBtn} ${tab === 'candidates' ? s.tabBtnActive : ''}`}
          onClick={() => setTab('candidates')}
        >
          Candidates ({stats?.total_unknown ?? '—'})
        </button>
      </div>

      <div className={s.toolbar}>
        <input
          type="search"
          className={s.search}
          placeholder="Filter skills…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={s.refreshBtn}
          disabled={refreshing}
          onClick={onRefreshAliases}
        >
          {refreshing ? 'Refreshing…' : 'Re-scan alias flags'}
        </button>
      </div>

      {tab === 'candidates' && (
        <div className={s.pills} style={{ marginBottom: 14 }}>
          {['all', 'pending', 'approved', 'rejected', 'merged'].map((st) => (
            <button
              key={st}
              type="button"
              className={`${s.pill} ${statusFilter === st ? s.pillActive : ''}`}
              onClick={() => setStatusFilter(st)}
            >
              {st.charAt(0).toUpperCase() + st.slice(1)}
            </button>
          ))}
        </div>
      )}

      {tab === 'candidates' && selected.size > 0 && (
        <div className={s.bulkBar}>
          <span>{selected.size} selected</span>
          <button
            type="button"
            className={s.btnReject}
            disabled={actingId !== null}
            onClick={bulkReject}
          >
            Reject all selected
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Spinner />
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                {tab === 'candidates' && <th style={{ width: 36 }} />}
                <th>Skill</th>
                {showAliasCol && <th>In aliases</th>}
                <th>Req</th>
                <th>NTH</th>
                <th>Total</th>
                {showStatusCol && <th>Status</th>}
                {tab === 'candidates' && <th>Suggested</th>}
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((row) => {
                const exp = expandedId === row.id
                const { canonical, mergeTarget } = getActionState(actionInputs, row)
                const canAct = !row.in_aliases && row.status === 'pending'
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={!row.in_aliases ? s.rowClick : ''}
                      onClick={() => {
                        if (!row.in_aliases) setExpandedId(exp ? null : row.id)
                      }}
                    >
                      {tab === 'candidates' && (
                        <td onClick={(e) => e.stopPropagation()}>
                          {canAct ? (
                            <input
                              type="checkbox"
                              className={s.checkbox}
                              checked={selected.has(row.id)}
                              onChange={() => toggleSelect(row.id)}
                            />
                          ) : null}
                        </td>
                      )}
                      <td>{row.skill_name}</td>
                      {showAliasCol && (
                        <td>
                          {row.in_aliases ? (
                            <span className={s.chipYes}>{'\u2713'}</span>
                          ) : (
                            <span className={s.chipNo}>{'\u2717'}</span>
                          )}
                        </td>
                      )}
                      <td>{row.req_count}</td>
                      <td>{row.nth_count}</td>
                      <td>{row.count}</td>
                      {showStatusCol && (
                        <td>{!row.in_aliases ? <StatusBadge status={row.status} /> : '—'}</td>
                      )}
                      {tab === 'candidates' && (
                        <td>{row.suggested_canonical || '—'}</td>
                      )}
                    </tr>
                    {exp && !row.in_aliases && (
                      <tr className={s.expandRow}>
                        <td colSpan={6}>
                          <div className={s.actionGrid} onClick={(e) => e.stopPropagation()}>
                            <div className={s.field}>
                              <label>Suggested canonical</label>
                              <input
                                className={s.input}
                                value={canonical}
                                onChange={(e) => setField(row.id, 'canonical', e.target.value)}
                                placeholder="New canonical name"
                              />
                            </div>
                            <div className={s.field}>
                              <label>Merge into existing</label>
                              <input
                                className={s.input}
                                value={mergeTarget}
                                onChange={(e) => setField(row.id, 'mergeTarget', e.target.value)}
                                placeholder="Existing canonical"
                              />
                            </div>
                            <button
                              type="button"
                              className={s.btnApprove}
                              disabled={actingId !== null || row.status !== 'pending'}
                              onClick={() => handleApprove(row)}
                            >
                              {'\u2713'} Approve new
                            </button>
                            <button
                              type="button"
                              className={s.btnMerge}
                              disabled={actingId !== null || row.status !== 'pending'}
                              onClick={() => handleMerge(row)}
                            >
                              {'\u21a4'} Merge
                            </button>
                            <button
                              type="button"
                              className={s.btnReject}
                              disabled={actingId !== null || row.status !== 'pending'}
                              onClick={() => handleReject(row)}
                            >
                              {'\u2717'} Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filteredItems.length === 0 && (
        <p style={{ color: '#666' }}>No skills for this filter.</p>
      )}

      <p style={{ marginTop: 12, fontSize: 13, color: '#666' }}>
        Showing {filteredItems.length} of {total} loaded · Extract JDs to populate candidates.
      </p>
    </div>
  )
}
