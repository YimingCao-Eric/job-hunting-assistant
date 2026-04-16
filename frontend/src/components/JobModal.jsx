import { Fragment, useEffect, useState } from 'react'
import { fitScoreDisplayParts } from '../utils/fitScoreDisplay'
import { normaliseLocation } from '../utils/location'
import { api } from '../api'
import s from '../pages/JobsPage.module.css'

function formatDateOnly(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function linkedInIsPromoted(job) {
  if (job.website !== 'linkedin' || !job.post_datetime || !job.created_at) return false
  const gapDays = Math.floor(
    (new Date(job.created_at) - new Date(job.post_datetime)) / (1000 * 60 * 60 * 24)
  )
  return gapDays > 2
}

const EDU_LABELS = {
  none: 'None required',
  bachelor: "Bachelor's",
  master: "Master's",
  phd: 'PhD',
}

function capitalizeWord(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function normalizeSkills(val) {
  if (!val) return []
  if (Array.isArray(val)) return val.filter(Boolean).map(String)
  if (typeof val === 'object') {
    const out = []
    for (const v of Object.values(val)) {
      if (Array.isArray(v)) out.push(...v.filter(Boolean).map(String))
      else if (v != null && v !== '') out.push(String(v))
    }
    return out
  }
  return []
}

function formatYoe(y) {
  if (y == null || y === '') return ''
  const n = Number(y)
  if (!Number.isFinite(n)) return ''
  const t = Number.isInteger(n) ? String(Math.trunc(n)) : String(n)
  return `${t}+ years`
}

function visaDisplayLabel(raw, needsSponsorship) {
  if (!needsSponsorship || raw == null || raw === '') return null
  const v = String(raw).toLowerCase()
  if (v === 'true') return 'Sponsored'
  if (v === 'false') return 'Not sponsored'
  return 'Unknown'
}

export default function JobModal({ job, onClose }) {
  const [showRawJd, setShowRawJd] = useState(false)
  const [needsSponsorship, setNeedsSponsorship] = useState(false)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!job?.id) return
    setShowRawJd(false)
    let cancelled = false
    ;(async () => {
      try {
        const cfg = await api.getConfig()
        if (!cancelled) setNeedsSponsorship(cfg.needs_sponsorship === true)
      } catch {
        if (!cancelled) setNeedsSponsorship(false)
      }
    })()
    return () => { cancelled = true }
  }, [job?.id])

  const isPromoted = linkedInIsPromoted(job)

  const requiredSkills = normalizeSkills(job.required_skills)
  const niceSkills = normalizeSkills(job.nice_to_have_skills)

  const salaryMin =
    job.extracted_salary_min != null && job.extracted_salary_min !== ''
      ? Number(job.extracted_salary_min)
      : job.salary_min_extracted != null
        ? Number(job.salary_min_extracted)
        : null

  const visaLabel = visaDisplayLabel(job.visa_req, needsSponsorship)
  const fitParts = fitScoreDisplayParts(job.fit_score)

  const metaRows = []
  if (job.extracted_yoe != null && job.extracted_yoe !== '') {
    metaRows.push({ key: 'yoe', label: 'YOE Required', value: formatYoe(job.extracted_yoe) })
  }
  if (job.education_req_degree) {
    const eduKey = job.education_req_degree
    metaRows.push({
      key: 'edu',
      label: 'Education',
      value: EDU_LABELS[eduKey] || capitalizeWord(eduKey),
    })
  }
  if (visaLabel) {
    metaRows.push({ key: 'visa', label: 'Visa', value: visaLabel })
  }
  if (salaryMin != null && Number.isFinite(salaryMin)) {
    metaRows.push({
      key: 'salary',
      label: 'Salary (min)',
      value: `$${salaryMin.toLocaleString()} CAD`,
    })
  }

  const hasExtractedStepB = Boolean(job.matched_at)

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

        {hasExtractedStepB ? (
          <div className={s.extractedView}>
            <div className={s.extractedPanelTitle}>Extracted Info</div>

            {requiredSkills.length > 0 && (
              <div className={s.extractedSection}>
                <div className={s.extractedSectionLabel}>Required skills</div>
                <div className={s.skillTagList}>
                  {requiredSkills.map((skill) => (
                    <span key={skill} className={s.skillTag}>{skill}</span>
                  ))}
                </div>
              </div>
            )}

            {niceSkills.length > 0 && (
              <div className={s.extractedSection}>
                <div className={s.extractedSectionLabel}>Nice to have</div>
                <div className={s.skillTagList}>
                  {niceSkills.map((skill) => (
                    <span key={skill} className={s.skillTag}>{skill}</span>
                  ))}
                </div>
              </div>
            )}

            {metaRows.length > 0 && (
              <div className={s.extractedMeta}>
                {metaRows.map((row) => (
                  <Fragment key={row.key}>
                    <span className={s.metaLabel}>{row.label}</span>
                    <span className={s.metaValue}>{row.value}</span>
                  </Fragment>
                ))}
              </div>
            )}

            {job.other_notes && (
              <div className={s.extractedSection} style={{ marginTop: '12px' }}>
                <div className={s.extractedSectionLabel}>NOTES</div>
                <p style={{ fontSize: '13px', color: '#444444', margin: 0, lineHeight: '1.5' }}>
                  {job.other_notes}
                </p>
              </div>
            )}

            {job.match_level && (
              <div className={s.extractedSection} style={{ marginTop: '12px' }}>
                <div className={s.extractedSectionLabel}>MATCH SCORE</div>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' }}>
                  {fitParts && (
                    <span>
                      <strong>
                        {fitParts.pct}
                        %
                        {fitParts.bonus ? ' +' : ''}
                      </strong>
                      {' '}
                      fit
                      {fitParts.bonus ? ' (incl. nice-to-have bonus)' : ''}
                    </span>
                  )}
                  {job.req_coverage != null && (
                    <span>
                      <strong>{Math.round(Number(job.req_coverage) * 100)}%</strong> req coverage
                    </span>
                  )}
                  <span
                    style={{
                      color:
                        {
                          strong_match: 'rgb(5,118,66)',
                          possible_match: 'rgb(26,95,180)',
                          stretch_match: '#cc8800',
                          weak_match: 'rgb(192,57,43)',
                        }[job.match_level] || '#555',
                    }}
                  >
                    {String(job.match_level).replace(/_/g, ' ')}
                  </span>
                </div>
                {job.match_reason && (
                  <p style={{ fontSize: '13px', color: '#444', margin: '6px 0 0', lineHeight: '1.5' }}>
                    {job.match_reason}
                  </p>
                )}
              </div>
            )}

            <div className={s.rawJdToggle}>
              <button
                type="button"
                className={s.rawJdBtn}
                onClick={() => setShowRawJd((v) => !v)}
              >
                {showRawJd ? '\u25bc Hide raw JD' : '\u25b6 Show raw JD'}
              </button>
            </div>
            {showRawJd && (
              <div className={s.jobDescription}>{job.job_description}</div>
            )}
          </div>
        ) : (
          <div className={s.jobDescription}>{job.job_description}</div>
        )}
      </div>
    </div>
  )
}
