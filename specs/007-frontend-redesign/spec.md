# Feature Specification: Search-Only Frontend Redesign

**Feature Branch**: `007-frontend-redesign`

**Created**: 2026-07-15

**Updated**: 2026-07-15 — scope corrected: the per-source read capability (FR-048–FR-052) shipped in feature 008; this is now a frontend-only feature.

**Status**: Planned

**Input**: User description: "Design a new, clean, consistent frontend for the search-only JHA with exactly four pages: Config (/), Jobs (/jobs), Logs (/logs), and Auto-Scrape (/dashboard/auto-scrape). The old frontend is being replaced because it is inconsistent (mixed JS/TS, ad-hoc styling). Describe each page's purpose, information architecture, key user flows, and states (loading/empty/error), and the shared navigation. Config edits search settings; Jobs lists scraped jobs with filters and a scan trigger plus live run progress; Logs shows search run-logs with expandable debug traces; Auto-Scrape is the orchestrator console (enable/pause/stop, cycles, session health). No dedup, matching, skills, or profile UI. Focus on behavior, IA, and UX — not the tech stack."

## Overview

The backend was reduced to **search-only**: dedup, matching, skills, and profile were deleted. The current frontend still carries ten routes, four of which (`/matching`, `/skills`, `/profile`, `/dedup`) call endpoints that **no longer exist** and are therefore broken today. It is also internally inconsistent — two unrelated visual systems, two duplicated data-access layers, and per-page ad-hoc styling — which makes every change expensive and every page behave slightly differently.

This feature replaces the frontend with **exactly four pages** that mirror the search-only backend, presented through one shared shell, one visual system, and one set of interaction conventions.

When this spec was drafted, one backend gap blocked the redesign: real scrape output was written to per-source storage with no read capability, so the Jobs page — the product's primary surface — had no source of real data. **That gap is now closed.** Feature 008 shipped the capability: `GET /jobs` returns canonical merged rows (`source_site`, `title`, `company`, `location_text`, `description`, `posted_at`, `remote`, `salary_min`/`salary_max`/`salary_currency`/`salary_period`, `dismissed`) in a paginated `{items, total, limit, offset}` envelope, with `GET /jobs/{id}` for a single job's detail. FR-048–FR-052 record what was required and are **delivered**; they are no longer this feature's work.

**This is therefore a frontend-only feature.** No backend change, no migration, and no smoke-test change is in scope.

**In scope**: the four pages and the shared shell.

**Out of scope**: any dedup, matching, skills, or profile surface; the per-source read capability (**delivered by feature 008** — see FR-048–FR-052); all backend change; authentication redesign.

## Clarifications

### Session 2026-07-15

- Q: Jobs data source — does this feature add a backend read capability for per-source scrape data, or does Jobs display only what the current job-listing capability returns? → A: Add the backend read capability; scope expands beyond the frontend. — **Superseded 2026-07-15**: feature 008 shipped that capability independently, so the expanded scope reverted. This feature is frontend-only and Jobs reads the canonical `GET /jobs`. The answer stands as the record of the decision; its consequence no longer applies.
- Q: Orchestrator settings placement — do orchestrator settings stay on Auto-Scrape, or move to Config alongside search settings? → A: Stay on Auto-Scrape.
- Q: Navigation layout — horizontal top nav, left sidebar, or top nav plus a persistent global status strip? → A: Horizontal top nav.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse scraped jobs and run a scan (Priority: P1)

The operator opens Jobs to see what the scraper has collected. They narrow the list by source site and by the date the job was scraped, open a job to read its full description, and click through to the live posting. When they want fresh data, they trigger a scan for one site (or all sites in sequence) and watch its progress advance in real time without reloading the page. If a scan is misbehaving they stop it.

**Why this priority**: This is the product's core value and its most-used surface — the reason the scraper exists is to produce a list a human reads. It is also the only page that both reads scrape output and drives the scraper, so it validates the read path, the command path, and the live-progress path in one slice.

**Independent Test**: With only this page and the shared shell built, an operator can open `/jobs`, filter the list, open a job, trigger a scan, watch progress to completion, and stop a scan mid-run — delivering the complete "collect and review jobs" loop with no other page present.

**Acceptance Scenarios**:

