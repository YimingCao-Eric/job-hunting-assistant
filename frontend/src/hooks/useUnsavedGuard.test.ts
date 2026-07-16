import { describe, expect, it } from 'vitest'

import { shouldBlockNavigation } from '@/hooks/useUnsavedGuard'

/**
 * FR-020's decision. The dialog rendering and the actual interception are
 * react-router's job (useBlocker, which needs the data router) and are verified
 * by hand via quickstart S6.9 -- this covers the logic that decides.
 */
describe('shouldBlockNavigation -- FR-020', () => {
  it('blocks leaving a dirty form for another page', () => {
    expect(shouldBlockNavigation(true, '/', '/jobs')).toBe(true)
    expect(shouldBlockNavigation(true, '/', '/dashboard/auto-scrape')).toBe(true)
  })

  it('does NOT block when the form is clean', () => {
    expect(shouldBlockNavigation(false, '/', '/jobs')).toBe(false)
  })

  it('does NOT block a same-path navigation, even when dirty', () => {
    // A search-param or hash change is not leaving the form. Prompting here
    // would train the operator to dismiss the dialog without reading it.
    expect(shouldBlockNavigation(true, '/', '/')).toBe(false)
    expect(shouldBlockNavigation(true, '/jobs', '/jobs')).toBe(false)
  })

  it('is dirty-gated: a clean same-path move is also fine', () => {
    expect(shouldBlockNavigation(false, '/', '/')).toBe(false)
  })
})
