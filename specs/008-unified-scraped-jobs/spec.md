# Feature Specification: Unified Scraped Jobs Table with Dual-Write Ingest

**Feature Branch**: `008-unified-scraped-jobs`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "Redesign the scraped_jobs table into a UNIFIED, site-agnostic table and make ingest dual-write. Every scrape must write both to its per-source table (linkedin_jobs/indeed_jobs/glassdoor_jobs, unchanged) AND to a redesigned scraped_jobs holding one canonical row, so GET /jobs reads scraped_jobs and returns real scraped data to the frontend, and those rows are the substrate for future matching. Use docs/live-per-source-schemas.md as the authoritative mapping — it defines the canonical merged columns and the exact per-source column each value comes from per site, with transforms (title, company, location_text, description, salary_* with period-vocab normalization, posted_at normalized to timestamptz, remote, apply_url; provenance: source_site, source_row_id, site_job_id, scan_run_id, job_url, scrape_time, matched). There is no source_table column. Acceptance: after a scan, scraped_jobs is populated with correctly mapped rows for all three sites; GET /jobs returns them; per-source tables still populate unchanged; the backend boots; and a smoke test covers the dual-write and the per-site projection. Describe behavior and outcomes, not implementation."

## Context: The Problem Being Solved

The search-only split (feature 006) routed every real scrape into one of three per-source stores — `linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs` — each faithfully shaped like the site it came from. The Jobs listing, however, still reads the older `scraped_jobs` store, which nothing on the per-source path writes to. The result is a system that scrapes correctly and shows nothing: a user can run a scan, watch all three sites populate their stores, then open the Jobs page and see an empty list.

The older `scraped_jobs` store is also the wrong shape to fix this by simply pointing new writers at it. It was built around a single site's vocabulary (`website`, `job_title`, `location`, `job_description`, `post_datetime`) and still carries dedup and matching attributes that the search-only split retired. It cannot represent an Indeed or Glassdoor posting without distortion.

This feature replaces that store with a **unified, site-agnostic** one and makes every ingest write **both** places: the per-source store keeps the raw, source-shaped truth; the unified store holds one canonical, comparable row per posting. That canonical row is what the Jobs page reads, and it is the substrate future matching will score against.

## Clarifications

### Session 2026-07-15

- Q: Where does the dual-write happen, and what guarantees the two rows stay together? → A: Both rows are written within the single ingest request that delivers the posting, in one transaction — per-source row and canonical row commit together or not at all. There is no deferred or batch merge step.
- Q: Indeed company precedence when both payloads carry a name? → A: The primary (mosaic) company value wins; the secondary (graphql) employer name is used only when the primary is absent.
- Q: How is Glassdoor's remote status derived, given it has no boolean? → A: True when the structured remote work types are present and non-empty; unknown (not false) when absent. Absence means "the site didn't say", not "not remote".
- Q: How is posting date normalized per site? → A: LinkedIn's and Indeed's millisecond-epoch values are converted to a point in time by dividing to seconds; Glassdoor's calendar date is cast to a point in time. All three land on one comparable representation.
- Q: Is a drop-and-recreate migration acceptable for the existing `scraped_jobs`? → A: Yes. It holds zero rows and a legacy single-site schema, so there is no data to preserve and no backfill is owed. The redesign replaces it outright.
- Q: What uniqueness applies, and is cross-site duplication allowed? → A: A posting's web address stays unique, so a same-site re-scrape is a no-op rather than a duplicate. The same job listed on two different sites has two distinct addresses and is allowed to appear twice; cross-site dedup is out of scope.
- Q: The claim flag is copied at ingest (always unclaimed), but the existing claim path flips it on per-source rows only — the unified copy would never update. How is this resolved? → A: Claiming records the claim on both rows in the same operation, mirroring the expire-both rule (FR-027). The claim smoke test is extended to cover it.
- Q: FR-015 requires one shared pay-period vocabulary but never defines it; the mapping doc exemplifies only annual and hourly, while the sites also emit monthly/weekly/daily. What is the canonical set? → A: Exactly five — hourly, daily, weekly, monthly, annual. Amounts are stored as quoted against their normalized period; no conversion or annualization. Periods outside the five leave the period unresolved and keep the amounts.
- Q: Does the unified store carry a copy of the raw source payload, which the mapping doc lists as an optional dev/test column? → A: No. Raw payloads stay on the per-source rows only; the unified row's back-reference reaches them. Copying would duplicate the heaviest column for every posting with no reader that needs it there, and CC-4 points the same way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Job seeker sees real scraped results on the Jobs page (Priority: P1)