1. **Given** jobs exist for multiple sites, **When** the operator opens Jobs, **Then** jobs are listed newest-scraped first with a per-site count shown on each source filter.
2. **Given** the operator selects the LinkedIn source filter, **When** the list refreshes, **Then** only LinkedIn jobs appear and the active filter is visually unambiguous.
3. **Given** the operator sets a scraped-date range, **When** the list refreshes, **Then** only jobs scraped within that range appear, combined with any active source filter.
4. **Given** the operator clicks a job, **When** the detail opens, **Then** the full description, company, location, posting date, and a working link to the original posting are shown.
5. **Given** no scan is running, **When** the operator triggers a scan for one site, **Then** the page shows the scan as starting and begins reporting progress within 10 seconds of the scraper picking it up.
6. **Given** a scan is running, **When** the scraper reports progress, **Then** pages-scanned and jobs-scraped counts update on screen without a manual refresh.
7. **Given** a scan is running, **When** the operator triggers another scan, **Then** the page refuses and explains why (a scan is already in progress) instead of failing silently.
8. **Given** a scan is running, **When** the operator clicks Stop, **Then** the run ends and the page reports it as stopped rather than leaving a permanently "running" indicator.
9. **Given** a scan finishes, **When** the run completes, **Then** the job list refreshes to include newly scraped jobs and the progress indicator resolves to a terminal state.

---

### User Story 2 - Operate the auto-scrape orchestrator (Priority: P2)

The operator opens Auto-Scrape to see whether unattended scraping is running, whether the browser extension is alive, and whether each site's login session is still good. They enable or pause the loop, run a one-off test cycle, review recent cycles and their outcomes, and reset a site session that has expired.

**Why this priority**: Unattended operation is what makes the system useful without a human present, but it is only worth automating once the manual scan loop (P1) is trustworthy. This page is the only window into whether the loop is healthy — without it, failures are invisible.

**Independent Test**: Can be fully tested by opening `/dashboard/auto-scrape`, confirming enabled/paused state and heartbeat freshness, enabling and pausing the loop, requesting a test cycle, reading the cycle history, and resetting a site session — delivering complete orchestrator visibility and control.

**Acceptance Scenarios**:

1. **Given** the operator opens Auto-Scrape, **When** the page loads, **Then** it shows whether the loop is enabled, the current cycle phase, and how recently the extension reported in.
2. **Given** the extension has not reported in recently, **When** the operator views the status, **Then** heartbeat staleness is called out as a warning distinct from "paused" — a stale heartbeat and a deliberate pause must not look the same.
3. **Given** the loop is paused, **When** the operator enables it, **Then** the page reflects the enabled state and any consecutive-failure counters are shown as cleared.
4. **Given** the loop is enabled, **When** the operator pauses it, **Then** the page reflects the paused state.
5. **Given** the operator requests a stop-and-exit, **When** they confirm, **Then** the page records the request as pending and explains that the extension acts on it asynchronously rather than claiming an immediate stop.
6. **Given** recent cycles exist, **When** the operator views cycle history, **Then** each cycle shows its number, start time, status, and scan attempt/success/failure counts, newest first.
7. **Given** a cycle failed, **When** the operator views it, **Then** the failure reason is shown rather than an unexplained "failed".
8. **Given** a site session is expired or rate-limited, **When** the operator views session health, **Then** that site's status, consecutive-failure count, and backoff are visible, and a reset control is available for that site.
9. **Given** the operator resets a site session, **When** the reset completes, **Then** that site's status returns to unknown with failure counters cleared.

---

### User Story 3 - Edit search settings (Priority: P3)

The operator opens Config to change what the scraper searches for — keywords, location, recency bound, and per-site filters. They review a preview of the search URL each site will use, save, and get unambiguous confirmation that the change was stored or a clear explanation of why it was rejected.

**Why this priority**: Settings change infrequently — often set once and left alone — so it is lower-frequency than browsing jobs or watching the loop. But it is the only way to steer what gets collected, so it must exist before the system is genuinely usable by someone other than its author.

**Independent Test**: Can be fully tested by opening `/`, changing a setting, saving, reloading, and confirming the value persisted — plus submitting an invalid value and confirming the error is explained and the form is not silently reset.

**Acceptance Scenarios**:

