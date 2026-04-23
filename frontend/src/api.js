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
    const searchParams = new URLSearchParams(cleanParams);
    if (params.order_by) searchParams.set('order_by', params.order_by);
    const query = searchParams.toString();
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

  createJobReport: async (jobId, body) => {
    const r = await fetch(
      `${BASE_URL}/jobs/${encodeURIComponent(jobId)}/report`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Report failed');
    }
    return r.json();
  },

  getJobReports: async (params = {}) => {
    const q = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(
          ([_, v]) => v !== null && v !== undefined && v !== ''
        )
      )
    ).toString();
    const r = await fetch(`${BASE_URL}/jobs/reports?${q}`, { headers: headers() });
    if (!r.ok) throw new Error('Failed to load job reports');
    return r.json();
  },

  getJobReportStats: async () => {
    const r = await fetch(`${BASE_URL}/jobs/reports/stats`, { headers: headers() });
    if (!r.ok) throw new Error('Failed to load job report stats');
    return r.json();
  },

  actionJobReport: async (reportId, body) => {
    const r = await fetch(
      `${BASE_URL}/jobs/reports/${encodeURIComponent(reportId)}/action`,
      { method: 'PUT', headers: headers(), body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Action failed');
    }
    return r.json();
  },

  // Profile
  getProfile: async () => {
    const r = await fetch(`${BASE_URL}/profile`, { headers: headers() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText || 'Failed to load profile');
    }
    return r.json();
  },

  uploadResume: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${BASE_URL}/profile/upload-resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Upload failed');
    }
    return r.json();
  },

  parseResume: async (markdown) => {
    const r = await fetch(`${BASE_URL}/profile/parse-resume`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ markdown }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Parse failed');
    }
    return r.json();
  },

  saveProfile: async (data) => {
    const r = await fetch(`${BASE_URL}/profile`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Failed to save profile');
    }
    return r.json();
  },

  getProfileExtracted: () =>
    fetch(`${BASE_URL}/profile/extracted`, { headers: headers() }).then((r) => {
      if (!r.ok) throw new Error('Failed to load extracted profile');
      return r.json();
    }),

  // Matching — POST /jobs/match queues work in the background; body.mode is optional:
  // cpu_only | llm_extraction_gates | cpu_score | llm_score. Response: { status: 'started', mode }.
  runMatching: async (opts = {}) => {
    const r = await fetch(`${BASE_URL}/jobs/match`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(opts && typeof opts === 'object' ? opts : {}),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(
        typeof err.detail === 'string' ? err.detail : r.statusText || 'Matching run failed'
      );
    }
    return r.json();
  },

  extractJDs: async () => api.runMatching({}),

  undoButton1: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/undo-button1`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) throw new Error('Undo failed');
    return r.json();
  },

  undoButton2: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/undo-button2`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) throw new Error('Undo failed');
    return r.json();
  },

  undoButton3: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/undo-button3`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) throw new Error('Undo failed');
    return r.json();
  },

  undoButton4: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/undo-button4`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) throw new Error('Undo failed');
    return r.json();
  },

  dismissJob: async (jobId) => {
    const r = await fetch(
      `${BASE_URL}/jobs/match/dismiss/${encodeURIComponent(jobId)}`,
      { method: 'POST', headers: headers() }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Dismiss failed');
    }
    return r.json();
  },

  undismissJob: async (jobId) => {
    const r = await fetch(
      `${BASE_URL}/jobs/match/undismiss/${encodeURIComponent(jobId)}`,
      { method: 'POST', headers: headers() }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Restore failed');
    }
    return r.json();
  },

  getMatchExtractedCount: () =>
    fetch(`${BASE_URL}/jobs/match/extracted-count`, { headers: headers() }).then((r) => r.json()),

  runGates: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/gates`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(
        typeof err.detail === 'string' ? err.detail : r.statusText || 'Gates run failed'
      );
    }
    return r.json();
  },

  resetExtraction: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/reset`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) throw new Error('Extraction reset failed');
    return r.json();
  },

  resetGates: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/reset-gates`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Reset gates failed');
    }
    return r.json();
  },

  scoreJobs: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/score`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(
        typeof err.detail === 'string' ? err.detail : r.statusText || 'Scoring failed'
      );
    }
    return r.json();
  },

  resetScore: async () => {
    const r = await fetch(`${BASE_URL}/jobs/match/reset-score`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg =
        typeof err.detail === 'string'
          ? err.detail
          : Array.isArray(err.detail)
            ? err.detail.map((e) => e.msg || e).join('; ')
            : r.statusText;
      throw new Error(msg || 'Reset score failed');
    }
    return r.json();
  },

  // Whether a matching pipeline task is currently running on the backend.
  // Returns { running: bool, mode: str|null }.
  getMatchStatus: () =>
    fetch(`${BASE_URL}/match/status`, { headers: headers() }).then((r) => r.json()),

  getMatchReports: () =>
    fetch(`${BASE_URL}/match/reports`, { headers: headers() }).then((r) => r.json()),

  getMatchReport: (id) =>
    fetch(`${BASE_URL}/match/reports/${encodeURIComponent(id)}`, {
      headers: headers(),
    }).then((r) => r.json()),

  getMatchLogs: async () => {
    const r = await fetch(`${BASE_URL}/match/logs`, { headers: headers() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(
        typeof err.detail === 'string' ? err.detail : r.statusText || 'Failed to load match logs'
      );
    }
    return r.json();
  },

  getSkillCandidates: async (params = {}) => {
    const clean = Object.fromEntries(
      Object.entries(params).filter(([_, v]) => v !== null && v !== undefined && v !== '')
    );
    const q = new URLSearchParams(clean).toString();
    const r = await fetch(`${BASE_URL}/skills/candidates?${q}`, { headers: headers() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Failed to load skills');
    }
    return r.json();
  },

  getSkillCandidateStats: async () => {
    const r = await fetch(`${BASE_URL}/skills/candidates/stats`, { headers: headers() });
    if (!r.ok) throw new Error('Failed to load skill stats');
    return r.json();
  },

  approveSkillCandidate: async (id, suggestedCanonical) => {
    const r = await fetch(`${BASE_URL}/skills/candidates/${encodeURIComponent(id)}/approve`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ suggested_canonical: suggestedCanonical ?? null }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Approve failed');
    }
    return r.json();
  },

  mergeSkillCandidate: async (id, mergeTarget) => {
    const r = await fetch(`${BASE_URL}/skills/candidates/${encodeURIComponent(id)}/merge`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ merge_target: mergeTarget }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Merge failed');
    }
    return r.json();
  },

  rejectSkillCandidate: async (id) => {
    const r = await fetch(`${BASE_URL}/skills/candidates/${encodeURIComponent(id)}/reject`, {
      method: 'PUT',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Reject failed');
    }
    return r.json();
  },

  refreshSkillAliases: async () => {
    const r = await fetch(`${BASE_URL}/skills/candidates/refresh-aliases`, {
      method: 'POST',
      headers: headers(),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : 'Refresh failed');
    }
    return r.json();
  },
};
