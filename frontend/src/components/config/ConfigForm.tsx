import { GeneralSection } from '@/components/config/GeneralSection'
import { GlassdoorSection } from '@/components/config/GlassdoorSection'
import { IndeedSection } from '@/components/config/IndeedSection'
import { LinkedInSection } from '@/components/config/LinkedInSection'
import type { SearchConfig } from '@/types/config'

export interface ConfigFormProps {
  draft: SearchConfig
  onChange: (next: SearchConfig) => void
  fieldErrors: Record<string, string>
}

/**
 * FR-017: read and edit the search settings the backend exposes, GROUPED into
 * general settings and per-site settings. The four sections ARE that grouping.
 *
 * FR-018: the retained-but-dead scoring/dedup fields are absent from every
 * section -- `dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`,
 * `cpu_binary_threshold`. Not rendered AND not sent; the omission is what
 * preserves them across the exclude_unset merge.
 *
 * `llm` and `dedup_mode` are not here either -- feature 006 deleted them from
 * the backend schema, so there is nothing to hide.
 */
export function ConfigForm({ draft, onChange, fieldErrors }: ConfigFormProps) {
  const set = <K extends keyof SearchConfig>(key: K, value: SearchConfig[K]) =>
    onChange({ ...draft, [key]: value })

  return (
    <div className="flex flex-col gap-4">
      <GeneralSection draft={draft} set={set} fieldErrors={fieldErrors} />
      <LinkedInSection draft={draft} set={set} fieldErrors={fieldErrors} />
      <IndeedSection draft={draft} set={set} fieldErrors={fieldErrors} />
      <GlassdoorSection draft={draft} onChange={onChange} />
    </div>
  )
}