1. **Given** the operator opens Config, **When** the page loads, **Then** current saved settings are shown, grouped so general settings and per-site settings are distinguishable.
2. **Given** the operator edits a field, **When** they have unsaved changes, **Then** the page indicates the form is dirty and Save is available.
3. **Given** the operator saves valid changes, **When** the save succeeds, **Then** a confirmation appears and a reload shows the persisted values.
4. **Given** the operator enters a value the backend rejects, **When** they save, **Then** the specific rejection reason is shown, the entered values are preserved for correction, and no partial save is implied.
5. **Given** the operator has edited keyword and location, **When** they view the per-site search preview, **Then** the preview reflects the current (unsaved) form state so they can sanity-check before saving.
6. **Given** the operator has unsaved changes, **When** they navigate away, **Then** they are warned rather than losing the edit silently.

---

### User Story 4 - Inspect run logs and debug traces (Priority: P4)

The operator opens Logs to answer "what happened on that run?". They scan a list of recent runs with outcome and counts, expand one to see its detail, and expand further into the run's debug trace to see the phase-by-phase event record when diagnosing a failure.

**Why this priority**: This is a diagnostic surface used when something has already gone wrong. It is genuinely valuable but is not part of the daily loop, and the headline outcome of the most recent run is already visible on Jobs — so it is the last of the four to earn its place.

**Independent Test**: Can be fully tested by opening `/logs`, reading the run list, expanding a run for its counts and error, and expanding its trace to inspect individual events — delivering complete post-hoc diagnosis with no other page present.

**Acceptance Scenarios**:

1. **Given** runs exist, **When** the operator opens Logs, **Then** recent runs are listed newest-first, each showing status, start time, duration, search keyword/location, and scraped/new/existing counts.
2. **Given** a run failed, **When** the operator views it, **Then** the error message and failure reason are shown alongside the counts.
3. **Given** the operator expands a run, **When** the detail opens, **Then** the run's full counts and any session error are shown without navigating away from the list.
4. **Given** a run has a debug trace, **When** the operator expands the trace, **Then** events are shown in time order with their relative timestamp, phase, level, and page number, and error-level events are visually distinct.
5. **Given** a run has a very large trace, **When** the operator expands it, **Then** the page remains responsive and does not freeze while rendering.
6. **Given** a run has no trace recorded, **When** the operator expands it, **Then** an explicit "no trace recorded" state is shown rather than an empty panel.

---

### Edge Cases

**Cross-cutting**

- **Backend unreachable**: every page shows a page-level error state naming the failure and offering retry — never an infinite spinner and never a silently empty list that reads as "no data".
- **Unauthorized (401)**: the shell shows a single, consistent "not authorized" state explaining the configured credential was rejected, rather than each page rendering its own empty or error variant.
- **Slow response**: a request that has not resolved within ~500ms shows a loading state; a page must never flash an empty state on its way to loaded data.
- **Legacy URL entered** (`/profile`, `/skills`, `/matching`, `/dedup`, `/search-report`, `/dedup/passed`, `/dedup/removed`): the operator lands on a clear "page removed" state that names the four surviving pages, rather than a blank screen or a silent redirect that hides what happened.
- **Unknown URL**: a not-found state consistent with the above.
- **Narrow viewport**: navigation and every page remain usable without horizontal scrolling.

**Jobs**

- Scan trigger rejected because a trigger is already pending, a stop cooldown is active, or a run is already in progress — each of the three is a distinct, human-readable explanation with the suggested retry delay, not a generic failure.
- Scan triggered but the scraper never picks it up (extension not running): the page must not show "in progress" indefinitely — after a bounded wait it reports that the scraper has not responded.
- A run exceeds its time budget and the backend force-fails it: the page reflects the terminal failure rather than a stuck progress bar.
- Job list empty because filters exclude everything vs. genuinely no jobs scraped: these are **different empty states** — the first offers to clear filters, the second explains that a scan has not run.
- A job's description or company is missing: the row still renders and the missing field is marked absent rather than blank.
- Live progress channel drops mid-run: progress continues via a fallback and the page does not stall or duplicate counts.

**Auto-Scrape**

- More than one extension instance reporting in: surfaced as a warning, because concurrent instances corrupt cycle accounting.
- A cycle is `failed` but partial results were already written: partial results are shown, labeled partial, rather than hidden.
- Background reapers mark a cycle failed with no user action: the page reflects the change on its next refresh without requiring reload.
- No cycles have ever run: an explicit "no cycles yet" state, not an empty table.

**Config**

- Config storage is malformed and the backend errors: the page reports that settings could not be read and does not present an empty form that would overwrite them on save.
- Concurrent edit: a save reflects the merged server result, and the form re-renders from the server's response rather than from local assumptions.