A job seeker runs a scan across LinkedIn, Indeed, and Glassdoor. When the scan finishes, the Jobs listing carries every posting the scan collected — regardless of which site it came from — in one consistent shape. A LinkedIn posting and a Glassdoor posting sit side by side with the same fields filled in the same way: title, company, location, when it was posted, salary, whether it's remote, and a link to apply.

**Why this priority**: This is the entire user-visible payoff. Today a successful scan produces an empty Jobs listing, which makes the product appear broken. Every other story in this feature exists to make this one work.

**Scope boundary**: This story is complete when the listing *returns* the postings in canonical form. Rendering them in the redesigned Jobs page is spec 007's work (FR-021), so the visible page does not become correct until 007 adapts to the canonical field names. Verification here is against the listing's response.

**Independent Test**: Run a scan that ingests at least one posting from each of the three sites, then request the Jobs listing. It returns those postings with populated canonical fields and correct site attribution. Delivers the feature's core value — real scraped data available to the frontend — on its own.

**Acceptance Scenarios**:

1. **Given** a completed scan that ingested postings from LinkedIn, Indeed, and Glassdoor, **When** the Jobs listing is requested, **Then** postings from all three sites are returned in one list, each carrying title, company, location, and an apply link.
2. **Given** a Glassdoor posting whose source data expresses its posting date as a calendar date and a LinkedIn posting whose source data expresses it as a millisecond timestamp, **When** both are returned by the Jobs listing, **Then** both carry a correct posting date on the same scale, and ordering by posting date places them correctly relative to each other.
3. **Given** an Indeed posting whose pay is quoted per hour and a LinkedIn posting whose pay is quoted per year, **When** both are returned by the Jobs listing, **Then** the first carries its amounts against the canonical hourly period and the second against the canonical annual period, each amount as the source quoted it, so the two are distinguishable rather than silently mixed.
4. **Given** a scan that collected no postings, **When** the Jobs listing is requested, **Then** an empty list is returned without error.

---

### User Story 2 - Every scrape lands in both stores, atomically (Priority: P1)

Each posting the extension sends to the backend is recorded twice: once in its per-source store, exactly as the site presented it, and once in the unified store, translated into canonical form. Neither write can happen without the other. A posting is never in one store but missing from the other.

**Why this priority**: This is the mechanism Story 1 depends on, and its atomicity is what makes the unified store trustworthy. A unified store that silently drifts from the per-source stores is worse than no unified store, because downstream matching would score a stale or incomplete picture.

**Independent Test**: Ingest one posting per site and inspect both stores. Each posting has exactly one per-source row and exactly one unified row, and the two agree. Then force the canonical write to fail and confirm the per-source row is absent too — no partial record survives.

**Acceptance Scenarios**:

1. **Given** a posting is ingested for any of the three sites, **When** ingest completes successfully, **Then** exactly one per-source row and exactly one unified row exist for that posting, and the unified row points back to its per-source row.
2. **Given** a posting is ingested, **When** the canonical write cannot be completed, **Then** the per-source write is not retained either, the ingest reports failure, and neither store contains a row for that posting.
3. **Given** the per-source stores' existing shape and contents, **When** postings are ingested after this change, **Then** the per-source rows are identical in structure and values to what the same postings produced before this change.
4. **Given** a posting whose web address was already ingested by an earlier scan, **When** it is ingested again, **Then** no duplicate appears in either store and the ingest reports the posting as already existing.

---

### User Story 3 - Every site's values land in the right canonical fields (Priority: P2)

