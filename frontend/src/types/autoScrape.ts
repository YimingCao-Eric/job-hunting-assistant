export interface AutoScrapeState {
  id: number;
  state: {
    enabled: boolean;
    test_cycle_pending: boolean;
    exit_requested: boolean;
    config_change_pending: boolean;
    cycle_id: number;
    cycle_phase: string;
    extension_instance_id: string | null;
    matrix_position?: { site_index: number; keyword_index: number };
    cycle_results?: {
      scans_attempted: number;
      scans_succeeded: number;
      scans_failed: number;
      failures_by_reason: Record<string, number>;
    };
    consecutive_precheck_failures: number;
    next_cycle_at: number;
    last_cycle_summary_id: string | null;
    last_cycle_completed_at: string | null;
    min_cycle_interval_ms: number;
    clean_cycles_count: number;
    consecutive_precheck_failures?: number;
  };
  last_sw_heartbeat_at: string | null;
  updated_at: string;
}

export interface AutoScrapeCycle {
  id: string;
  cycle_id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  phase_heartbeat_at: string | null;
  precheck_status: string | null;
  precheck_details: Record<string, unknown> | null;
  scans_attempted: number;
  scans_succeeded: number;
  scans_failed: number;
  failures_by_reason: Record<string, number> | null;
  run_log_ids: string[] | null;
  postcheck_status: string | null;
  postcheck_details: Record<string, unknown> | null;
  cleanup_results: Record<string, unknown> | null;
  dedup_task_id: string | null;
  match_results: Record<string, unknown> | null;
  apply_results: Record<string, unknown> | null;
  error_message: string | null;
  notes: string | null;
}

export interface SessionState {
  site: string;
  last_probe_status: string;
  last_probe_at: string;
  consecutive_failures: number;
  notified_user: boolean;
  backoff_multiplier: number;
  updated_at: string;
}

export interface AutoScrapeConfig {
  config: {
    enabled_sites?: string[];
    keywords?: string[];
    min_cycle_interval_minutes?: number;
    inter_scan_delay_seconds?: number;
    scan_timeout_minutes?: number;
    max_consecutive_precheck_failures?: number;
    max_consecutive_dead_session_cycles?: number;
    [key: string]: unknown;
  };
  updated_at: string;
}

export interface ConfigLimits {
  limits: Record<string, { min: number; max: number; recommended: number }>;
  derived_limits: {
    max_keywords?: number;
    max_scans_per_cycle_hard?: number;
    max_scans_per_cycle_warn?: number;
    valid_sites?: string[];
    [key: string]: unknown;
  };
}

export interface ConfigUpdateResponse {
  config: Record<string, unknown>;
  warnings: string[];
  next_cycle_estimated_at?: string | null;
}
