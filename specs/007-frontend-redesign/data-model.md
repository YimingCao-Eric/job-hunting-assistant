# Phase 1 Data Model: Search-Only Frontend Redesign

**Feature**: 007-frontend-redesign | **Date**: 2026-07-15

These are **frontend view models** — hand-written TypeScript interfaces under `web/src/types/` that mirror the backend's Pydantic schemas. The frontend owns no persistence and no schema; this document defines what it reads, what it is allowed to write, and the validation/display rules that attach to each field.

**Two rules govern every type here:**

1. **No runtime validation.** No Zod, no strict parsing, no exhaustive switches on server-supplied shapes. Constitution Principle VII requires consumers to tolerate added fields; a runtime validator would reject forward-compatible additions and break on the next backend release. These interfaces are compile-time only.
2. **Backend field names verbatim.** `job_url` not `url`, `location_text` not `location`, `scrape_time` not `scrapedAt`, `include_debug_log` not `include_trace`. The no-drive-by-renames constraint applies across the boundary.

---

## Entity: Job (`types/job.ts`)

Spec entity **Job**. Source: `GET /jobs` → `ScrapedJobRead` (`backend/schemas/scraped_job.py:43-95`). Backed by canonical `scraped_jobs`, populated by atomic dual-write at ingest (feature 008).

**Access: read-only.** The frontend never writes a job row. `dismissed` is the only writable canonical field (`PUT /jobs/{id}`), no requirement asks for a dismiss control, and the route is not bound. This is how Constitution Principle V (CC-1 append-only, claim-and-flag, shelf-life) and FR-052 are satisfied — vacuously.

```ts
export type SourceSite = 'linkedin' | 'indeed' | 'glassdoor';

// NOTE: 'YEARLY' is deliberately absent. It is an accepted *input* token that
// ingest maps to 'ANNUAL' (core/scraped_job_projection.py:56-63); it is never stored.
export type SalaryPeriod = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ANNUAL';

export interface Job {
  id: string;                       // uuid — CANONICAL id space. Use for GET /jobs/{id}.
  source_site: SourceSite;          // varchar(16), no DB CHECK; values above are the real set
  source_row_id: string;            // uuid — PER-SOURCE id space. Polymorphic, no FK. Not interchangeable with `id`.
  site_job_id: string | null;       // LI job_posting_id / Indeed jobkey / GD listing_id
  scan_run_id: string;              // uuid — FK to extension_run_logs.id
  job_url: string;                  // UNIQUE. The link to the original posting (FR-024).
  scrape_time: string;              // ISO tz-aware. THE SORT KEY. "scraped date" in the spec.
  matched: boolean;
  dismissed: boolean;
  title: string | null;
  company: string | null;           // CAN BE "" — see R19 #2. Test emptiness, not just null.
  location_text: string | null;
  description: string | null;       // full JD text, returned inline in the LIST response
  remote: boolean | null;           // TRI-STATE. null ≠ false. See rules below.
  apply_url: string | null;
  experience_level: string | null;  // always null for Indeed (projection.py:210)
  industry: string | null;          // always null for Indeed (projection.py:219)
  salary_min: string | null;        // STRING, plain decimal notation. Not a number.
  salary_max: string | null;        // STRING, plain decimal notation. Not a number.
  salary_currency: string | null;   // varchar(3)
  salary_period: SalaryPeriod | null;
  posted_at: string | null;         // ISO tz-aware. "posting date" in the spec.
}

export interface JobsPage {
  items: Job[];
  total: number;                    // count WITH filters, IGNORING limit/offset
  limit: number;
  offset: number;
}
```

### Two id spaces — do not confuse them

| Field | Space | Used for |
|---|---|---|
| `id` | canonical `scraped_jobs.id` | `GET /jobs/{id}` |
| `source_row_id` | per-source table row id | nothing this frontend calls |

`POST /jobs/ingest` returns the **per-source** id, not the canonical one. The frontend does not call ingest; noted so the asymmetry isn't discovered the hard way.

### Field rules