**Logs**

- No runs at all: explicit empty state.
- A trace event carries unexpected extra fields: it still renders rather than breaking the trace panel.

## Requirements *(mandatory)*

### Functional Requirements

**Shell & navigation**

- **FR-001**: The application MUST expose exactly four navigable pages: Config (`/`), Jobs (`/jobs`), Logs (`/logs`), and Auto-Scrape (`/dashboard/auto-scrape`).
- **FR-002**: A persistent horizontal navigation bar MUST be present at the top of every page, listing exactly those four destinations and unambiguously indicating the current one. Page content MUST retain the full viewport width — no persistent side rail may consume it — because every page is horizontally dense.
- **FR-003**: Navigation destinations MUST be defined in one place, so that the set of pages cannot drift between the navigation and the routes it points at.
- **FR-004**: The application MUST NOT present any dedup, matching, skills, or profile surface — no page, no navigation entry, no tab, no badge, and no control.
- **FR-005**: Requesting a removed or unknown URL MUST land on a stated "page removed / not found" state that names the four available pages.
- **FR-006**: Navigation and page content MUST remain usable at narrow viewport widths without horizontal scrolling.

**Consistency (the reason this feature exists)**

- **FR-007**: All four pages MUST derive their visual treatment from a single shared set of design tokens (color, spacing, typography, radius). No page may introduce its own palette or one-off values.
- **FR-008**: Shared interaction elements — buttons, form inputs, cards, tables, modals, badges, tabs, spinners — MUST be provided as common building blocks reused by all pages, not re-implemented per page.
- **FR-009**: Loading, empty, and error states MUST be presented identically across all four pages: same placement, same structure, same tone.
- **FR-010**: Every page MUST reach the backend through one shared access layer that applies credentials and error handling uniformly; per-page bespoke access paths are prohibited.
- **FR-011**: A destructive or irreversible control (stop a scan, stop-and-exit the orchestrator, reset a site session) MUST require explicit confirmation and MUST be visually distinct from non-destructive controls.

**State handling**

- **FR-012**: Every page MUST show a loading state while its initial data is in flight, and MUST NOT render an empty state before the first result resolves.
- **FR-013**: Every page MUST distinguish "no data exists" from "no data matches the current filters", and the filtered-empty state MUST offer a way to clear filters.
- **FR-014**: Every failed request MUST produce an error state that states what failed and offers a retry, preserving any user input already entered.
- **FR-015**: A background refresh MUST NOT replace already-rendered content with a loading state; refreshes update in place.
- **FR-016**: When the backend rejects a request with a structured reason, the page MUST surface that specific reason rather than a generic failure message.

**Config page**

- **FR-017**: Config MUST let the operator read and edit the search settings the backend exposes, grouped into general settings and per-site settings.
- **FR-018**: Config MUST NOT display settings that no longer drive any backend behavior (the retained-but-unused scoring and dedup-threshold fields), while preserving their stored values untouched across a save.
- **FR-019**: Config MUST show a live preview of the search each site will perform, reflecting current unsaved form state, with the ability to copy it.
- **FR-020**: Config MUST indicate unsaved changes, confirm successful saves, and warn before navigation that would discard edits.
- **FR-021**: On a rejected save, Config MUST show the field-specific reason and retain the operator's entered values.

**Jobs page**

- **FR-022**: Jobs MUST list the jobs actually collected by scraping — the per-source scrape record — newest-scraped first, showing at minimum title, company, location, source site, posting date, and scraped date.
- **FR-023**: Jobs MUST support filtering by source site (with per-site counts) and by scraped-date range, combinable, with pagination.
- **FR-024**: Jobs MUST offer a detail view exposing the full job description and a working link to the original posting.
- **FR-025**: Jobs MUST offer a scan trigger per site and a sequential "scan all sites" action.
- **FR-026**: Jobs MUST display live progress for an active run — at minimum status, pages scanned, and jobs scraped — updating without operator action.
- **FR-027**: Jobs MUST show a bounded, explained state when a scan is triggered but the scraper does not begin within a defined wait, instead of an indefinite "in progress".
- **FR-028**: Jobs MUST offer a stop control while a run is active, and MUST reflect the resulting terminal state.
- **FR-029**: Jobs MUST refresh the list when a run reaches a terminal state.
- **FR-030**: Jobs MUST NOT poll any backend endpoint whose read consumes a pending command intended for the scraper.

