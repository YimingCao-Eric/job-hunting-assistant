/**
 * Build Glassdoor Canada job search URL from config `glassdoor` object.
 * Mirrors `extension/background/search_urls.js` `buildGlassdoorSearchUrl`.
 * @param {Record<string, unknown> | null | undefined} g
 */
function toSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')
}

export function buildGlassdoorPreviewUrl(g) {
  if (!g) return ''
  const locSlug = g.location_slug || toSlug(g.location)
  const kwSlug = g.keyword_slug || toSlug(g.keyword)
  if (!locSlug || !kwSlug) return ''
  const locLen = String(locSlug).length
  const kwStart = locLen + 1
  const kwEnd = kwStart + String(kwSlug).length
  const path = `https://www.glassdoor.ca/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${locLen}_IN3_KO${kwStart},${kwEnd}.htm`
  const params = new URLSearchParams()
  if (g.fromAge != null) params.set('fromAge', g.fromAge)
  if (g.applicationType != null) params.set('applicationType', g.applicationType)
  if (g.remoteWorkType != null) params.set('remoteWorkType', g.remoteWorkType)
  if (g.minSalary != null) params.set('minSalary', g.minSalary)
  if (g.maxSalary != null) params.set('maxSalary', g.maxSalary)
  if (g.minRating != null) params.set('minRating', g.minRating)
  if (g.jobType) params.set('jobType', g.jobType)
  if (g.seniorityType != null) params.set('seniorityType', g.seniorityType)
  params.set('sortBy', 'date_desc')
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}
