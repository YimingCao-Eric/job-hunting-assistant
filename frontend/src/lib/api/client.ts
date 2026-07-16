import { isAbortError, networkError, normalizeError } from '@/lib/api/errors'

/**
 * THE single shared access layer (FR-010). This file contains the ONLY fetch()
 * call in src/, enforced by an ESLint rule -- a second access layer is a lint
 * failure, not a review comment.
 *
 * The old app had three: src/api.js (504 lines, untyped, several methods never
 * checked response.ok), src/lib/api/autoScrape.ts, and an ad-hoc env read in
 * JobsPage.jsx for the WebSocket.
 *
 * NO RUNTIME VALIDATION. Responses are cast, not parsed -- added backend keys
 * must pass through (Constitution Principle VII). Do not add Zod here.
 */

const DEFAULT_BASE_URL = 'http://localhost:8000'

/**
 * Baked in at BUILD time, as built -- the token ships in the bundle.
 * NEXT_PUBLIC_API_BASE is deliberately not read: Vite only exposes VITE_*, so
 * the old fallback was always undefined (research R19).
 */
export const apiBaseUrl = (): string => import.meta.env.VITE_API_URL || DEFAULT_BASE_URL
const authToken = (): string => import.meta.env.VITE_AUTH_TOKEN || 'dev-token'

export type QueryValue = string | number | boolean | undefined | null

export interface RequestOptions {
  query?: Record<string, QueryValue>
  signal?: AbortSignal
}

/** Drops undefined/null so an unset filter is an absent param, not `?x=undefined`. */
function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${apiBaseUrl()}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, options.query)

  const headers: Record<string, string> = {
    // Constitution Principle VII: every route except /health requires this.
    Authorization: `Bearer ${authToken()}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    })
  } catch (cause) {
    // An abort is a cancellation, not a failure -- rethrow raw so TanStack
    // Query treats it as such rather than surfacing an error state.
    if (isAbortError(cause)) throw cause
    throw networkError(cause, apiBaseUrl())
  }

  if (!response.ok) {
    // Parse defensively: several real 500s have unparseable or HTML bodies.
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      parsed = undefined
    }
    throw normalizeError(response.status, parsed)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** Typed verbs -- the one shape worth porting from the old lib/api/autoScrape.ts. */
export const get = <T>(path: string, options?: RequestOptions): Promise<T> =>
  request<T>('GET', path, undefined, options)

export const post = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>('POST', path, body, options)

export const put = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>('PUT', path, body, options)
