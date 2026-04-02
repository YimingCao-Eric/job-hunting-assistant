/* ── Glassdoor JD fetcher — job-listing HTML + __NEXT_DATA__ (Next.js embed) ─ */

const GLASSDOOR_JD_FETCH_TIMEOUT_MS = 8000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip HTML to structured plain text (paragraphs, bullets).
 */
function stripHtmlToStructuredText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Collect JobPosting objects from JSON-LD (single object, @graph, nested).
 */
function collectJobPostingObjects(node, out) {
  if (!node || typeof node !== "object") return;
  const t = node["@type"];
  const types = Array.isArray(t) ? t : t != null ? [t] : [];
  if (types.includes("JobPosting")) out.push(node);
  if (Array.isArray(node["@graph"])) {
    for (const g of node["@graph"]) {
      collectJobPostingObjects(g, out);
    }
  }
}

const PROVINCE_ABBR = {
  Ontario: "ON",
  "British Columbia": "BC",
  Quebec: "QC",
  Alberta: "AB",
  Manitoba: "MB",
  Saskatchewan: "SK",
  "Nova Scotia": "NS",
  "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL",
  Newfoundland: "NL",
  "Prince Edward Island": "PE",
  "Northwest Territories": "NT",
  Nunavut: "NU",
  Yukon: "YT",
};

/**
 * Build location string from schema.org JobPosting (JSON-LD).
 * Abbreviates provinces; TELECOMMUTE + empty → "Remote"; never "Remote, Canada".
 */
function locationFromJobPosting(jobPosting) {
  if (!jobPosting || typeof jobPosting !== "object") return null;
  const addr = jobPosting.jobLocation?.address || {};
  const addressLocality = addr.addressLocality;
  const addressRegionFull = addr.addressRegion;
  const addressRegion = PROVINCE_ABBR[addressRegionFull] ?? addressRegionFull;

  let fullLocation = null;

  if (addressLocality && addressRegion) {
    if (addressLocality.toLowerCase() === "remote") {
      fullLocation = "Remote";
    } else if (addressRegion === "Canada") {
      fullLocation = addressLocality;
    } else {
      fullLocation = `${addressLocality}, ${addressRegion}`;
    }
  } else if (addressLocality) {
    fullLocation =
      addressLocality.toLowerCase() === "remote" ? "Remote" : addressLocality;
  } else if (addressRegion) {
    fullLocation = addressRegion === "Canada" ? null : addressRegion;
  }

  const isRemoteJob = jobPosting.jobLocationType === "TELECOMMUTE";
  if (isRemoteJob && !fullLocation) fullLocation = "Remote";

  if (fullLocation === "Canada") fullLocation = null;

  return fullLocation;
}

/**
 * First JobPosting from JSON-LD scripts in a parsed document.
 */
function extractFirstJobPostingFromDoc(doc) {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const j = JSON.parse(script.textContent);
      const postings = [];
      collectJobPostingObjects(j, postings);
      if (postings[0]) return postings[0];
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Parse JSON-LD scripts for JobPosting: directApply + location.
 * @param {string | Document} htmlOrDoc
 */
function extractJsonLdJobPostingMeta(htmlOrDoc) {
  const doc =
    typeof htmlOrDoc === "string"
      ? new DOMParser().parseFromString(htmlOrDoc, "text/html")
      : htmlOrDoc;
  const scripts = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]')
  );
  let easyApply = false;
  let location = null;
  for (const script of scripts) {
    try {
      const j = JSON.parse(script.textContent);
      const postings = [];
      collectJobPostingObjects(j, postings);
      for (const jp of postings) {
        if (Object.prototype.hasOwnProperty.call(jp, "directApply")) {
          easyApply = jp.directApply === true;
        }
        const loc = locationFromJobPosting(jp);
        if (loc) location = loc;
      }
    } catch {
      /* next script */
    }
  }
  return { easyApply, location };
}