| Rule | Detail |
|---|---|
| **`remote` is tri-state** | `true` → "Remote"; `false` → "On-site"; **`null` → "—"**, never "On-site". Glassdoor **never emits `false`** (`projection.py:245`), so a naive ternary mislabels every non-remote Glassdoor job. Owned by `lib/format/remote.ts`, unit-tested. |
| **Salaries are strings and are never annualized** | Plain decimal notation guaranteed by a `field_serializer` (`schemas/scraped_job.py:85-95`) that exists to stop asyncpg's `Decimal('1.2E+5')` reaching the wire. Parse with `Number()`. An `HOURLY` `"55"` is **$55/hr**. Never convert between periods. Owned by `lib/format/salary.ts`, unit-tested. |
| **`salary_period: null` with amounts present is legal** | An unrecognized input token yields a null period while retaining amounts. Render amounts with no period suffix. |
| **Absent ≠ empty** | FR-051: a missing projected field is returned as explicit `null`, never omitted. The row still renders with the field marked absent (spec edge case: "A job's description or company is missing"). `company` may be `""` as well as `null` — both are "absent" for display. |
| **`description` is inline in the list** | It is not a detail-only field. `GET /jobs/{id}` returns the same shape with no extra fields — so detail can render from the list row with no second request. The route is bound anyway for deep-link/refresh correctness. |

### Filters — what exists, and what does not

```ts
export interface JobFilters {
  source_site?: SourceSite;   // exact ==; NOT enum-validated server-side (bogus → 200 empty, not 422)
  scraped_from?: string;      // 'YYYY-MM-DD' — >= midnight UTC of that day
  scraped_to?: string;        // 'YYYY-MM-DD' — < midnight UTC of day+1 (whole day INCLUSIVE)
  limit?: number;             // default 25; ge=1, le=500. 0 is a 422.
  offset?: number;            // ge=0, no max
}
```

**Deliberately not in this type** (each absence is a requirement, not an oversight):

| Omitted | Why |
|---|---|
| `easy_apply`, `dedup_status` | **Do not exist.** Removed by feature 008. FR-004. |
| `date_from` / `date_to` | Exist, but filter `posted_at` (a `timestamptz`) against a bare date, so `date_to=2026-07-15` means `posted_at <= 2026-07-15T00:00:00` and drops nearly the whole day (`routers/jobs.py:893-895`). FR-023 needs a **scraped**-date range, so the correct pair is the required pair. R16. |
| `dismissed` | Tri-state where omitted → `dismissed == false`, which is the wanted behavior. **No value returns both.** R15. |
| `scan_run_id` | Exists; no requirement needs it. |
| sort / order | **Not configurable.** `scrape_time DESC`, no tiebreaker → offset pagination can drop/repeat rows across page boundaries on ties (common: batch ingest shares a `scrape_time`). Accepted, R16. |

### Derived: SourceCounts

FR-023's per-site counts. **No backend facet endpoint exists** — this is computed by three parallel `GET /jobs?source_site=<site>&limit=1` calls reading `total` (R3).

```ts
export type SourceCounts = Record<SourceSite, number>;
```

The count requests must carry the **same `dismissed` state as the list** (both omit it, both get the `false` default) or the counts will not sum to the list's `total`.

---

## Entity: Search Configuration (`types/config.ts`)

Spec entity **Search Configuration**. Source: `GET /config` → `SearchConfigRead` (`backend/schemas/config.py:6-41`). Backed by a **JSON file** (`settings.config_path`, default `/app/data/config.json`), not the database.

**Access: read + partial write.** `PUT /config` merges `exclude_unset` fields over the file (`routers/config.py:43-55`).

```ts
export interface SearchConfig {
  // general
  website: string;                    // default 'linkedin'
  keyword: string;                    // default ''
  location: string;                   // default 'Canada'
  general_date_posted: number;        // default 1
  general_internship_only: boolean;
  general_remote_only: boolean;
  allowed_languages: string[];        // default ['en']
  no_contract: boolean;
  remote_only: boolean;
  needs_sponsorship: boolean;
  no_agency: boolean;
  salary_min: number;                 // default 0
  blacklist_companies: string[];
  blacklist_locations: string[];
  blacklist_titles: string[];
  target_titles: string[];

  // linkedin
  f_tpr_bound: number;                // default 48
  f_experience: string | null;
  f_job_type: string | null;
  f_remote: string | null;
  linkedin_f_tpr: string | null;

  // indeed
  indeed_keyword: string | null;
  indeed_location: string | null;
  indeed_fromage: number;             // default 1
  indeed_remotejob: boolean | null;
  indeed_jt: string | null;
  indeed_sort: string;                // default 'relevance'
  indeed_radius: number | null;
  indeed_explvl: string | null;
  indeed_lang: string | null;

  // glassdoor
  glassdoor: Record<string, unknown> | null;
}

// The write type. Every field optional — the backend merges exclude_unset.
export type SearchConfigUpdate = Partial<SearchConfig>;
```

