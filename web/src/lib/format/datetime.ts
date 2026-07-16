/** Pure date/time display helpers. No business logic -- the UI displays. */

const ABSENT = '—'

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ABSENT
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ABSENT
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ABSENT
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ABSENT
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

/** Compact duration: "1h 04m", "3m 12s", "820ms". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return ABSENT
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Elapsed between two ISO stamps; `to` defaults to now for an in-flight run. */
export function formatElapsed(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!fromIso) return ABSENT
  const start = new Date(fromIso).getTime()
  if (Number.isNaN(start)) return ABSENT
  const end = toIso ? new Date(toIso).getTime() : now
  if (Number.isNaN(end)) return ABSENT
  return formatDuration(end - start)
}

/** Relative age, e.g. "12s ago", "4m ago". Used for heartbeat display (FR-038). */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ABSENT
  const seconds = Math.max(0, Math.floor((now - t) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
