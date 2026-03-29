/* ── Indeed JD fetch — GraphQL API (apis.indeed.com) ─────────────────── */

async function _strategy6(jk, scanDelay) {
  try {
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

    const query = `
      query GetJobData($jobDataInput: JobDataInput!) {
        jobData(input: $jobDataInput) {
          results {
            job {
              description {
                text
                html
              }
              title
              employer { name }
              location {
                city
                admin1Name
                countryCode
              }
            }
          }
        }
      }
    `;

    const res = await fetch("https://apis.indeed.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "indeed-api-key": apiKey,
        "indeed-co": "CA",
      },
      body: JSON.stringify({
        query,
        variables: {
          jobDataInput: {
            jobKeys: [jk],
            useSearchlessPrice: false,
          },
        },
      }),
    });

    if (res.status === 429 || res.status === 503) {
      console.warn("[JHA-Indeed] strategy6 graphQL " + jk + " status=" + res.status + " — rate limited");
      return { rateLimited: true };
    }
    if (!res.ok) {
      console.warn("[JHA-Indeed] strategy6 graphQL " + jk + " status=" + res.status);
      return null;
    }

    const data = await res.json();
    const results = data?.data?.jobData?.results;

    if (!results || results.length === 0) {
      console.log("[JHA-Indeed] strategy6: phantom jk (no results) " + jk);
      return { phantom: true };
    }

    const job = results[0]?.job;
    const jd = job?.description?.text || job?.description?.html || null;

    if (!jd || jd.length < 100) {
      console.warn(
        "[JHA-Indeed] strategy6: JD too short for jk=" + jk + " (len=" + (jd?.length ?? 0) + ")"
      );
      return null;
    }

    return { jd };
  } catch (e) {
    console.error("[JHA-Indeed] strategy6 threw:", e.message);
    return null;
  }
}

async function fetchIndeedJD(jk, scanDelay) {
  return _strategy6(jk, scanDelay);
}
