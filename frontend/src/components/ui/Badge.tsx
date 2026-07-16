import type { ReactNode } from 'react'

import type { Tone } from '@/lib/tokens/semantics'

export interface BadgeProps {
  /**
   * Callers pass `tone={PROBE_TONE[s.last_probe_status]}` -- a SEMANTIC prop,
   * never a raw color (composition rules 3 and 4).
   */
  tone: Tone
  /** Renders a leading dot; useful for status at a glance. */
  dot?: boolean
  children: ReactNode
  title?: string
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-raised text-text-secondary border-border',
  success: 'bg-success-subtle text-success-text border-success/30',
  warning: 'bg-warning-subtle text-warning-text border-warning/30',
  danger: 'bg-danger-subtle text-danger-text border-danger/30',
  info: 'bg-info-subtle text-info-text border-info/30',
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-text-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

export function Badge({ tone, dot = false, children, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={[
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border',
        'px-2 py-0.5 text-xs font-medium',
        TONE[tone],
      ].join(' ')}
    >
      {dot ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} /> : null}
      {children}
    </span>
  )
}
