import { useEffect, useState, useCallback, Fragment } from 'react'
import { api } from '../api'
import PageTitle from '../components/PageTitle'
import Spinner from '../components/Spinner'
import { buildGlassdoorPreviewUrl } from '../utils/glassdoorUrl'
import s from './ConfigPage.module.css'

const GLASSDOOR_DEFAULT = {
  keyword: '',
  location: '',
  country_code: 'IN3',
  fromAge: 1,
  remoteWorkType: null,
  minSalary: null,
  maxSalary: null,
  minRating: null,
  jobType: null,
  seniorityType: null,
}

const DEFAULTS = {
  website: 'linkedin',
  indeed_keyword: '',
  indeed_location: '',
  indeed_fromage: 1,
  indeed_remotejob: false,
  indeed_jt: '',
  indeed_explvl: '',
  indeed_lang: '',
  keyword: '',
  location: '',
  f_tpr_bound: 48,
  f_experience: '',
  f_job_type: '',
  f_remote: '',
  salary_min: 0,
  scan_delay: 'normal',
  general_date_posted: 1,
  general_internship_only: false,
  general_remote_only: false,
  linkedin_f_tpr: '',
  glassdoor: { ...GLASSDOOR_DEFAULT },
}

const TAB_IDS = /** @type {const} */ (['general', 'linkedin', 'indeed', 'glassdoor'])

function parseCsv(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function toggleCsvField(current, val, checked) {
  const set = new Set(parseCsv(current))
  if (checked) set.add(val)
  else set.delete(val)
  return [...set].sort().join(',')
}

function nullToEmpty(v) {
  return v == null ? '' : String(v)
}

function emptyToNull(v) {
  return v === '' ? null : v
}

function toSlug(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '-')
}

/**
 * Pure preview URLs from current form state (same shape as `config`).
 * @param {typeof DEFAULTS & Record<string, unknown>} config
 * @returns {{ linkedin: string, indeed: string, glassdoor: string }}
 */
function buildPreviewUrls(config) {
  const li = new URLSearchParams()
  li.set('keywords', config.keyword ?? '')
  li.set('location', config.location ?? '')
  const fTprHours = parseInt(String(config.linkedin_f_tpr ?? ''), 10)
  const fTprBound = parseInt(String(config.f_tpr_bound), 10) || 0
  if (!Number.isNaN(fTprHours) && fTprHours > 0) {
    li.set('f_TPR', `r${fTprHours * 3600}`)
  } else if (fTprBound > 0) {
    li.set('f_TPR', `r${fTprBound * 3600}`)
  }
  const fE = String(config.f_experience ?? '').trim()
  if (fE) li.set('f_E', fE)
  const fJt = String(config.f_job_type ?? '').trim()
  if (fJt) li.set('f_JT', fJt)
  const fWt = String(config.f_remote ?? '').trim()
  if (fWt) li.set('f_WT', fWt)
  const linkedin = `https://www.linkedin.com/jobs/search?${li.toString()}`

  const iq = new URLSearchParams()
  const q = String(config.indeed_keyword ?? '').trim() || String(config.keyword ?? '')
  const l = String(config.indeed_location ?? '').trim() || String(config.location ?? '')
  iq.set('q', q)
  iq.set('l', l)
  iq.set('sort', 'relevance')
  const fromage =
    parseInt(String(config.general_date_posted ?? config.indeed_fromage), 10) || 1
  if (fromage > 0) iq.set('fromage', String(fromage))
  if (config.indeed_remotejob === true || config.general_remote_only === true) {
    iq.set('remotejob', '1')
  }
  const ij = config.general_internship_only
    ? 'internship'
    : String(config.indeed_jt ?? '').trim()
  if (ij) iq.set('jt', ij)
  const ex = String(config.indeed_explvl ?? '').trim()
  if (ex) iq.set('explvl', ex)
  const lang = String(config.indeed_lang ?? '').trim()
  if (lang) iq.set('lang', lang)
  const indeed = `https://ca.indeed.com/jobs?${iq.toString()}`

  const gPreview = {
    ...config.glassdoor,
    keyword: config.glassdoor.keyword || config.keyword,
    location: config.glassdoor.location || config.location,
    fromAge:
      parseInt(String(config.general_date_posted ?? config.glassdoor.fromAge), 10) || 1,
  }
  const glassdoor = buildGlassdoorPreviewUrl(gPreview) || ''

  return { linkedin, indeed, glassdoor }
}

