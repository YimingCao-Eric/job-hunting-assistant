/* ── LinkedIn DOM: cards, session, extraction ──────────────────────────── */

function getCards(silent = false) {
  for (const selector of JOB_CARD_SELECTORS) {
    const cards = Array.from(document.querySelectorAll(selector));
    if (cards.length > 0) return cards;
  }
  if (!silent) console.warn("[JHA-LinkedIn] No job cards found");
  return [];
}

async function waitForCards(timeoutMs = 8000) {
  const start = Date.now();
  let lastCount = 0;
  let stableFor = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(300);
    const cards = getCards(true);
    const count = cards.length;
    if (count >= 25) return cards;
    if (count > 0 && count === lastCount) {
      stableFor += 300;
      if (stableFor >= 1000) return cards;
    } else {
      stableFor = 0;
    }
    lastCount = count;
  }
  return getCards(true);
}

function getJobId(card) {
  const fromAttr = card.getAttribute("data-occludable-job-id");
  if (fromAttr) return fromAttr;
  const a = card.querySelector('a[href*="/jobs/view/"]');
  const match = a?.href?.match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
}

function checkSession() {
  const href = window.location.href;
  if (href.includes("/checkpoint/challenge")) return "captcha";
  if (
    href.includes("/login") ||
    href.includes("/authwall") ||
    href.includes("/checkpoint")
  )
    return "expired";
  if (!href.includes("/jobs/")) return "redirected";
  return "live";
}

async function reportSessionError(error) {
  await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "SESSION_ERROR", error }, resolve)
  );
}

function extractCardData(card) {
  if (!card) return null;

  const job_id = getJobId(card);
  const anchor = card.querySelector('a[href*="/jobs/view/"]');
  const rawUrl =
    anchor?.href ||
    (job_id ? `https://www.linkedin.com/jobs/view/${job_id}/` : null);
  const job_url = rawUrl ? rawUrl.split("?")[0].split("&")[0] : null;

  const titleEl =
    card.querySelector(".job-card-list__title") ||
    card.querySelector('[class*="job-card-list__title"]') ||
    card.querySelector('a[class*="job-card"][aria-label]') ||
    card.querySelector('[class*="job-title"]') ||
    card.querySelector("strong") ||
    card.querySelector('a[href*="/jobs/view/"]');
  const companyEl = card.querySelector(
    '.job-card-container__company-name, .artdeco-entity-lockup__subtitle, [class*="company-name"]'
  );
  const locationEl = card.querySelector(
    '.job-card-container__metadata-item, [class*="job-card-container__metadata"]'
  );
  const timeEl = card.querySelector("time");
  const easy_apply = !!card.querySelector(
    '[class*="easy-apply"], .job-card-container__easy-apply-label'
  );

  const job_title =
    titleEl?.innerText?.trim().split("\n")[0] ||
    titleEl?.getAttribute("aria-label") ||
    null;

  return {
    job_id,
    job_title,
    company: companyEl?.innerText?.trim() || null,
    location: locationEl?.innerText?.trim() || null,
    post_datetime: timeEl?.getAttribute("datetime") || null,
    job_url,
    easy_apply,
  };
}