**Per-source scrape read capability** — ✅ **DELIVERED BY FEATURE 008. Out of this feature's scope.**

Originally added as scope by Clarification Q1, when no read path existed. Feature 008 built it via the canonical `scraped_jobs` table, populated by atomic dual-write at ingest. The requirements below are **retained as the record of what was required and satisfied** — they are not work items for this feature, and no task implements them. Each is discharged against live code (`backend/routers/jobs.py`, `backend/schemas/scraped_job.py`), not against documentation.

- **FR-048** ✅: The system MUST expose a read capability over the per-source scrape record for all three supported sites. — **Delivered**: `GET /jobs` over canonical `scraped_jobs` (`backend/routers/jobs.py:850`).
- **FR-049** ✅: That capability MUST present a single common projection across the three sites — at minimum title, company, location, description, original posting URL, posting date, scraped date, and source site — so that Jobs renders one uniform list rather than three site-shaped variants. — **Delivered**: `ScrapedJobRead` (`backend/schemas/scraped_job.py:43-95`), which also carries `remote`, salary fields, `apply_url`, `experience_level`, and `industry`.
- **FR-050** ✅: That capability MUST support everything FR-022–FR-024 require of it: ordering newest-scraped-first, filtering by source site and scraped-date range, per-site counts, pagination, and retrieval of a single job's full detail. — **Delivered, with one gap absorbed by the frontend**: `scrape_time DESC`; `source_site` + `scraped_from`/`scraped_to`; `limit`/`offset` + `total`; `GET /jobs/{id}`. **There is no per-site count endpoint** — no facet, no aggregate — so Jobs derives counts client-side from three `?source_site=X&limit=1` reads of `total`. See plan.md research R3.
- **FR-051** ✅: A job whose source record is missing a projected field MUST be returned with that field explicitly absent rather than omitted from results, so FR-013's "no data matches" and a partially-populated row stay distinguishable. — **Delivered**: nullable columns serialize as explicit `null`, never dropped. Note two real traits the frontend must absorb: `remote` is **tri-state** (`null` means the site did not say — not "on-site"), and `company` may be `""` as well as `null`.
- **FR-052** ✅: The read capability MUST NOT mutate scrape records. The per-source tables are append-only by constitutional invariant, with only claim-and-flag and shelf-life expiry permitted to write them. — **Delivered**: the `GET` handlers are read-only. This frontend additionally never calls `PUT /jobs/{id}` (the only job write, `dismissed`), so Constitution Principle V is satisfied vacuously.

**Logs page**

- **FR-031**: Logs MUST list recent search runs newest-first with status, start time, duration, search keyword/location, and outcome counts.
- **FR-032**: Logs MUST let the operator filter runs by status.
- **FR-033**: Logs MUST allow expanding a run in place to see its full detail, including error message and failure reason for failed runs.
- **FR-034**: Logs MUST allow expanding a run's debug trace, presenting events in time order with relative timestamp, phase, level, and page number, with error-level events visually distinct.
- **FR-035**: Logs MUST remain responsive when a run's trace contains up to the backend's maximum retained events, and MUST NOT fetch trace payloads for runs whose traces are not expanded.
- **FR-036**: Logs MUST show an explicit state for a run with no recorded trace.

**Auto-Scrape page**

- **FR-037**: Auto-Scrape MUST show current orchestrator status: enabled/paused, cycle phase, current cycle number, and next-cycle time when scheduled.
- **FR-038**: Auto-Scrape MUST show extension heartbeat freshness graded by age, and MUST present a stale heartbeat as a warning distinct from a deliberate pause.
- **FR-039**: Auto-Scrape MUST warn when more than one extension instance is reporting in.
- **FR-040**: Auto-Scrape MUST offer enable, pause, stop-and-exit, and run-test-cycle controls, and MUST present each as a request the extension acts on asynchronously rather than as a completed action.
- **FR-041**: Auto-Scrape MUST list recent cycles newest-first with cycle number, start time, status, and scan attempted/succeeded/failed counts, and MUST show the failure reason for failed cycles.
- **FR-042**: Auto-Scrape MUST show a cycle's partial results, labeled as partial, when a cycle failed after producing some.
- **FR-043**: Auto-Scrape MUST show per-site session health: probe status, consecutive failures, and backoff, with a per-site reset control.
- **FR-044**: Auto-Scrape MUST let the operator edit the orchestrator's own settings, validated against the backend's published limits, surfacing warnings and field-level errors before and after save.
- **FR-045**: Auto-Scrape MUST NOT display orchestrator settings that no longer drive behavior (the retained post-scrape pipeline toggles), while preserving their stored values across a save.
- **FR-046**: Auto-Scrape MUST NOT write orchestrator state in a way that discards state fields it does not manage.
- **FR-047**: Auto-Scrape MUST reflect externally-driven changes (background reapers, extension activity) on its refresh cycle without requiring a manual reload.

