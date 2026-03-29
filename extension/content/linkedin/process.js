/* ── LinkedIn per-card ingest pipeline ─────────────────────────────────── */

function pushScanError(counters, entry) {
  if (!counters.errors) counters.errors = [];
  if (counters.errors.length >= 200) return;
  counters.errors.push(entry);
}

async function processCard(card, config, counters, preExtractedCardData = null) {
  const cardData = preExtractedCardData || extractCardData(card);
  if (!cardData) return { skipped: true };
  if (!cardData.job_id) {
    counters.id_skipped = (counters.id_skipped || 0) + 1;
    await recordSkip("linkedin", cardData, "no_id", config.runId);
    return { skipped: true };
  }
  counters.scraped++;

  if (cardData.post_datetime && isStale(cardData.post_datetime)) {
    counters.stale_skipped++;
    await recordSkip("linkedin", cardData, "stale", config.runId);
    return { skipped: true };
  }

  await cardDelay(config.scan_delay || "normal");
  const voyagerResult = await fetchJDViaVoyager(cardData.job_id);
  if (!voyagerResult) {
    counters.jd_failed++;
    pushScanError(counters, {
      job_id: cardData.job_id,
      type: "jd_failed",
      message: "Voyager returned no JD",
    });
    await recordSkip("linkedin", cardData, "jd_failed", config.runId);
    return { skipped: true };
  }

  if (!cardData.job_title && voyagerResult.title) {
    cardData.job_title = voyagerResult.title;
  }
  if (!cardData.location && voyagerResult.location) {
    cardData.location = voyagerResult.location;
  }
  if (!cardData.company && voyagerResult.company) {
    cardData.company = voyagerResult.company;
  }
  if (!cardData.post_datetime && voyagerResult.listedAt) {
    cardData.post_datetime = new Date(voyagerResult.listedAt).toISOString();
  }

  const jdText =
    voyagerResult.jd != null ? String(voyagerResult.jd).trim() : "";
  if (!jdText) {
    counters.jd_failed++;
    pushScanError(counters, {
      job_id: cardData.job_id,
      type: "jd_failed",
      message: "JD text empty after fetch — skipping ingest",
    });
    await recordSkip("linkedin", cardData, "jd_failed", config.runId);
    return { skipped: true };
  }

  const jobPayload = {
    website: "linkedin",
    job_title: cardData.job_title,
    company: cardData.company,
    location: cardData.location,
    job_description: jdText,
    job_url: cardData.job_url,
    apply_url: voyagerResult.apply_url,
    easy_apply: cardData.easy_apply,
    post_datetime: cardData.post_datetime,
    search_filters: {
      f_tpr: config.f_tpr,
      f_experience: config.f_experience,
      f_job_type: config.f_job_type,
      f_remote: config.f_remote,
      salary_min: config.salary_min,
    },
    scan_run_id: config.runId,
  };

  await new Promise((resolve) =>
    chrome.storage.local.set({ _preIngest: Date.now() }, resolve)
  );
  await new Promise((r) => setTimeout(r, 100));

  const result = await ingestJob(jobPayload);

  if (!result) {
    counters.jd_failed++;
    pushScanError(counters, {
      job_id: cardData.job_id,
      type: "jd_failed",
      message: "No response from extension (ingest)",
    });
    console.warn(
      "[JHA] Ingest: no response from background for:",
      cardData.job_title
    );
  } else if (result.error || !result.id) {
    counters.jd_failed++;
    pushScanError(counters, {
      job_id: cardData.job_id,
      type: "jd_failed",
      message: result.error || "Ingest rejected",
    });
    console.warn("[JHA] Ingest failed for:", cardData.job_title, result.error);
  } else if (result.already_exists || result.content_duplicate) {
    counters.existing++;
  } else {
    counters.new_jobs++;
  }

  await chrome.storage.local.set({ liveProgress: { ...counters } });

  return result || {};
}
