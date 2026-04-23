/* ── Glassdoor page-level scan loop (SERP + "Show more jobs" pagination) ─ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function interCardPacingMs() {
  const min = 1000;
  const max = 2000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cardJobId(el) {
  return el.getAttribute("data-jobid") || el.getAttribute("data-id");
}

async function emitPageEnd(counters, currentPage, done) {
  await JhaDebug.emit("page_end", {
    done,
    pages_scanned: currentPage,
    counters: {
      scraped: counters.scraped,
      new_jobs: counters.new_jobs,
      existing: counters.existing,
      jd_failed: counters.jd_failed,
      stale_skipped: counters.stale_skipped,
      totalRateLimited: counters.totalRateLimited || 0,
      errors_count: counters.errors?.length || 0,
    },
  });
}

async function scanGlassdoorPage(config, runId) {
  const counters = {
    scraped: 0,
    new_jobs: 0,
    existing: 0,
    stale_skipped: 0,
    jd_failed: 0,
    pages: 0,
    errors: [],
  };
  const SHOW_MORE_MIN_WAIT_MS = 1500;
  const SHOW_MORE_POLL_MS = 500;
  const SHOW_MORE_MAX_WAIT_MS = 12000;
  const processedJobIds = new Set();
  let pageNum = 0;

  while (true) {
    pageNum++;
    JhaDebug.setPage(pageNum);

    await JhaDebug.emit("page_start", {
      url: location.href,
      current_page: pageNum,
    });

    console.log(`[JHA-Glassdoor] scanning page ${pageNum}`);

    let cards = [];
    const waitStart = Date.now();
    for (let attempt = 0; attempt < 10; attempt++) {
      const allCards = Array.from(document.querySelectorAll("[data-jobid]"));
      cards = allCards.filter((c) => {
        const id = cardJobId(c);
        return id && !processedJobIds.has(id);
      });
      if (cards.length > 0) break;
      await sleep(800);
    }

    const totalDomCards = document.querySelectorAll("[data-jobid]").length;
    await JhaDebug.emit("cards_found", {
      count: cards.length,
      total_dom_cards: totalDomCards,
      took_ms: Date.now() - waitStart,
      ...(cards.length === 0
        ? {
            doc_title: document.title,
            body_snippet: document.body.innerText.slice(0, 300),
          }
        : {}),
    });

    if (cards.length === 0) {
      const pe = {
        type: "pagination_ended",
        page: pageNum,
        reason: "no_new_cards_found",
        url: location.href,
        total_dom_cards: totalDomCards,
      };
      pushScanError(counters, pe);
      await JhaDebug.emit("pagination_ended", pe);
      console.log("[JHA-Glassdoor] no new cards found — done");
      await emitPageEnd(counters, pageNum, true);
      break;
    }

    console.log(`[JHA-Glassdoor] found ${cards.length} new cards on page ${pageNum}`);

    let stopRequested = false;

    for (let idx = 0; idx < cards.length; idx++) {
      const cardEl = cards[idx];
      const jobId = cardJobId(cardEl);
      if (!jobId) continue;
      processedJobIds.add(jobId);

      const stopFlag = await new Promise((r) =>
        chrome.runtime.sendMessage({ type: "CHECK_STOP", runId }, r)
      );
      if (stopFlag?.stop) {
        console.log("[JHA-Glassdoor] stop requested");
        await JhaDebug.emit("pagination_ended", {
          type: "pagination_ended",
          page: pageNum,
          reason: "stop_requested",
          url: location.href,
        });
        await emitPageEnd(counters, pageNum, true);
        stopRequested = true;
        break;
      }

      await JhaDebug.emit("card_process", {
        job_id: jobId,
        idx_on_page: idx,
      });

      const result = await processGlassdoorCard(cardEl, config, counters);

      if (result?.rateLimited) {
        await JhaDebug.emit("pagination_ended", {
          type: "pagination_ended",
          page: pageNum,
          reason: "rate_limited_cooldown",
          url: location.href,
          total_rate_limited: counters.totalRateLimited || 0,
        });
        console.warn("[JHA-Glassdoor] rate limited — waiting 60s");
        await sleep(60000);
        continue;
      }

      await sleep(interCardPacingMs());
    }

    counters.pages = pageNum;

    if (stopRequested) {
      console.log("[JHA-Glassdoor] halting pagination — user stop");
      break;
    }

    await emitPageEnd(counters, pageNum, false);

    const showMoreBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.offsetParent !== null && b.textContent.trim() === "Show more jobs"
    );

    await JhaDebug.emit("show_more_poll", {
      page: pageNum,
      found: !!showMoreBtn,
      selector: 'button:contains("Show more jobs")',
    });

    if (!showMoreBtn) {
      const pe = {
        type: "pagination_ended",
        page: pageNum,
        reason: "show_more_button_not_found",
        url: location.href,
        doc_title: document.title,
      };
      pushScanError(counters, pe);
      await JhaDebug.emit("pagination_ended", pe);
      console.log('[JHA-Glassdoor] no "Show more jobs" button — all pages done');
      break;
    }

    const domCountBefore = document.querySelectorAll("[data-jobid]").length;

    await JhaDebug.emit("show_more_click", {
      page: pageNum,
      dom_count_before: domCountBefore,
    });

    console.log(
      `[JHA-Glassdoor] clicking "Show more jobs" for page ${pageNum + 1} (${domCountBefore} cards in DOM)`
    );
    showMoreBtn.click();

    await sleep(SHOW_MORE_MIN_WAIT_MS);
    let waited = SHOW_MORE_MIN_WAIT_MS;
    while (waited < SHOW_MORE_MAX_WAIT_MS) {
      await sleep(SHOW_MORE_POLL_MS);
      waited += SHOW_MORE_POLL_MS;
      const newTotal = document.querySelectorAll("[data-jobid]").length;
      if (newTotal > domCountBefore) {
        await JhaDebug.emit("show_more_loaded", {
          page: pageNum,
          dom_count_before: domCountBefore,
          dom_count_after: newTotal,
          new_cards: newTotal - domCountBefore,
          waited_ms: waited,
        });
        console.log(
          `[JHA-Glassdoor] show more loaded — ${newTotal} total cards (${waited}ms)`
        );
        break;
      }
    }

    const finalDomCount = document.querySelectorAll("[data-jobid]").length;
    if (finalDomCount === domCountBefore) {
      const pe = {
        type: "pagination_ended",
        page: pageNum,
        reason: "show_more_timeout",
        url: location.href,
        dom_count_before: domCountBefore,
        waited_ms: waited,
      };
      pushScanError(counters, pe);
      await JhaDebug.emit("pagination_ended", pe);
      console.warn("[JHA-Glassdoor] show more: no new cards after 12s — stopping");
      break;
    }
  }

  return counters;
}
