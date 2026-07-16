/**
 * Mirrors `SearchConfigRead` (backend/schemas/config.py:6-41). Backed by a JSON
 * FILE (settings.config_path, default /app/data/config.json), not the database.
 */

export interface SearchConfig {
  // --- general ---
  website: string
  keyword: string
  location: string
  general_date_posted: number
  general_internship_only: boolean
  general_remote_only: boolean
  allowed_languages: string[]
  no_contract: boolean
  remote_only: boolean
  needs_sponsorship: boolean
  no_agency: boolean
  salary_min: number
  blacklist_companies: string[]
  blacklist_locations: string[]
  blacklist_titles: string[]
  target_titles: string[]

  // --- linkedin ---
  f_tpr_bound: number
  f_experience: string | null
  f_job_type: string | null
  f_remote: string | null
  linkedin_f_tpr: string | null

  // --- indeed ---
  indeed_keyword: string | null
  indeed_location: string | null
  indeed_fromage: number
  indeed_remotejob: boolean | null
  indeed_jt: string | null
  indeed_sort: string
  indeed_radius: number | null
  indeed_explvl: string | null
  indeed_lang: string | null

  // --- glassdoor ---
  glassdoor: Record<string, unknown> | null
}

/**
 * THE DEAD FIELDS ARE MODELLED BY EXCLUSION.
 *
 * `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold` and
 * `cpu_binary_threshold` exist on the backend schema and are deliberately absent
 * from SearchConfig. PUT /config is an `exclude_unset` merge, so A FIELD NEVER
 * SENT IS A FIELD NEVER TOUCHED -- that is the whole FR-018 mechanism.
 *
 * Not sending is strictly SAFER than round-tripping: round-tripping re-submits
 * them through _validate_scoring_config, which can reject a file that was
 * already on disk. (research R11)
 */
export type SearchConfigUpdate = Partial<SearchConfig>

/** Ephemeral, not a backend entity. Drives FR-019/FR-020/FR-021. */
export interface ConfigFormState {
  /** Last server truth. Re-seeded FROM THE SAVE RESPONSE, never from the draft. */
  saved: SearchConfig | null
  /** Current form values. The search preview renders from THIS (FR-019). */
  draft: SearchConfig | null
  isDirty: boolean
  fieldErrors: Record<string, string>
}