/**
 * Rendered job description from DOM (preferred over stripped plain fragments).
 */
function jdFromRenderedDom(doc) {
  const descEl = doc.querySelector(
    '[class*="JobDetails_jobDescription"], [data-test="jobDescriptionContent"], ' +
      '[id="job-description"], [class*="desc__text"], [class*="jobDescriptionContent"]'
  );
  if (!descEl) return null;
  return stripHtmlToStructuredText(descEl.innerHTML);
}

async function fetchGlassdoorJD(jobUrl, jl) {
  if (!jobUrl) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
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

      if (res.status === 429 || res.status === 403) {
        console.warn(`[JHA-Glassdoor] fetch_jd: HTTP ${res.status} for jl=${jl}`)
        return null;
      }
      if (res.status === 502 || res.status === 503) {
        console.warn(
          `[JHA-Glassdoor] fetch_jd: HTTP ${res.status} for jl=${jl} url=${safeUrl}`
        );
        if (attempt < 2) {
          await sleep(2000);
          continue;
        }
        return null;
      }
      if (!res.ok) {
        console.warn(`[JHA-Glassdoor] fetch_jd: HTTP ${res.status} for jl=${jl} url=${safeUrl}`);
        return null;
      }

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const { easyApply: easyApplyFromLd, location: locationFromLd } =
        extractJsonLdJobPostingMeta(doc);

      const withMeta = (rest) => {
        const loc = rest.location ?? locationFromLd;
        return {
          ...rest,
          easy_apply: rest.easy_apply ?? easyApplyFromLd,
          ...(loc ? { location: loc } : {}),
        };
      };

      let jd = jdFromRenderedDom(doc);
      if (!jd || jd.length < 100) {
        const jobPosting = extractFirstJobPostingFromDoc(doc);
        const rawDesc = jobPosting?.description;
        if (rawDesc) {
          const descStr =
            typeof rawDesc === "string"
              ? rawDesc
              : rawDesc && typeof rawDesc === "object" && "value" in rawDesc
                ? rawDesc.value
                : String(rawDesc);
          jd = stripHtmlToStructuredText(descStr);
        }
      }

      // Strategy: __NEXT_DATA__ (most reliable — Glassdoor is Next.js)
      if (!jd || jd.length < 100) {
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
              const clean = desc.includes("<")
                ? stripHtmlToStructuredText(desc)
                : String(desc).replace(/\s+/g, " ").trim();
              if (clean.length >= 100) {
                jd = clean;
              }
            }
          } catch {
            /* fall through */
          }
        }
      }

      // Strategy: first JSON-LD script block (regex — may differ from ld+json order)
      if (!jd || jd.length < 100) {
        const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (ldMatch) {
          try {
            const d = JSON.parse(ldMatch[1]);
            const desc = d?.description || d?.jobDescription || null;
            if (desc) {
              const clean = desc.includes("<")
                ? stripHtmlToStructuredText(desc)
                : String(desc).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              if (clean.length >= 100) {
                const loc = locationFromJobPosting(d) || locationFromLd;
                return withMeta({ jd: clean, easy_apply: easyApplyFromLd, location: loc });
              }
            }
          } catch {
            /* fall through */
          }
        }
      }

      // Strategy: DOM plain text fallback
      if (!jd || jd.length < 100) {
        const el = doc.querySelector(
          '[class*="JobDetails_jobDescription"], [data-test="jobDescriptionContent"], #JobDescriptionContainer'
        );
        if (el) {
          const clean = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (clean.length >= 100) {
            jd = clean;
          }
        }
      }

      if (jd && jd.length >= 100) {
        return withMeta({ jd, easy_apply: easyApplyFromLd });
      }

      console.warn(`[JHA-Glassdoor] fetch_jd: no JD found for jl=${jl} url=${safeUrl}`);
      return { phantom: true, easy_apply: false };
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
