import { get, put, type RequestOptions } from '@/lib/api/client'
import type { SearchConfig, SearchConfigUpdate } from '@/types/config'

/**
 * /config -- search settings. Backed by a JSON FILE (settings.config_path,
 * default /app/data/config.json), not the database.
 */

/**
 * Missing file -> {} -> all defaults.
 * Malformed file -> 500 {"detail": "config.json is malformed: ..."} -- which
 * the page must report WITHOUT rendering an empty form, since an empty form
 * would overwrite the file on save.
 */
export const fetchConfig = (o?: RequestOptions) => get<SearchConfig>('/config', o)

/**
 * A PARTIAL MERGE, not a whole-object write:
 *   updates = body.model_dump(exclude_unset=True); existing.update(updates)
 * (routers/config.py:43-55). The response is the FULL MERGED config, so the
 * form re-seeds from it rather than from the local draft (the "concurrent edit"
 * edge case).
 *
 * SEND ONLY THE FIELDS THE FORM OWNS. The four dead fields
 * (dedup_fuzzy_threshold, nth_bonus_weight, cpu_strong_threshold,
 * cpu_binary_threshold) are never sent, and NOT SENDING IS WHAT PRESERVES THEM
 * (FR-018). It is strictly safer than round-tripping: round-tripping re-submits
 * them through _validate_scoring_config, which can reject a file that was
 * already on disk.
 *
 * Errors are SHAPE 1 -- {"detail": "<plain string>"} -- NOT FastAPI's usual
 * array. That is the shape a naive [{loc,msg}] handler breaks on, and it is
 * exactly FR-021's path. normalizeError discriminates by runtime type.
 *
 * Sharp edge we cannot cause but must survive: float(merged.get(
 * "cpu_strong_threshold", 0.85)) at config.py:23-24 is NOT try/except-wrapped,
 * so a non-numeric value ALREADY on disk raises an unhandled ValueError -> a
 * bare 500, not a 422.
 */
export const saveConfig = (body: SearchConfigUpdate, o?: RequestOptions) =>
  put<SearchConfig>('/config', body, o)
