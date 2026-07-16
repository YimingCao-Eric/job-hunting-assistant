import type { SalaryPeriod } from '@/types/job'

/**
 * Salaries are PLAIN-NOTATION STRINGS and are NEVER ANNUALIZED.
 *
 * Two real traits, both easy to get wrong:
 *
 * 1. They are JSON strings, not numbers. The DB type is NUMERIC -> Decimal, and
 *    a field_serializer does format(v, "f") (schemas/scraped_job.py:85-95)
 *    SPECIFICALLY because asyncpg returns Decimal('1.2E+5') for 120000 and a
 *    naive str() would put "1.2E+5" on the wire. So: plain decimal, always.
 *
 * 2. Amounts are never annualized. An HOURLY "55" is $55/HOUR -- not $55/yr,
 *    not $114,400/yr. NEVER convert between periods. The live corpus has 34
 *    HOURLY rows (e.g. {min:"20", max:"30", cur:"CAD", per:"HOURLY"}).
 *
 * 'YEARLY' does not appear here because it is never stored -- it is an input
 * token ingest maps to 'ANNUAL' (projection.py:56-63).
 */

export const SALARY_ABSENT = '—'

/** Render the period AS GIVEN. No conversion, ever. */
const PERIOD_SUFFIX: Record<SalaryPeriod, string> = {
  HOURLY: '/hr',
  DAILY: '/day',
  WEEKLY: '/wk',
  MONTHLY: '/mo',
  ANNUAL: '/yr',
}

/** "" and null are both absent. Number("") is 0, which would render "$0". */
function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function formatAmount(value: number, currency: string | null, locale?: string): string {
  // Annual salaries don't want cents; hourly rates might (20.50).
  const fractionDigits = Number.isInteger(value) ? 0 : 2

  // No currency -> the BARE number. Do not assume USD (research R5).
  if (!currency) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value)
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value)
  } catch {
    // An unknown/invalid ISO code must not crash a row. Fall back to a labelled
    // bare number rather than dropping the currency silently.
    const n = new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value)
    return `${currency} ${n}`
  }
}

export interface SalaryFields {
  salary_min: string | null
  salary_max: string | null
  salary_currency: string | null
  salary_period: SalaryPeriod | null
}

/**
 * min+max -> "$55–$80/hr" | min only -> "From $55/hr"
 * max only -> "Up to $80/hr" | neither -> "—"
 *
 * A null period with amounts present is LEGAL (an unrecognized input token
 * yields period: null while retaining amounts) -> render with no suffix.
 */
export function formatSalary(job: SalaryFields, locale?: string): string {
  const min = parseAmount(job.salary_min)
  const max = parseAmount(job.salary_max)
  if (min === null && max === null) return SALARY_ABSENT

  const suffix = job.salary_period ? PERIOD_SUFFIX[job.salary_period] : ''
  const fmt = (v: number) => formatAmount(v, job.salary_currency, locale)

  if (min !== null && max !== null) {
    // En dash, and the symbol is repeated so the range is unambiguous.
    return `${fmt(min)}–${fmt(max)}${suffix}`
  }
  if (min !== null) return `From ${fmt(min)}${suffix}`
  return `Up to ${fmt(max as number)}${suffix}`
}
