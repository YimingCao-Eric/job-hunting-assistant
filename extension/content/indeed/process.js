/* ── Indeed per-card ingest pipeline ─────────────────────────────────── */

function pushScanError(counters, entry) {
  if (!counters.errors) counters.errors = [];
  if (counters.errors.length >= 200) return;
  counters.errors.push(entry);
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

  const jdResult = await fetchIndeedJD(cardData.jk, config.scan_delay || "normal");

  if (jdResult && jdResult.phantom) {
    // Phantom jk — not a real job, skip silently like a stale card
    counters.stale_skipped++;
    return { skipped: true };
  }

  if (!jdResult) {
    counters.jd_failed++;
    pushScanError(counters, {
      jk: cardData.jk,
      type: "jd_failed",
      message: "Indeed JD fetch returned no result",
    });
    await recordSkip("indeed", cardData, "jd_failed", config.runId);
    return { skipped: true };
  }
  if (jdResult.rateLimited) {
    console.warn("[JHA-Indeed] Rate limited — scan will cool down at page level");
    counters.totalRateLimited = (counters.totalRateLimited || 0) + 1;
    return { rateLimited: true };
  }

  const result = await ingestJob({
    website: "indeed",
    job_title: cardData.job_title,
    company: cardData.company,
    location: cardData.location,
    job_description: jdResult.jd,
    job_url: cardData.job_url,
    apply_url: cardData.job_url,
    easy_apply: cardData.easy_apply,
    post_datetime: parseIndeedPostDate(cardData.snippets),
    search_filters: {
      indeed_fromage: config.indeed_fromage,
      indeed_jt: config.indeed_jt,
      indeed_remotejob: config.indeed_remotejob,
    },
    scan_run_id: config.runId,
  });

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
