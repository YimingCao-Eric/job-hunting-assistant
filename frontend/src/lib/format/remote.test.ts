import { describe, expect, it } from 'vitest'

import { formatRemote, remoteTitle } from '@/lib/format/remote'

describe('formatRemote -- the tri-state', () => {
  it('true -> Remote', () => {
    expect(formatRemote(true)).toBe('Remote')
  })

  it('false -> On-site', () => {
    expect(formatRemote(false)).toBe('On-site')
  })

  // THE test. null means the site did not say -- not that the job is on-site.
  it('null -> "—" and NEVER "On-site"', () => {
    expect(formatRemote(null)).toBe('—')
    expect(formatRemote(null)).not.toBe('On-site')
  })

  it('undefined -> "—" and never "On-site" (defensive: field omitted entirely)', () => {
    expect(formatRemote(undefined)).toBe('—')
    expect(formatRemote(undefined)).not.toBe('On-site')
  })

  it('ONLY an explicit false ever produces "On-site"', () => {
    const inputs: Array<boolean | null | undefined> = [true, false, null, undefined]
    const onSite = inputs.filter((v) => formatRemote(v) === 'On-site')
    expect(onSite).toEqual([false])
  })
})

describe('formatRemote -- the Glassdoor case (research R4)', () => {
  // projection.py:245 -> `True if p.get("remote_work_types") else None`.
  // Glassdoor emits true or null, NEVER false. Live corpus: 64 null, 0 false.
  it('a non-remote Glassdoor job (null) is not claimed to be on-site', () => {
    const glassdoorRemoteValues: Array<boolean | null> = [null, true, null, null]
    const rendered = glassdoorRemoteValues.map(formatRemote)
    expect(rendered).toEqual(['—', 'Remote', '—', '—'])
    expect(rendered).not.toContain('On-site')
  })

  it('demonstrates the bug this guards against', () => {
    const naive = (r: boolean | null) => (r ? 'Remote' : 'On-site')
    // The naive version invents a fact the backend never asserted:
    expect(naive(null)).toBe('On-site')
    // Ours does not:
    expect(formatRemote(null)).toBe('—')
  })
})

describe('remoteTitle', () => {
  it('explains only the absent case', () => {
    expect(remoteTitle(null)).toBe('The source site did not state this')
    expect(remoteTitle(undefined)).toBe('The source site did not state this')
    expect(remoteTitle(true)).toBeUndefined()
    expect(remoteTitle(false)).toBeUndefined()
  })
})
