import { describe, expect, it } from 'vitest'

import { buildSearchPreview, toSlug } from '@/lib/format/searchPreview'
import type { SearchConfig } from '@/types/config'

/** The live GET /config at time of writing. */
const LIVE: SearchConfig = {
  website: 'linkedin',
  keyword: 'software engineer',
  location: 'Canada',
  general_date_posted: 1,
  general_internship_only: false,
  general_remote_only: false,
  allowed_languages: ['en'],
  no_contract: false,
  remote_only: false,
  needs_sponsorship: false,
  no_agency: false,
  salary_min: 0,
  blacklist_companies: [],
  blacklist_locations: [],
  blacklist_titles: [],
  target_titles: [],
  f_tpr_bound: 48,
  f_experience: null,
  f_job_type: null,
  f_remote: null,
  linkedin_f_tpr: null,
  indeed_keyword: 'software engineer',
  indeed_location: 'Canada',
  indeed_fromage: 1,
  indeed_remotejob: null,
  indeed_jt: null,
  indeed_sort: 'relevance',
  indeed_radius: null,
  indeed_explvl: null,
  indeed_lang: null,
  glassdoor: {
    keyword: 'software engineer',
    location: 'Canada',
    location_slug: 'canada',
    keyword_slug: 'software-engineer',
    country_code: 'IN3',
    fromAge: 1,
    applicationType: null,
    remoteWorkType: null,
    minSalary: null,
    maxSalary: null,
    minRating: null,
    jobType: null,
    seniorityType: null,
    sortBy: 'date_desc',
  },
}

const cfg = (over: Partial<SearchConfig> = {}): SearchConfig => ({ ...LIVE, ...over })

describe('buildSearchPreview -- LinkedIn (mirrors search_urls.js buildSearchUrl)', () => {
  it('builds the live config’s URL', () => {
    const { linkedin } = buildSearchPreview(cfg())
    expect(linkedin).toContain('https://www.linkedin.com/jobs/search?')
    expect(linkedin).toContain('keywords=software+engineer')
    expect(linkedin).toContain('location=Canada')
  })

  it('linkedin_f_tpr overrides the bound and is EXACT (r{h*3600})', () => {
    const { linkedin, linkedinNote } = buildSearchPreview(cfg({ linkedin_f_tpr: '6' }))
    expect(linkedin).toContain('f_TPR=r21600')
    // Deterministic -> no caveat needed.
    expect(linkedinNote).toBeNull()
  })

  // The preview CANNOT be exact here: computeFtpr narrows the window at scan
  // time from the last completed run. Showing the ceiling silently would be the
  // same lie the old preview told, so the caveat is part of the contract.
  it('without an override it shows the BOUND as a ceiling and says it narrows', () => {
    const { linkedin, linkedinNote } = buildSearchPreview(cfg({ f_tpr_bound: 48 }))
    expect(linkedin).toContain('f_TPR=r172800') // 48 * 3600
    expect(linkedinNote).toContain('ceiling')
    expect(linkedinNote).toContain('narrows')
  })

  it('a zero/absent bound means NO f_TPR param at all (computeFtpr returns null)', () => {
    const { linkedin, linkedinNote } = buildSearchPreview(cfg({ f_tpr_bound: 0 }))
    expect(linkedin).not.toContain('f_TPR')
    expect(linkedinNote).toContain('No recency bound')
  })

  it('optional filters map to f_E / f_JT / f_WT only when set', () => {
    const { linkedin } = buildSearchPreview(
      cfg({ f_experience: '2', f_job_type: 'F', f_remote: '2' }),
    )
    expect(linkedin).toContain('f_E=2')
    expect(linkedin).toContain('f_JT=F')
    expect(linkedin).toContain('f_WT=2')
    expect(buildSearchPreview(cfg()).linkedin).not.toContain('f_E=')
  })
})

