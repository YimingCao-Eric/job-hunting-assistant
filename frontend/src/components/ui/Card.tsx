import type { ReactNode } from 'react'

export interface CardProps {
  title?: string
  actions?: ReactNode
  children: ReactNode
}

/**
 * Replaces `<div className="bg-white border rounded-lg p-6 shadow-sm">`, which
 * the old app repeated VERBATIM across five auto-scrape files (CurrentCycle:27,
 * CycleHistory:13, SessionHealth:32, ConfigEditor:106, StatusHeader:86).
 */
export function Card({ title, actions, children }: CardProps) {
  return (
    <section className="rounded-lg border border-border bg-surface-card shadow-card">
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          {title ? (
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          ) : (
            <span />
          )}
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  )
}
