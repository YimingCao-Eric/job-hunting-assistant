import { Card } from '@/components/ui/Card'
import { Field, NullableText } from '@/components/config/fields'
import { GRID, inputClass } from '@/components/config/fieldUtils'
import type { SectionProps } from '@/components/config/GeneralSection'

/** FR-017's LinkedIn per-site group. */
export function LinkedInSection({ draft, set, fieldErrors }: SectionProps) {
  return (
    <Card title="LinkedIn">
      <div className={GRID}>
        <Field
          label="Recency bound (hours)"
          htmlFor="f_tpr_bound"
          // Honest about computeFtpr: this is a CEILING, not the value used.
          hint="A ceiling — at scan time the extension narrows it to the time since the last completed LinkedIn run."
          error={fieldErrors.f_tpr_bound}
        >
          <input
            id="f_tpr_bound"
            type="number"
            min={0}
            value={draft.f_tpr_bound}
            onChange={(e) => set('f_tpr_bound', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field
          label="Override recency (hours)"
          htmlFor="linkedin_f_tpr"
          hint="Set this to pin f_TPR exactly, ignoring the bound."
        >
          <NullableText
            id="linkedin_f_tpr"
            value={draft.linkedin_f_tpr}
            onChange={(v) => set('linkedin_f_tpr', v)}
          />
        </Field>

        <Field label="Experience (f_E)" htmlFor="f_experience">
          <NullableText id="f_experience" value={draft.f_experience} onChange={(v) => set('f_experience', v)} />
        </Field>

        <Field label="Job type (f_JT)" htmlFor="f_job_type">
          <NullableText id="f_job_type" value={draft.f_job_type} onChange={(v) => set('f_job_type', v)} />
        </Field>

        <Field label="Workplace type (f_WT)" htmlFor="f_remote">
          <NullableText id="f_remote" value={draft.f_remote} onChange={(v) => set('f_remote', v)} />
        </Field>
      </div>
    </Card>
  )
}
