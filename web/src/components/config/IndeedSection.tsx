import { Card } from '@/components/ui/Card'
import { Check, Field, NullableText } from '@/components/config/fields'
import { GRID, inputClass, toNum } from '@/components/config/fieldUtils'
import type { SectionProps } from '@/components/config/GeneralSection'

/** FR-017's Indeed per-site group. */
export function IndeedSection({ draft, set, fieldErrors }: SectionProps) {
  return (
    <Card title="Indeed">
      <div className={GRID}>
        <Field label="Keyword" htmlFor="indeed_keyword" hint="Falls back to the general keyword.">
          <NullableText id="indeed_keyword" value={draft.indeed_keyword} onChange={(v) => set('indeed_keyword', v)} />
        </Field>

        <Field label="Location" htmlFor="indeed_location" hint="Falls back to the general location.">
          <NullableText id="indeed_location" value={draft.indeed_location} onChange={(v) => set('indeed_location', v)} />
        </Field>

        <Field label="Days back (fromage)" htmlFor="indeed_fromage" error={fieldErrors.indeed_fromage}>
          <input
            id="indeed_fromage"
            type="number"
            min={0}
            value={draft.indeed_fromage}
            onChange={(e) => set('indeed_fromage', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Job type (jt)" htmlFor="indeed_jt">
          <NullableText id="indeed_jt" value={draft.indeed_jt} onChange={(v) => set('indeed_jt', v)} />
        </Field>

        <Field label="Experience level (explvl)" htmlFor="indeed_explvl">
          <NullableText id="indeed_explvl" value={draft.indeed_explvl} onChange={(v) => set('indeed_explvl', v)} />
        </Field>

        <Field label="Language (lang)" htmlFor="indeed_lang">
          <NullableText id="indeed_lang" value={draft.indeed_lang} onChange={(v) => set('indeed_lang', v)} />
        </Field>

        <Field label="Radius" htmlFor="indeed_radius">
          <input
            id="indeed_radius"
            type="number"
            value={draft.indeed_radius ?? ''}
            onChange={(e) => set('indeed_radius', toNum(e.target.value))}
            className={inputClass}
          />
        </Field>

        {/* As-built: the extension HARDCODES sort=relevance and ignores this
            stored value (search_urls.js). Shown, but labelled honestly rather
            than implying it does something. */}
        <Field
          label="Sort"
          htmlFor="indeed_sort"
          hint="Stored, but the extension currently hardcodes sort=relevance and ignores this."
        >
          <input
            id="indeed_sort"
            value={draft.indeed_sort}
            onChange={(e) => set('indeed_sort', e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Check
          id="indeed_remotejob"
          label="Remote only (Indeed)"
          checked={draft.indeed_remotejob === true}
          onChange={(v) => set('indeed_remotejob', v ? true : null)}
        />
      </div>
    </Card>
  )
}
