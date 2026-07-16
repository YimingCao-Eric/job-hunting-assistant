import { useCallback, useEffect } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router-dom'

import type { ConfirmDialogProps } from '@/components/ui/ConfirmDialog'

/**
 * FR-020: warn before navigation that would discard edits.
 *
 * useBlocker ONLY works under a DATA ROUTER (createBrowserRouter). Under
 * <BrowserRouter> -- what the old app used -- it throws. That is why router.tsx
 * is a data router from day one (research R14).
 *
 * Usage:
 *   const guard = useUnsavedGuard(isDirty)
 *   ...
 *   <ConfirmDialog {...guard.dialogProps} />
 */
export interface UnsavedGuard {
  isBlocked: boolean
  dialogProps: ConfirmDialogProps
}

/**
 * The guard's DECISION, extracted so it is unit-testable without a DOM.
 *
 * Blocks only a real move to a different path. A same-path navigation (a
 * search-param or hash change) must NOT prompt: the operator has not left the
 * form and their edits are not at risk, so prompting there would train them to
 * dismiss the dialog reflexively.
 */
export function shouldBlockNavigation(
  isDirty: boolean,
  currentPathname: string,
  nextPathname: string,
): boolean {
  return isDirty && currentPathname !== nextPathname
}

export function useUnsavedGuard(isDirty: boolean): UnsavedGuard {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      shouldBlockNavigation(isDirty, currentLocation.pathname, nextLocation.pathname),
    [isDirty],
  )
  const blocker = useBlocker(shouldBlock)

  // useBlocker covers in-app navigation only. This covers tab close / reload /
  // external links, which react-router cannot intercept. The browser renders its
  // own generic dialog here -- the text is not ours to choose.
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const isBlocked = blocker.state === 'blocked'

  return {
    isBlocked,
    dialogProps: {
      open: isBlocked,
      title: 'Discard unsaved changes?',
      body: 'You have edits that have not been saved. Leaving this page will discard them.',
      confirmLabel: 'Discard changes',
      // Discarding the operator's typing is destructive, even though no
      // backend call is involved (FR-011).
      tone: 'destructive',
      onConfirm: () => blocker.proceed?.(),
      onCancel: () => blocker.reset?.(),
    },
  }
}
