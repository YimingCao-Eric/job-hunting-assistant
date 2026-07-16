import { describe, expect, it } from 'vitest'

import {
  ApiError,
  isAbortError,
  isApiError,
  isPageLevelFailure,
  networkError,
  normalizeError,
} from '@/lib/api/errors'

const err = (kind: ApiError['kind'], status = 500) =>
  new ApiError({ status, kind, message: 'x' })

describe('normalizeError -- shape 1: {"detail": "<string>"}', () => {
  // The trap: this is NOT FastAPI's usual 422. A handler that assumes
  // detail is an array breaks on EVERY /config validation error (FR-021).
  it('surfaces the exact backend message from a /config 422', () => {
    const e = normalizeError(422, { detail: 'nth_bonus_weight must be between 0.0 and 1.0' })
    expect(e.kind).toBe('validation')
    expect(e.message).toBe('nth_bonus_weight must be between 0.0 and 1.0')
  })

  it('treats a non-422 string detail as a server error', () => {
    const e = normalizeError(500, { detail: 'config.json is malformed: ...' })
    expect(e.kind).toBe('server')
    expect(e.message).toBe('config.json is malformed: ...')
  })
})

describe('normalizeError -- shape 2: FastAPI validation array', () => {
  it('keys fieldErrors by the last loc segment and uses the first msg', () => {
    const e = normalizeError(422, {
      detail: [
        { loc: ['query', 'limit'], msg: 'Input should be less than or equal to 500', type: 'x' },
        { loc: ['body', 'keyword'], msg: 'Input should be a valid string', type: 'y' },
      ],
    })
    expect(e.kind).toBe('validation')
    expect(e.fieldErrors).toEqual({
      limit: 'Input should be less than or equal to 500',
      keyword: 'Input should be a valid string',
    })
    expect(e.message).toBe('Input should be less than or equal to 500')
  })

  it('survives an empty array', () => {
    const e = normalizeError(422, { detail: [] })
    expect(e.kind).toBe('validation')
    expect(e.message).toBeTruthy()
  })
})

describe('normalizeError -- shape 3: {"detail": {"field_errors": {...}}}', () => {
  it('lifts field_errors and summarizes a single field', () => {
    const e = normalizeError(422, { detail: { field_errors: { keywords: 'max 10 keywords' } } })
    expect(e.kind).toBe('validation')
    expect(e.fieldErrors).toEqual({ keywords: 'max 10 keywords' })
    expect(e.message).toBe('keywords: max 10 keywords')
  })

  it('summarizes multiple fields by name', () => {
    const e = normalizeError(422, {
      detail: {
        field_errors: {
          keywords: 'max 10 keywords',
          scans_per_cycle: '11 keywords x 3 sites = 33 scans/cycle, max 30',
        },
      },
    })
    expect(e.fieldErrors).toHaveProperty('scans_per_cycle')
    expect(e.message).toContain('2 fields were rejected')
    expect(e.message).toContain('keywords')
  })
})

describe('normalizeError -- shape 4: trigger-scan 409 (SC-011)', () => {
  it.each([
    ['scan_pending', 3000],
    ['stop_cooldown', 5000],
    ['scan_in_progress', 5000],
  ] as const)('carries reason=%s and its retry delay', (reason, retryAfterMs) => {
    const e = normalizeError(409, {
      detail: { reason, message: 'A scan is already running.', retry_after_ms: retryAfterMs },
    })
    expect(e.kind).toBe('conflict')
    expect(e.reason).toBe(reason)
    expect(e.retryAfterMs).toBe(retryAfterMs)
    expect(e.message).toBe('A scan is already running.')
  })

  it('does not mistake a 409 without a reason key for shape 4', () => {
    const e = normalizeError(409, { detail: 'cycle must be in scrape_running to complete' })
    expect(e.reason).toBeUndefined()
    expect(e.message).toBe('cycle must be in scrape_running to complete')
  })
})

