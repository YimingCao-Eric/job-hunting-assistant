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
 * Full JobPosting node for source_raw.json_ld (§3 v6-3A).
 * Prefer @type === 'JobPosting'; else first JobPosting inside @graph / arrays.
 */
function extractGlassdoorJobPostingJsonLd(doc) {
  const ldNodes = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const node of ldNodes) {
    try {
      const parsed = JSON.parse(node.textContent);
      const t = parsed["@type"];
      if (t === "JobPosting") return parsed;
      if (Array.isArray(t) && t.includes("JobPosting")) return parsed;
      const postings = [];
      collectJobPostingObjects(parsed, postings);
      if (postings[0]) return postings[0];
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

/**
 * Parse Next.js embed once per listing HTML response.
 */
function parseGlassdoorNextData(html) {
  const nextMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!nextMatch) return null;
  try {
    return JSON.parse(nextMatch[1]);
  } catch {
    return null;
  }
}

function getListingIdFromUrl(url) {
  try {
    const u = new URL(url);
    const jl = u.searchParams.get("jl");
    if (jl && /^[0-9]+$/.test(jl)) return jl;
  } catch {
    /* invalid URL */
  }
  return null;
}

/**
 * Extract a balanced JSON object or array starting at startIdx (first char `{` or `[`).
 */
function extractBalancedJsonFragment(html, startIdx) {
  const pairs = { "{": "}", "[": "]" };
  const openChars = new Set(["{", "["]);
  const stack = [];
  let inStr = false;
  let esc = false;
  let quote = null;

  for (let j = startIdx; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      continue;
    }
    if (openChars.has(c)) {
      stack.push(c);
      continue;
    }
    if (c === "}" || c === "]") {
      if (!stack.length) return null;
      const top = stack.pop();
      if (pairs[top] !== c) return null;
      if (!stack.length) {
        return html.slice(startIdx, j + 1);
      }
    }
  }
  return null;
}

/**
 * Find `"key":` and JSON-parse the following `{...}` or `[...]` value (first match that parses).
 */
function extractJsonObjectAfterKey(html, key) {
  const needle = `"${key}"`;
  let searchStart = 0;
  while (searchStart < html.length) {
    const pos = html.indexOf(needle, searchStart);
    if (pos === -1) return null;
    let i = pos + needle.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== ":") {
      searchStart = pos + needle.length;
      continue;
    }
    i++;
    while (i < html.length && /\s/.test(html[i])) i++;
    const frag = extractBalancedJsonFragment(html, i);
    if (!frag || (frag[0] !== "{" && frag[0] !== "[")) {
      searchStart = pos + needle.length;
      continue;
    }
    try {
      return JSON.parse(frag);
    } catch {
      searchStart = pos + needle.length;
    }
  }
  return null;
}

/**
 * __next_f chunks look like: self.__next_f.push([1,"...JSON-encoded string..."])
 * Collect every quoted string inside those push() calls and JSON-parse it (un-escapes).
 */
function extractRscEncodedString(html) {
  const decoded = [];
  const re =
    /__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const jsonStringLiteral = m[1];
    try {
      decoded.push(JSON.parse(jsonStringLiteral));
    } catch {
      /* skip malformed chunk */
    }
  }
  return decoded;
}

/**
 * Walk raw HTML + decoded RSC flight chunks for embedded job payload.
 * Pass 1: unescaped `"jobViewPage":{` / `"jobListing":{` (SSR / legacy).
 * Pass 2: JS-decoded strings from __next_f.push — escaped `\"jobViewPage\"` in HTML.
 */
function extractGlassdoorJobRootFromHtml(html) {
  if (typeof html !== "string" || !html.length) return null;

  const direct =
    extractJsonObjectAfterKey(html, "jobViewPage") ||
    extractJsonObjectAfterKey(html, "jobListing");
  if (direct && typeof direct === "object") {
    return direct;
  }

  const chunks = extractRscEncodedString(html);
  for (const chunk of chunks) {
    if (typeof chunk !== "string" || chunk.length < 50) continue;
    const found =
      extractJsonObjectAfterKey(chunk, "jobViewPage") ||
      extractJsonObjectAfterKey(chunk, "jobListing");
    if (found && typeof found === "object") return found;
  }
  return null;
}

/**
 * Backend expects sibling keys jobListing.jobDetailsData and jobListing.jobDetailsRawData.
 * Live jobViewPage nests raw under jobDetailsData — hoist when needed.
 * Ensure jobDetailsData.listingId for ingest (top-level or jobview.job.listingId).
 */
function ensureBackendGlassdoorListingShape(jobListingRoot, jlFromUrl) {
  if (!jobListingRoot || typeof jobListingRoot !== "object") return jobListingRoot;

  const jdd = jobListingRoot.jobDetailsData;
  if (!jdd || typeof jdd !== "object") return jobListingRoot;

  const topRaw = jobListingRoot.jobDetailsRawData;
  const nestedRaw = jdd.jobDetailsRawData;

  const jobDetailsRawData =
    topRaw && typeof topRaw === "object"
      ? topRaw
      : nestedRaw && typeof nestedRaw === "object"
        ? nestedRaw
        : {};

  const needsRawHoist =
    (!topRaw || typeof topRaw !== "object") &&
    nestedRaw &&
    typeof nestedRaw === "object";

  const listingFromJv = jobDetailsRawData?.jobview?.job?.listingId;

  const resolvedListing =
    jdd.listingId ?? listingFromJv ?? jlFromUrl ?? undefined;

  const jobDetailsData =
    resolvedListing !== undefined ? { ...jdd, listingId: resolvedListing } : jdd;

  if (
    !needsRawHoist &&
    jobDetailsData === jdd &&
    resolvedListing === jdd.listingId
  ) {
    return jobListingRoot;
  }

  return {
    ...jobListingRoot,
    jobDetailsData,
    ...(needsRawHoist ? { jobDetailsRawData } : {}),
  };
}

