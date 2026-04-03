const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const TOKEN = import.meta.env.VITE_AUTH_TOKEN || 'dev-token';

const headers = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
});

export const api = {
  // Config
  getConfig: () =>
    fetch(`${BASE_URL}/config`, { headers: headers() }).then(r => r.json()),

  updateConfig: (data) =>
    fetch(`${BASE_URL}/config`, {
      method: 'PUT', headers: headers(), body: JSON.stringify(data)
    }).then(r => r.json()),

  // Jobs
  getJobs: async (params = {}) => {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([_, v]) => v !== null && v !== undefined && v !== '')
    );
    const query = new URLSearchParams(cleanParams).toString();
    const data = await fetch(`${BASE_URL}/jobs?${query}`, { headers: headers() }).then(r => r.json());
    if (Array.isArray(data)) {
      return { items: data, total: data.length, limit: data.length, offset: 0 };
    }
    return data;
  },

  // Scan trigger (optional extra fields e.g. scan_all for Scan All sequence)
  triggerScan: (website = null, extra = {}) => {
    const body = { ...extra };
    if (website) body.website = website;
    return fetch(`${BASE_URL}/extension/trigger-scan`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }).then(r => r.json());
  },

  // Stop scan
  stopScan: () =>
    fetch(`${BASE_URL}/extension/trigger-stop`, {
      method: 'POST', headers: headers()
    }).then(r => r.json()),

  // Skipped / filtered jobs
  getSkippedJobs: (scanRunId, params = {}) => {
    const q = new URLSearchParams({ scan_run_id: scanRunId, ...params }).toString();
    return fetch(`${BASE_URL}/jobs/skipped?${q}`, { headers: headers() }).then(r => r.json());
  },

  getJob: (jobId) =>
    fetch(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}`, { headers: headers() }).then(async (r) => {
      if (!r.ok) throw new Error('Job not found');
      return r.json();
    }),

  // Run logs (for scan status)
  getRunLogs: (limit = 1) =>
    fetch(`${BASE_URL}/extension/run-log?limit=${limit}`, { headers: headers() })
      .then(r => r.json()),

  getExtensionState: () =>
    fetch(`${BASE_URL}/extension/state`, { headers: headers() }).then(r => r.json()),

  runDedup: () =>
    fetch(`${BASE_URL}/jobs/dedup`, {
      method: 'POST',
      headers: headers(),
    }).then((r) => r.json()),

  resetDedup: () =>
    fetch(`${BASE_URL}/jobs/dedup/reset`, {
      method: 'POST',
      headers: headers(),
    }).then((r) => r.json()),

  getDedupReports: () =>
    fetch(`${BASE_URL}/dedup/reports`, {
      headers: headers(),
    }).then((r) => r.json()),

  getDedupReport: (id) =>
    fetch(`${BASE_URL}/dedup/reports/${id}`, {
      headers: headers(),
    }).then((r) => r.json()),

  getJobsByDedupStatus: async (status, params = {}) => {
    const cleanParams = Object.fromEntries(
      Object.entries({ dedup_status: status, ...params }).filter(
        ([_, v]) => v !== null && v !== undefined && v !== ''
      )
    );
    const qs = new URLSearchParams(cleanParams).toString();
    const data = await fetch(`${BASE_URL}/jobs?${qs}`, {
      headers: headers(),
    }).then((r) => r.json());
    if (Array.isArray(data)) {
      return { items: data, total: data.length, limit: data.length, offset: 0 };
    }
    return data;
  },
};
