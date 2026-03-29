/* ── Indeed DOM: session, cards, extraction ────────────────────────────── */

function checkSession() {
  const href = window.location.href;
  if (href.includes("/account/login") || href.includes("signin")) return "expired";
  if (!href.includes("ca.indeed.com/jobs")) return "redirected";
  return "live";
}

function getCards() {
  return Array.from(document.querySelectorAll("a[data-jk]"));
}

async function waitForCards(timeoutMs = 10000) {
  const start = Date.now();
  let last = 0;
  let stableFor = 0;
  while (Date.now() - start < timeoutMs) {
    const count = getCards().length;
    if (count > last) {
      last = count;
      stableFor = 0;
    } else if (count > 0) {
      stableFor += 300;
      if (stableFor >= 1000) {
        console.log("[JHA-Indeed] waitForCards: " + count + " cards");
        return getCards();
      }
    }
    await sleep(300);
  }
  const final = getCards();
  console.log("[JHA-Indeed] waitForCards timeout: " + final.length + " cards");
  return final;
}

function extractCardData(anchor) {
  const jk = anchor.getAttribute("data-jk");
  const container = anchor.closest(".job_seen_beacon");
  const job_url = "https://ca.indeed.com/viewjob?jk=" + jk;

  const titleEl = anchor.querySelector('span[id*="jobTitle"], span[title]');
  const title =
    titleEl?.innerText?.trim() || anchor.innerText?.trim() || null;
  const company =
    container
      ?.querySelector('[data-testid="company-name"]')
      ?.innerText?.trim() || null;
  const location =
    container
      ?.querySelector('[data-testid="text-location"]')
      ?.innerText?.trim() || null;
  const easy_apply = !!container?.querySelector(
    '[aria-label*="Easily apply"]'
  );
  const snippets = Array.from(
    container?.querySelectorAll(
      '[data-testid="attribute_snippet_testid"]'
    ) || []
  )
    .map((e) => e.innerText?.trim())
    .filter(Boolean);

  return { jk, job_title: title, company, location, easy_apply, snippets, job_url };
}
