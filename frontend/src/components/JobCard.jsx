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

/**
 * @param {{ job: object, onClick: () => void, footer?: import('react').ReactNode }} props
 */
export default function JobCard({ job, onClick, footer }) {
  const isRemote = jobIsRemote(job)
  const isIntern = jobIsInternship(job)
  const isPromoted = jobIsPromotedGap(job)

  return (
    <div
      className={s.card}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
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
      {footer}
    </div>
  )
}
