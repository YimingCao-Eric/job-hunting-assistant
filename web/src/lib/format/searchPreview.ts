import type { SearchConfig } from '@/types/config'

/**
 * FR-019: a live preview of THE SEARCH EACH SITE WILL PERFORM, from the current
 * (unsaved) form state.
 *
 * These builders MIRROR `extension/background/search_urls.js`, which is the
 * authority -- the extension is what actually navigates. A preview that
 * diverges from it is worse than no preview, because its entire value is
 * "sanity-check before saving".
 *
 * THE OLD FRONTEND'S PREVIEW LIED, in at least three ways (ConfigPage.jsx:92-144
 * vs search_urls.js). Deliberately NOT reproduced here:
 *   1. Indeed `fromage`   -- old used `general_date_posted ?? indeed_fromage`;
 *                            the extension uses `indeed_fromage` only.
 *   2. Indeed `remotejob` -- old used `indeed_remotejob || general_remote_only`;
 *                            the extension uses `indeed_remotejob` only.
 *   3. Glassdoor `fromAge`-- old overrode with `general_date_posted`;
 *                            the extension uses `glassdoor.fromAge` only.
 *
 * As-built warts, faithfully reproduced (Principle I -- documented, not "fixed"):
 *   - Indeed `sort` is HARDCODED to "relevance" by the extension. The stored
 *     `indeed_sort` field is IGNORED. So the preview hardcodes it too.
 *   - Glassdoor `sortBy` is hardcoded to "date_desc"; stored sortBy is ignored.
 */

export interface SearchPreview {
  linkedin: string
  indeed: string
  glassdoor: string
  /** Why linkedin's f_TPR may differ at scan time. See below. */
  linkedinNote: string | null
}

export const toSlug = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')

/**
 * LinkedIn's f_TPR CANNOT be previewed exactly, and pretending otherwise would
 * be the same lie the old preview told.
 *
 * The extension calls computeFtpr(f_tpr_bound, website) at SCAN TIME
 * (config_fetch.js:15-48), which fetches the last COMPLETED run for that site
 * and narrows the window to min(hoursSinceLastRun, bound) -- floored at 1 hour.
 * It only returns the full `r{bound*3600}` when there is no prior run, or the
 * lookup fails.
 *
 * So: `linkedin_f_tpr` set  -> exact and deterministic.
 *     otherwise             -> we show the CEILING and say it narrows.
 */
function linkedinFtpr(config: SearchConfig): { param: string | null; note: string | null } {
  const explicitHours = Number.parseInt(String(config.linkedin_f_tpr ?? '').trim(), 10)
  if (!Number.isNaN(explicitHours) && explicitHours > 0) {
    return { param: `r${explicitHours * 3600}`, note: null }
  }

  const bound = Number(config.f_tpr_bound)
  if (!bound || bound <= 0) {
    return { param: null, note: 'No recency bound is set, so no f_TPR filter is applied.' }
  }

  return {
    param: `r${bound * 3600}`,
    note:
      `f_TPR shows the ${bound}h ceiling. At scan time the extension narrows it to the time ` +
      `since the last completed LinkedIn run (minimum 1h); the full ${bound}h is used only when ` +
      `there is no prior run.`,
  }
}

/** Mirrors buildSearchUrl(config, f_tpr, 0) -- startOffset 0, page 1. */
function buildLinkedinUrl(config: SearchConfig): { url: string; note: string | null } {
  const params = new URLSearchParams({
    keywords: config.keyword ?? '',
    location: config.location ?? '',
  })
  const { param, note } = linkedinFtpr(config)
  if (param) params.set('f_TPR', param)
  if (config.f_experience) params.set('f_E', config.f_experience)
  if (config.f_job_type) params.set('f_JT', config.f_job_type)
  if (config.f_remote) params.set('f_WT', config.f_remote)
  return { url: `https://www.linkedin.com/jobs/search?${params.toString()}`, note }
}

/** Mirrors buildIndeedSearchUrl(config, 0). */
function buildIndeedUrl(config: SearchConfig): string {
  const params = new URLSearchParams()
  params.set('q', config.indeed_keyword || config.keyword || 'software engineer')
  params.set('l', config.indeed_location || config.location || 'Canada')
  // As-built: hardcoded. `indeed_sort` is stored but the extension ignores it.
  params.set('sort', 'relevance')
  if (config.indeed_fromage) params.set('fromage', String(config.indeed_fromage))
  if (config.indeed_remotejob) params.set('remotejob', '1')
  const jt = config.general_internship_only ? 'internship' : (config.indeed_jt ?? '').trim()
  if (jt) params.set('jt', jt)
  if (config.indeed_explvl) params.set('explvl', config.indeed_explvl)
  if (config.indeed_lang) params.set('lang', config.indeed_lang)
  return `https://ca.indeed.com/jobs?${params.toString()}`
}

/**
 * Mirrors buildGlassdoorSearchUrl(config).
 *
 * The extension reads g.location_slug / g.keyword_slug DIRECTLY with no
 * fallback -- if they are missing it throws. We return '' instead of throwing,
 * so the preview can say so rather than crash the page.
 */
function buildGlassdoorUrl(config: SearchConfig): string {
  const g = config.glassdoor
  if (!g) return ''

  const locSlug = String(g.location_slug ?? '')
  const kwSlug = String(g.keyword_slug ?? '')
  if (!locSlug || !kwSlug) return ''

  const locLen = locSlug.length
  const kwStart = locLen + 1
  const kwEnd = kwStart + kwSlug.length
  const path = `https://www.glassdoor.ca/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${locLen}_IN3_KO${kwStart},${kwEnd}.htm`

  const params = new URLSearchParams()
  const set = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) params.set(key, String(value))
  }
  set('fromAge', g.fromAge)
  set('applicationType', g.applicationType)
  set('remoteWorkType', g.remoteWorkType)
  set('minSalary', g.minSalary)
  set('maxSalary', g.maxSalary)
  set('minRating', g.minRating)
  if (g.jobType) params.set('jobType', String(g.jobType))
  set('seniorityType', g.seniorityType)
  // As-built: hardcoded, like the extension. Stored sortBy is ignored.
  params.set('sortBy', 'date_desc')

  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export function buildSearchPreview(config: SearchConfig): SearchPreview {
  const linkedin = buildLinkedinUrl(config)
  return {
    linkedin: linkedin.url,
    linkedinNote: linkedin.note,
    indeed: buildIndeedUrl(config),
    glassdoor: buildGlassdoorUrl(config),
  }
}