### Key Entities

- **Search Configuration**: What the scraper looks for — keyword, location, recency bound, and per-site filters. Read and written whole; the backend merges partial edits and preserves fields the frontend does not send.
- **Job**: One scraped posting — title, company, location, description, source site, original URL, posting date, scraped date. Stored per source site, so the same concept is physically recorded in three differently-shaped ways; this feature defines one common projection over them (FR-049). Append-only: read-only to this frontend, and writable elsewhere only by claim-and-flag and shelf-life expiry.
- **Scan Run**: One scraping attempt — status (`running` / `completed` / `failed`), start and completion time, search keyword/location, counts (pages scanned, scraped, new, existing, stale skipped, JD failed), error message, failure reason and category, and an optional debug trace. Runs are also created and terminated by actors other than this frontend.
- **Debug Trace Event**: One record within a run's trace — relative timestamp, phase, level, optional page number, and free-form data. Retained as a bounded ring of the most recent events; may carry fields the frontend does not recognize.
- **Auto-Scrape State**: The orchestrator's live status — enabled, cycle phase, current cycle number, pending requests (test cycle, exit, config change), failure counters, next-cycle time. Shared mutable state written by both this frontend and the extension.
- **Cycle**: One unattended round — cycle number, start/completion time, status, scan counts, failure breakdown, associated runs, and results. Produced by the orchestrator; read-only to this frontend.
- **Site Session**: Per-site login health — probe status (`live` / `expired` / `captcha` / `rate_limited` / `unknown`), consecutive failures, backoff multiplier, and whether the operator was notified. Exactly one per supported site.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The application presents exactly four pages; a reviewer walking every reachable navigation path finds zero dedup, matching, skills, or profile surfaces.
- **SC-002**: Zero pages call a backend capability that no longer exists — every action a user can take resolves against a live capability (the current frontend has four pages that fail).
- **SC-003**: An operator can reach any of the four pages from any other in one click.
- **SC-004**: An operator new to the system can trigger a scan and see progress reported within 1 minute of first opening the app, without instruction.
- **SC-005**: 100% of the four pages present loading, empty, and error states drawn from the same shared presentation — a reviewer comparing any two pages finds no structural difference in how these states appear.
- **SC-006**: Zero one-off color or spacing values exist outside the shared token set.
- **SC-007**: Every user-facing control's visual treatment maps to its consequence: 100% of destructive actions are distinguishable from non-destructive ones without reading the label, and each requires confirmation.
- **SC-008**: When the backend is unreachable, 100% of pages surface a stated error with a retry within 10 seconds — none hang indefinitely and none render a misleading empty state.
- **SC-009**: Live scan progress reflects a change in run state within 10 seconds of it occurring.
- **SC-010**: Expanding a debug trace at the backend's maximum retained event count keeps the page interactive (no input blocked for more than 1 second).
- **SC-011**: Each of the three distinct scan-rejection reasons produces a distinct, actionable message; zero rejections surface as a generic failure.
- **SC-012**: All four pages are usable at 360px width with no horizontal scrolling.
- **SC-013**: Any of the four pages renders its first meaningful content within 2 seconds on a normal connection.

## Assumptions

**Scope and product**

