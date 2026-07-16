/** Non-component helpers for the Config sections.
 *  Split from fields.tsx so that file exports components only -- otherwise
 *  react-refresh cannot fast-refresh it (eslint react-refresh/only-export-components). */

export const inputClass =
  'w-full rounded-md border border-border bg-surface-card px-2 py-1.5 text-sm text-text-primary ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'

export const listToText = (v: string[]) => v.join('\n')

export const textToList = (v: string) =>
  v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

/** '' -> null, so clearing a numeric field means "unset", not 0. */
export const toNum = (v: string): number | null => (v.trim() === '' ? null : Number(v))