For each of the three sites, the values the site provides arrive in the canonical fields a reader expects — company name in the company field, the site's own posting identifier retained, remote status resolved to a yes/no/unknown answer even where the site expresses it as a structure rather than a flag.

**Why this priority**: Story 1 proves postings *appear*; this proves they appear *correctly*. Mapping errors are silent — a posting with the wrong company or an empty location still renders — so this needs its own verification rather than riding on the listing's success.

**Independent Test**: For each site, ingest a posting with known source values and confirm each canonical field holds the value the mapping specifies for that site. Independently verifiable per site without the Jobs page.

**Acceptance Scenarios**:

1. **Given** an Indeed posting that carries a company name in its primary payload, **When** it is ingested, **Then** the canonical company field holds that name; **and given** an Indeed posting lacking it but carrying an employer name in its secondary payload, **Then** the canonical company field falls back to that employer name.
2. **Given** a Glassdoor posting that expresses remote status only as a structured list of remote work types, **When** it is ingested, **Then** the canonical remote field reads true when that list is present and non-empty, and unknown when it is absent.
3. **Given** postings from each of the three sites, **When** they are ingested, **Then** each unified row records which site it came from, the site's own posting identifier, the originating scan run, and the moment it was scraped.
4. **Given** a posting whose source lacks a value the canonical shape allows to be absent (for example, no salary), **When** it is ingested, **Then** the unified row is still created with that field empty rather than the ingest failing.

---

### Edge Cases

- **A posting arrives with a site value the system does not recognize.** Ingest rejects it as a bad request, exactly as it does today, and neither store is written.
- **A posting arrives without an identified scan run.** Ingest rejects it as a bad request, exactly as it does today.
- **The same posting is scraped twice within one scan.** The second write is recognized as an existing posting and no duplicate appears in either store; the originally stored values are kept.
- **The same job is posted on two different sites.** It appears twice — once per site — because each site's web address is distinct. Recognizing that two sites list the same job is out of scope for this feature.
- **A site provides a pay period word outside the canonical five.** The unified row stores the pay amounts and leaves the period unresolved rather than guessing a wrong period or discarding the amounts. The five cover every period the three sites are known to emit, so this indicates a site changed its vocabulary and is worth surfacing rather than absorbing silently.
- **A source posting date is absent or unparseable.** The unified row is created with an empty posting date rather than failing ingest.
- **Auto-expiration removes an aged per-source row.** The corresponding unified row is removed in the same operation, so the Jobs page never shows a posting whose source record is gone and the unified store does not accumulate orphans.
- **A job seeker dismisses a posting, then the same posting is scraped again.** The posting's web address is already present, so no new row is created and the dismissal survives the re-scrape.

## Requirements *(mandatory)*

### Functional Requirements

**Unified store shape**

- **FR-001**: The system MUST provide a single, site-agnostic store of scraped postings in which one row represents one posting from one site, with the same fields carrying the same meaning regardless of which site the posting came from.
- **FR-002**: The unified store MUST carry, for each posting, the canonical business fields defined by the authoritative mapping: title, company, location text, description, remote status, apply link, experience level, industry, pay minimum, pay maximum, pay currency, pay period, and posting date.
- **FR-003**: The unified store MUST carry, for each posting, provenance identifying which site it came from, which per-source row it corresponds to, the site's own posting identifier, the scan run that collected it, the posting's web address, when it was scraped, and whether it has been claimed by matching.
- **FR-004**: The unified store MUST identify a posting's origin site by the site value alone; it MUST NOT carry a separate field naming the per-source table.
- **FR-005**: The unified store MUST NOT carry dedup or matching result attributes, which the search-only split retired; when matching returns, its attributes are added here rather than to the per-source stores. The one exception is the job seeker's dismissal state (FR-023), which is a user action rather than a dedup artifact.
- **FR-005a**: The unified store MUST NOT carry a copy of the posting's raw source payload. Raw payloads remain on the per-source rows, which the unified row's back-reference reaches; a reader needing raw data follows that reference rather than reading it from the unified row.
- **FR-006**: The unified store MUST reject two postings sharing the same web address, so that re-scraping a posting cannot create a duplicate.

