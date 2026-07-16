import type { SourceSite } from '@/types/job'

/**
 * Mirrors the /admin/auto-scrape/* schemas (backend/schemas/auto_scrape.py).
 *
 * The old version of this file DID NOT COMPILE: it declared
 * `consecutive_precheck_failures` twice (line 18 required, line 24 optional)
 * -- a genuine TS2300 that shipped because no script ever ran tsc and ESLint
 * never touched .ts. Declared exactly once below.
 */

export interface AutoScrapeStateRead {
  /** Always 1 -- singleton, CHECK id=1. */
  id: number
  state: AutoScrapeState
  last_sw_heartbeat_at: string | null
  updated_at: string
}

/**
 * `state` is a FREE-FORM JSONB dict server-side -- not typed, not validated,
 * shaped only by a migration seed (023_auto_scrape_foundations.py:34-52).
 * This interface is OUR READING CONTRACT, not a server guarantee; hence the
 * index signature (Constitution Principle VII).
 */
export interface AutoScrapeState {
  enabled: boolean
  test_cycle_pending: boolean
  exit_requested: boolean
  config_change_pending: boolean
  cycle_id: number
  /** 'idle' | 'scrape_running' | 'postscrape_running'. Typed `string`, not a
   *  union: it is an opaque key in a free-form dict with no server validation
   *  (tests write 'test_put' into it). */
  cycle_phase: string
  extension_instance_id: string | null
  matrix_position: { site_index: number; keyword_index: number }
  cycle_results: {
    scans_attempted: number
    scans_succeeded: number
    scans_failed: number
    failures_by_reason: Record<string, number>
  }
  /** Declared ONCE. See the file header. */
  consecutive_precheck_failures: number
  /** Epoch MILLISECONDS. 0 | '0' | null all mean "unscheduled" -- the sentinel
   *  is polymorphic (routers/auto_scrape.py:88-98). Normalize on read. */
  next_cycle_at: number | string | null
  last_cycle_summary_id: string | null
  last_cycle_completed_at: string | null
  min_cycle_interval_ms: number
  clean_cycles_count: number
  [key: string]: unknown
}

export interface AutoScrapeInstances {
  instances: { instance_id: string; last_heartbeat_at: string }[]
  /** > 1 -> warn (FR-039). Concurrent instances corrupt cycle accounting. */
  count: number
}

/** NOTE the inconsistent underscore: `scrape_complete` but `post_scrape_complete`.
 *  As-built (schemas/auto_scrape.py:28-36). A real Literal server-side, unlike
 *  RunLog.status, so a closed union is honest here. */
export type CycleStatus =
  | 'scrape_running'
  | 'scrape_complete'
  | 'postscrape_running'
  | 'post_scrape_complete'
  | 'failed'

export interface Cycle {
  /** The uuid ROW id. */
  id: string
  /** The integer cycle NUMBER the operator sees (FR-041). Display this. */
  cycle_id: number
  started_at: string
  completed_at: string | null
  status: CycleStatus
  phase_heartbeat_at: string | null
  precheck_status: string | null
  precheck_details: Record<string, unknown> | null
  scans_attempted: number
  scans_succeeded: number
  scans_failed: number
  failures_by_reason: Record<string, number> | null
  run_log_ids: string[] | null
  postcheck_status: string | null
  postcheck_details: Record<string, unknown> | null
  cleanup_results: Record<string, unknown> | null
  /** ALWAYS null -- dedup retired. Not displayed (FR-004). */
  dedup_task_id: string | null
  match_results: Record<string, unknown> | null
  apply_results: Record<string, unknown> | null
  error_message: string | null
  notes: string | null
}

/** The one vocabulary with a real DB CHECK constraint
 *  (ck_site_session_states_probe_status, migration 023) as well as a Literal. */
export type ProbeStatus = 'live' | 'expired' | 'captcha' | 'rate_limited' | 'unknown'

export interface SiteSession {
  /** The PRIMARY KEY. There is no `id` field. */
  site: SourceSite
  last_probe_status: ProbeStatus
  last_probe_at: string
  consecutive_failures: number
  notified_user: boolean
  /** rate_limited doubles it, capped at 64.0. */
  backoff_multiplier: number
  updated_at: string
}

export interface AutoScrapeConfigRead {
  config: AutoScrapeConfig
  updated_at: string
}

export interface AutoScrapeConfig {
  enabled_sites: string[]
  keywords: string[]
  min_cycle_interval_minutes: number
  inter_scan_delay_seconds: number
  scan_timeout_minutes: number
  max_consecutive_precheck_failures: number
  max_consecutive_dead_session_cycles: number
  /** FR-045 dead fields: hidden, and NEVER sent (omission preserves them). */
  run_dedup_after_scrape: boolean
  run_matching_after_dedup: boolean
  run_apply_after_matching: boolean
}

export type AutoScrapeConfigUpdate = Partial<AutoScrapeConfig>

/** PUT /config returns THIS, while POST /config/reset returns the full
 *  AutoScrapeConfigRead envelope. The asymmetry is as-built. */
export interface AutoScrapeConfigUpdateResponse {
  config: AutoScrapeConfig
  /** sites x keywords >= 15 -> a warning on a 200, NOT an error. FR-044
   *  requires rendering these on success, not just field errors. */
  warnings: string[]
  next_cycle_estimated_at: string | null
}

export interface LimitRange {
  min: number
  max: number
  recommended: number
}

/** THE source of truth for orchestrator validation (FR-044). Never hardcode. */
export interface AutoScrapeConfigLimits {
  limits: Record<string, LimitRange>
  /** NOTE: valid_sites is nested INSIDE derived_limits in the response, even
   *  though get_limits() returns it as a sibling. Bind to the response. */
  derived_limits: {
    max_keywords: number
    max_scans_per_cycle_hard: number
    max_scans_per_cycle_warn: number
    valid_sites: string[]
  }
}

/** Derived, not a backend field. FR-038. */
export type HeartbeatGrade = 'fresh' | 'aging' | 'stale' | 'never'
