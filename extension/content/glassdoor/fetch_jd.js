/* ── Glassdoor JD fetcher — job-listing HTML + __NEXT_DATA__ (Next.js embed) ─ */

const GLASSDOOR_JD_FETCH_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchGlassdoorJD(jobUrl, jl, scanDelay) {
  if (!jobUrl) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Rewrite .com to .ca — content script runs on glassdoor.ca;
    // cross-origin fetch to glassdoor.com fails with CORS TypeError
    const safeUrl = jobUrl
      .replace("https://www.glassdoor.com/", "https://www.glassdoor.ca/")
      .replace("https://glassdoor.com/", "https://www.glassdoor.ca/");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GLASSDOOR_JD_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(safeUrl, {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      clearTimeout(timeout);

      if (res.status === 429 || res.status === 503) return { rateLimited: true };
      if (!res.ok) {
        console.warn(`[JHA-Glassdoor] fetch_jd: HTTP ${res.status} for jl=${jl} url=${safeUrl}`);
        return null;
      }

      const html = await res.text();

      // Strategy 1: __NEXT_DATA__ (most reliable — Glassdoor is Next.js)
      const nextMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
      );
      if (nextMatch) {
        try {
          const d = JSON.parse(nextMatch[1]);
          const desc =
            d?.props?.pageProps?.jobListing?.jobview?.job?.description ||
            d?.props?.pageProps?.jobListing?.jobview?.job?.descriptionFragments?.join("\n") ||
            d?.props?.pageProps?.jobDetail?.jobDescription ||
            d?.props?.pageProps?.job?.description ||
            null;
          if (desc) {
            const clean = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (clean.length >= 100) return { jd: clean };
          }
        } catch (e) {
          /* fall through */
        }
      }

      // Strategy 2: JSON-LD
      const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (ldMatch) {
        try {
          const d = JSON.parse(ldMatch[1]);
          const desc = d?.description || d?.jobDescription || null;
          if (desc) {
            const clean = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (clean.length >= 100) return { jd: clean };
          }
        } catch (e) {
          /* fall through */
        }
      }

      // Strategy 3: DOM selector on fetched HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const el = doc.querySelector(
        '[class*="JobDetails_jobDescription"], [data-test="jobDescriptionContent"], #JobDescriptionContainer'
      );
      if (el) {
        const clean = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (clean.length >= 100) return { jd: clean };
      }

      console.warn(`[JHA-Glassdoor] fetch_jd: no JD found for jl=${jl} url=${safeUrl}`);
      return { phantom: true };
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < 2) {
        console.warn(
          `[JHA-Glassdoor] fetch_jd: attempt ${attempt} failed for jl=${jl} url=${safeUrl} (${err.name}) — retrying in 2s`
        );
        await sleep(2000);
        continue;
      }
      if (err.name === "AbortError") {
        console.warn(`[JHA-Glassdoor] fetch_jd: timeout for jl=${jl} url=${safeUrl}`);
      } else {
        console.error(`[JHA-Glassdoor] fetch_jd error for jl=${jl} url=${safeUrl}: ${err.message}`);
      }
      return null;
    }
  }

  return null;
}
