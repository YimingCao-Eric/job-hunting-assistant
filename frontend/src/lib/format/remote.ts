/**
 * `remote` is TRI-STATE and `null` must NEVER render "On-site".
 *
 * null means THE SITE DID NOT SAY. That is not the same claim as "this job is
 * on-site". The failure mode is a plain `remote ? 'Remote' : 'On-site'` --
 * correct-looking, and wrong for every null.
 *
 * This is not hypothetical. Glassdoor NEVER emits false: the projection is
 * `True if p.get("remote_work_types") else None`
 * (core/scraped_job_projection.py:245). Measured against the live corpus:
 * 64 Glassdoor rows are null and ZERO are false -- so the naive ternary would
 * label every non-remote Glassdoor job "On-site" on no evidence at all.
 *
 * Also the mechanism for FR-051/FR-013: an absent field must stay
 * distinguishable from a known-negative one.
 */

export const REMOTE_ABSENT = '—'

export function formatRemote(remote: boolean | null | undefined): string {
  if (remote === true) return 'Remote'
  if (remote === false) return 'On-site'
  return REMOTE_ABSENT
}

/** Tooltip for the absent case, so "—" is explained rather than mysterious. */
export function remoteTitle(remote: boolean | null | undefined): string | undefined {
  return remote === true || remote === false ? undefined : 'The source site did not state this'
}