describe('normalizeError -- status-driven rules', () => {
  it('401 -> unauthorized (handled once in the shell)', () => {
    const e = normalizeError(401, { detail: 'Unauthorized' })
    expect(e.kind).toBe('unauthorized')
    expect(e.message).toContain('credential')
  })

  it('404 -> not_found, surfacing the backend string', () => {
    const e = normalizeError(404, { detail: 'Job not found' })
    expect(e.kind).toBe('not_found')
    expect(e.message).toBe('Job not found')
  })

  it('404 with no parseable detail still reads', () => {
    expect(normalizeError(404, undefined).message).toBeTruthy()
  })

  // Rule 9 is a LIVE path, not padding: a non-numeric cpu_strong_threshold on
  // disk raises an unhandled ValueError -> a bare 500 with no useful detail.
  it('500 with an unparseable body -> stated server error', () => {
    const e = normalizeError(500, undefined)
    expect(e.kind).toBe('server')
    expect(e.message).toContain('500')
  })

  it('500 with an HTML body (not JSON) -> stated server error', () => {
    const e = normalizeError(502, '<html>Bad Gateway</html>')
    expect(e.kind).toBe('server')
    expect(e.message).toContain('502')
  })

  it('an unhandled status -> unknown, still readable', () => {
    const e = normalizeError(418, {})
    expect(e.kind).toBe('unknown')
    expect(e.message).toContain('418')
  })
})

describe('normalizeError -- the "[object Object]" invariant', () => {
  // SC-011: zero rejections may surface as a generic failure. String(detail)
  // yields "[object Object]" for shapes 3 and 4 -- this is the regression guard.
  const bodies: unknown[] = [
    { detail: 'a string' },
    { detail: [{ loc: ['body', 'x'], msg: 'bad', type: 't' }] },
    { detail: { field_errors: { a: 'bad' } } },
    { detail: { reason: 'scan_pending', message: 'queued', retry_after_ms: 3000 } },
    { detail: { unexpected: { nested: true } } },
    { detail: null },
    { detail: 42 },
    {},
    undefined,
    null,
    'plain text',
    [],
  ]

  it.each([400, 401, 404, 409, 422, 500, 503])('never emits "[object Object]" at %i', (status) => {
    for (const body of bodies) {
      const e = normalizeError(status, body)
      expect(e.message).not.toContain('[object Object]')
      expect(e.message.length).toBeGreaterThan(0)
      expect(typeof e.message).toBe('string')
    }
  })

  it('stringifies a non-string field_errors value instead of coercing it', () => {
    const e = normalizeError(422, { detail: { field_errors: { sites: ['a', 'b'] } } })
    expect(e.fieldErrors?.sites).toBe('["a","b"]')
    expect(e.message).not.toContain('[object Object]')
  })
})

describe('networkError / isApiError / isAbortError', () => {
  it('network failure -> status 0, kind network, names the base URL', () => {
    const e = networkError(new TypeError('Failed to fetch'), 'http://localhost:8000')
    expect(e.status).toBe(0)
    expect(e.kind).toBe('network')
    expect(e.message).toContain('http://localhost:8000')
  })

  it('isApiError narrows only ApiError', () => {
    expect(isApiError(networkError(null, 'x'))).toBe(true)
    expect(isApiError(new Error('plain'))).toBe(false)
    expect(isApiError('nope')).toBe(false)
    expect(isApiError(null)).toBe(false)
  })

  // An aborted request is a cancellation, not a failure -- it must reach
  // TanStack Query raw rather than becoming an error state.
  it('isAbortError detects DOMException and named Errors, not others', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    const named = new Error('aborted')
    named.name = 'AbortError'
    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

describe('isPageLevelFailure -- the composition rule', () => {
  it('ALL queries failed with network -> one page-level error', () => {
    expect(isPageLevelFailure([err('network', 0), err('network', 0), err('network', 0)])).toBe(true)
  })

  it('a SUBSET failed -> per-query (a healthy state must not be blanked)', () => {
    expect(isPageLevelFailure([err('network', 0), null, err('network', 0)])).toBe(false)
    expect(isPageLevelFailure([null, null])).toBe(false)
  })

  it('all failed but NOT all network -> per-query (specific reasons must survive)', () => {
    expect(isPageLevelFailure([err('network', 0), err('validation', 422)])).toBe(false)
    expect(isPageLevelFailure([err('server', 500), err('server', 500)])).toBe(false)
    expect(isPageLevelFailure([err('conflict', 409)])).toBe(false)
  })

  it('no queries -> not a page-level failure', () => {
    expect(isPageLevelFailure([])).toBe(false)
  })

  it('a single network failure on a one-query page IS page-level', () => {
    expect(isPageLevelFailure([err('network', 0)])).toBe(true)
  })
})
