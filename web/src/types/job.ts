/**
 * Mirrors `ScrapedJobRead` (backend/schemas/scraped_job.py:43-95), the canonical
 * merged row delivered by feature 008. Compile-time only: no runtime validation,
 * so added backend keys pass through (Constitution Principle VII).
 *
 * Backend field names verbatim -- `job_url` not `url`, `location_text` not
 * `location`, `scrape_time` not `scrapedAt`.
 */

export type SourceSite = 'linkedin' | 'indeed' | 'glassdoor'

export const SOURCE_SITES: readonly SourceSite[] = ['linkedin', 'indeed', 'glassdoor']

/**
 * NOTE: 'YEARLY' is deliberately ABSENT. It is an accepted *input* token that
 * ingest maps to 'ANNUAL' (core/scraped_job_projection.py:56-63) and is NEVER
 * stored. A UI that switches on 'YEARLY' has a branch that can never execute
 * and silently misses the one ('ANNUAL') that can.
 */
export type SalaryPeriod = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ANNUAL'

export interface Job {
  /** CANONICAL id space -- use for GET /jobs/{id}. */
  id: string
  source_site: SourceSite
  /** PER-SOURCE id space. Polymorphic, no FK. NOT interchangeable with `id`. */
  source_row_id: string
  site_job_id: string | null
  scan_run_id: string
  /** The link to the original posting (FR-024). Named job_url, not url. */
  job_url: string
  /** ISO, tz-aware. THE SORT KEY -- the spec's "scraped date". */
  scrape_time: string
  matched: boolean
  dismissed: boolean
  title: string | null
  /** CAN BE "" as well as null -- an empty mosaic company wins over a populated
   *  graphql employer_name for Indeed (projection.py:217). Test emptiness. */
  company: string | null
  location_text: string | null
  description: string | null
  /** TRI-STATE. null means the site did not say -- NOT "on-site".
   *  Glassdoor never emits false (projection.py:245). See lib/format/remote.ts. */
  remote: boolean | null
  apply_url: string | null
  /** Always null for Indeed (projection.py:210). */
  experience_level: string | null
  /** Always null for Indeed (projection.py:219). */
  industry: string | null
  /** STRING in plain decimal notation, not a number. A field_serializer
   *  guarantees this because asyncpg would otherwise emit Decimal('1.2E+5'). */
  salary_min: string | null
  salary_max: string | null
  salary_currency: string | null
  salary_period: SalaryPeriod | null
  /** ISO, tz-aware. The spec's "posting date". */
  posted_at: string | null
}

/** The paginated envelope. `total` is the count WITH filters, IGNORING limit/offset. */
export interface JobsPage {
  items: Job[]
  total: number
  limit: number
  offset: number
}

/**
 * Only the params the backend actually accepts and we actually want.
 *
 * Deliberately absent, each for a reason:
 *  - easy_apply, dedup_status, website, skip_reason -- DO NOT EXIST (removed by 008)
 *  - date_from / date_to -- exist, but filter posted_at (a timestamptz) against
 *    bare-date midnight, so date_to=2026-07-15 drops nearly all of that day.
 *    FR-023 needs a SCRAPED-date range, so the correct pair is the required pair.
 *  - dismissed -- omitted means `dismissed == false`, which is what we want.
 *    No value returns both. (research R15)
 *  - sort/order -- not configurable. scrape_time DESC, no tiebreaker.
 */
export interface JobFilters {
  source_site?: SourceSite
  /** 'YYYY-MM-DD'. >= midnight UTC of that day. */
  scraped_from?: string
  /** 'YYYY-MM-DD'. < midnight UTC of day+1 -- whole day INCLUSIVE. */
  scraped_to?: string
  /** Default 25. ge=1, le=500. 0 is a 422. */
  limit?: number
  offset?: number
}

/** FR-023's per-site counts. No facet endpoint exists -- derived client-side
 *  from three `?source_site=X&limit=1` reads of `total` (research R3). */
export type SourceCounts = Record<SourceSite, number>
