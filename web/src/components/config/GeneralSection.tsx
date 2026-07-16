import { Card } from '@/components/ui/Card'
import { Check, Field } from '@/components/config/fields'
import { GRID, inputClass, listToText, textToList } from '@/components/config/fieldUtils'
import type { SearchConfig } from '@/types/config'

export interface SectionProps {
  draft: SearchConfig
  set: <K extends keyof SearchConfig>(key: K, value: SearchConfig[K]) => void
  fieldErrors: Record<string, string>
}

const LISTS = [
  ['blacklist_companies', 'Blacklisted companies'],
  ['blacklist_locations', 'Blacklisted locations'],
  ['blacklist_titles', 'Blacklisted titles'],
  ['target_titles', 'Target titles'],
] as const

/**
 * FR-017's "general settings" group.
 *
 * FR-018: `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`
 * and `cpu_binary_threshold` are absent by design — not rendered and not sent,
 * which is exactly what preserves them across the exclude_unset merge.
 */
export function GeneralSection({ draft, set, fieldErrors }: SectionProps) {
  return (
    <Card title="General">
      <div className={GRID}>
        <Field label="Default site" htmlFor="website" hint="Which site a scan targets by default.">
          <select
            id="website"
            value={draft.website}
            onChange={(e) => set('website', e.target.value)}
            className={inputClass}
          >
            <option value="linkedin">linkedin</option>
            <option value="indeed">indeed</option>
            <option value="glassdoor">glassdoor</option>
          </select>
        </Field>

        <Field label="Keyword" htmlFor="keyword" error={fieldErrors.keyword}>
          <input
            id="keyword"
            value={draft.keyword}
            onChange={(e) => set('keyword', e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Location" htmlFor="location" error={fieldErrors.location}>
          <input
            id="location"
            value={draft.location}
            onChange={(e) => set('location', e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Date posted (days)"
          htmlFor="general_date_posted"
          hint="General recency preference."
          error={fieldErrors.general_date_posted}
        >
          <input
            id="general_date_posted"
            type="number"
            min={0}
            value={draft.general_date_posted}
            onChange={(e) => set('general_date_posted', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Minimum salary" htmlFor="salary_min" error={fieldErrors.salary_min}>
          <input
            id="salary_min"
            type="number"
            min={0}
            value={draft.salary_min}
            onChange={(e) => set('salary_min', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Allowed languages" htmlFor="allowed_languages" hint="Comma-separated, e.g. en, fr">
          <input
            id="allowed_languages"
            value={draft.allowed_languages.join(', ')}
            onChange={(e) =>
              set(
                'allowed_languages',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
        <Check
          id="general_internship_only"
          label="Internships only"
          checked={draft.general_internship_only}
          onChange={(v) => set('general_internship_only', v)}
        />
        <Check
          id="general_remote_only"
          label="Remote only (general)"
          checked={draft.general_remote_only}
          onChange={(v) => set('general_remote_only', v)}
        />
        <Check id="remote_only" label="Remote only" checked={draft.remote_only} onChange={(v) => set('remote_only', v)} />
        <Check id="no_contract" label="No contract roles" checked={draft.no_contract} onChange={(v) => set('no_contract', v)} />
        <Check
          id="needs_sponsorship"
          label="Needs sponsorship"
          checked={draft.needs_sponsorship}
          onChange={(v) => set('needs_sponsorship', v)}
        />
        <Check id="no_agency" label="No agencies" checked={draft.no_agency} onChange={(v) => set('no_agency', v)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LISTS.map(([key, label]) => (
          <Field key={key} label={label} htmlFor={key} hint="One per line.">
            <textarea
              id={key}
              rows={3}
              value={listToText(draft[key])}
              onChange={(e) => set(key, textToList(e.target.value))}
              className={inputClass}
            />
          </Field>
        ))}
      </div>
    </Card>
  )
}