**Grouping for FR-017** ("general settings and per-site settings"): the comment blocks above are the grouping. `website`, `keyword`, `location`, the `general_*` fields, the blacklists, and the flags are general; `f_*`/`linkedin_f_tpr` are LinkedIn; `indeed_*` are Indeed; `glassdoor` is Glassdoor.

### The dead fields — modeled by exclusion

`dedup_fuzzy_threshold`, `nth_bonus_weight`, `cpu_strong_threshold`, `cpu_binary_threshold` exist on the backend schema and are **deliberately absent from `SearchConfig`**. FR-018 requires hiding them while preserving stored values; because `PUT` is an `exclude_unset` merge, **a field never sent is a field never touched**. Not sending is strictly safer than round-tripping, which would re-submit them through `_validate_scoring_config` and could reject a file that was already on disk (R11).

Two further keys — `fit_score_req_weight`, `fit_score_nth_weight` — are **scrubbed from the file by the backend on every write** (`config.py:49-50`) and are on neither schema. Not modeled; noted so the deletion isn't attributed to us.

### Ephemeral: the dirty-form model

Not a backend entity. Drives FR-019/FR-020/FR-021.

```ts
export interface ConfigFormState {
  saved: SearchConfig | null;   // last server truth; re-seeded FROM THE SAVE RESPONSE, not local assumption
  draft: SearchConfig | null;   // current form values
  isDirty: boolean;             // draft ≠ saved
  fieldErrors: Record<string, string>;  // from the normalized ApiError
}
```

Rules:
- **FR-019** — the per-site search preview renders from `draft`, not `saved`, so unsaved edits are visible before saving.
- **FR-020** — `isDirty` gates `useUnsavedGuard` (`useBlocker`, requires the data router — R14).
- **FR-021** — on a rejected save, `draft` is **retained untouched** and `fieldErrors` is populated. Never reset the form on error.
- **Concurrent edit** (spec edge case) — on success, re-seed **both** `saved` and `draft` from the `PUT` response body, which is the merged server result, never from the local draft.

---

## Entity: Scan Run (`types/runLog.ts`)

Spec entity **Scan Run**. Source: `GET /extension/run-log` → `RunLogRead` (`backend/schemas/run_log.py:37-64`).

