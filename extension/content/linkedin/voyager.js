/* ── LinkedIn Voyager API for job description & company ──────────────── */

function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID=([^;]+)/);
  return match ? match[1].replace(/"/g, "") : null;
}

async function fetchCompanyName(companyUrn, csrfToken) {
  if (!companyUrn) return null;
  const match = companyUrn.match(/:(\d+)$/);
  if (!match) return null;
  const companyId = match[1];

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), 3000)
  );
  const fetchPromise = (async () => {
    try {
      const res = await fetch(
        `https://www.linkedin.com/voyager/api/entities/companies/${companyId}`,
        {
          credentials: "include",
          headers: {
            "csrf-token": csrfToken,
            Accept: "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
          },
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const miniCompany = data?.included?.find(
        (i) => i?.$type?.includes("MiniCompany") || i?.name
      );
      return miniCompany?.name || miniCompany?.localizedName || null;
    } catch {
      return null;
    }
  })();

  return Promise.race([fetchPromise, timeout]);
}

/**
 * Fetches JD from Voyager; up to 2 attempts with 500ms between tries (single
 * function — avoids a separate outer retry + long sleep that worsened SW suspension).
 */
async function fetchJDViaVoyager(jobId) {
  const csrfToken = getCsrfToken();
  console.log(
    `[JHA] Voyager ${jobId}: csrfToken=${csrfToken ? "present" : "MISSING"}`
  );
  if (!csrfToken) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(
        `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`,
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
      console.log(`[JHA] Voyager ${jobId}: status=${res.status}`);
      if (res.status === 429 || res.status === 403 || res.status === 999) {
        return null;
      }
      if (!res.ok) {
        console.warn(`[JHA] Voyager ${jobId}: non-ok status ${res.status}`);
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        return null;
      }
      const data = await res.json();
      const jdRaw =
        data?.data?.description?.text ||
        data?.included?.[0]?.description?.text ||
        data?.description?.text ||
        null;
      const trimmed = jdRaw != null ? String(jdRaw).trim() : "";
      console.log(`[JHA] Voyager ${jobId}: jdLength=${trimmed.length}`);

      if (trimmed.length > 0) {
        const apply_url =
          data?.data?.applyMethod?.companyApplyUrl ||
          data?.data?.applyMethod?.easyApplyUrl ||
          null;
        const companyUrn = data?.data?.companyDetails?.company || null;
        const companyName = await fetchCompanyName(companyUrn, csrfToken);
        const applyMethod = data?.data?.applyMethod;
        const easy_apply = !!(
          applyMethod?.easyApplyUrl ||
          String(applyMethod?.$type || "").includes("EasyApply")
        );

        return {
          jd: trimmed,
          apply_url,
          title: data?.data?.title || null,
          location: data?.data?.formattedLocation || null,
          listedAt:
            data?.data?.originalListedAt || data?.data?.listedAt || null,
          company: companyName,
          easy_apply,
        };
      }

      console.warn(
        `[JHA-LinkedIn] fetchJDViaVoyager: short/empty JD for ${jobId} (len=${trimmed.length}) — will retry`
      );
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return null;
    } catch (e) {
      console.error(`[JHA] Voyager ${jobId}: fetch threw: ${e.message}`);
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return null;
    }
  }
  return null;
}
