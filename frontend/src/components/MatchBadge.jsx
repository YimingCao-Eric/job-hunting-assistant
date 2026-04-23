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

/**
 * @param {{ job: object, showLevelBadge?: boolean }} props
 * When showLevelBadge is false, fit % still shows; Strong/Weak/etc. and confidence dot are hidden.
 */
export default function MatchBadge({ job, showLevelBadge = false }) {
  const level = job.match_level
  const fitParts = fitScoreDisplayParts(job.fit_score)
  const showLevel = Boolean(showLevelBadge && level)
  if (!showLevel && !fitParts) return null
  const confidence = job.match_confidence
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
      {showLevel
        ? (
            <span className={`${s.matchBadge} ${badgeClass}`}>
              {ICONS[level]}
              {' '}
              {LABELS[level] || level}
            </span>
          )
        : null}
      {fitParts && (
        <span style={{ fontSize: '12px', color: '#666', marginLeft: showLevel ? '6px' : 0 }}>
          {fitParts.bonus ? `${fitParts.pct}% fit +` : `${fitParts.pct}% fit`}
        </span>
      )}
      {showLevelBadge && confidence && dotClass
        ? <span className={`${s.confidenceDot} ${dotClass}`} />
        : null}
    </div>
  )
}