**Dual-write ingest**

- **FR-007**: Ingesting a posting MUST write both its per-source row and its unified row, within the single request that delivers that posting. There is no deferred, batched, or separately-triggered merge step: a posting that has been accepted is canonically readable immediately.
- **FR-008**: The two writes MUST be all-or-nothing — one transaction, committing together or not at all. If either cannot be completed, neither is retained and the ingest reports failure. No state exists, even transiently to another reader, in which one row is visible without the other.
- **FR-009**: Ingest MUST continue to write per-source rows exactly as it does today — same fields, same values, same treatment of already-seen postings — with no observable change to those stores.
- **FR-010**: When a posting's web address is already present, ingest MUST report it as already existing and leave the previously stored values in both stores untouched, creating no duplicate.
- **FR-011**: Ingest MUST continue to reject unrecognized site values and postings without an identified scan run, as it does today, writing to neither store.

**Per-site mapping and normalization**

- **FR-012**: For each of the three sites, each canonical field MUST be populated from the specific source field that `docs/live-per-source-schemas.md` designates for that site. That document is authoritative for per-site source lineage and transforms, and wins over this spec on any such detail. It does **not** override the decisions recorded under Clarifications, which deliberately depart from it in three places: the raw payload is omitted (FR-005a), the pay-period vocabulary is fixed at five values (FR-015), and dismissal state is added (FR-023). Those three are settled here and MUST be written back into that document.
- **FR-013**: Company for Indeed postings MUST be taken from the primary payload's company value, falling back to the secondary payload's employer name when the primary is absent.
- **FR-014**: Remote status for Glassdoor postings MUST be derived as true when the site's structured remote work types are present and non-empty, and left unknown otherwise; the underlying structure is not preserved in the canonical field.
- **FR-015**: Pay period MUST be normalized onto one shared vocabulary across all three sites, so that values the sites express differently for the same period resolve to the same canonical period. The canonical vocabulary is exactly: hourly, daily, weekly, monthly, and annual. Every period any of the three sites emits MUST map onto one of these — for example, each site's several spellings of a yearly period all resolve to annual.
- **FR-015a**: Pay amounts MUST be stored as the source quoted them, against their normalized period. The system MUST NOT convert amounts between periods or derive an annualized figure; a monthly salary is stored as a monthly amount with a monthly period, never multiplied onto an annual scale.
- **FR-016**: Posting date MUST be normalized onto one shared point-in-time representation across all three sites, so that dates the sites express as millisecond timestamps and as calendar dates become directly comparable and sortable; the raw source form MUST NOT be stored in the canonical posting-date field.
- **FR-017**: A canonical field whose source value is absent MUST be left empty rather than causing the ingest to fail.

**Reading the unified store**

- **FR-018**: The Jobs listing MUST read from the unified store and return the postings a scan collected, across all three sites, to the frontend.
- **FR-019**: The Jobs listing MUST allow narrowing results by origin site, by scan run, and by dismissal state, and MUST exclude dismissed postings by default so that dismissing a posting removes it from the job seeker's working list.
- **FR-020**: The Jobs listing MUST continue to return results in pages, with a caller-controlled page size and offset and a total count, as it does today.
- **FR-021**: The Jobs listing's response MUST expose the canonical field names of the unified store, replacing the retired store's site-specific field names. Adapting the frontend to those names is out of scope for this feature and is handled under spec 007; this feature's acceptance is verified at the listing's response, not in the rendered page.
- **FR-022**: Every route reading or writing the unified store MUST require bearer authentication, consistent with the existing auth boundary.

**Retained and retired surfaces**

