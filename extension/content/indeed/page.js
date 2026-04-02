/* ── Indeed multi-page scan (pagination via next link) ───────────────── */

async function runSinglePage(config, state) {
  const counters = {
    scraped: state.scraped || 0,
    new_jobs: state.new_jobs || 0,
    existing: state.existing || 0,
    stale_skipped: state.stale_skipped || 0,
    jd_failed: state.jd_failed || 0,
    totalRateLimited: state.totalRateLimited || 0,
    errors: state.errors || [],
  };
  const currentPage = state.current_page || 1;

  let cards = await waitForCards(12000);
  if (cards.length === 0) {
    await sleep(3000);
    cards = await waitForCards(8000);
  }
  if (cards.length === 0) {
    console.log("[JHA-Indeed] No cards — done");
    return { ...counters, pages_scanned: currentPage, done: true };
  }

  console.log("[JHA-Indeed] Page " + currentPage + ": " + cards.length + " cards");

  for (const anchor of cards) {
    const { stopRequested } = await chrome.storage.local.get("stopRequested");
    if (stopRequested) {
      return { ...counters, pages_scanned: currentPage, done: true };
    }

    const result = await processCard(anchor, config, counters);

    if (result && result.rateLimited) {
      console.warn("[JHA-Indeed] Rate limited — aborting scan");
      return { ...counters, pages_scanned: currentPage, done: true };
    }
  }

  await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      {
        type: "PUT_EXTENSION_STATE",
        data: {
          current_page: currentPage + 1,
          today_searches: (state.today_searches || 0) + 1,
        },
      },
      resolve
    )
  );

  const nextBtn = document.querySelector(
    '[data-testid="pagination-page-next"]'
  );
  if (!nextBtn || nextBtn.disabled) {
    console.log("[JHA-Indeed] No next button — done");
    return { ...counters, pages_scanned: currentPage, done: true };
  }

  const nextHref = nextBtn.getAttribute("href");
  if (!nextHref) {
    return { ...counters, pages_scanned: currentPage, done: true };
  }

  const nextUrl = nextHref.startsWith("http")
    ? nextHref
    : "https://ca.indeed.com" + nextHref;

  await chrome.storage.local.set({
    scanPageState: {
      ...counters,
      current_page: currentPage + 1,
      today_searches: (state.today_searches || 0) + 1,
    },
    liveProgress: { ...counters, page: currentPage + 1 },
  });

  await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "NAVIGATE_SCAN_TAB", url: nextUrl }, resolve)
  );

  return { ...counters, pages_scanned: currentPage, done: false };
}