export default function ConfigPage() {
  const [config, setConfig] = useState(DEFAULTS)
  const [activeTab, setActiveTab] = useState(/** @type {typeof TAB_IDS[number]} */ ('general'))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [previewUrls, setPreviewUrls] = useState(
    /** @type {{ linkedin: string, indeed: string, glassdoor: string } | null} */ (null)
  )

  useEffect(() => {
    if (loading) return
    setPreviewUrls(buildPreviewUrls(config))
  }, [config, loading])

  useEffect(() => {
    api.getConfig()
      .then(data => {
        const g = data.glassdoor && typeof data.glassdoor === 'object' ? data.glassdoor : {}
        const next = {
          website: data.website || 'linkedin',
          indeed_keyword: nullToEmpty(data.indeed_keyword),
          indeed_location: nullToEmpty(data.indeed_location),
          indeed_fromage: data.indeed_fromage ?? 1,
          indeed_remotejob: data.indeed_remotejob === true,
          indeed_jt: nullToEmpty(data.indeed_jt),
          indeed_explvl: nullToEmpty(data.indeed_explvl),
          indeed_lang: nullToEmpty(data.indeed_lang),
          keyword: nullToEmpty(data.keyword),
          location: nullToEmpty(data.location),
          f_tpr_bound: data.f_tpr_bound ?? 48,
          f_experience: nullToEmpty(data.f_experience),
          f_job_type: nullToEmpty(data.f_job_type),
          f_remote: nullToEmpty(data.f_remote),
          salary_min: data.salary_min ?? 0,
          scan_delay: data.scan_delay || 'normal',
          general_date_posted: data.general_date_posted ?? 1,
          general_internship_only: data.general_internship_only === true,
          general_remote_only: data.general_remote_only === true,
          linkedin_f_tpr: nullToEmpty(data.linkedin_f_tpr),
          glassdoor: {
            ...GLASSDOOR_DEFAULT,
            keyword: nullToEmpty(g.keyword),
            location: nullToEmpty(g.location),
            country_code: g.country_code || 'IN3',
            fromAge: g.fromAge != null ? g.fromAge : 1,
            remoteWorkType: g.remoteWorkType === 1 ? 1 : null,
            minSalary: g.minSalary != null ? g.minSalary : null,
            maxSalary: g.maxSalary != null ? g.maxSalary : null,
            minRating: g.minRating != null ? g.minRating : null,
            jobType: g.jobType != null ? g.jobType : null,
            seniorityType: g.seniorityType != null ? g.seniorityType : null,
          },
        }
        setConfig(next)
      })
      .catch(() => setError('Failed to load config — is the backend running?'))
      .finally(() => setLoading(false))
  }, [])

  const set = useCallback((field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }))
  }, [])

  const setGlassdoor = useCallback((patch) => {
    setConfig(prev => ({
      ...prev,
      glassdoor: { ...prev.glassdoor, ...patch },
    }))
  }, [])

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const g = config.glassdoor
      const maxSalRaw = g.maxSalary
      const maxSal =
        maxSalRaw === '' || maxSalRaw == null
          ? null
          : parseInt(String(maxSalRaw), 10) || null

      const f_experience_final = config.general_internship_only
        ? '1'
        : emptyToNull(config.f_experience)

      const indeed_keyword_final =
        emptyToNull(config.indeed_keyword) ?? emptyToNull(config.keyword)
      const indeed_location_final =
        emptyToNull(config.indeed_location) ?? emptyToNull(config.location)
      const indeed_fromage_final =
        parseInt(String(config.general_date_posted ?? config.indeed_fromage), 10) || 1
      const indeed_remotejob_final = config.general_remote_only
        ? true
        : config.indeed_remotejob
          ? true
          : null
      const indeed_jt_final = config.general_internship_only
        ? 'internship'
        : emptyToNull(config.indeed_jt)

      const gd_keyword_final = g.keyword || config.keyword || 'software engineer'
      const gd_location_final = g.location || config.location || 'Canada'
      const gd_location_slug_final = toSlug(gd_location_final)
      const gd_keyword_slug_final = toSlug(gd_keyword_final)
      const gd_fromAge_final =
        config.general_date_posted != null
          ? Number(config.general_date_posted)
          : g.fromAge == null
            ? null
            : Number(g.fromAge)
      const gd_remoteWorkType_final = config.general_remote_only
        ? 1
        : g.remoteWorkType === 1
          ? 1
          : null
      const gd_seniorityType_final = config.general_internship_only
        ? 'internship'
        : g.seniorityType === '' || g.seniorityType == null
          ? null
          : g.seniorityType

      await api.updateConfig({
        website: config.website,
        general_date_posted: config.general_date_posted ?? 1,
        general_internship_only: config.general_internship_only === true,
        general_remote_only: config.general_remote_only === true,
        linkedin_f_tpr: emptyToNull(config.linkedin_f_tpr),
        indeed_keyword: indeed_keyword_final,
        indeed_location: indeed_location_final,
        indeed_fromage: indeed_fromage_final,
        indeed_remotejob: indeed_remotejob_final,
        indeed_jt: indeed_jt_final,
        indeed_sort: 'relevance',
        indeed_radius: null,
        indeed_explvl: emptyToNull(config.indeed_explvl),
        indeed_lang: emptyToNull(config.indeed_lang),
        keyword: config.keyword,
        location: config.location,
        f_tpr_bound: parseInt(config.f_tpr_bound, 10) || 0,
        f_experience: f_experience_final,
        f_job_type: emptyToNull(config.f_job_type),
        f_remote: emptyToNull(config.f_remote),
        salary_min: parseInt(config.salary_min, 10) || 0,
        scan_delay: config.scan_delay,
        glassdoor: {
          keyword: gd_keyword_final,
          location: gd_location_final,
          location_slug: gd_location_slug_final,
          keyword_slug: gd_keyword_slug_final,
          country_code: g.country_code || 'IN3',
          fromAge: gd_fromAge_final,
          applicationType: null,
          remoteWorkType: gd_remoteWorkType_final,
          minSalary: null,
          maxSalary: maxSal,
          minRating:
            g.minRating === '' || g.minRating == null ? null : Number(g.minRating),
          jobType: g.jobType === '' || g.jobType == null ? null : g.jobType,
          seniorityType: gd_seniorityType_final,
          sortBy: 'date_desc',
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  const copyUrl = (url) => {
    navigator.clipboard.writeText(url).catch(() => {})
  }

  const openTest = (url) => {
    const sep = url.includes('?') ? '&' : '?'
    window.open(url + sep + 'jha_preview=1', '_blank', 'noopener,noreferrer')
  }

  return (
    <div>
      <PageTitle>Search Config</PageTitle>

      <div className={s.card}>
        {loading ? (
          <div className={s.spinnerWrap}><Spinner /></div>
        ) : error && !config.keyword ? (
          <div className={s.error}>{error}</div>
        ) : (
          <>
            {error && <div className={s.error}>{error}</div>}

            <form className={s.form} onSubmit={handleSave}>
              <div className={s.tabs} role="tablist">
                {TAB_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === id}
                    className={`${s.tab} ${activeTab === id ? s.tabActive : ''}`}
                    onClick={() => setActiveTab(id)}
                  >
                    {id === 'general' && 'General'}
                    {id === 'linkedin' && 'LinkedIn'}
                    {id === 'indeed' && 'Indeed'}
                    {id === 'glassdoor' && 'Glassdoor'}
                  </button>
                ))}
              </div>

              {activeTab === 'general' && (
                <Fragment>
                  <div className={s.field}>
                    <label className={s.label}>
                      Keyword <span style={{ color: 'red' }}>*</span>
                    </label>
                    <input
                      className={s.input}
                      value={config.keyword}
                      onChange={e => set('keyword', e.target.value)}
                      placeholder="e.g. software engineer"
                      required
                    />
                  </div>
                  <div className={s.field}>
                    <label className={s.label}>
                      Location <span style={{ color: 'red' }}>*</span>
                    </label>
                    <input
                      className={s.input}
                      value={config.location}
                      onChange={e => set('location', e.target.value)}
                      placeholder="e.g. Canada"
                      required
                    />
                  </div>
                  <div className={s.field}>
                    <label className={s.label}>Minimum salary (annual)</label>
                    <input
                      className={s.input}
                      type="number"
                      min={0}
                      value={config.salary_min}
                      onChange={e => set('salary_min', e.target.value)}
                      placeholder="0 = no filter"
                    />
                    <span className={s.hint}>
                      Annual salary in dollars (e.g. 80000). Use commas for readability.
                    </span>
                  </div>
                  <div className={s.field}>
                    <label className={s.label}>Date posted (days ago)</label>
                    <input
                      className={s.input}
                      type="number"
                      min={1}
                      max={30}
                      value={config.general_date_posted ?? 1}
                      onChange={e => set('general_date_posted', parseInt(e.target.value, 10) || 1)}
                      placeholder="1"
                    />
                    <span className={s.hint}>
                      Propagates to Indeed and Glassdoor date lookback on save
                    </span>
                  </div>
                  <div className={s.field}>
                    <label className={s.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={config.general_internship_only === true}
                        onChange={e => {
                          const checked = e.target.checked
                          set('general_internship_only', checked)
                          if (checked) set('f_experience', '1')
                        }}
                      />
                      Internship only
                    </label>
                  </div>
                  <div className={s.field}>
                    <label className={s.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={config.general_remote_only === true}
                        onChange={e => set('general_remote_only', e.target.checked)}
                      />
                      Remote only
                    </label>
                  </div>
                </Fragment>
              )}

              {activeTab === 'linkedin' && (
                <Fragment>
                  <div className={s.field}>
                    <label className={s.label}>Time posted (hours ago, f_TPR)</label>
                    <input
                      className={s.input}
                      type="number"
                      min={1}
                      value={config.linkedin_f_tpr === '' ? '' : String(config.linkedin_f_tpr)}
                      onChange={e => {
                        const v = e.target.value
                        set('linkedin_f_tpr', v === '' ? '' : String(parseInt(v, 10) || 1))
                      }}
                      placeholder="blank = use time lookback bound"
                    />
                  </div>
                  {(() => {
                    const fTprActive = config.linkedin_f_tpr !== '' && config.linkedin_f_tpr != null
                    return (
                      <div className={s.field}>
                        <label
                          className={s.label}
                          style={{ opacity: fTprActive ? 0.4 : 1 }}
                        >
                          Time lookback bound (hours, f_tpr_bound)
                        </label>
                        <input
                          className={s.input}
                          type="number"
                          min={0}
                          max={720}
                          value={config.f_tpr_bound}
                          onChange={e => set('f_tpr_bound', e.target.value)}
                          disabled={fTprActive}
                          style={{ opacity: fTprActive ? 0.4 : 1 }}
                        />
                        <span className={s.hint} style={{ opacity: fTprActive ? 0.4 : 1 }}>
                          {fTprActive
                            ? 'Disabled — Time posted (f_TPR) is set'
                            : 'Used when Time posted (f_TPR) is blank — drives rolling f_TPR from last run'}
                        </span>
                      </div>
                    )
                  })()}
                  <div className={s.field}>
                    <span className={s.label}>Experience level (f_E)</span>
                    <div className={s.checkboxGrid}>
                      {[
                        ['1', 'Internship'],
                        ['2', 'Entry'],
                        ['3', 'Associate'],
                        ['4', 'Mid-Senior'],
                        ['5', 'Director'],
                        ['6', 'Executive'],
                      ].map(([v, label]) => (
                        <label key={v} className={s.checkboxLabel}>
                          <input
                            type="checkbox"
                            checked={parseCsv(config.f_experience).includes(v)}
                            onChange={e =>
                              set(
                                'f_experience',
                                toggleCsvField(config.f_experience, v, e.target.checked)
                              )}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className={s.field}>
                    <span className={s.label}>Remote type (f_WT)</span>
                    <div className={s.checkboxGrid}>
                      {[
                        ['1', 'On-site'],
                        ['2', 'Remote'],
                        ['3', 'Hybrid'],
                      ].map(([v, label]) => (
                        <label key={v} className={s.checkboxLabel}>
                          <input
                            type="checkbox"
                            checked={parseCsv(config.f_remote).includes(v)}
                            onChange={e =>
                              set(
                                'f_remote',
                                toggleCsvField(config.f_remote, v, e.target.checked)
                              )}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className={s.field}>
                    <span className={s.label}>Job type (f_JT)</span>
                    <div className={s.checkboxGrid}>
                      {[
                        ['F', 'Full-time'],
                        ['P', 'Part-time'],
                        ['C', 'Contract'],
                        ['T', 'Temporary'],
                        ['V', 'Volunteer'],
                        ['I', 'Internship'],
                      ].map(([v, label]) => (
                        <label key={v} className={s.checkboxLabel}>
                          <input
                            type="checkbox"
                            checked={parseCsv(config.f_job_type).includes(v)}
                            onChange={e =>
                              set(
                                'f_job_type',
                                toggleCsvField(config.f_job_type, v, e.target.checked)
                              )}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  {previewUrls && (
                    <div className={s.previewSection}>
                      <div className={s.previewTitle}>Search URL preview (LinkedIn)</div>
                      <div className={s.previewCards}>
                        <div className={s.previewCard}>
                          <div className={s.previewSite}>🔵 LinkedIn</div>
                          <div className={s.previewUrlRow}>
                            <div className={s.previewUrl} title={previewUrls.linkedin}>
                              {previewUrls.linkedin}
                            </div>
                            <button
                              type="button"
                              className={s.previewBtn}
                              title="Copy URL"
                              aria-label="Copy LinkedIn URL"
                              onClick={() => copyUrl(previewUrls.linkedin)}
                            >
                              📋
                            </button>
                          </div>
                          <div className={s.previewActions}>
                            <button
                              type="button"
                              className={s.previewBtn}
                              onClick={() => openTest(previewUrls.linkedin)}
                            >
                              Test ↗
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </Fragment>
              )}

              {activeTab === 'indeed' && (
                <Fragment>
                    <div className={s.field}>
                      <label className={s.label}>Date posted (days ago)</label>
                      <input
                        className={s.input}
                        type="number"
                        min={1}
                        max={30}
                        value={config.indeed_fromage}
                        onChange={e => set('indeed_fromage', parseInt(e.target.value, 10) || 1)}
                        placeholder="1"
                      />
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Job type</label>
                      <select
                        className={s.select}
                        value={config.indeed_jt}
                        onChange={e => set('indeed_jt', e.target.value)}
                      >
                        <option value="">Any</option>
                        <option value="fulltime">fulltime</option>
                        <option value="parttime">parttime</option>
                        <option value="contract">contract</option>
                        <option value="internship">internship</option>
                        <option value="temporary">temporary</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Experience level</label>
                      <select
                        className={s.select}
                        value={config.indeed_explvl}
                        onChange={e => set('indeed_explvl', e.target.value)}
                      >
                        <option value="">Any</option>
                        <option value="ENTRY_LEVEL">ENTRY_LEVEL</option>
                        <option value="MID_LEVEL">MID_LEVEL</option>
                        <option value="SENIOR_LEVEL">SENIOR_LEVEL</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Language</label>
                      <select
                        className={s.select}
                        value={config.indeed_lang}
                        onChange={e => set('indeed_lang', e.target.value)}
                      >
                        <option value="">Any</option>
                        <option value="en">English</option>
                        <option value="fr">French</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={config.indeed_remotejob}
                          onChange={e =>
                            set('indeed_remotejob', e.target.checked)}
                        />
                        Remote jobs only
                      </label>
                    </div>
                {previewUrls && (
                  <div className={s.previewSection}>
                    <div className={s.previewTitle}>Search URL preview (Indeed)</div>
                    <div className={s.previewCards}>
                      <div className={s.previewCard}>
                        <div className={s.previewSite}>🟢 Indeed</div>
                        <div className={s.previewUrlRow}>
                          <div className={s.previewUrl} title={previewUrls.indeed}>
                            {previewUrls.indeed}
                          </div>
                          <button
                            type="button"
                            className={s.previewBtn}
                            title="Copy URL"
                            aria-label="Copy Indeed URL"
                            onClick={() => copyUrl(previewUrls.indeed)}
                          >
                            📋
                          </button>
                        </div>
                        <div className={s.previewActions}>
                          <button
                            type="button"
                            className={s.previewBtn}
                            onClick={() => openTest(previewUrls.indeed)}
                          >
                            Test ↗
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                </Fragment>
              )}

              {activeTab === 'glassdoor' && (
                <Fragment>
                    <div className={s.field}>
                      <label className={s.label}>Date posted (days ago)</label>
                      <input
                        className={s.input}
                        type="number"
                        min={1}
                        max={30}
                        value={config.glassdoor.fromAge ?? 1}
                        onChange={e =>
                          setGlassdoor({ fromAge: parseInt(e.target.value, 10) || 1 })}
                        placeholder="1"
                      />
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Job type</label>
                      <select
                        className={s.select}
                        value={config.glassdoor.jobType ?? ''}
                        onChange={e =>
                          setGlassdoor({
                            jobType: e.target.value === '' ? null : e.target.value,
                          })}
                      >
                        <option value="">Any</option>
                        <option value="fulltime">Full-time</option>
                        <option value="contract">Contract</option>
                        <option value="permanent">Permanent</option>
                        <option value="temporary">Temporary</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Seniority</label>
                      <select
                        className={s.select}
                        value={config.glassdoor.seniorityType ?? ''}
                        onChange={e =>
                          setGlassdoor({
                            seniorityType:
                              e.target.value === '' ? null : e.target.value,
                          })}
                      >
                        <option value="">Any</option>
                        <option value="entrylevel">Entry level</option>
                        <option value="midseniorlevel">Mid-senior</option>
                        <option value="director">Director</option>
                        <option value="executive">Executive</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Max salary</label>
                      <input
                        className={s.input}
                        type="number"
                        min={0}
                        value={config.glassdoor.maxSalary ?? ''}
                        onChange={e => {
                          const v = e.target.value
                          setGlassdoor({
                            maxSalary: v === '' ? null : parseInt(v, 10) || 0,
                          })
                        }}
                        placeholder="Blank = no filter"
                      />
                    </div>
                    <div className={s.field}>
                      <label className={s.label}>Min company rating</label>
                      <select
                        className={s.select}
                        value={
                          config.glassdoor.minRating == null
                            ? ''
                            : String(config.glassdoor.minRating)
                        }
                        onChange={e => {
                          const v = e.target.value
                          setGlassdoor({
                            minRating: v === '' ? null : parseFloat(v),
                          })
                        }}
                      >
                        <option value="">Any</option>
                        <option value="4.0">4.0+ ★★★★</option>
                        <option value="3.0">3.0+ ★★★</option>
                        <option value="2.0">2.0+ ★★</option>
                      </select>
                    </div>
                    <div className={s.field}>
                      <label className={s.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={config.glassdoor.remoteWorkType === 1}
                          onChange={e =>
                            setGlassdoor({
                              remoteWorkType: e.target.checked ? 1 : null,
                            })}
                        />
                        Remote only
                      </label>
                    </div>
                {previewUrls && (
                  <div className={s.previewSection}>
                    <div className={s.previewTitle}>Search URL preview (Glassdoor)</div>
                    <div className={s.previewCards}>
                      <div className={s.previewCard}>
                        <div className={s.previewSite}>🟢 Glassdoor</div>
                        <div className={s.previewUrlRow}>
                          <div className={s.previewUrl} title={previewUrls.glassdoor}>
                            {previewUrls.glassdoor || '\u2014'}
                          </div>
                          <button
                            type="button"
                            className={s.previewBtn}
                            title="Copy URL"
                            aria-label="Copy Glassdoor URL"
                            disabled={!previewUrls.glassdoor}
                            onClick={() => previewUrls.glassdoor && copyUrl(previewUrls.glassdoor)}
                          >
                            📋
                          </button>
                        </div>
                        <div className={s.previewActions}>
                          <button
                            type="button"
                            className={s.previewBtn}
                            disabled={!previewUrls.glassdoor}
                            onClick={() => previewUrls.glassdoor && openTest(previewUrls.glassdoor)}
                          >
                            Test ↗
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                </Fragment>
              )}

              <button
                type="submit"
                disabled={saving}
                className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ''}`}
              >
                {saving ? 'Saving...' : saved ? 'Saved \u2713' : 'Save'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