- **FR-023**: A job seeker MUST still be able to dismiss a posting, and the unified store MUST carry each posting's dismissal state. Dismissal is the only retained attribute from the retired store's dedup-era columns, kept because it records a user's decision rather than a pipeline artifact.
- **FR-024**: The skipped-postings listing MUST be removed along with the dedup attributes it depends on. Ingest MUST NOT **record** a skip reason anywhere, and MUST NOT create postings without a web address. Ingest MUST, however, still **accept** a skip-reason submission without error, doing nothing with it: the extension reports every skipped card on every site, and rejecting those reports would cost seconds of retry backoff per skipped card on a path this feature does not otherwise touch. *(Amended 2026-07-15 — deviation D1, approved; original text said "MUST NOT accept or record", written before the live caller was known.)*
- **FR-025**: The ingest path used when a posting arrives without raw source data — which today writes only the retired store — MUST be resolved so it cannot write rows in a shape the unified store no longer supports.
- **FR-026**: Administrative cleanup that deletes postings by origin site and by empty core fields MUST be retired. Its origin-site screen is retired because the condition can no longer arise — ingest already rejects any site outside the three-site allowlist. Its empty-core and short-description screens are retired for a stronger reason: the conditions can still arise, but no compliant remedy exists. Deleting only the unified row would leave a per-source row with no counterpart, breaking the one-to-one correspondence SC-002 asserts; deleting the per-source row too is not among the permitted mutations on the raw store. Aged rows are still reclaimed by auto-expiration, and a posting whose site supplied no title is a faithful record, not corruption. *(Amended 2026-07-15 — deviation D2, approved; original text offered "operate on canonical fields, or be retired where the condition can no longer arise", before that analysis was done.)*

**Lifecycle**

- **FR-027**: When auto-expiration removes an aged per-source row, the corresponding unified row MUST be removed in the same operation, so that no unified row outlives the per-source row it came from.
- **FR-028**: When a posting is claimed for matching, the claim MUST be recorded on both its per-source row and its unified row in the same operation, so the two never disagree about whether a posting has been claimed. A unified row MUST NOT report a posting as unclaimed once its per-source row has been claimed.

**Verification**

- **FR-029**: The backend MUST start successfully with the redesigned store in place.
- **FR-030**: A smoke test MUST verify that ingesting a posting produces both a per-source row and a unified row that agree, for each of the three sites.
- **FR-031**: A smoke test MUST verify the per-site projection: for each site, that each canonical field holds the value the authoritative mapping designates for that site, including the Indeed company fallback, the Glassdoor remote derivation, pay period normalization, and posting date normalization.
- **FR-032**: The existing auto-expiration smoke test MUST be extended to verify that expiring a per-source row also removes its unified row.
- **FR-033**: The existing claim smoke test MUST be extended to verify that claiming a per-source row also records the claim on its unified row.

### Key Entities

