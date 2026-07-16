import { useEffect, useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/Button'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  tone: 'default' | 'destructive'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * FR-011's other half. REQUIRED by every destructive control:
 *  - stop a scan       (POST /extension/trigger-stop -- immediately marks ALL
 *                       running run-logs failed, regardless of age)
 *  - stop-and-exit     (POST /admin/auto-scrape/shutdown)
 *  - reset a session   (POST /admin/auto-scrape/reset-session/{site})
 * Also serves FR-020's unsaved-changes warning via useUnsavedGuard.
 *
 * NEVER window.confirm -- unstyleable, untestable, and inconsistent with every
 * other surface in the app.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    confirmRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-overlay/40 p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        ref={confirmRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-surface-card shadow-overlay outline-none"
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id="confirm-dialog-title" className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          <div className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            onClick={onConfirm}
            busy={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
