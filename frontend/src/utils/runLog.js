/** Infer site from stored run log search_filters (extension convention). */
export function detectWebsiteFromRunLog(runLog) {
  if (!runLog || !runLog.search_filters) return null
  const sf = runLog.search_filters
  if (sf.website === 'glassdoor') return 'glassdoor'
  const keys = Object.keys(sf)
  if (keys.some(k => k.startsWith('indeed_'))) return 'indeed'
  return 'linkedin'
}
