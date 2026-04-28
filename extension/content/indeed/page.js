/* ── Indeed multi-page scan (pagination via next link) ───────────────── */

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

  await JhaDebug.emit("page_start", {
    url: location.href,
    current_page: currentPage,
  });

  const waitStart = Date.now();
  let cards = await waitForCards(12000);
  await JhaDebug.emit("cards_found", {
    attempt: 1,
    count: cards.length,
    took_ms: Date.now() - waitStart,
    ...(cards.length === 0
      ? {
          doc_title: document.title,
          body_snippet: document.body.innerText.slice(0, 300),
        }
      : {}),
  });
  if (cards.length === 0) {
    await JhaDebug.emit("cards_found", {
      attempt: 2,
      reason: "retry_after_3s",
      count: 0,
    });
    await sleep(3000);
    const retryStart = Date.now();
    cards = await waitForCards(8000);
    await JhaDebug.emit("cards_found", {
      attempt: 2,
      count: cards.length,
      took_ms: Date.now() - retryStart,
      ...(cards.length === 0
        ? {
            doc_title: document.title,
            body_snippet: document.body.innerText.slice(0, 300),
          }
        : {}),
    });
  }
  if (cards.length === 0) {
    const pe = {
      type: "pagination_ended",
      page: currentPage,
      reason: "no_cards_found",
      url: location.href,
      doc_title: document.title,
      body_snippet: document.body.innerText.slice(0, 300),
    };
    pushScanError(counters, pe);
    await JhaDebug.emit("pagination_ended", pe);
    console.log("[JHA-Indeed] No cards — done");
    await emitPageEnd(counters, currentPage, true);
    return { ...counters, pages_scanned: currentPage, done: true };
  }

  console.log("[JHA-Indeed] Page " + currentPage + ": " + cards.length + " cards");

  for (let idx = 0; idx < cards.length; idx++) {
    const anchor = cards[idx];
    const flags = await chrome.storage.local.get([
      "_backendDownDuringScan",
      "_watchdogTripped",
      "stopRequested",
    ]);
    if (flags._backendDownDuringScan) {
      await JhaDebug.emit(
        "error",
        {
          where: "scrape_loop",
          message: "backend_unavailable",
          reason: "ingest_retries_exhausted",
        },
        "error"
      );
      counters.aborted_reason = "backend_unavailable";
      await emitPageEnd(counters, currentPage, true);
      return { ...counters, pages_scanned: currentPage, done: true };
    }
    if (flags._watchdogTripped) {
      await JhaDebug.emit(
        "error",
        {
          where: "scrape_loop",
          message: "sw_died_detected",
        },
        "error"
      );
      counters.aborted_reason = "sw_died";
      await emitPageEnd(counters, currentPage, true);
      return { ...counters, pages_scanned: currentPage, done: true };
    }
    if (flags.stopRequested) {
      await JhaDebug.emit("pagination_ended", {
        type: "pagination_ended",
        page: currentPage,
        reason: "stop_requested",
        url: location.href,
      });
      await emitPageEnd(counters, currentPage, true);
      return { ...counters, pages_scanned: currentPage, done: true };
    }

    const jk = anchor.getAttribute("data-jk");
    await JhaDebug.emit("card_process", {
      jk: jk || null,
      idx_on_page: idx,
    });

    const result = await processCard(anchor, config, counters);

    if (result && result.rateLimited) {
      await JhaDebug.emit("pagination_ended", {
        type: "pagination_ended",
        page: currentPage,
        reason: "rate_limited_abort",
        url: location.href,
        total_rate_limited: counters.totalRateLimited || 0,
      });
      console.warn("[JHA-Indeed] Rate limited — aborting scan");
      await emitPageEnd(counters, currentPage, true);
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
  await JhaDebug.emit("next_poll", {
    iter: 1,
    found: !!nextBtn,
    disabled: !!(nextBtn && nextBtn.disabled),
    has_href: !!(nextBtn && nextBtn.getAttribute("href")),
    selector: '[data-testid="pagination-page-next"]',
  });

  if (!nextBtn || nextBtn.disabled) {
    const pe = {
      type: "pagination_ended",
      page: currentPage,
      reason: nextBtn ? "next_button_disabled" : "next_button_not_found",
      url: location.href,
      doc_title: document.title,
    };
    pushScanError(counters, pe);
    await JhaDebug.emit("pagination_ended", pe);
    console.log("[JHA-Indeed] No next button — done");
    await emitPageEnd(counters, currentPage, true);
    return { ...counters, pages_scanned: currentPage, done: true };
  }

  const nextHref = nextBtn.getAttribute("href");
  if (!nextHref) {
    const pe = {
      type: "pagination_ended",
      page: currentPage,
      reason: "next_button_no_href",
      url: location.href,
    };
    pushScanError(counters, pe);
    await JhaDebug.emit("pagination_ended", pe);
    await emitPageEnd(counters, currentPage, true);
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

  await JhaDebug.emit("navigate", {
    next_url: nextUrl,
    from_page: currentPage,
  });

  await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "NAVIGATE_SCAN_TAB", url: nextUrl }, resolve)
  );

  await emitPageEnd(counters, currentPage, false);
  return { ...counters, pages_scanned: currentPage, done: false };
}
