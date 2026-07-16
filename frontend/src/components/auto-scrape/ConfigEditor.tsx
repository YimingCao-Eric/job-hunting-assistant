import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { useAutoScrape } from '@/hooks/useAutoScrape'
import type {
  AutoScrapeConfig,
  AutoScrapeConfigLimits,
  AutoScrapeConfigUpdate,
} from '@/types/autoScrape'

/**
 * FR-044: the orchestrator's own settings, VALIDATED AGAINST THE BACKEND'S
 * PUBLISHED LIMITS (GET /config/limits) -- never hardcoded.
 *
 * The old ConfigEditor violated the stack boundary ("the React UI triggers and
 * displays, it does not own business logic") three ways, all fixed here:
 *   - hardcoded fallbacks `?? 10`, `?? 30`, `?? 12` that could silently drift
 *     from the server's real limits
 *   - a hardcoded site list at :112, while limits.derived_limits.valid_sites was
 *     fetched and never used
 *   - a magic `~{scansPerCycle * 4} min` estimate with no backend basis (dropped)
 *
 * And its worst bug: handleSave/handleReset were `try { ... } finally
 * { setBusy(false) }` with NO CATCH -- a failed save was COMPLETELY INVISIBLE,
 * surfacing only as an unhandled rejection. Errors surface here.
 */

/** FR-045: hidden AND never sent. Omission preserves them via exclude_unset. */
const DEAD_FIELDS = ['run_dedup_after_scrape', 'run_matching_after_dedup', 'run_apply_after_matching'] as const

const NUMERIC_FIELDS = [
  { key: 'min_cycle_interval_minutes', label: 'Min cycle interval (minutes)' },
  { key: 'inter_scan_delay_seconds', label: 'Inter-scan delay (seconds)' },
  { key: 'scan_timeout_minutes', label: 'Scan timeout (minutes)' },
  { key: 'max_consecutive_precheck_failures', label: 'Max consecutive precheck failures' },
  { key: 'max_consecutive_dead_session_cycles', label: 'Max consecutive dead-session cycles' },
] as const

export interface ConfigEditorProps {
  config: AutoScrapeConfig
  limits: AutoScrapeConfigLimits
  mutations: ReturnType<typeof useAutoScrape>['mutations']
}

/**
 * NOTE: the draft is seeded from `config` ONCE, at mount. Re-seeding on change
 * is handled by the PARENT keying this component on the server's `updated_at`,
 * which remounts it after a save or reset.
 *
 * The obvious `useEffect(() => setDraft(config), [config])` is wrong twice over:
 * it cascades an extra render, and it would silently clobber the operator's
 * unsaved edits on any refetch. (Caught by react-hooks/set-state-in-effect --
 * the rule the old config never ran.)
 */
