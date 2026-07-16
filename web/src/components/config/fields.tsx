import type { ReactNode } from 'react'

import { inputClass } from '@/components/config/fieldUtils'

/** Shared form COMPONENTS for the Config sections, so each section stays a thin,
 *  readable list of fields. Non-component helpers live in fieldUtils.ts. */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint && !error ? <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p> : null}
      {/* FR-021: the field-specific rejection reason, on the field itself. */}
      {error ? (
        <p role="alert" className="mt-0.5 text-[11px] text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function Check({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded-sm border-border-strong text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      {label}
    </label>
  )
}

/** A text input bound to a `string | null` field: '' means null, not "". */
export function NullableText({
  id,
  value,
  onChange,
}: {
  id: string
  value: string | null
  onChange: (v: string | null) => void
}) {
  return (
    <input
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={inputClass}
    />
  )
}
