/* ── LinkedIn multi-page scan (pagination via URL) ─────────────────────── */

function buildLinkedInSearchUrl(config, startOffset) {
  const params = new URLSearchParams({
    keywords: config.keyword,
    location: config.location,
  });
  const liHours = parseInt(String(config.linkedin_f_tpr ?? "").trim(), 10);
  let effectiveTpr = null;
  if (!Number.isNaN(liHours) && liHours > 0) {
    effectiveTpr = `r${liHours * 3600}`;
  } else if (config.f_tpr) {
    effectiveTpr = config.f_tpr;
  }
  if (effectiveTpr) params.set("f_TPR", effectiveTpr);
  if (config.f_experience) params.set("f_E", config.f_experience);
  if (config.f_job_type) params.set("f_JT", config.f_job_type);
  if (config.f_remote) params.set("f_WT", config.f_remote);
  let sb = "";
  if (config.salary_min) {
    const salaryBracket = config.salary_min;
    if (salaryBracket > 0 && salaryBracket >= 40000) {
      if (salaryBracket < 60000) sb = "1";
      else if (salaryBracket < 80000) sb = "2";
      else if (salaryBracket < 100000) sb = "3";
      else if (salaryBracket < 120000) sb = "4";
      else if (salaryBracket < 140000) sb = "5";
      else if (salaryBracket < 160000) sb = "6";
      else if (salaryBracket < 180000) sb = "7";
      else if (salaryBracket < 200000) sb = "8";
      else sb = "9";
    }
  }
  if (sb) params.set("f_SB2", sb);
  if (startOffset > 0) params.set("start", startOffset);
  return `https://www.linkedin.com/jobs/search?${params.toString()}`;
}

async function runSinglePage(config, state) {
  const counters = {
    scraped: state.scraped || 0,
    new_jobs: state.new_jobs || 0,
    existing: state.existing || 0,
    stale_skipped: state.stale_skipped || 0,
    jd_failed: state.jd_failed || 0,
    id_skipped: state.id_skipped || 0,
    errors: state.errors || [],
  };
  const currentPage = state.current_page || 1;

  const { stopRequested } = await chrome.storage.local.get("stopRequested");
  if (stopRequested) {
    console.log("[JHA] Stop requested — exiting before processing");
    return {
      ...counters,
      pages_scanned: currentPage,
      early_stop: true,
      done: true,
    };
  }

  let cards = await waitForCards(12000);
  if (cards.length === 0) {
    console.log("[JHA] No cards first attempt — retrying in 3s");
    await sleep(3000);
    cards = await waitForCards(8000);
  }
  if (cards.length === 0) {
    console.log("[JHA] No cards — exhausted");
    return {
      ...counters,
      pages_scanned: currentPage,
      early_stop: false,
      done: true,
    };
  }

  console.log(`[JHA] Page ${currentPage}: ${cards.length} cards`);

  let consecutiveDuplicates = 0;
  for (const card of cards) {
    const { stopRequested: stopNow } =
      await chrome.storage.local.get("stopRequested");
    if (stopNow) {
      console.log("[JHA] Stop requested — exiting scan");
      return {
        ...counters,
        pages_scanned: currentPage,
        early_stop: true,
        done: true,
      };
    }

    const result = await processCard(card, config, counters);

    if (result.error || !result.id) {
      // skipped or ingest failure — already counted by processCard
    } else if (result.already_exists || result.content_duplicate) {
      consecutiveDuplicates++;
    } else {
      consecutiveDuplicates = 0;
    }
    if (consecutiveDuplicates >= 5) {
      console.log("[JHA] 5 consecutive duplicates — early stop");
      return {
        ...counters,
        pages_scanned: currentPage,
        early_stop: true,
        done: true,
      };
    }
  }

  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  await sleep(500);

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

  let nextBtn = null;
  for (const sel of NEXT_BUTTON_SELECTORS) {
    nextBtn = document.querySelector(sel);
    if (nextBtn) break;
  }
  if (
    !nextBtn ||
    nextBtn.disabled ||
    nextBtn.getAttribute("aria-disabled") === "true"
  ) {
    console.log("[JHA] No Next button — last page");
    return {
      ...counters,
      pages_scanned: currentPage,
      early_stop: false,
      done: true,
    };
  }

  await chrome.storage.local.set({
    scanPageState: {
      ...counters,
      current_page: currentPage + 1,
      today_searches: (state.today_searches || 0) + 1,
    },
    liveProgress: { ...counters, page: currentPage + 1 },
  });

  const nextOffset = currentPage * 25;
  const nextUrl = buildLinkedInSearchUrl(config, nextOffset);

  await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      { type: "NAVIGATE_SCAN_TAB", url: nextUrl },
      resolve
    )
  );

  return {
    ...counters,
    pages_scanned: currentPage,
    early_stop: false,
    done: false,
  };
}
