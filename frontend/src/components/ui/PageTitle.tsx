import type { ReactNode } from 'react'

export interface PageTitleProps {
  title: string
  /** Right-aligned controls. Wraps below the title at narrow widths (FR-006). */
  actions?: ReactNode
}

export function PageTitle({ title, actions }: PageTitleProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-6">
      <h1 className="text-xl font-semibold tracking-tight text-text-primary">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