- Single operator, trusted local/self-hosted deployment. No multi-user, roles, or permissions.
- The frontend triggers and displays; it owns no business logic (per the project constitution's stack boundaries). Scraping remains the extension's job.
- Authentication remains as-built: a single statically-configured bearer credential, applied by the shared access layer. No login screen, session, or refresh is introduced. The existing separate credential path for the live-progress channel is preserved.
- The four routes keep their current paths, so existing bookmarks for Config, Jobs, Logs, and Auto-Scrape continue to work. Config remains at `/` as the landing page.
- The old frontend's pages are removed outright rather than redirected, since their backing endpoints are gone — a redirect would misrepresent removed functionality as relocated.
- Desktop-first, with the narrow-viewport floor set at 360px. No native mobile app.
- No dark mode, internationalization, or accessibility conformance target is committed in this round; these are deliberately deferred, not designed out.
- **Rejected alternative — persistent cross-page status strip.** Live run state stays on Jobs (FR-026) and orchestrator state on Auto-Scrape (FR-037). A global strip surfacing both on every page was considered and rejected for this round: it would require all four pages to track live run state, widening the polling surface for modest benefit. Accepted cost — an operator sitting on Config or Logs will not see that a scan is running.

**Backend dependencies observed as-built (constraints the design must absorb, not fix)**

These describe real current behavior, warts included, per constitutional Principle I. **Every one of them is absorbed, not fixed** — this feature changes no backend code, so the design must live with all of them. (The one gap that was originally to be fixed here, the missing per-source read path, was closed by feature 008 instead; see FR-048–FR-052.)

- **Scan triggering is a mailbox, not a request/response.** The trigger returns no run identifier and returns before any scan starts; the extension picks the command up on its own polling schedule. Correlating a trigger to its run therefore depends on recency, and a bounded wait (FR-027) is required because a trigger may never be collected at all.
- **Pending-command reads are destructive.** The endpoints exposing queued scraper commands clear the flag when read. The frontend must never poll them or it will steal the extension's instructions (FR-030).
- **Live progress has one push channel plus polling.** Progress is pushed only when a run is updated; a poll fallback is required for the case where the channel drops (FR-026).
- **Orchestrator state is a whole-object write.** A partial write silently destroys unsent fields, so the frontend must submit merged state (FR-046).
- **Run logs have no per-run fetch and no total count.** A run's detail and its trace are only available from the list response, which drives the expand-in-place design (FR-033) rather than a detail route.
- **Debug traces are large and inline.** Traces are a ring buffer of up to 10,000 events returned inline with each listed run, and are included by default. Logs must opt out of trace payloads for collapsed runs (FR-035) or the list response becomes unusably large.
- **Two disjoint settings surfaces exist.** Search settings and orchestrator settings share no fields and neither reads the other. Per Clarification Q2 this spec keeps them on separate pages accordingly: search settings on Config, orchestrator settings on Auto-Scrape. The cost is accepted knowingly — "what gets searched" is answered in two places — in exchange for each page addressing a single backend surface with one validation and error model.
- **Some stored fields are retained but dead** — scoring/dedup thresholds on search settings, post-scrape pipeline toggles on orchestrator settings. They remain readable and writable and are re-validated on every save. FR-018 and FR-045 hide them without clearing them, so saves continue to pass validation.
- **Runs and cycles change without user action.** Backend reapers fail stale runs and cycles independently; the UI must treat externally-driven change as normal (FR-047).
- **Shelf life is not editable** — it exists only in backend storage with no exposed endpoint — so it is out of scope for Config.

## Dependencies

- **Backend, search-only surface** — the four pages depend on the existing configuration, jobs, extension/run-log, and auto-scrape capabilities. All four exist today; this feature adds no backend capability.
- **Feature 008, unified `scraped_jobs`** — ✅ **satisfied.** User Story 1 depends on the canonical read capability (FR-048–FR-052), which feature 008 shipped. **US1 is unblocked**; Jobs has a real data source. This dependency is discharged, not outstanding.
- **Chrome extension** — Jobs progress and all auto-scrape activity depend on the extension running. When it is absent, pages must degrade to a stated state (FR-027, FR-038) rather than appear broken.
- **Constitution, Principle II** — the existing smoke-test suite defines backend behavior. Where this spec and a smoke test disagree about backend behavior, the smoke test wins. This feature changes no backend behavior, so it changes no smoke test: `smoke_test_auto_expiration.py`, `smoke_test_auto_scrape.py`, and `smoke_test_matched_claim.py` must still pass **unmodified**. The read capability's own smoke coverage was feature 008's obligation and is discharged there.
- **Constitution, Principle V** — the per-source tables are append-only, with only claim-and-flag and shelf-life expiry permitted to mutate them; the derived `scraped_jobs` row permits only the claim-flip, a user-set `dismissed` flag, and expiry `DELETE`. This frontend is **read-only over both** and never writes a job row, so the invariant is untouched.
