/* ── Indeed per-card ingest pipeline ─────────────────────────────────── */

function pushScanError(counters, entry) {
  if (!counters.errors) counters.errors = [];
  if (counters.errors.length >= 200) return;
  counters.errors.push(entry);
}

/** Job detail page — sync DOM check only (no executeScript / async). */
function detectIndeedEasyApply() {
  return !!(
    document.querySelector('[data-testid="indeed-apply-widget"]') ||
    document.querySelector("#indeedApplyButton") ||
    document.querySelector(".ia-IndeedApplyButton")
  );
}

function parseIndeedPostDate(snippets) {
  if (!Array.isArray(snippets)) return null;
  const snippet = snippets.find(s => /posted|active/i.test(s));
  if (!snippet) return null;

  const now = new Date();
  const justPosted = /just posted|today/i.test(snippet);
  if (justPosted) return now.toISOString();

  const match = snippet.match(/(\d+)\s*(day|hour|minute)/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit.startsWith('hour') ? amount * 3600000
            : unit.startsWith('minute') ? amount * 60000
            : amount * 86400000;
  return new Date(now.getTime() - ms).toISOString();
}

async function processCard(anchor, config, counters) {
  counters.scraped++;
  const cardData = extractCardData(anchor);

  if (!cardData.jk) {
    counters.stale_skipped++;
    await recordSkip("indeed", cardData, "no_id", config.runId);
    return { skipped: true };
  }

  const gqlStart = Date.now();
  const [mosaicJob, jdResult] = await Promise.all([
    getIndeedMosaicJobForJk(cardData.jk),
    fetchIndeedJD(cardData.jk),
  ]);

  const gqlResultType = jdResult?.error
    ? "error"
    : jdResult?.rateLimited
      ? "rate_limited"
      : jdResult?.phantom
        ? "phantom"
        : jdResult?.jd
          ? "jd_ok"
          : "unknown";

  await JhaDebug.emit(
    "indeed_graphql",
    {
      jk: cardData.jk,
      took_ms: Date.now() - gqlStart,
      result_type: gqlResultType,
      jd_len: jdResult?.jd?.length || 0,
      http_status: jdResult?.http_status ?? null,
      has_indeed_key: !!document.head.getAttribute("data-jha-api-key"),
      error: jdResult?.error ?? null,
    },
    gqlResultType === "jd_ok" ? "info" : "warn"
  );

  if (jdResult?.error) {
    counters.jd_failed++;
    pushScanError(counters, {
      jk: cardData.jk,
      type: "jd_failed",
      message: `Indeed JD: ${jdResult.error}`,
    });
    await recordSkip("indeed", cardData, "jd_failed", config.runId);
    return { skipped: true };
  }
  if (jdResult?.rateLimited) {
    console.warn("[JHA-Indeed] Rate limited — scan will cool down at page level");
    counters.totalRateLimited = (counters.totalRateLimited || 0) + 1;
    return { rateLimited: true };
  }
  if (jdResult?.phantom) {
    // Phantom jk — not a real job, skip silently like a stale card
    counters.stale_skipped++;
    return { skipped: true };
  }

  const easyApply = detectIndeedEasyApply();
  const applyUrl = easyApply ? null : cardData.job_url;

  const mosaicPayload = mosaicJob ?? null;
  let graphqlPayload = null;
  const gj = jdResult.graphql_job;
  if (gj && typeof gj === "object" && Object.keys(gj).length > 0) {
    graphqlPayload = gj;
  }
  const source_raw =
    mosaicPayload || graphqlPayload
      ? { mosaic: mosaicPayload, graphql: graphqlPayload }
      : undefined;

  const ingStart = Date.now();
  const result = await ingestJob({
    website: "indeed",
    job_title: cardData.job_title,
    company: cardData.company,
    location: cardData.location,
    job_description: jdResult.jd,
    job_url: cardData.job_url,
    apply_url: applyUrl,
    easy_apply: easyApply,
    post_datetime: parseIndeedPostDate(cardData.snippets),
    search_filters: {
      indeed_fromage: config.indeed_fromage,
      indeed_jt: config.indeed_jt,
      indeed_remotejob: config.indeed_remotejob,
    },
    scan_run_id: config.runId,
    ...(source_raw ? { source_raw } : {}),
  });

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
      jk: cardData.jk,
      title: cardData.job_title,
      company: cardData.company,
      took_ms: Date.now() - ingStart,
      result_type: resultType,
      result_error: result?.error || null,
      http_status: result?.http_status || null,
    },
    result && result.id ? "info" : "warn"
  );

  if (!result) {
    counters.jd_failed++;
    pushScanError(counters, {
      jk: cardData.jk,
      type: "jd_failed",
      message: "No response from extension (ingest)",
    });
  } else if (result.error || !result.id) {
    counters.jd_failed++;
    pushScanError(counters, {
      jk: cardData.jk,
      type: "jd_failed",
      message: result.error || "Ingest rejected",
    });
    console.warn("[JHA-Indeed] Ingest failed:", cardData.job_title, result?.error);
  } else if (result.already_exists || result.content_duplicate) {
    counters.existing++;
  } else {
    counters.new_jobs++;
  }

  await chrome.storage.local.set({ liveProgress: { ...counters } });

  return result || {};
}