/**
 * source_raw for Glassdoor ingest — listing_id required (backend 400 otherwise).
 * Path 1: RSC/HTML embedded jobViewPage or jobListing. Path 2: __NEXT_DATA__ jobListing.
 * Path 3: ?jl= + JSON-LD stub only.
 */
function buildGlassdoorSourceRaw(jobListingSubtree, jsonLd, fetchedUrl) {
  const urlJl = getListingIdFromUrl(fetchedUrl || "");
  let jl =
    jobListingSubtree && typeof jobListingSubtree === "object"
      ? ensureBackendGlassdoorListingShape(jobListingSubtree, urlJl)
      : jobListingSubtree;

  const ndListingId = jl?.jobDetailsData?.listingId;
  if (ndListingId) {
    return {
      jobListing: jl,
      json_ld: jsonLd ?? null,
    };
  }
  if (urlJl && jsonLd) {
    return {
      jobListing: { jobDetailsData: { listingId: urlJl } },
      json_ld: jsonLd,
    };
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
function hasJdText(jd) {
  return jd != null && String(jd).trim().length > 0;
}

function jdFromRenderedDom(doc) {
  const descEl = doc.querySelector(
    '[class*="JobDetails_jobDescription"], [data-test="jobDescriptionContent"], ' +
      '[id="job-description"], [class*="desc__text"], [class*="jobDescriptionContent"]'
  );
  if (!descEl) return null;
  return stripHtmlToStructuredText(descEl.innerHTML);
}

/**
 * Pin a listing URL to the current page's origin.
 * Glassdoor hands back locale subdomains (e.g. fr.glassdoor.ca) in listing links; fetching
 * one from a www.glassdoor.ca page is cross-origin and CORS-blocked, so keep path + query
 * and take protocol/host from the page.
 */
function toSameOriginUrl(jobUrl) {
  try {
    const u = new URL(jobUrl, location.origin);
    u.protocol = location.protocol;
    u.host = location.host;
    return u.href;
  } catch {
    return jobUrl;
  }
}

async function fetchGlassdoorJD(jobUrl, jl) {
  if (!jobUrl) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const safeUrl = toSameOriginUrl(jobUrl);

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
      const nextData = parseGlassdoorNextData(html);
      const fromEmbedded = extractGlassdoorJobRootFromHtml(html);
      const jobListingSubtree =
        fromEmbedded ||
        (nextData?.props?.pageProps?.jobListing &&
        typeof nextData.props.pageProps.jobListing === "object"
          ? nextData.props.pageProps.jobListing
          : null);
      const jsonLdForSourceRaw = extractGlassdoorJobPostingJsonLd(doc);
      const glassdoorSourceRaw = buildGlassdoorSourceRaw(
        jobListingSubtree,
        jsonLdForSourceRaw,
        safeUrl
      );
      const attachSourceRaw = (payload) =>
        glassdoorSourceRaw ? { ...payload, source_raw: glassdoorSourceRaw } : payload;

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
      if (!hasJdText(jd)) {
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
      if (!hasJdText(jd) && nextData) {
        try {
          const desc =
            nextData?.props?.pageProps?.jobListing?.jobDetailsRawData?.jobview
              ?.job?.description ||
            nextData?.props?.pageProps?.jobListing?.jobview?.job?.description ||
            nextData?.props?.pageProps?.jobListing?.jobview?.job?.descriptionFragments?.join(
              "\n"
            ) ||
            nextData?.props?.pageProps?.jobViewPage?.jobDetailsData
              ?.jobDetailsRawData?.jobview?.job?.description ||
            nextData?.props?.pageProps?.jobDetail?.jobDescription ||
            nextData?.props?.pageProps?.job?.description ||
            null;
          if (desc) {
            const clean = desc.includes("<")
              ? stripHtmlToStructuredText(desc)
              : String(desc).replace(/\s+/g, " ").trim();
            if (hasJdText(clean)) {
              jd = clean;
            }
          }
        } catch {
          /* fall through */
        }
      }

      // Strategy: first JSON-LD script block (regex — may differ from ld+json order)
      if (!hasJdText(jd)) {
        const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (ldMatch) {
          try {
            const d = JSON.parse(ldMatch[1]);
            const desc = d?.description || d?.jobDescription || null;
            if (desc) {
              const clean = desc.includes("<")
                ? stripHtmlToStructuredText(desc)
                : String(desc).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              if (hasJdText(clean)) {
                const loc = locationFromJobPosting(d) || locationFromLd;
                return attachSourceRaw(
                  withMeta({
                    jd: clean,
                    easy_apply: easyApplyFromLd,
                    location: loc,
                    http_status: res.status,
                  })
                );
              }
            }
          } catch {
            /* fall through */
          }
        }
      }

      // Strategy: DOM plain text fallback
      if (!hasJdText(jd)) {
        const el = doc.querySelector(
          '[class*="JobDetails_jobDescription"], [data-test="jobDescriptionContent"], #JobDescriptionContainer'
        );
        if (el) {
          const clean = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (hasJdText(clean)) {
            jd = clean;
          }
        }
      }

      if (hasJdText(jd)) {
        return attachSourceRaw(
          withMeta({
            jd: String(jd).trim(),
            easy_apply: easyApplyFromLd,
            http_status: res.status,
          })
        );
      }

      console.warn(`[JHA-Glassdoor] fetch_jd: no JD found for jl=${jl} url=${safeUrl}`);
      return { phantom: true, easy_apply: false, http_status: res.status };
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
