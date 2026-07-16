import { get, post, put, type RequestOptions } from '@/lib/api/client'
import type {
  AutoScrapeConfigLimits,
  AutoScrapeConfigRead,
  AutoScrapeConfigUpdate,
  AutoScrapeConfigUpdateResponse,
  AutoScrapeInstances,
  AutoScrapeStateRead,
  Cycle,
  SiteSession,
} from '@/types/autoScrape'
import type { SourceSite } from '@/types/job'

const BASE = '/admin/auto-scrape'

/**
 * /admin/auto-scrape/*. See contracts/backend-bindings.md, Surface 4.
 *
 * ======================= FR-046: PUT /state IS NOT BOUND =======================
 * `PUT /admin/auto-scrape/state` is a WHOLE-OBJECT REPLACEMENT
 * (row.state = body.state, routers/auto_scrape.py:132). It is the service
 * worker's channel for pushing its full state; any partial write from here
 * would SILENTLY DESTROY every key we did not send.
 *
 * The mutator endpoints below exist precisely so a client can change one thing
 * without owning the whole object. FR-046 is therefore satisfied by NOT HAVING
 * THE CAPABILITY -- which is stronger than satisfying it by careful merging.
 * Do not add a putState() here. (research R17)
 * ==============================================================================
 *
 * Naming, as-built and consumed verbatim:
 *   "status"        -> GET /state      (there is NO /status route)
 *   "stop-and-exit" -> POST /shutdown  (sets exit_requested: true)
 *   "test cycle"    -> POST /test-cycle
 *   session reset   -> POST /reset-session/{site}  (singular; the update route
 *                      is plural /sessions/{site} -- inconsistent, as-built)
 */

// ---------- reads ----------

/** FR-037/FR-038. 500 {"detail": "auto_scrape_state missing"} if the singleton is absent. */
export const fetchState = (o?: RequestOptions) => get<AutoScrapeStateRead>(`${BASE}/state`, o)

/** FR-039. count > 1 -> warn. Errors SURFACE -- see the note in useAutoScrape. */
export const fetchInstances = (o?: RequestOptions) => get<AutoScrapeInstances>(`${BASE}/instances`, o)

export const fetchConfig = (o?: RequestOptions) => get<AutoScrapeConfigRead>(`${BASE}/config`, o)

/** FR-044: THE source of truth for validation. Never hardcode these bounds. */
export const fetchConfigLimits = (o?: RequestOptions) =>
  get<AutoScrapeConfigLimits>(`${BASE}/config/limits`, o)

/** FR-041. Bare array; limit default 10, ge=1 le=100, NO offset -> cannot page past 100. */
export const fetchCycles = (limit = 10, o?: RequestOptions) =>
  get<Cycle[]>(`${BASE}/cycles`, { ...o, query: { limit } })

/** FR-043. Bare array. `site` is the PK -- there is no `id` field. */
export const fetchSessions = (o?: RequestOptions) => get<SiteSession[]>(`${BASE}/sessions`, o)

// ---------- mutators (server-side; the FR-046-safe way to change state) ----------

/** Zeroes every consecutive_* key and sets enabled: true, config_change_pending: false
 *  (auto_scrape.py:377-392). FR-037's "counters shown as cleared" comes from the
 *  RESPONSE, not from a client-side assumption. */
export const enableLoop = (o?: RequestOptions) => post<AutoScrapeStateRead>(`${BASE}/enable`, undefined, o)

export const pauseLoop = (o?: RequestOptions) => post<AutoScrapeStateRead>(`${BASE}/pause`, undefined, o)

/** "Stop-and-exit". Sets exit_requested: true. DESTRUCTIVE -> ConfirmDialog (FR-011).
 *  FR-040: a REQUEST the extension acts on asynchronously, not a completed stop. */
export const shutdownLoop = (o?: RequestOptions) =>
  post<AutoScrapeStateRead>(`${BASE}/shutdown`, undefined, o)

/** Sets test_cycle_pending: true. FR-040: a request, not an action. */
export const requestTestCycle = (o?: RequestOptions) =>
  post<AutoScrapeStateRead>(`${BASE}/test-cycle`, undefined, o)

export const resetCounters = (o?: RequestOptions) =>
  post<AutoScrapeStateRead>(`${BASE}/reset-counters`, undefined, o)

/** FR-043. Sets consecutive_failures=0, notified_user=false, backoff_multiplier=1.0,
 *  last_probe_status='unknown'. DESTRUCTIVE -> ConfirmDialog (FR-011). */
export const resetSession = (site: SourceSite, o?: RequestOptions) =>
  post<SiteSession>(`${BASE}/reset-session/${site}`, undefined, o)

/**
 * FR-044. A SHALLOW merge server-side: top-level keys are replaced wholesale and
 * arrays are NOT merged element-wise (_merge_config, auto_scrape.py:72-77), so
 * editing `keywords` means sending the COMPLETE new array.
 *
 * Same exclude_unset mechanism as /config, so FR-045's dead fields
 * (run_dedup_after_scrape, run_matching_after_dedup, run_apply_after_matching)
 * are preserved BY OMISSION -- never send them.
 *
 * 422 -> {"detail": {"field_errors": {...}}} (shape 3), normalized to
 * ApiError.fieldErrors. A 200 may still carry warnings[] (FR-044).
 */
export const saveConfig = (body: AutoScrapeConfigUpdate, o?: RequestOptions) =>
  put<AutoScrapeConfigUpdateResponse>(`${BASE}/config`, body, o)

/** Returns the full ConfigRead envelope, while saveConfig returns
 *  ConfigUpdateResponse. The asymmetry is as-built. */
export const resetConfig = (o?: RequestOptions) =>
  post<AutoScrapeConfigRead>(`${BASE}/config/reset`, undefined, o)
