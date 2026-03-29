/* ── Glassdoor DOM: parse a single job card element ─────────────────────── */

function parseGlassdoorCard(cardEl) {
  const jobId = cardEl.getAttribute("data-id") || cardEl.getAttribute("data-jobid") || null;

  const titleEl = cardEl.querySelector('[data-test="job-title"], .JobCard_jobTitle__GLyJ1, a.jobTitle, [class*="jobTitle"]');
  const jobTitle = titleEl ? titleEl.textContent.trim() : null;

  const linkEl = cardEl.querySelector('a[data-test="job-title"], a[href*="/job-listing/"], a[href*="?jl="]');
  let jobUrl = null;
  if (linkEl) {
    const href = linkEl.getAttribute("href");
    jobUrl = href.startsWith("http") ? href : `https://www.glassdoor.ca${href}`;
  }

  const companyEl = cardEl.querySelector('[data-test="employer-name"], .EmployerProfile_compactEmployerName__9MGcV, [class*="EmployerProfile_compactEmployerName"], [class*="employerName"]');
  const company = companyEl ? companyEl.textContent.trim() : null;

  const locationEl = cardEl.querySelector('[data-test="emp-location"], .JobCard_location__N_iYE, [class*="location"]');
  const location = locationEl ? locationEl.textContent.trim() : null;

  const salaryEl = cardEl.querySelector('[data-test="detailSalary"], [class*="salary"], [class*="Salary"]');
  const salary = salaryEl ? salaryEl.textContent.trim() : null;

  const easyApplyEl = cardEl.querySelector('[data-test="easy-apply"], [class*="EasyApply"], [class*="easyApply"]');
  const easyApply = !!easyApplyEl;

  const ageEl = cardEl.querySelector('[data-test="job-age"], [class*="jobAge"], [class*="JobCard_listingAge"]');
  const ageText = ageEl ? ageEl.textContent.trim() : null;

  let jl = jobId;
  if (jobUrl) {
    const jlMatch = jobUrl.match(/[?&]jl=(\d+)/);
    if (jlMatch) jl = jlMatch[1];
  }

  return { jobId, jl, jobTitle, company, location, salary, easyApply, ageText, jobUrl };
}
