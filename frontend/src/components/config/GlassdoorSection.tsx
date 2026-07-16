import { Card } from '@/components/ui/Card'
import { Field } from '@/components/config/fields'
import { GRID, inputClass, toNum } from '@/components/config/fieldUtils'
import { toSlug } from '@/lib/format/searchPreview'
import type { SearchConfig } from '@/types/config'

export interface GlassdoorSectionProps {
  draft: SearchConfig
  onChange: (next: SearchConfig) => void
}

/**
 * FR-017's Glassdoor per-site group.
 *
 * Glassdoor's URL is built from the SLUGS, not the keyword/location:
 * search_urls.js reads g.location_slug / g.keyword_slug directly with no
 * fallback. The backend does NOT derive them -- PUT /config just merges. So
 * editing the keyword without updating the slug would SILENTLY BREAK Glassdoor
 * scraping. They are kept in sync here; the stored data confirms the convention
 * ("software engineer" -> "software-engineer").
 */
export function GlassdoorSection({ draft, onChange }: GlassdoorSectionProps) {
  const g = draft.glassdoor ?? {}

  const set = (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...g, [key]: value }
    if (key === 'keyword') next.keyword_slug = toSlug(value)
    if (key === 'location') next.location_slug = toSlug(value)
    onChange({ ...draft, glassdoor: next })
  }

  const text = (id: string, key: string, label: string, hint?: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        value={String(g[key] ?? '')}
        onChange={(e) => set(key, e.target.value || null)}
        className={inputClass}
      />
    </Field>
  )

  const number = (id: string, key: string, label: string, step?: string) => (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        type="number"
        step={step}
        value={String(g[key] ?? '')}
        onChange={(e) => set(key, toNum(e.target.value))}
        className={inputClass}
      />
    </Field>
  )

  return (
    <Card title="Glassdoor">
      <div className={GRID}>
        <Field label="Keyword" htmlFor="gd_keyword" hint={`URL slug: ${String(g.keyword_slug ?? '—')}`}>
          <input
            id="gd_keyword"
            value={String(g.keyword ?? '')}
            onChange={(e) => set('keyword', e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Location" htmlFor="gd_location" hint={`URL slug: ${String(g.location_slug ?? '—')}`}>
          <input
            id="gd_location"
            value={String(g.location ?? '')}
            onChange={(e) => set('location', e.target.value)}
            className={inputClass}
          />
        </Field>

        {number('gd_fromage', 'fromAge', 'Days back (fromAge)')}
        {number('gd_minsalary', 'minSalary', 'Min salary')}
        {number('gd_maxsalary', 'maxSalary', 'Max salary')}
        {number('gd_minrating', 'minRating', 'Min rating', '0.1')}
        {text('gd_jobtype', 'jobType', 'Job type')}
        {text('gd_remote', 'remoteWorkType', 'Remote work type')}
        {text('gd_seniority', 'seniorityType', 'Seniority')}
      </div>
    </Card>
  )
}