**Access: read-only.** The frontend triggers scans and reads runs; it never writes a run-log row. (`PUT /extension/run-log/{id}` is the extension's channel and is what fires the WS broadcast.)

**The response is a bare array — no `{items, total}` envelope and no total count.** So Logs cannot show "page 3 of N"; it pages by `limit`/`offset` and stops when a page returns short. This is as-built and is why the spec's Assumptions say "no total count".

```ts
export type RunStatus = 'running' | 'completed' | 'failed';
// NOTE: free-text column, no DB constraint and no Pydantic enum
// (models/extension_run_log.py:25). Treat unknown values as unknown, don't crash.

export interface RunLog {
  id: string;                       // uuid
  strategy: string;                 // default 'C'
  status: string;                   // widen to string; narrow to RunStatus for display only
  started_at: string;               // ISO. Sort key, DESC, no tiebreaker.
  completed_at: string | null;
  pages_scanned: number;
  scraped: number;
  new_jobs: number;
  existing: number;
  stale_skipped: number;
  jd_failed: number;
  early_stop: boolean | null;
  session_error: string | null;
  search_keyword: string | null;    // may be the literal '(setup pending)' — see below
  search_location: string | null;   // may be the literal '(setup pending)'
  search_filters: Record<string, unknown> | null;
  error_message: string | null;
  errors: unknown[] | null;         // untyped JSONB array
  created_at: string;
  scan_all: boolean;
  scan_all_position: number | null;
  scan_all_total: number | null;
  debug_log: DebugLog | null;       // ABSENT when include_debug_log=false; ABSENT on WS payloads
  failure_reason: string | null;
  failure_category: string | null;
}
```

**`'(setup pending)'`**: `POST /run-log/start` substitutes this literal for a blank keyword/location (`routers/extension.py:28-31`). A just-triggered run can display it. Render as-is; it resolves on the next update. It is real backend behavior, not a bug to hide.

**`status` is typed `string`, not `RunStatus`.** The column is free text with no DB constraint and no Pydantic enum — five different code paths write it. `RunStatus` is the display vocabulary; an unrecognized value renders as itself rather than crashing a switch. This is the Principle VII posture applied to a field that only looks like an enum.

**Naming inconsistency, documented not renamed** (Principle I + the no-drive-by-renames constraint): the same run-log UUID is called `scrape_run_id`, `scan_run_id`, and `runId` in different places in this system. `Job.scan_run_id` is that id. Consumed as named.

### Debug Trace Event

Spec entity **Debug Trace Event**. Source: `DebugEvent` (`backend/schemas/debug_log.py:4-12`).

```ts
export interface DebugEvent {
  t: number;                        // epoch ms
  dt: number;                       // ms since run start — THIS is the displayed relative timestamp
  page: number | null;
  phase: string;
  level: string;                    // default 'info'; seen: info | warn | error | debug
  data: Record<string, unknown>;    // default {}
  [key: string]: unknown;           // model_config = ConfigDict(extra="allow") — events legitimately carry unknown keys
}

// debug_log is an OBJECT WRAPPING the array, not a bare array.
export interface DebugLog { events: DebugEvent[]; }
```

- **Ring buffer: 10,000 events**, keeps the **last** N (`combined[-ring_size:]`, `routers/extension.py:370-371`), configurable via `DEBUG_LOG_RING_SIZE`. Oldest are dropped, so a trace may legitimately not start at `dt: 0`.
- **The index signature is load-bearing.** It is the type-level expression of `extra="allow"` and of the spec's "a trace event carries unexpected extra fields: it still renders" edge case. The panel renders known columns and stringifies the rest; it never switches exhaustively (R13).
- `include_debug_log=false` (the run list) makes `debug_log` `null`. WS payloads always exclude it.

---

## Entity: Auto-Scrape State (`types/autoScrape.ts`)

Spec entity **Auto-Scrape State**. Source: `GET /admin/auto-scrape/state` → `AutoScrapeStateRead`.

**Access: read + mutate-via-endpoint only. `PUT /state` is never called** — it is a whole-object replacement that silently destroys unsent keys (`routers/auto_scrape.py:132`). FR-046 is satisfied by not having the capability (R17).

```ts
export interface AutoScrapeStateRead {
  id: number;                       // always 1 — singleton, CHECK id=1
  state: AutoScrapeState;           // free-form JSONB server-side; typed here for our reads only
  last_sw_heartbeat_at: string | null;
  updated_at: string;
}

export interface AutoScrapeState {
  enabled: boolean;
  test_cycle_pending: boolean;
  exit_requested: boolean;
  config_change_pending: boolean;
  cycle_id: number;
  cycle_phase: string;              // 'idle' | 'scrape_running' | 'postscrape_running' — NOT typed or validated server-side
  extension_instance_id: string | null;
  matrix_position: { site_index: number; keyword_index: number };
  cycle_results: {
    scans_attempted: number; scans_succeeded: number; scans_failed: number;
    failures_by_reason: Record<string, number>;
  };
  consecutive_precheck_failures: number;   // declared ONCE — the old file declared it twice (TS2300)
  next_cycle_at: number;            // epoch MILLISECONDS. 0 | '0' | null all mean "unscheduled".
  last_cycle_summary_id: string | null;
  last_cycle_completed_at: string | null;
  min_cycle_interval_ms: number;
  clean_cycles_count: number;
  [key: string]: unknown;           // state is free-form JSONB; tolerate keys we don't model (Principle VII)
}
```

**`state` is untyped and unvalidated server-side** — a free-form `dict[str, Any]`, shaped only by a migration seed (`alembic/versions/023_auto_scrape_foundations.py:34-52`). The interface above is *our reading contract*, not a server guarantee; hence the index signature.

**`cycle_phase` is typed `string`, not a union**, for the same reason `RunLog.status` is: it is an opaque key in a free-form dict with no server-side validation (tests write `test_put` into it).

**`next_cycle_at` is epoch ms and its "unscheduled" sentinel is polymorphic** — `0`, `"0"`, or `None` (`routers/auto_scrape.py:88-98`). Normalize on read.

**The TS2300 fix**: the old `types/autoScrape.ts` declared `consecutive_precheck_failures` twice — required at line 18, optional at line 24. It is a genuine `tsc` error that shipped because no script ever ran `tsc` and ESLint never touched `.ts`. Declared exactly once here (N2/R18).

### Heartbeat freshness (derived) — FR-038

Not a backend field. `lib/format/heartbeat.ts`, unit-tested, derives a grade from `last_sw_heartbeat_at`.

```ts
export type HeartbeatGrade = 'fresh' | 'aging' | 'stale' | 'never';
```

**FR-038's hard rule: a stale heartbeat and a deliberate pause must not look the same.** `enabled: false` is an operator decision (neutral tone); a stale heartbeat is a malfunction (warning tone). They are independent — `enabled: true` + `stale` is the alarming combination and must be unmistakable.

### Instances — FR-039

`GET /admin/auto-scrape/instances` → `{instances: {instance_id, last_heartbeat_at}[], count: number}`. `count > 1` → warn: concurrent instances corrupt cycle accounting.

**Do not copy the old failure handling**: `fetchAutoScrapeInstances` currently silently degrades to `{count: 1, instances: []}` on non-OK — i.e. it fabricates the healthy answer on error, which defeats the requirement. Errors surface.

---

## Entity: Cycle (`types/autoScrape.ts`)

Spec entity **Cycle**. Source: `GET /admin/auto-scrape/cycles` → `list[CycleRead]`. **Read-only** to this frontend.

```ts
export type CycleStatus =
  | 'scrape_running' | 'scrape_complete'
  | 'postscrape_running' | 'post_scrape_complete'   // NOTE the inconsistent underscore. As-built.
  | 'failed';

export interface Cycle {
  id: string;                       // uuid — the ROW id
  cycle_id: number;                 // the human-facing cycle NUMBER (from a sequence)
  started_at: string;
  completed_at: string | null;
  status: CycleStatus;
  phase_heartbeat_at: string | null;
  precheck_status: string | null;
  precheck_details: Record<string, unknown> | null;
  scans_attempted: number;
  scans_succeeded: number;
  scans_failed: number;
  failures_by_reason: Record<string, number> | null;
  run_log_ids: string[] | null;
  postcheck_status: string | null;
  postcheck_details: Record<string, unknown> | null;
  cleanup_results: Record<string, unknown> | null;
  dedup_task_id: string | null;     // ALWAYS null — dedup retired. Not displayed.
  match_results: Record<string, unknown> | null;
  apply_results: Record<string, unknown> | null;
  error_message: string | null;
  notes: string | null;
}
```

- **`id` vs `cycle_id`**: `id` is the uuid row key; `cycle_id` is the integer number the operator sees (FR-041 "cycle number"). Display `cycle_id`.
- **`status` uses a real `Literal`** server-side (`schemas/auto_scrape.py:28-36`) — unlike `RunLog.status` — so a union type is honest here. Note `scrape_complete` vs `post_scrape_complete`: the underscore is inconsistent as-built and is consumed as-is.
- **FR-042 (partial results)**: `status === 'failed'` with non-zero `scans_succeeded` or a populated `cleanup_results`/`match_results` means partial results exist. Show them, labeled partial. Do not hide them.
- **FR-041 failure reason**: `error_message` + `failures_by_reason`. Never render a bare "failed".
- **`dedup_task_id` is always null** (dedup retired) — not displayed. FR-004.
- **`GET /cycles` caps at `limit` 100 (default 10), has no `offset`, and returns a bare array.** Cycle history cannot page past 100. FR-041 says "recent cycles"; the page requests 10 and does not offer paging.

---

## Entity: Site Session (`types/autoScrape.ts`)

Spec entity **Site Session**. Source: `GET /admin/auto-scrape/sessions` → `list[SiteSessionStateRead]`. Exactly one row per supported site.

**Access: read + `POST /reset-session/{site}`** (FR-043). `PUT /sessions/{site}` is the extension's probe-reporting channel and is **not** called by this frontend.

```ts
export type ProbeStatus = 'live' | 'expired' | 'captcha' | 'rate_limited' | 'unknown';

export interface SiteSession {
  site: SourceSite;                 // the PRIMARY KEY — there is no `id` field
  last_probe_status: ProbeStatus;
  last_probe_at: string;
  consecutive_failures: number;
  notified_user: boolean;
  backoff_multiplier: number;       // rate_limited doubles it, capped at 64.0
  updated_at: string;
}
```

- `ProbeStatus` is the one vocabulary with a **real DB CHECK constraint** (`ck_site_session_states_probe_status`, migration 023) as well as a Pydantic `Literal`. A closed union is fully honest here.
- **Reset semantics (FR-043)**: `POST /reset-session/{site}` sets `consecutive_failures=0`, `notified_user=false`, `backoff_multiplier=1.0`, `last_probe_status='unknown'`. This is exactly the spec's Acceptance Scenario 9 ("status returns to unknown with failure counters cleared") — no client-side state assumption needed; re-read the response.
- **Semantic tone** is a token-set lookup (R9), not an inline ternary: `live` → success; `expired`/`captcha` → danger; `rate_limited` → warning; `unknown` → neutral.
- **404 `{"detail": "unknown site"}`** if `{site}` is outside the allowlist. Unreachable from a closed-set UI.
- **Sharp edge, not ours to fix**: both session routes use `scalar_one()`, not `scalar_one_or_none()` — a missing row raises `NoResultFound` → **500**, not 404. The three rows are seeded by migration 023. The FR-014 error path must survive an unparseable 500 body.

---

## Cross-cutting: normalized error

The one error type every page consumes. Full derivation and the four wire shapes: [contracts/error-model.md](./contracts/error-model.md).

```ts
export interface ApiError extends Error {
  status: number;                              // 0 for network/abort failures
  kind: 'network' | 'unauthorized' | 'not_found'
      | 'validation' | 'conflict' | 'server' | 'unknown';
  message: string;                             // always human-readable, never "[object Object]"
  fieldErrors?: Record<string, string>;        // FR-021 / FR-044 — shapes 2 and 3
  reason?: 'scan_pending' | 'stop_cooldown' | 'scan_in_progress';  // SC-011 — shape 4
  retryAfterMs?: number;                       // shape 4
}
```

`kind: 'unauthorized'` (401) is handled once in the shell as a single consistent state (spec edge case: "the shell shows a single, consistent 'not authorized' state… rather than each page rendering its own variant"), not per page.

---

## Cross-cutting: navigation (`lib/nav.ts`)

FR-003 requires the page set to be defined in one place so nav and routes cannot drift.

```ts
export const NAV_ITEMS = [
  { path: '/',                      label: 'Config',      element: ConfigPage },
  { path: '/jobs',                  label: 'Jobs',        element: JobsPage },
  { path: '/logs',                  label: 'Logs',        element: LogsPage },
  { path: '/dashboard/auto-scrape', label: 'Auto-Scrape', element: AutoScrapePage },
] as const;
```

`router.tsx` builds routes from `NAV_ITEMS`; `TopNav.tsx` renders links from `NAV_ITEMS`. **One array is the sole source of both** — drift is structurally impossible, not merely discouraged. FR-001 is then a property of the array's length, and FR-004 a property of its contents.

Legacy paths (`/profile`, `/skills`, `/matching`, `/dedup`, `/search-report`, `/dedup/passed`, `/dedup/removed`) are **not** entries — they fall through to the `*` route and land on `NotFoundPage`, which names the four surviving pages (FR-005). They are **not redirected**: the spec is explicit that a redirect would misrepresent removed functionality as relocated.
