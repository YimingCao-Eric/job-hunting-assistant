import d from './DedupSkipBadge.module.css'

const LABELS = {
  language: 'Language',
  yoe_gate: 'YOE Gate',
  salary_gate: 'Salary Gate',
  education_gate: 'Education Gate',
  visa_gate: 'Visa Gate',
  extraction_failed: 'Extraction Failed',
  scoring_failed: 'Scoring Failed',
}

function detail(reason, job) {
  if (reason === 'yoe_gate')
    return job.extracted_yoe != null ? `Required ${job.extracted_yoe}+ yrs (gate)` : 'Experience requirement'
  if (reason === 'salary_gate')
    return 'Salary below minimum'
  if (reason === 'education_gate')
    return job.education_req_degree ? `${job.education_req_degree} required` : 'Education requirement'
  if (reason === 'visa_gate')
    return 'No sponsorship offered'
  return null
}

export default function MatchSkipBadge({ reason, job }) {
  const r = reason || job?.match_skip_reason || ''
  const dtext = detail(r, job)
  return (
    <div className={d.skipBadge}>
      <div className={d.skipTitle}>
        {'\u2298'}{' '}
        {LABELS[r] || r || 'Match skip'}
      </div>
      {dtext ? <div className={d.skipDetail}>{dtext}</div> : null}
    </div>
  )
}
