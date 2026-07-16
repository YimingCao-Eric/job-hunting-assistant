import DOMPurify from 'dompurify'

/**
 * Job descriptions arrive as RAW HTML scraped from third-party sites
 * (e.g. "<div><div>Are you ready to dive into..."). That is UNTRUSTED INPUT:
 * a malicious or compromised posting could run script in the operator's
 * session -- a session whose bearer token is baked into the bundle.
 *
 * So the rule is: SANITIZE FIRST, ALWAYS. `dangerouslySetInnerHTML` is only
 * ever handed the output of `sanitizeDescription()`, never a raw field.
 *
 * This restores the formatting (bullets, bold, links, headings) that the
 * earlier plain-text extraction threw away, without trusting the source.
 */

/** Formatting only. Anything not listed is dropped, including script/style/iframe,
 *  form controls, and media (which can carry event handlers and beacon URLs). */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code',
  'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

/**
 * `href` and `title` only.
 *
 * Deliberately NOT allowed:
 *  - `style`  -- CSS can exfiltrate (background:url(...)) and can overlay the UI
 *  - `class`/`id` -- would let scraped markup collide with our own styling
 *  - `on*`    -- DOMPurify strips these anyway; the allowlist makes it explicit
 *  - `src`    -- no remote image/media loads from a scraped page
 */
const ALLOWED_ATTR = ['href', 'title']

let hookInstalled = false

/**
 * Links in a job description point at third-party sites we do not control.
 * Force them to open in a new tab and to sever the opener reference.
 * DOMPurify has already rejected javascript:/data: hrefs by this point (its
 * default ALLOWED_URI_REGEXP); this hook only hardens what survived.
 */
function installHook() {
  if (hookInstalled || !DOMPurify.isSupported) return
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  })
  hookInstalled = true
}

/** True only where a real DOM exists for DOMPurify to parse with. */
export const isSanitizerAvailable = (): boolean => DOMPurify.isSupported

/**
 * A DOM-free fallback. Regex tag-stripping is NOT a sanitizer and is never used
 * as one -- it exists only to render something safe as TEXT when no DOM is
 * available (SSR, tests), where sanitizeDescription refuses to guess.
 */
export function stripTags(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/**
 * Returns HTML that is safe to inject.
 *
 * ============================ THE CRITICAL GUARD ============================
 * When DOMPurify has no DOM to work with, `DOMPurify.sanitize()` RETURNS ITS
 * INPUT UNCHANGED rather than throwing. Injecting that would be a silent XSS
 * hole that every test in a node environment would happily pass.
 *
 * So we return '' when the sanitizer is unavailable, and the caller renders the
 * stripTags() text instead. Callers MUST check isSanitizerAvailable() -- see
 * JobDetail.
 * ===========================================================================
 */
export function sanitizeDescription(input: string | null | undefined): string {
  if (!input) return ''
  if (!DOMPurify.isSupported) return ''

  installHook()

  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Drop the content of removed dangerous elements, not just their tags.
    FORBID_CONTENTS: ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template'],
    // No <form>/<input>: a scraped page must never render something that looks
    // like our own UI asking for input.
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'style', 'link', 'meta'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Return a string, not a DocumentFragment.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  })
}

/** Does this look like markup at all? Some sites send plain text. */
export const looksLikeHtml = (s: string | null | undefined): boolean =>
  !!s && /<[a-z][\s\S]*>/i.test(s)
