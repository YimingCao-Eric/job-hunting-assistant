import type { ReactNode } from 'react'

import { Spinner } from '@/components/ui/Spinner'

export interface ButtonProps {
  /**
   * SC-007 / FR-011: `destructive` is distinguishable from `primary` WITHOUT
   * reading the label -- different fill, not just different wording. It is the
   * only variant permitted for stop-a-scan, stop-and-exit and reset-a-session,
   * and EVERY use must be paired with ConfirmDialog.
   */
  variant: 'primary' | 'secondary' | 'destructive'
  size?: 'sm' | 'md'
  /** Renders a Spinner and disables. The ONLY in-button loading affordance. */
  busy?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  type?: 'button' | 'submit'
  title?: string
}

// No `className` escape hatch, deliberately (composition rule 2): if a caller
// needs a look these variants don't offer, the variant set is wrong -- fix it
// here. The old app copy-pasted `px-4 py-2 bg-blue-600 text-white rounded
// hover:bg-blue-700 disabled:opacity-50` across three files.
const VARIANT: Record<ButtonProps['variant'], string> = {
  primary: 'bg-accent text-text-inverse hover:bg-accent-hover border-transparent',
  secondary:
    'bg-surface-card text-text-primary hover:bg-surface-raised border-border-strong',
  destructive: 'bg-danger text-text-inverse hover:bg-danger-hover border-transparent',
}

const SIZE: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
}

export function Button({
  variant,
  size = 'md',
  busy = false,
  disabled = false,
  onClick,
  children,
  type = 'button',
  title,
}: ButtonProps) {
  // `busy` implies `disabled` -- a busy control must not be re-triggerable.
  const isDisabled = disabled || busy

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-md border font-medium',
        'transition-colors focus-visible:outline focus-visible:outline-2',
        'focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
      ].join(' ')}
    >
      {busy ? <Spinner size="sm" /> : null}
      {children}
    </button>
  )
}
