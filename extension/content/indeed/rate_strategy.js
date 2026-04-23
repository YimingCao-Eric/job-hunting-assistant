/* ── Indeed JD fetch — GraphQL API (apis.indeed.com) ─────────────────── */

async function _strategy6(jk, apiKey) {
  if (!apiKey) {
    console.warn("[JHA-Indeed] strategy6: no apiKey");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let res;
  try {
    res = await fetch("https://apis.indeed.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "indeed-api-key": apiKey,
        "indeed-co": "CA",
      },
      body: JSON.stringify({
        query: `query { jobData(input: { jobKeys: [${JSON.stringify(jk)}] }) {
          results { job { title description { text html } } } } }`,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.warn("[JHA-Indeed] GraphQL timeout jk=", jk);
    } else {
      console.warn("[JHA-Indeed] fetch error jk=", jk, err.message);
    }
    return { phantom: true, http_status: null };
  }
  clearTimeout(timeoutId);

  if (res.status === 429 || res.status === 403) {
    return { phantom: true, http_status: res.status };
  }
  if (!res.ok) {
    console.warn("[JHA-Indeed] _strategy6: HTTP", res.status, "jk=", jk);
    return { phantom: true, http_status: res.status };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { phantom: true, http_status: res.status };
  }

  if (data.errors?.length) {
    console.warn(
      "[JHA-Indeed] _strategy6: GraphQL errors jk=",
      jk,
      data.errors.map((e) => e.message)
    );
    return { phantom: true, http_status: res.status };
  }

  const job = data?.data?.jobData?.results?.[0]?.job;
  if (!job) return { phantom: true, http_status: res.status };

  const descHtml = job.description?.html;
  const descText = job.description?.text;
  let jd = descText;
  if (descHtml && descHtml.length > 50) {
    jd = descHtml
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

  if (!jd || !String(jd).trim())
    return { phantom: true, http_status: res.status };
  return { jd, http_status: res.status };
}

async function fetchIndeedJD(jk) {
  let apiKey = document.head.getAttribute("data-jha-api-key");

  if (!apiKey) {
    const result = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "GET_MAIN_WORLD_VALUE" }, resolve)
    );
    apiKey = result?.value || null;
    if (apiKey) {
      document.head.setAttribute("data-jha-api-key", apiKey);
    }
  }

  if (!apiKey) {
    console.warn("[JHA-Indeed] strategy6: oneGraphApiKey not found — falling back to null");
    return null;
  }

  return _strategy6(jk, apiKey);
}
