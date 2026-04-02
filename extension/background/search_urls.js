/* ── Search URL builders ─────────────────────────────────────────────── */

function buildSearchUrl(config, f_tpr, startOffset = 0) {
  const params = new URLSearchParams({
    keywords: config.keyword,
    location: config.location,
  });
  const liHours = parseInt(String(config.linkedin_f_tpr ?? "").trim(), 10);
  let fTprParam = null;
  if (!Number.isNaN(liHours) && liHours > 0) {
    fTprParam = `r${liHours * 3600}`;
  } else if (f_tpr) {
    fTprParam = f_tpr;
  }
  if (fTprParam) params.set("f_TPR", fTprParam);
  if (config.f_experience) params.set("f_E", config.f_experience);
  if (config.f_job_type) params.set("f_JT", config.f_job_type);
  if (config.f_remote) params.set("f_WT", config.f_remote);
  if (startOffset > 0) params.set("start", startOffset);
  return `https://www.linkedin.com/jobs/search?${params.toString()}`;
}

function buildIndeedSearchUrl(config, startOffset = 0) {
  const params = new URLSearchParams();
  params.set("q", config.indeed_keyword || config.keyword || "software engineer");
  params.set("l", config.indeed_location || config.location || "Canada");
  params.set("sort", "relevance");
  if (config.indeed_fromage) params.set("fromage", String(config.indeed_fromage));
  if (config.indeed_remotejob) params.set("remotejob", "1");
  const ij = config.general_internship_only
    ? "internship"
    : (config.indeed_jt || "").trim();
  if (ij) params.set("jt", ij);
  if (config.indeed_explvl) params.set("explvl", config.indeed_explvl);
  if (config.indeed_lang) params.set("lang", config.indeed_lang);
  if (startOffset > 0) params.set("start", String(startOffset));
  return `https://ca.indeed.com/jobs?${params.toString()}`;
}

function buildGlassdoorSearchUrl(config) {
  const g = config.glassdoor;

  const locSlug = g.location_slug;
  const kwSlug  = g.keyword_slug;
  const locLen  = locSlug.length;
  const kwStart = locLen + 1;
  const kwEnd   = kwStart + kwSlug.length;

  const path = `https://www.glassdoor.ca/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${locLen}_IN3_KO${kwStart},${kwEnd}.htm`;

  const params = new URLSearchParams();
  if (g.fromAge != null)         params.set("fromAge",         g.fromAge);
  if (g.applicationType != null) params.set("applicationType", g.applicationType);
  if (g.remoteWorkType != null)  params.set("remoteWorkType",  g.remoteWorkType);
  if (g.minSalary != null)       params.set("minSalary",       g.minSalary);
  if (g.maxSalary != null)       params.set("maxSalary",       g.maxSalary);
  if (g.minRating != null)       params.set("minRating",       g.minRating);
  if (g.jobType) params.set("jobType", g.jobType);
  if (g.seniorityType != null)   params.set("seniorityType",   g.seniorityType);
  params.set("sortBy", "date_desc");

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
