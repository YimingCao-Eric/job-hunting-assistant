/* ── LinkedIn Voyager API for job description & company ──────────────── */

function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID=([^;]+)/);
  return match ? match[1].replace(/"/g, "") : null;
}

/**
 * Fetches JD from Voyager; up to 2 attempts with 500ms between tries.
 * Returns { jd, ... } on success, or { error, status } on failure (G3).
 */
async function fetchJDViaVoyager(jobId) {
  const csrfToken = getCsrfToken();
  console.log(
    `[JHA] Voyager ${jobId}: csrfToken=${csrfToken ? "present" : "MISSING"}`
  );
  if (!csrfToken) return { error: "no_csrf", status: null };

  let lastStatus = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const decorationId =
        "com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65";
      const res = await fetch(
        `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}?decorationId=${encodeURIComponent(decorationId)}`,
        {
          credentials: "include",
          headers: {
            "csrf-token": csrfToken,
            Accept: "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
        }
      );
      lastStatus = res.status;
      console.log(`[JHA] Voyager ${jobId}: status=${res.status}`);
      if (res.status === 429 || res.status === 403 || res.status === 999) {
        return { error: `http_${res.status}`, status: res.status };
      }
      if (!res.ok) {
        console.warn(`[JHA] Voyager ${jobId}: non-ok status ${res.status}`);
        if (attempt === 1) {
          await sleep(500);
          continue;
        }
        return { error: `http_${res.status}`, status: res.status };
      }
      const json = await res.json();
      const jdRaw =
        json?.data?.description?.text ||
        json?.included?.[0]?.description?.text ||
        json?.description?.text ||
        null;
      const jdText = jdRaw != null ? String(jdRaw).trim() : "";
      console.log(`[JHA] Voyager ${jobId}: jdLength=${jdText.length}`);

      if (jdText.length > 0) {
        const apply_url =
          json?.data?.applyMethod?.companyApplyUrl ||
          json?.data?.applyMethod?.easyApplyUrl ||
          null;
        const applyMethod = json?.data?.applyMethod;
        const easy_apply = !!(
          applyMethod?.easyApplyUrl ||
          String(applyMethod?.$type || "").includes("EasyApply")
        );

        let source_raw = null;
        if (
          json &&
          json.data != null &&
          typeof json.data === "object" &&
          !Array.isArray(json.data)
        ) {
          source_raw = {
            data: json.data,
            included: Array.isArray(json.included) ? json.included : [],
          };
        }

        return {
          jd: jdText,
          apply_url,
          title: json?.data?.title || null,
          location: json?.data?.formattedLocation || null,
          listedAt:
            json?.data?.originalListedAt || json?.data?.listedAt || null,
          company: null,
          easy_apply,
          status: res.status,
          ...(source_raw ? { source_raw } : {}),
        };
      }

      console.warn(
        `[JHA-LinkedIn] fetchJDViaVoyager: short/empty JD for ${jobId} (len=${jdText.length}) — will retry`
      );
      if (attempt === 1) {
        await sleep(500);
        continue;
      }
      return { error: "empty_jd", status: res.status };
    } catch (e) {
      console.error(`[JHA] Voyager ${jobId}: fetch threw: ${e.message}`);
      if (attempt === 1) {
        await sleep(500);
        continue;
      }
      return { error: `fetch_threw: ${e.message}`, status: lastStatus };
    }
  }
  return { error: "unknown", status: lastStatus };
}
