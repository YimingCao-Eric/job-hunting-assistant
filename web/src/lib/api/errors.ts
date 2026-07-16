/**
 * The four-shape -> one-ApiError normalizer. See contracts/error-model.md.
 *
 * THE BACKEND RETURNS FOUR INCOMPATIBLE `detail` TYPES:
 *   1. {"detail": "<string>"}                          /config 422, all 401s, all 404s
 *   2. {"detail": [{loc, msg, type}, ...]}             FastAPI body/param validation
 *   3. {"detail": {"field_errors": {...}}}             PUT /admin/auto-scrape/config 422
 *   4. {"detail": {reason, message, retry_after_ms}}   POST /extension/trigger-scan 409
 *
 * Both obvious implementations fail, in OPPOSITE directions:
 *   - Assuming FastAPI's [{loc,msg}] array breaks on every /config error, which
 *     is exactly FR-021's path (shape 1 is a plain string).
 *   - String(detail) yields "[object Object]" for shapes 3 and 4 -- the precise
 *     generic failure SC-011 forbids.
 * So `detail` MUST be discriminated by RUNTIME TYPE before it is read.
 *
 * This is the ONLY place an error body is parsed (FR-010).
 */

export type ApiErrorKind =
  | 'network'
  | 'unauthorized'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'server'
  | 'unknown'

/** The three scan-rejection reasons (SC-011). Each gets a distinct message. */
export type ScanRejectionReason = 'scan_pending' | 'stop_cooldown' | 'scan_in_progress'

interface ApiErrorInit {
  status: number
  kind: ApiErrorKind
  message: string
  fieldErrors?: Record<string, string>
  reason?: ScanRejectionReason
  retryAfterMs?: number
  cause?: unknown
}

export class ApiError extends Error {
  /** HTTP status; 0 for network/abort failures. */
  readonly status: number
  readonly kind: ApiErrorKind
  /** Shapes 2 and 3. Keyed by field name. */
  readonly fieldErrors?: Record<string, string>
  /** Shape 4 only. */
  readonly reason?: ScanRejectionReason
  readonly retryAfterMs?: number

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'ApiError'
    this.status = init.status
    this.kind = init.kind
    this.fieldErrors = init.fieldErrors
    this.reason = init.reason
    this.retryAfterMs = init.retryAfterMs
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/**
 * Rule 2: an aborted request is NOT a failure. The client rethrows it raw so
 * TanStack Query sees a cancellation rather than an error state.
 */
export function isAbortError(value: unknown): boolean {
  return value instanceof DOMException
    ? value.name === 'AbortError'
    : value instanceof Error && value.name === 'AbortError'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Coerce a field_errors map to strings without ever producing "[object Object]". */
function toStringRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

function summarize(fieldErrors: Record<string, string>): string {
  const entries = Object.entries(fieldErrors)
  if (entries.length === 0) return 'The backend rejected this request.'
  if (entries.length === 1) {
    const [field, msg] = entries[0]
    return `${field}: ${msg}`
  }
  return `${entries.length} fields were rejected: ${entries.map(([f]) => f).join(', ')}.`
}

/** Rule 1: fetch rejected -- network down, DNS, or CORS. */
export function networkError(cause: unknown, baseUrl: string): ApiError {
  return new ApiError({
    status: 0,
    kind: 'network',
    message: `Could not reach the backend at ${baseUrl}.`,
    cause,
  })
}

/**
 * Rules 3-10, applied in order. `detail` is discriminated by runtime type --
 * never assumed. Rules 5 and 6 check for the DISCRIMINATING KEY, not the status
 * alone, because both are objects and only the key tells them apart.
 *
 * INVARIANT: `message` is always human-readable and always safe to render.
 */
export function normalizeError(status: number, body: unknown): ApiError {
  const detail = isRecord(body) ? body.detail : undefined

  // Rule 3 -- 401. Handled ONCE in the shell, not per page.
  if (status === 401) {
    return new ApiError({
      status,
      kind: 'unauthorized',
      message: 'The configured credential was rejected by the backend.',
    })
  }

  // Rule 4 -- 404. detail is shape 1.
  if (status === 404) {
    return new ApiError({
      status,
      kind: 'not_found',
      message: typeof detail === 'string' ? detail : 'The requested resource was not found.',
    })
  }

  // Rule 5 -- shape 4. 409 AND a `reason` key.
  if (status === 409 && isRecord(detail) && typeof detail.reason === 'string') {
    return new ApiError({
      status,
      kind: 'conflict',
      reason: detail.reason as ScanRejectionReason,
      message:
        typeof detail.message === 'string'
          ? detail.message
          : 'The backend refused this request because it conflicts with work already in progress.',
      retryAfterMs: typeof detail.retry_after_ms === 'number' ? detail.retry_after_ms : undefined,
    })
  }

  // Rule 6 -- shape 3. A `field_errors` key.
  if (isRecord(detail) && isRecord(detail.field_errors)) {
    const fieldErrors = toStringRecord(detail.field_errors)
    return new ApiError({ status, kind: 'validation', fieldErrors, message: summarize(fieldErrors) })
  }

  // Rule 7 -- shape 2. FastAPI's array, keyed by the LAST loc segment.
  if (Array.isArray(detail)) {
    const fieldErrors: Record<string, string> = {}
    let firstMessage: string | undefined
    for (const item of detail) {
      if (!isRecord(item)) continue
      const msg = typeof item.msg === 'string' ? item.msg : 'Invalid value.'
      firstMessage ??= msg
      const loc = Array.isArray(item.loc) ? item.loc : []
      const field = loc.length > 0 ? String(loc[loc.length - 1]) : '_'
      fieldErrors[field] = msg
    }
    return new ApiError({
      status,
      kind: 'validation',
      fieldErrors,
      message: firstMessage ?? 'The backend rejected this request.',
    })
  }

  // Rule 8 -- shape 1. NOT FastAPI's usual 422 shape.
  if (typeof detail === 'string') {
    return new ApiError({
      status,
      kind: status === 422 ? 'validation' : 'server',
      message: detail,
    })
  }

  // Rule 9 -- a 500 whose body is unparseable or absent. NOT defensive padding:
  // a non-numeric cpu_strong_threshold already on disk raises an unhandled
  // ValueError (routers/config.py:23-24), and a missing site_session row raises
  // NoResultFound -- both are bare 500s with no useful detail.
  if (status >= 500) {
    return new ApiError({
      status,
      kind: 'server',
      message: `The backend failed to handle this request (HTTP ${status}).`,
    })
  }

  // Rule 10.
  return new ApiError({
    status,
    kind: 'unknown',
    message: `Unexpected response from the backend (HTTP ${status}).`,
  })
}

/**
 * The error COMPOSITION RULE (contracts/ui-primitives.md, rule 5a).
 *
 * "The backend is down" is ONE fact and deserves one statement; "these four
 * things each failed differently" is FOUR facts and deserves four.
 *
 * Returns true only when every query on a page has failed AND every failure is
 * a network failure -> the page renders ONE page-level ErrorState. A subset
 * failing, or any non-network failure, stays scoped per query so the specific
 * reason FR-016 requires survives.
 */
export function isPageLevelFailure(
  errors: ReadonlyArray<ApiError | null | undefined>,
): boolean {
  if (errors.length === 0) return false
  return errors.every((e) => e != null && e.kind === 'network')
}
