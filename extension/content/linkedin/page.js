/* ── LinkedIn in-SPA pagination scan (single long-running invocation) ── */

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
      errors_count: counters.errors?.length || 0,
    },
  });
}

async function runFullScan(config, tabId) {
  const processedJobIds = new Set();
  const counters = {
    scraped: 0,
    new_jobs: 0,
    existing: 0,
    stale_skipped: 0,
    jd_failed: 0,
    id_skipped: 0,
    errors: [],
  };
  let currentPage = 1;

  let mutationCount = 0;
  let mutationObserver = null;
  const cardListEl = document.querySelector(
    ".scaffold-layout__list, .jobs-search-results-list"
  );
  if (cardListEl) {
    mutationObserver = new MutationObserver((mutations) => {
      mutationCount += mutations.length;
    });
    mutationObserver.observe(cardListEl, { childList: true, subtree: true });
  }

  try {
    while (true) {
      JhaDebug.setPage(currentPage);

      const { stopRequested } = await chrome.storage.local.get("stopRequested");
      if (stopRequested) {
        await JhaDebug.emit("pagination_ended", {
          type: "pagination_ended",
          page: currentPage,
          reason: "stop_requested",
          url: location.href,
        });
        await emitPageEnd(counters, currentPage, true);
        break;
      }

      await JhaDebug.emit("page_start", {
        url: location.href,
        current_page: currentPage,
        has_currentJobId: /[?&]currentJobId=/.test(location.href),
        has_trailing_slash_before_query: /\/jobs\/search\/\?/.test(
          location.href
        ),
      });

      const isFirstPage = currentPage === 1;
      const waitStart = Date.now();
      let cards = await waitForCards(isFirstPage ? 12000 : 8000);
      await JhaDebug.emit("cards_found", {
        attempt: 1,
        count: cards.length,
        took_ms: Date.now() - waitStart,
        first_page: isFirstPage,
        ...(cards.length < 25
          ? {
              doc_title: document.title,
              has_no_results_banner: !!document.querySelector(
                ".jobs-search-no-results-banner"
              ),
              body_cards_total: document.querySelectorAll(
                "li[data-occludable-job-id]"
              ).length,
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
          has_no_results_banner: !!document.querySelector(
            ".jobs-search-no-results-banner"
          ),
          has_auth_wall: !!document.querySelector(".authwall"),
        };
        pushScanError(counters, pe);
        await JhaDebug.emit("pagination_ended", pe);
        await emitPageEnd(counters, currentPage, true);
        break;
      }

      console.log(`[JHA] Page ${currentPage}: ${cards.length} cards`);

      for (let idx = 0; idx < cards.length; idx++) {
        const card = cards[idx];
        const { stopRequested: stopNow } =
          await chrome.storage.local.get("stopRequested");
        if (stopNow) {
          await JhaDebug.emit("pagination_ended", {
            type: "pagination_ended",
            page: currentPage,
            reason: "stop_requested_mid_page",
            url: location.href,
          });
          await emitPageEnd(counters, currentPage, true);
          return { ...counters, pages_scanned: currentPage };
        }

        const jobId = card.getAttribute("data-occludable-job-id");
        await JhaDebug.emit("card_process", {
          job_id: jobId || null,
          idx_on_page: idx,
          duplicate_in_set: !!(jobId && processedJobIds.has(jobId)),
        });
        if (!jobId) continue;
        if (processedJobIds.has(jobId)) {
          console.log(`[JHA-LinkedIn] Skipping duplicate job id: ${jobId}`);
          continue;
        }
        processedJobIds.add(jobId);

        const cardData = extractCardData(card);
        if (!cardData || !cardData.job_id) continue;

        await processCard(card, config, counters, cardData);
      }

      await emitPageEnd(counters, currentPage, false);

      await new Promise((resolve) =>
        chrome.runtime.sendMessage(
          {
            type: "PUT_EXTENSION_STATE",
            data: {
              current_page: currentPage + 1,
              today_searches: currentPage,
            },
          },
          resolve
        )
      );

      await JhaDebug.emit("dom_mutations", {
        page: currentPage,
        count: mutationCount,
      });
      mutationCount = 0;

      await JhaDebug.emit("scroll", {
        scroll_height: document.body.scrollHeight,
        viewport: window.innerHeight,
      });
      for (const sel of PAGINATION_CONTAINER_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollIntoView({ behavior: "instant", block: "end" });
          break;
        }
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });

      const nextBtn = await pollForNextButton();
      const nextDisabled =
        nextBtn &&
        (nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true");

      if (!nextBtn || nextDisabled) {
        const pe = {
          type: "pagination_ended",
          page: currentPage,
          reason: nextBtn ? "next_button_disabled" : "next_button_not_found",
          url: location.href,
          doc_title: document.title,
          cards_on_page: document.querySelectorAll(
            "li[data-occludable-job-id]"
          ).length,
          has_no_results_banner: !!document.querySelector(
            ".jobs-search-no-results-banner"
          ),
          selectors_tried: NEXT_BUTTON_SELECTORS.length,
        };
        pushScanError(counters, pe);
        await JhaDebug.emit("pagination_ended", pe);
        await emitPageEnd(counters, currentPage, true);
        break;
      }

      const urlBefore = location.href;
      const lastCardIdsBefore = getCurrentCardIdSet();

      await JhaDebug.emit("next_click", {
        page: currentPage,
        url_before: urlBefore,
        selector_matched: findMatchingSelector(nextBtn),
      });
      nextBtn.click();

      const spaStart = Date.now();
      const transitioned = await waitForSpaTransition(
        urlBefore,
        lastCardIdsBefore,
        10000
      );
      await JhaDebug.emit("spa_transition", {
        page: currentPage,
        took_ms: Date.now() - spaStart,
        transitioned,
        url_after: location.href,
        url_mutated: location.href !== urlBefore,
        added_currentJobId:
          !/[?&]currentJobId=/.test(urlBefore) &&
          /[?&]currentJobId=/.test(location.href),
      });

      if (!transitioned) {
        const pe = {
          type: "pagination_ended",
          page: currentPage,
          reason: "spa_transition_timeout",
          url: location.href,
          url_before: urlBefore,
        };
        pushScanError(counters, pe);
        await JhaDebug.emit("pagination_ended", pe);
        await emitPageEnd(counters, currentPage, true);
        break;
      }

      currentPage++;
    }
  } finally {
    if (mutationObserver) mutationObserver.disconnect();
  }

  return { ...counters, pages_scanned: currentPage };
}

async function pollForNextButton(maxMs = 5000, intervalMs = 300) {
  const start = Date.now();
  let iter = 0;
  while (Date.now() - start < maxMs) {
    iter++;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    await sleep(intervalMs);
    for (const sel of NEXT_BUTTON_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        await JhaDebug.emit("next_poll", {
          iter,
          found: true,
          selector_matched: sel,
          elapsed_ms: Date.now() - start,
        });
        return btn;
      }
    }
    await JhaDebug.emit("next_poll", {
      iter,
      found: false,
      elapsed_ms: Date.now() - start,
    });
  }
  return null;
}

async function waitForSpaTransition(urlBefore, cardIdsBefore, maxMs = 10000) {
  const start = Date.now();
  const checkIntervalMs = 250;
  while (Date.now() - start < maxMs) {
    await sleep(checkIntervalMs);
    if (location.href !== urlBefore) return true;
    const currentCardIds = getCurrentCardIdSet();
    if (!cardIdSetsEqual(currentCardIds, cardIdsBefore)) return true;
  }
  return false;
}

function getCurrentCardIdSet() {
  const s = new Set();
  for (const el of document.querySelectorAll("li[data-occludable-job-id]")) {
    s.add(el.getAttribute("data-occludable-job-id"));
  }
  return s;
}

function cardIdSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function findMatchingSelector(btn) {
  for (const sel of NEXT_BUTTON_SELECTORS) {
    try {
      if (btn.matches(sel)) return sel;
    } catch {
      /* invalid selector */
    }
  }
  return "(none)";
}