export function ConfigEditor({ config, limits, mutations }: ConfigEditorProps) {
  const [draft, setDraft] = useState<AutoScrapeConfig>(config)
  const { saveConfig, resetConfig } = mutations

  // From the server. NOT hardcoded -- note valid_sites is nested INSIDE
  // derived_limits in the response, even though get_limits() returns it as a
  // sibling. Bind to the response shape, not the function's.
  const validSites = limits.derived_limits.valid_sites
  const maxKeywords = limits.derived_limits.max_keywords
  const warnAt = limits.derived_limits.max_scans_per_cycle_warn
  const hardMax = limits.derived_limits.max_scans_per_cycle_hard

  const scansPerCycle = draft.enabled_sites.length * draft.keywords.length
  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])

  const fieldErrors = saveConfig.isError ? (saveConfig.error.fieldErrors ?? {}) : {}

  const toggleSite = (site: string) =>
    setDraft((d) => ({
      ...d,
      enabled_sites: d.enabled_sites.includes(site)
        ? d.enabled_sites.filter((s) => s !== site)
        : [...d.enabled_sites, site],
    }))

  const save = () => {
    // FR-045: send ONLY the fields this form owns. The three dead pipeline
    // toggles are never sent, which is exactly what preserves them.
    const body: AutoScrapeConfigUpdate = {
      enabled_sites: draft.enabled_sites,
      // A shallow merge server-side replaces top-level keys wholesale and does
      // NOT merge arrays element-wise -- so send the COMPLETE array.
      keywords: draft.keywords,
      min_cycle_interval_minutes: draft.min_cycle_interval_minutes,
      inter_scan_delay_seconds: draft.inter_scan_delay_seconds,
      scan_timeout_minutes: draft.scan_timeout_minutes,
      max_consecutive_precheck_failures: draft.max_consecutive_precheck_failures,
      max_consecutive_dead_session_cycles: draft.max_consecutive_dead_session_cycles,
    }
    saveConfig.mutate(body)
  }

  const warnings = saveConfig.isSuccess
    ? ((saveConfig.data as { warnings?: string[] } | undefined)?.warnings ?? [])
    : []

  return (
    <Card
      title="Orchestrator settings"
      actions={
        <div className="flex items-center gap-2">
          {isDirty ? <Badge tone="info">Unsaved changes</Badge> : null}
          <Button variant="secondary" size="sm" busy={resetConfig.isPending} onClick={() => resetConfig.mutate()}>
            Reset to defaults
          </Button>
          <Button variant="primary" size="sm" busy={saveConfig.isPending} disabled={!isDirty} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="text-xs font-medium text-text-muted">Enabled sites</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {/* From the server's valid_sites -- the old code fetched this and
                then hardcoded the list anyway. */}
            {validSites.map((site) => {
              const on = draft.enabled_sites.includes(site)
              return (
                <button
                  key={site}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSite(site)}
                  className={[
                    'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    on
                      ? 'border-accent bg-accent text-text-inverse'
                      : 'border-border bg-surface-card text-text-secondary hover:bg-surface-raised',
                  ].join(' ')}
                >
                  {site}
                </button>
              )
            })}
          </div>
          {fieldErrors.enabled_sites ? (
            <p role="alert" className="mt-1 text-xs text-danger-text">
              {fieldErrors.enabled_sites}
            </p>
          ) : null}
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="keywords" className="text-xs font-medium text-text-muted">
              Keywords (one per line)
            </label>
            <span className="text-xs text-text-muted tabular-nums">
              {draft.keywords.length} / {maxKeywords}
            </span>
          </div>
          <textarea
            id="keywords"
            rows={4}
            value={draft.keywords.join('\n')}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                keywords: e.target.value.split('\n').map((k) => k.trimStart()),
              }))
            }
            className="mt-1.5 w-full rounded-md border border-border bg-surface-card px-2 py-1.5 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          {fieldErrors.keywords ? (
            <p role="alert" className="mt-1 text-xs text-danger-text">
              {fieldErrors.keywords}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC_FIELDS.map(({ key, label }) => {
            const range = limits.limits[key]
            return (
              <div key={key}>
                <label htmlFor={key} className="text-xs font-medium text-text-muted">
                  {label}
                </label>
                <input
                  id={key}
                  type="number"
                  value={draft[key]}
                  // min/max/placeholder all come from the SERVER's published limits.
                  min={range?.min}
                  max={range?.max}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                  className="mt-1 w-full rounded-md border border-border bg-surface-card px-2 py-1.5 text-sm tabular-nums text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <p className="mt-0.5 text-[11px] text-text-muted">
                  {range ? `${range.min}–${range.max} (recommended ${range.recommended})` : ' '}
                </p>
                {fieldErrors[key] ? (
                  <p role="alert" className="text-xs text-danger-text">
                    {fieldErrors[key]}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>

        {/* `scans_per_cycle` is a SYNTHETIC field key, not a config field:
            > hardMax -> a 422 field_error; >= warnAt -> a warning on a 200. */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
          <span className="text-xs text-text-secondary">
            {draft.keywords.length} keywords × {draft.enabled_sites.length} sites ={' '}
            <span className="font-medium tabular-nums text-text-primary">{scansPerCycle}</span>{' '}
            scans/cycle
          </span>
          {scansPerCycle > hardMax ? (
            <Badge tone="danger">over the {hardMax} maximum</Badge>
          ) : scansPerCycle >= warnAt ? (
            <Badge tone="warning">at or above the {warnAt} warning threshold</Badge>
          ) : null}
          {fieldErrors.scans_per_cycle ? (
            <p role="alert" className="text-xs text-danger-text">
              {fieldErrors.scans_per_cycle}
            </p>
          ) : null}
        </div>

        {/* FR-044: warnings arrive on a 200 and must be rendered on SUCCESS,
            not only on failure. */}
        {warnings.length > 0 ? (
          <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2">
            {warnings.map((w) => (
              <p key={w} className="text-xs text-warning-text">
                {w}
              </p>
            ))}
          </div>
        ) : null}

        {saveConfig.isSuccess && warnings.length === 0 && !isDirty ? (
          <p className="text-xs text-success-text">Settings saved.</p>
        ) : null}

        {/* THE FIX. The old handleSave had try/finally with no catch, so this
            never appeared and a failed save looked identical to a successful one. */}
        {saveConfig.isError ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger-text">
            Could not save: {saveConfig.error.message}
          </p>
        ) : null}
        {resetConfig.isError ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger-text">
            Could not reset: {resetConfig.error.message}
          </p>
        ) : null}

        <p className="text-[11px] text-text-muted">
          {DEAD_FIELDS.length} retained post-scrape pipeline settings are not shown — they no longer
          drive any behaviour. Their stored values are preserved across saves.
        </p>
      </div>
    </Card>
  )
}
