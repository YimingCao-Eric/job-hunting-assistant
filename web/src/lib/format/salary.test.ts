import { describe, expect, it } from 'vitest'

import { formatSalary, type SalaryFields } from '@/lib/format/salary'
import type { SalaryPeriod } from '@/types/job'

// Pin the locale so assertions are deterministic regardless of the host.
const L = 'en-CA'

const job = (over: Partial<SalaryFields>): SalaryFields => ({
  salary_min: null,
  salary_max: null,
  salary_currency: 'CAD',
  salary_period: null,
  ...over,
})

describe('formatSalary -- NEVER annualized (the headline trap)', () => {
  // An HOURLY "55" is $55/hr. Not $55/yr. Not $114,400/yr.
  it('an HOURLY "55" renders $55/hr', () => {
    const out = formatSalary(job({ salary_min: '55', salary_period: 'HOURLY' }), L)
    expect(out).toBe('From $55/hr')
    expect(out).not.toContain('/yr')
    expect(out).not.toContain('114,400')
  })

  // Straight from the live corpus.
  it('a real HOURLY range {min:"20", max:"30", CAD} renders $20–$30/hr', () => {
    const out = formatSalary(
      job({ salary_min: '20', salary_max: '30', salary_period: 'HOURLY' }),
      L,
    )
    expect(out).toBe('$20–$30/hr')
    expect(out).not.toContain('/yr')
  })

  it('the same NUMBER under different periods differs ONLY by suffix -- no conversion', () => {
    const periods: SalaryPeriod[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL']
    const rendered = periods.map((p) =>
      formatSalary(job({ salary_min: '55', salary_period: p }), L),
    )
    expect(rendered).toEqual([
      'From $55/hr',
      'From $55/day',
      'From $55/wk',
      'From $55/mo',
      'From $55/yr',
    ])
    // The amount is identical everywhere: nothing was scaled.
    for (const r of rendered) expect(r).toContain('55')
  })

  it('ANNUAL renders per-year and is not converted either', () => {
    expect(
      formatSalary(job({ salary_min: '52000', salary_max: '95000', salary_period: 'ANNUAL' }), L),
    ).toBe('$52,000–$95,000/yr')
  })
})

describe('formatSalary -- plain-notation strings', () => {
  // The field_serializer exists precisely so "1.2E+5" never reaches us.
  it('parses plain notation, not scientific', () => {
    expect(formatSalary(job({ salary_min: '120000', salary_period: 'ANNUAL' }), L)).toBe(
      'From $120,000/yr',
    )
  })

  it('handles a fractional hourly rate without losing the cents', () => {
    expect(formatSalary(job({ salary_min: '20.5', salary_period: 'HOURLY' }), L)).toBe(
      'From $20.50/hr',
    )
  })

  it('treats "" as absent, not as 0', () => {
    // Number("") === 0, which would render "$0" -- a fabricated salary.
    expect(formatSalary(job({ salary_min: '', salary_max: '' }), L)).toBe('—')
    expect(formatSalary(job({ salary_min: '', salary_max: '30', salary_period: 'HOURLY' }), L)).toBe(
      'Up to $30/hr',
    )
  })

  it('treats unparseable junk as absent rather than NaN', () => {
    expect(formatSalary(job({ salary_min: 'competitive' }), L)).toBe('—')
  })
})

describe('formatSalary -- the four shapes', () => {
  it('min + max -> a range', () => {
    expect(
      formatSalary(job({ salary_min: '20', salary_max: '30', salary_period: 'HOURLY' }), L),
    ).toBe('$20–$30/hr')
  })

  it('min only -> From', () => {
    expect(formatSalary(job({ salary_min: '20', salary_period: 'HOURLY' }), L)).toBe('From $20/hr')
  })

  it('max only -> Up to', () => {
    expect(formatSalary(job({ salary_max: '30', salary_period: 'HOURLY' }), L)).toBe('Up to $30/hr')
  })

  it('neither -> "—" (378 of 500 live rows have no salary)', () => {
    expect(formatSalary(job({}), L)).toBe('—')
  })
})

describe('formatSalary -- period and currency edge cases', () => {
  // Legal: an unrecognized input token yields period null while keeping amounts.
  it('a null period with amounts renders the amounts with NO suffix', () => {
    const out = formatSalary(job({ salary_min: '55', salary_period: null }), L)
    expect(out).toBe('From $55')
    expect(out).not.toMatch(/\/(hr|day|wk|mo|yr)/)
  })

  it('a null currency renders the BARE number -- never assumes USD', () => {
    const out = formatSalary(
      job({ salary_min: '55', salary_currency: null, salary_period: 'HOURLY' }),
      L,
    )
    expect(out).toBe('From 55/hr')
    expect(out).not.toContain('$')
  })

  it('an unknown currency code degrades to a labelled number instead of throwing', () => {
    const out = formatSalary(
      job({ salary_min: '55', salary_currency: 'XYZ', salary_period: 'HOURLY' }),
      L,
    )
    expect(out).toContain('55')
    expect(out).toContain('XYZ')
  })

  it('never emits the string YEARLY -- it is an input token, never stored', () => {
    const periods: SalaryPeriod[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL']
    for (const p of periods) {
      expect(formatSalary(job({ salary_min: '1', salary_period: p }), L)).not.toContain('YEARLY')
    }
  })
})
