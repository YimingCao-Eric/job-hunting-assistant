document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('dashboard-link').addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: 'http://localhost:5173' })
  })

  const refresh = async () => {
    const { liveProgress, scanInProgress } = await chrome.storage.local.get(['liveProgress', 'scanInProgress'])
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
      progress.textContent = liveProgress
        ? `Last: ${liveProgress.scraped || 0} scraped · ${liveProgress.new_jobs || 0} new`
        : 'No recent scan'
    }
  }

  await refresh()
  // Poll while popup is open
  setInterval(refresh, 1000)
})
