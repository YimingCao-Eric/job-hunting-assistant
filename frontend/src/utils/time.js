const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export function formatRelativeTime(isoString) {
  if (!isoString) return ''
  const then = new Date(isoString)
  const now = Date.now()
  const diffMs = now - then.getTime()
  if (diffMs < 0) return ''

  const hours = diffMs / (1000 * 60 * 60)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${Math.floor(hours)}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`

  return `${MONTHS[then.getMonth()]} ${then.getDate()}`
}

export function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

export function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return null
  const seconds = Math.round((new Date(endIso) - new Date(startIso)) / 1000)
  return formatElapsed(seconds)
}

export function formatScanTime(isoString) {
  if (!isoString) return ''
  const d = new Date(isoString)
  return d.toLocaleString('en-CA', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true
  })
}

export function formatAbsoluteTime(isoString) {
  if (!isoString) return '\u2014'
  const d = new Date(isoString)
  const pad = n => String(n).padStart(2, '0')
  const year = d.getFullYear()
  const month = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const hours = pad(d.getHours())
  const mins = pad(d.getMinutes())
  const offsetMin = -d.getTimezoneOffset()
  const offsetSign = offsetMin >= 0 ? '+' : '-'
  const offsetHours = Math.floor(Math.abs(offsetMin) / 60)
  const tz = `GMT${offsetSign}${offsetHours}`
  return `${year}-${month}-${day} ${hours}:${mins} ${tz}`
}
