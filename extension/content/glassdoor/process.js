/* ── Glassdoor per-card ingest pipeline ─────────────────────────────────── */

function pushScanError(counters, entry) {
  if (!counters.errors) counters.errors = [];
  if (counters.errors.length >= 200) return;
  counters.errors.push(entry);
}

async function processGlassdoorCard(cardEl, config, counters) {
  counters.scraped++;

  const cardData = parseGlassdoorCard(cardEl);

  if (!cardData.jobUrl || !cardData.jl) {
    counters.stale_skipped++;
    return { skipped: true };
  }

  const jdResult = await fetchGlassdoorJD(cardData.jobUrl, cardData.jl);

  if (jdResult && jdResult.phantom) {
    counters.stale_skipped++;
    return { skipped: true };
  }

  if (!jdResult) {
    counters.jd_failed++;
    pushScanError(counters, {
      jl: cardData.jl,
      type: "jd_failed",
      message: "JD fetch returned no result",
    });
    return { skipped: true };
  }

  if (jdResult.rateLimited) {
    console.warn("[JHA-Glassdoor] Rate limited — scan will cool down at page level");
    counters.totalRateLimited = (counters.totalRateLimited || 0) + 1;
    return { rateLimited: true };
  }

  const easyApply = jdResult?.easy_apply === true;
  const jobUrl = cardData.jobUrl || null;

  const job = {
    website:         "glassdoor",
    job_title:       cardData.jobTitle  || "Unknown",
    company:         cardData.company   || "Unknown",
    location:
      jdResult.location ||
      cardData.location ||
      config.glassdoor?.location ||
      "Canada",
    job_url:         cardData.jobUrl,
    apply_url:       easyApply ? null : jobUrl,
    job_description: jdResult.jd,
    easy_apply:      easyApply,
    post_datetime:   null,
    search_filters: {
      website: "glassdoor",
      keyword: config.glassdoor?.keyword || "software engineer",
      location: config.glassdoor?.location || "Canada",
    },
    scan_run_id:     config.runId || null,
  };

  const result = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "INGEST_JOB", job }, (r) => {
      if (r !== undefined) { resolve(r); return; }
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "INGEST_JOB", job }, resolve);
      }, 2000);
    })
  );

  if (!result) {
    counters.jd_failed++;
    pushScanError(counters, {
      jl: cardData.jl,
      type: "jd_failed",
      message: "No response from extension (ingest)",
    });
    return { skipped: true };
  }

  if (result.error || !result.id) {
    counters.jd_failed++;
    pushScanError(counters, {
      jl: cardData.jl,
      type: "jd_failed",
      message: result.error || "Ingest rejected",
    });
    console.warn("[JHA-Glassdoor] Ingest failed:", cardData.jobTitle, result?.error);
    return { skipped: true };
  }

  if (result.already_exists || result.content_duplicate) {
    counters.existing++;
    return { existing: true };
  }

  counters.new_jobs++;
  return { ingested: true, jobId: result.id };
}