describe('buildSearchPreview -- Indeed (mirrors buildIndeedSearchUrl)', () => {
  it('builds the live config’s URL', () => {
    const { indeed } = buildSearchPreview(cfg())
    expect(indeed).toContain('https://ca.indeed.com/jobs?')
    expect(indeed).toContain('q=software+engineer')
    expect(indeed).toContain('l=Canada')
  })

  it('falls back to the general keyword/location when the indeed_* ones are blank', () => {
    const { indeed } = buildSearchPreview(cfg({ indeed_keyword: null, indeed_location: null }))
    expect(indeed).toContain('q=software+engineer')
    expect(indeed).toContain('l=Canada')
  })

  // As-built wart: the extension HARDCODES sort=relevance and ignores the
  // stored indeed_sort. Reproduced, not "fixed".
  it('hardcodes sort=relevance, ignoring the stored indeed_sort', () => {
    const { indeed } = buildSearchPreview(cfg({ indeed_sort: 'date' }))
    expect(indeed).toContain('sort=relevance')
    expect(indeed).not.toContain('sort=date')
  })

  it('general_internship_only forces jt=internship over indeed_jt', () => {
    const { indeed } = buildSearchPreview(cfg({ general_internship_only: true, indeed_jt: 'F' }))
    expect(indeed).toContain('jt=internship')
  })
})

describe('buildSearchPreview -- the old preview’s three divergences are NOT reproduced', () => {
  // Each of these is a way the old ConfigPage preview claimed something the
  // extension does not do. FR-019's value is sanity-checking before saving, so
  // a preview that diverges is worse than none.

  it('Indeed fromage uses indeed_fromage ONLY -- not general_date_posted', () => {
    const { indeed } = buildSearchPreview(cfg({ indeed_fromage: 7, general_date_posted: 1 }))
    expect(indeed).toContain('fromage=7') // old would have shown fromage=1
  })

  it('Indeed remotejob uses indeed_remotejob ONLY -- not general_remote_only', () => {
    const { indeed } = buildSearchPreview(cfg({ indeed_remotejob: null, general_remote_only: true }))
    // The old preview set remotejob=1 here. The extension does not.
    expect(indeed).not.toContain('remotejob')
  })

  it('Glassdoor fromAge uses glassdoor.fromAge ONLY -- not general_date_posted', () => {
    const { glassdoor } = buildSearchPreview(
      cfg({ general_date_posted: 30, glassdoor: { ...LIVE.glassdoor, fromAge: 3 } }),
    )
    expect(glassdoor).toContain('fromAge=3') // old would have shown fromAge=30
  })
})

describe('buildSearchPreview -- Glassdoor (mirrors buildGlassdoorSearchUrl)', () => {
  it('builds the slug-offset path exactly as the extension does', () => {
    const { glassdoor } = buildSearchPreview(cfg())
    // canada(6) -> IL.0,6 ; keyword starts at 7, ends at 7+17=24
    expect(glassdoor).toContain(
      'https://www.glassdoor.ca/Job/canada-software-engineer-jobs-SRCH_IL.0,6_IN3_KO7,24.htm',
    )
    expect(glassdoor).toContain('sortBy=date_desc')
    expect(glassdoor).toContain('fromAge=1')
  })

  it('omits null optionals rather than sending "null"', () => {
    const { glassdoor } = buildSearchPreview(cfg())
    expect(glassdoor).not.toContain('minSalary')
    expect(glassdoor).not.toContain('null')
  })

  it('returns "" rather than throwing when slugs are missing (the extension throws)', () => {
    const { glassdoor } = buildSearchPreview(
      cfg({ glassdoor: { ...LIVE.glassdoor, keyword_slug: null, location_slug: null } }),
    )
    expect(glassdoor).toBe('')
  })

  it('handles a null glassdoor object', () => {
    expect(buildSearchPreview(cfg({ glassdoor: null })).glassdoor).toBe('')
  })
})

describe('toSlug', () => {
  it('lowercases and hyphenates, matching the stored slugs', () => {
    expect(toSlug('Software Engineer')).toBe('software-engineer')
    expect(toSlug('Canada')).toBe('canada')
    expect(toSlug(null)).toBe('')
  })
})