- **Unified Scraped Posting**: One canonical, site-agnostic record of a single posting from a single site. Holds the business fields a reader or matcher cares about (what the job is, where, for whom, for how much, posted when, how to apply) alongside provenance (which site, which per-source row, the site's own identifier, which scan run, its web address, when scraped, whether claimed) and the job seeker's dismissal state. Uniquely identified by its web address. Belongs to exactly one scan run, corresponds to exactly one per-source row, and does not outlive that row.
- **Per-Source Posting** (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs` — unchanged): The faithful, source-shaped record of a posting as its site presented it, retaining fields the canonical shape does not carry. Remains the raw store of record and the origin of every unified row. Its structure and behavior are unchanged by this feature.
- **Scan Run** (unchanged): The collection event that produced a set of postings. Both stores reference it; deleting one is restricted while postings reference it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a scan that collects postings from all three sites, the Jobs listing returns real postings from every site that returned results — where today it returns none.
- **SC-002**: 100% of postings successfully ingested during a scan appear in the Jobs listing, with no posting present in a per-source store but missing from the unified store, or the reverse.
- **SC-003**: For every posting in the Jobs listing, title, company, location, and apply link are populated whenever the originating site supplied them — verified for all three sites.
- **SC-004**: Posting dates from all three sites sort correctly against each other in one list, and every resolved pay period across all three sites reads as one of the canonical five.
- **SC-005**: The per-source stores are unchanged in structure and, for identical input postings, in content — confirmed by the existing per-source smoke coverage passing with no change to its per-source expectations.
- **SC-006**: The backend starts successfully and the Jobs listing responds, with the redesigned store in place.
- **SC-007**: A smoke test covering the dual-write and the per-site projection passes for all three sites.
- **SC-008**: After auto-expiration runs, the number of unified rows whose per-source row no longer exists is zero.
- **SC-009**: A posting a job seeker dismissed does not reappear in their default Jobs listing, including after a later scan re-encounters it.
- **SC-010**: After a claim runs, the number of postings whose per-source row and unified row disagree about being claimed is zero.

## Assumptions

- **The authoritative mapping is `docs/live-per-source-schemas.md`.** Its per-site source columns and transforms are taken as given and win over this spec on any lineage detail, except for the three departures settled under Clarifications and scoped in FR-012. It reflects the live database as of 2026-07-15 and supersedes `docs/current-schemas.md`.
- **The existing `scraped_jobs` store is replaced, not migrated.** The mapping document records that it currently holds zero rows, so no data needs preserving and no backfill of historical per-source rows is expected. Only postings ingested after this change populate the unified store.
- **Re-scrapes leave stored values untouched.** Consistent with the append-only invariant on the per-source stores (Principle V), a posting whose web address is already present is reported as already existing and is not refreshed with newer values in either store. Refresh-on-rescrape is a separate concern.
- **Normalization at the canonical write is explicitly permitted.** Constitution v1.1.0 Principle V settles this: CC-10/CC-11 govern *where* normalized data lives — the derived row — not *when* it is computed, so performing the merge inside the ingest transaction satisfies them as long as per-source rows stay source-shaped. This spec previously deferred the question to the plan's Constitution Check gate; it is now answered and no longer a gate item.
- **Cross-site deduplication is out of scope.** The same job listed on two sites yields two unified rows, because each site's web address differs. Recognizing them as one job is a separate concern.
- **Matching is out of scope, but the claim flag is not passive.** This feature establishes the substrate matching will consume and adds no matching *results* (score, level, reasoning). The claim flag is different: it already exists on the per-source rows and is already flipped by the existing claim path, so carrying it onto the unified row obliges this feature to keep the two in step (FR-028). Treating it as a write-once copy would guarantee it is wrong.
- **Index scope is constrained by CC-12.** The mapping document's illustrative schema suggests indexes beyond primary-key, unique, and foreign-key ones. The constitution forbids speculative indexes without demonstrated need; the plan should justify any such index or drop it.
- **Two decisions extend the mapping document rather than follow it.** `docs/live-per-source-schemas.md` does not define a dismissal attribute, and it exemplifies only two pay periods (annual, hourly) without stating the full vocabulary. FR-023 adds dismissal because it records a user's decision rather than a retired pipeline artifact; FR-015 fixes the canonical vocabulary at five periods because the sites demonstrably emit monthly, weekly, and daily, which two values would silently drop. The mapping document remains authoritative for every field it does define — these are additions to it, not disagreements with it, and both should be written back into that document so it stays the single source of truth.
- **Dismissed postings are hidden by default.** The retired store's listing defaulted to hiding postings that dedup had *skipped*, not ones the user had dismissed. With the skip concept gone (FR-024), FR-019 makes dismissal the default exclusion instead, since a dismiss action that leaves the posting in the list does nothing for the user. This is a deliberate behavior change, not a preserved default.
- **Three existing smoke tests change by design.** `smoke_test_auto_scrape.py` constructs rows in the retired `scraped_jobs` shape and must be moved to the redesigned shape. `smoke_test_auto_expiration.py` pins expiration to per-source tables and must be extended to assert the unified row is removed too (FR-032). `smoke_test_matched_claim.py` pins claiming to the three per-source tables and must be extended to assert the claim reaches the unified row (FR-033). All three are intentional, reviewable updates under Principle II — the behavior change they encode is the point of the feature, not a regression. Their existing per-source expectations do not change; the unified assertions are additive.
- **Frontend breakage between this feature and 007 is accepted.** Renaming the listing's response fields (FR-021) breaks the current UI's field reads until 007 adapts. This is accepted because the UI shows an empty list today regardless, so there is no working behavior to preserve.
