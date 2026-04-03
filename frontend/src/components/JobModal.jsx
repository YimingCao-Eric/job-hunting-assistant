import { useEffect } from 'react'
import { normaliseLocation } from '../utils/location'
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

export default function JobModal({ job, onClose }) {
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
