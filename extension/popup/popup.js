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

    if (scanInProgress) {
      status.textContent = 'Scanning...'
      status.className = 'scanning'
      if (liveProgress) {
        progress.textContent =
          `Scraped: ${liveProgress.scraped || 0}  ·  New: ${liveProgress.new_jobs || 0}  ·  Failed: ${liveProgress.jd_failed || 0}`
      }
    } else {
      status.textContent = 'Idle'
      status.className = 'idle'
      if (lastRunSummary) {
        progress.textContent =
          `Last: ${lastRunSummary.scraped || 0} scraped · ${lastRunSummary.new_jobs || 0} new`
      } else {
        progress.textContent = 'No recent scan'
      }
    }
  }

  await refresh()
  setInterval(refresh, 1000)
})
