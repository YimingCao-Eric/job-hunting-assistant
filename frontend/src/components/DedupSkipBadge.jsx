import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatAbsoluteTime } from '../utils/time'
import s from './DedupSkipBadge.module.css'

const SKIP_REASON_LABELS = {
  blacklisted: {
    label: 'Blacklisted',
    detail: () => 'company or location blacklisted',
  },
  title_blacklisted: {
    label: 'Title Blacklisted',
    detail: () => 'title contains blacklisted term',
  },
  job_type: {
    label: 'Job Type',
    detail: () => 'title contains: intern/co-op/student',
  },
  agency: {
    label: 'Agency Posting',
    detail: () => 'agency detected in company or JD',
  },
  language: {
    label: 'Language',
    detail: () => 'JD language not in allowed list',
  },
  title_mismatch: {
    label: 'Title Mismatch',
    detail: () => 'title matches none of target titles',
  },
  contract_mismatch: {
    label: 'Contract Role',
    detail: () => 'contains contract/freelance term',
  },
  remote_mismatch: {
    label: 'Not Remote',
    detail: () => 'JD indicates onsite requirement',
  },
  sponsorship: {
    label: 'No Sponsorship',
    detail: () => 'JD states no sponsorship',
  },
  url_duplicate: {
    label: 'URL Duplicate',
    detail: () => 'same job URL already exists',
  },
  content_duplicate: {
    label: 'Content Duplicate',
    detail: () => 'same JD content already exists',
  },
  jd_failed: {
    label: 'JD Failed',
    detail: () => 'job description could not be fetched',
  },
  no_id: {
    label: 'No ID',
    detail: () => 'job ID could not be extracted',
  },
}

function truncateUrl(u, max = 60) {
  if (!u) return ''
  if (u.length <= max) return u
  return `${u.slice(0, max - 1)}\u2026`
}

function AlreadyScrapedDetail({ job, original, loadingOriginal, originalError }) {
  const oid = job.dedup_original_job_id
  if (!oid) {
    return <div className={s.skipDetail}>exact URL or hash match</div>
  }
  if (loadingOriginal) {
    return <div className={s.skipDetailMuted}>Loading{'\u2026'}</div>
  }
  if (originalError || !original) {
    return <div className={s.skipDetail}>Could not load duplicate details.</div>
  }

  const scoreLine =
    job.dedup_similarity_score != null
      ? `${Math.round(job.dedup_similarity_score * 100)}% similar`
      : 'exact hash match'

  return (
    <>
      <div className={s.skipDetail}>{scoreLine}</div>
      <div className={s.skipDetail}>
        Duplicate of: {original.job_title || '\u2014'} @ {original.company || '\u2014'}
      </div>
      {original.job_url && (
        <div className={s.skipLinkRow}>
          <a
            className={s.skipLink}
            href={original.job_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
          >
            {'\u2197'} {truncateUrl(original.job_url)}
          </a>
        </div>
      )}
      {original.created_at && (
        <div className={s.skipDetailMuted}>
          Originally scraped: {formatAbsoluteTime(original.created_at)}
        </div>
      )}
    </>
  )
}

export default function DedupSkipBadge({ job }) {
  const reason = job.skip_reason || ''
  const meta = SKIP_REASON_LABELS[reason] || {
    label: reason || 'Unknown',
    detail: () => '',
  }

  const [original, setOriginal] = useState(undefined)
  const [loadingOriginal, setLoadingOriginal] = useState(false)
  const [originalError, setOriginalError] = useState(false)

  useEffect(() => {
    if (reason !== 'already_scraped' || !job.dedup_original_job_id) {
      setOriginal(undefined)
      setLoadingOriginal(false)
      setOriginalError(false)
      return
    }
    let cancelled = false
    setLoadingOriginal(true)
    setOriginalError(false)
    ;(async () => {
      try {
        const o = await api.getJob(job.dedup_original_job_id)
        if (!cancelled) setOriginal(o)
      } catch {
        if (!cancelled) {
          setOriginal(null)
          setOriginalError(true)
        }
      } finally {
        if (!cancelled) setLoadingOriginal(false)
      }
    })()
    return () => { cancelled = true }
  }, [reason, job.dedup_original_job_id])

  return (
    <div className={s.skipBadge}>
      <div className={s.skipTitle}>
        {'\u2298'}{' '}
        {reason === 'already_scraped' ? 'Already Scraped' : meta.label}
      </div>
      {reason === 'already_scraped' ? (
        <AlreadyScrapedDetail
          job={job}
          original={original}
          loadingOriginal={loadingOriginal}
          originalError={originalError}
        />
      ) : (
        <div className={s.skipDetail}>{meta.detail(job)}</div>
      )}
    </div>
  )
}
