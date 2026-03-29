/* ── Glassdoor page-level scan loop (SERP + "Show more jobs" pagination) ─ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scanDelayMs(setting) {
  const ranges = { fast: [500, 1000], normal: [1000, 2000], slow: [3000, 5000] };
  const [min, max] = ranges[setting] || ranges.normal;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cardJobId(el) {
  return el.getAttribute("data-jobid") || el.getAttribute("data-id");
}

async function scanGlassdoorPage(config, settings, runId) {
  const counters = {
    scraped: 0,
    new_jobs: 0,
    existing: 0,
    stale_skipped: 0,
    jd_failed: 0,
    pages: 0,
    early_stop: false,
    errors: [],
  };

  const EARLY_STOP_THRESHOLD = 5;
  const SHOW_MORE_MIN_WAIT_MS = 1500;
  const SHOW_MORE_POLL_MS = 500;
  const SHOW_MORE_MAX_WAIT_MS = 12000;
  const processedJobIds = new Set();
  let pageNum = 0;

  while (true) {
    pageNum++;
    console.log(`[JHA-Glassdoor] scanning page ${pageNum}`);

    let cards = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const allCards = Array.from(document.querySelectorAll("[data-jobid]"));
      cards = allCards.filter((c) => {
        const id = cardJobId(c);
        return id && !processedJobIds.has(id);
      });
      if (cards.length > 0) break;
      await sleep(800);
    }

    if (cards.length === 0) {
      console.log("[JHA-Glassdoor] no new cards found — done");
      break;
    }

    console.log(`[JHA-Glassdoor] found ${cards.length} new cards on page ${pageNum}`);

    let consecutiveExisting = 0;
    let stopRequested = false;

    for (const cardEl of cards) {
      const jobId = cardJobId(cardEl);
      if (!jobId) continue;
      processedJobIds.add(jobId);

      const stopFlag = await new Promise((r) =>
        chrome.runtime.sendMessage({ type: "CHECK_STOP", runId }, r)
      );
      if (stopFlag?.stop) {
        console.log("[JHA-Glassdoor] stop requested");
        stopRequested = true;
        counters.early_stop = true;
        break;
      }

      const result = await processGlassdoorCard(cardEl, config, counters, settings);

      if (result?.rateLimited) {
        console.warn("[JHA-Glassdoor] rate limited — waiting 60s");
        await sleep(60000);
        continue;
      }

      if (result?.existing) {
        consecutiveExisting++;
        if (consecutiveExisting >= EARLY_STOP_THRESHOLD) {
          console.log("[JHA-Glassdoor] early stop — 5 consecutive existing");
          stopRequested = true;
          counters.early_stop = true;
          break;
        }
      } else {
        consecutiveExisting = 0;
      }

      await sleep(scanDelayMs(settings?.scanDelay || "normal"));
    }

    counters.pages = pageNum;

    /* Inner `break` only exits the `for`; this exits the `while` before any "Show more" click. */
    if (stopRequested) {
      console.log("[JHA-Glassdoor] halting pagination — early stop or user stop");
      break;
    }

    const showMoreBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.offsetParent !== null && b.textContent.trim() === "Show more jobs"
    );

    if (!showMoreBtn) {
      console.log('[JHA-Glassdoor] no "Show more jobs" button — all pages done');
      break;
    }

    const domCountBefore = document.querySelectorAll("[data-jobid]").length;
    console.log(`[JHA-Glassdoor] clicking "Show more jobs" for page ${pageNum + 1} (${domCountBefore} cards in DOM)`);
    showMoreBtn.click();

    await sleep(SHOW_MORE_MIN_WAIT_MS);
    let waited = SHOW_MORE_MIN_WAIT_MS;
    while (waited < SHOW_MORE_MAX_WAIT_MS) {
      await sleep(SHOW_MORE_POLL_MS);
      waited += SHOW_MORE_POLL_MS;
      const newTotal = document.querySelectorAll("[data-jobid]").length;
      if (newTotal > domCountBefore) {
        console.log(`[JHA-Glassdoor] show more loaded — ${newTotal} total cards (${waited}ms)`);
        break;
      }
    }
    if (document.querySelectorAll("[data-jobid]").length === domCountBefore) {
      console.warn("[JHA-Glassdoor] show more: no new cards after 12s — stopping");
      break;
    }
  }

  return counters;
}
