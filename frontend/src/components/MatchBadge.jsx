import { fitScoreDisplayParts } from '../utils/fitScoreDisplay'
import s from './MatchBadge.module.css'

const ICONS = {
  strong_match: '\u2b50',
  possible_match: '\u2713',
  stretch_match: '~',
  weak_match: '\u2717',
}

const LABELS = {
  strong_match: 'Strong',
  possible_match: 'Possible',
  stretch_match: 'Stretch',
  weak_match: 'Weak',
}

export default function MatchBadge({ job }) {
  const level = job.match_level
  if (!level) return null
  const fitParts = fitScoreDisplayParts(job.fit_score)
  const confidence = job.match_confidence || job.confidence
  const badgeClass = s[`badge_${level}`] || s.badge_weak_match
  const dotClass =
    confidence === 'high'
      ? s.dot_high
      : confidence === 'medium'
        ? s.dot_medium
        : confidence === 'low'
          ? s.dot_low
          : ''
  return (
    <div className={s.matchFooter}>
      <span className={`${s.matchBadge} ${badgeClass}`}>
        {ICONS[level]}{' '}
        {LABELS[level] || level}
      </span>
      {fitParts && (
        <span style={{ fontSize: '12px', color: '#666', marginLeft: '6px' }}>
          {fitParts.bonus ? `${fitParts.pct}% fit +` : `${fitParts.pct}% fit`}
        </span>
      )}
      {confidence && dotClass ? <span className={`${s.confidenceDot} ${dotClass}`} /> : null}
    </div>
  )
}
