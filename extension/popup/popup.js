document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('dashboard-link').addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: 'http://localhost:5173' })
  })

  const refresh = async () => {
    const { liveProgress, lastRunSummary, scanInProgress } =
      await chrome.storage.local.get(['liveProgress', 'lastRunSummary', 'scanInProgress'])
    const status = document.getElementById('status')
    const progress = document.getElementById('progress')

    const formatProgressLine = (p) => {
      const parts = [
        `Scraped: ${p.scraped || 0}`,
        `New: ${p.new_jobs || 0}`,
        `Existing: ${p.existing || 0}`,
        `Failed: ${p.jd_failed || 0}`,
      ]
      if (p.completedAt != null) {
        const d = new Date(p.completedAt)
        if (!Number.isNaN(d.getTime())) {
          parts.push(`Done: ${d.toLocaleString()}`)
        }
      }
      return parts.join('  ·  ')
    }

    if (scanInProgress && liveProgress) {
      status.textContent = 'Scanning...'
      status.className = 'scanning'
      progress.textContent = formatProgressLine(liveProgress)
    } else if (lastRunSummary) {
      status.textContent = scanInProgress ? 'Scanning…' : 'Idle'
      status.className = scanInProgress ? 'scanning' : 'idle'
      progress.textContent = formatProgressLine(lastRunSummary)
    } else {
      status.textContent = scanInProgress ? 'Scanning…' : 'Idle'
      status.className = scanInProgress ? 'scanning' : 'idle'
      progress.textContent = 'No recent scan'
    }
  }

  await refresh()
  setInterval(refresh, 1000)
})
