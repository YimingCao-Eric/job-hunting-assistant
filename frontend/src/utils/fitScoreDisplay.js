/**
 * CPU fit_score can exceed 1.0 (nice-to-have bonus). Cap display at 100% and mark bonus.
 * @param {number|string|null|undefined} fitScore
 * @returns {{ pct: number, bonus: boolean } | null}
 */
export function fitScoreDisplayParts(fitScore) {
  if (fitScore == null || fitScore === '') return null
  const n = Number(fitScore)
  if (Number.isNaN(n)) return null
  if (n > 1) return { pct: 100, bonus: true }
  return { pct: Math.min(100, Math.round(n * 100)), bonus: false }
}
