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

  const voyStart = Date.now();
  const [voyagerResult] = await Promise.all([
    fetchJDViaVoyager(cardData.job_id),
    new Promise((resolve) =>
      chrome.storage.local.set({ _swHeartbeat: Date.now() }, resolve)
    ),
  ]);

  const jdText =
    voyagerResult && voyagerResult.jd != null
      ? String(voyagerResult.jd).trim()
      : "";

  await JhaDebug.emit(
    "voyager",
    {
      job_id: cardData.job_id,
      took_ms: Date.now() - voyStart,
      http_status: voyagerResult?.status ?? null,
      error: voyagerResult?.error ?? null,
      got_jd: !!(voyagerResult && voyagerResult.jd && !voyagerResult.error),
      jd_len: jdText.length,
      got_company: !!(voyagerResult && voyagerResult.company),
      got_listed_at: !!(voyagerResult && voyagerResult.listedAt),
    },
    voyagerResult && !voyagerResult.error ? "info" : "warn"
  );

  if (!voyagerResult || voyagerResult.error) {
    counters.jd_failed++;
    pushScanError(counters, {
      job_id: cardData.job_id,
      type: "jd_failed",
      message: voyagerResult?.error
        ? `Voyager: ${voyagerResult.error}`
        : "Voyager returned no JD",
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

  const rawApplyUrl = voyagerResult?.apply_url || null;
  const isEasyApply = !!(
    rawApplyUrl && rawApplyUrl.includes("linkedin.com/job-apply/")
  );
  const applyUrl = isEasyApply ? null : rawApplyUrl;

  const jobPayload = {
    website: "linkedin",
    job_title: cardData.job_title,
    company: cardData.company,
    location: cardData.location,
    job_description: jdText,
    job_url: cardData.job_url,
    apply_url: applyUrl,
    easy_apply: isEasyApply,
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

  const ingStart = Date.now();
  const result = await ingestJob(jobPayload);
  const resultType = !result
    ? "no_response"
    : result.error
      ? "error"
      : !result.id
        ? "rejected"
        : result.already_exists
          ? "existing"
          : result.content_duplicate
            ? "content_duplicate"
            : "new";

  await JhaDebug.emit(
    "ingest",
    {
      job_id: cardData.job_id,
      title: cardData.job_title,
      company: cardData.company,
      took_ms: Date.now() - ingStart,
      result_type: resultType,
      result_error: result?.error || null,
      http_status: result?.http_status ?? null,
    },
    result && result.id ? "info" : "warn"
  );

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
