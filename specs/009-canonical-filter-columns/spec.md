# Feature Specification: Canonical Filter Columns on `scraped_jobs`

**Feature Branch**: `031-scraped-jobs-matching-columns`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Extend the canonical scraped_jobs projection (feature 008) so a future filtering/matching service can read ONLY scraped_jobs without joining the per-source tables. Add five nullable canonical columns to scraped_jobs: employment_type, workplace_type, language, education_requirements, and salary_disclosed (boolean). Populate each from the per-source row at dual-write time, normalized to a canonical form per site, mirroring how feature 008 already transforms salary_period and remote. Per-site sources (verify against docs/live-per-source-schemas.md): employment_type from linkedin formatted_employment_status / indeed job_types / glassdoor job_type or employment_type; workplace_type from linkedin workplace_types_labels / indeed remote_location / glassdoor remote_work_types; language from indeed language else NULL; education_requirements from glassdoor education_labels or experience_requirements_description else NULL; salary_disclosed derived from linkedin salary_provided_by_employer, indeed salary_snippet_source (employer vs site-estimate), glassdoor salary_source. NULL where a site does not provide the field. Acceptance: after a scan, scraped_jobs carries the five new columns populated per site (or NULL), existing GET /jobs and ingest behavior is unchanged, and all existing smoke tests still pass. Do NOT build the separate service. Describe behavior and outcomes, not implementation."

## Context: what exists today

Feature 008 shipped the unified `scraped_jobs` table (Alembic migration `030`, 22 columns). It is a
**derived** table: every `POST /jobs/ingest` writes the per-source row and one canonical row in a
single transaction, and the canonical row is projected from the per-source values — not re-parsed
from the raw payload.

Two canonical fields already establish the normalization pattern this feature extends:

- **`salary_period`** — the three sites spell the same period differently (`YEARLY` / `YEAR` /
  `ANNUAL`). It is normalized onto a fixed five-value vocabulary. An unrecognized token yields
  NULL **and logs a warning**, keeping the salary amounts intact; a wrong period is worse than an
  absent one.
- **`remote`** — tri-state. Glassdoor exposes no boolean, so it is derived from a structured list
  being non-empty. Absent means *"the site didn't say"*, which is deliberately **not** the same
  claim as *"not remote"* — hence NULL rather than false.

Both rules hold for the five columns added here: a fixed canonical vocabulary, unrecognized input
→ NULL + warning, and absence never asserted as a negative.

A consumer that wants to filter on employment type, workplace type, language, education, or
whether a salary is employer-stated must today read the per-source tables, because those
attributes exist only in site-shaped form (as `varchar`, as `boolean`, and as several differently
structured lists). That defeats the purpose of the canonical table.

**Verified against `docs/live-per-source-schemas.md` and the live builders** — all thirteen named
source fields exist on their tables and are already carried in the per-source parameters the
canonical projection reads, so no new extraction from raw payloads is required by this feature.

## Clarifications

### Session 2026-07-16

- Q: LinkedIn/Glassdoor state a literal `Other`/`OTHER` employment status that maps to no canonical token — NULL silently, NULL with a warning, or add `OTHER` to the vocabulary? → A: Recognized-but-unmappable — NULL, no warning. It is a value the site uses correctly, not a gap in our vocabulary; warning on it would drown the warnings that signal real drift.
- Q: `salary_disclosed` when the salary-source field is present but carries an unrecognized token — NULL or false? → A: NULL + warning. `false` is a positive claim ("the site estimated this"); only an explicitly-recognized estimate token may assert it.
- Q: What is the canonical form of `language` (FR-011 said only "canonical, consistent form")? → A: Bare lowercase base code — `en-US` → `en`, `EN` → `en`. Region subtag discarded; the filter is "which language", not "which regional variant".
- Q: LinkedIn states remoteness in two independent fields (`work_remote_allowed` boolean, `workplace_types_labels` list) that can contradict — which wins for `workplace_type`? → A: Labels win (they alone can express hybrid); `remote` stays as-is from `work_remote_allowed`; log a warning when the two contradict.
- Q: Glassdoor's `education_labels` is a list that may carry several credentials, but `education_requirements` is one free-text value — which label wins? → A: Join all labels into one value, source order preserved, separator `"; "`. Nothing discarded; free text has no ranking to apply.

### Session 2026-07-16 (post-`/speckit-analyze` remediation)

Four defects found by cross-artifact analysis, resolved here. Each was a spec defect, not a design change — no decision from the earlier sessions is reversed.

- Q: FR-022 said "any smoke-test edit would signal an unintended regression", yet 13 tasks extend `smoke_test_scraped_jobs_merge.py`, and Constitution §II *requires* new permanent behavior to be captured by a smoke test. Which governs? → A: Both, once separated. FR-022 now binds existing **assertions**; FR-022a permits **additive** extension and forbids modifying/relaxing/deleting an existing assertion — that is the regression signal FR-022 exists to catch.
- Q: FR-011b required rejecting an "implausible" language code without defining plausible. → A: Shape, not membership — two or three ASCII letters after normalization (ISO 639-1/639-2 shape). No allow-list, no check that the code names a real language (FR-011b, FR-011c).
- Q: FR-002 says NULL means "the site did not say", but the staged delivery leaves later stories' columns NULL-and-unpopulated at each earlier checkpoint. → A: FR-002a — the guarantee binds the completed feature, not each increment; a column must not be added without being populated unless the increment reaches no consumer.
- Q: SC-007 ("throughput is materially unchanged") named no threshold and had no task, so it could not be passed or failed. → A: Restated as a structural claim that *is* exactly checkable — same number of DB statements per posting, zero added queries/round trips/reads — verified by inspecting the ingest path rather than by a benchmark harness this project does not have.

### Session 2026-07-17 (FR-005d warning review — live scan)

The mapping shipped reasoned-not-observed by design, with warnings as the correction mechanism. The first live three-site scan ran it. **All three findings closed**; full detail in FR-005e.

- Q: LinkedIn `workplace_type` was NULL for every row — the mapping assumed `localizedName` label objects. What does LinkedIn actually send? → A: A self-referential URN map, `{"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}` — no labels at all. Map the enum codes `1/2/3` → `ONSITE`/`REMOTE`/`HYBRID` (FR-005a). Codes are locale-proof where labels are not, so this is better than what was originally specified, not merely a repair.
- Q: Indeed sends `"Permanent"` as a job type, which FR-005c deliberately left unmapped. Resolve it. → A: New canonical token `PERMANENT`, vocabulary 6 → 7 (FR-004, FR-004a). It is a tenure axis, not hours — a permanent part-time job exists — so it is not folded into `FULL_TIME`, and it ranks below the hours tokens so `["Full-time","Permanent"]` still yields `FULL_TIME`.
- Q: Indeed's `salary_snippet_source` is `"EXTRACTION"` for its entire salary population — True, False, or NULL? → A: **True**. Indeed parsed the pay from employer-authored prose; it estimated nothing, so FR-010a's tri-state rule rules `false` out, and NULL would strand every Indeed salary as "provenance unknown" when the provenance is known. `salary_disclosed` encodes provenance, not parse reliability. This reverses the placeholder NULL that was asserted while the token was unmapped — an intentional, declared behavior change (Constitution II), not a test edited until it passed.
- Q: Glassdoor `workplace_type` is NULL on every live row. Projection defect? → A: No — the scraper returns `remote_work_types` empty, so there is nothing to map and NULL is the correct output. Scraper-layer follow-up, out of scope here (FR-005f).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filter by employment type and workplace type across all sites (Priority: P1)

A consumer of the canonical table asks for "full-time remote jobs" and gets a correct answer
across LinkedIn, Indeed, and Glassdoor postings by reading `scraped_jobs` alone — never touching a
per-source table, and never needing to know that one site said `Full-time`, another said
`FULL_TIME`, and a third expressed remoteness as a list.

**Why this priority**: These are the two highest-value filters and the two that are unusable today
without per-site knowledge. Each site expresses them in a different shape (single text, boolean,
structured list), so this is where a canonical projection earns its keep. Delivered alone, this
already makes the table filterable.

**Independent Test**: Run a scan that ingests postings from all three sites, then read
`scraped_jobs` only. Every row carries `employment_type` and `workplace_type` as one canonical
token or an explicit NULL, and rows from different sites describing the same kind of job carry the
same token.

> **As built (2026-07-17):** `employment_type` populates for all three sites. `workplace_type`
> populates for LinkedIn and Indeed; on Glassdoor it is NULL on every live row because the scraper
> returns `remote_work_types` empty (SC-002a, FR-005f). The projection is correct and the mapping is
> in place — the gap is upstream, in the extension, and out of scope for this feature.

**Acceptance Scenarios**:

1. **Given** a LinkedIn posting whose employment status is `Full-time` and whose workplace labels
   list contains `Remote`, **When** it is ingested, **Then** its canonical row carries
   `employment_type = FULL_TIME` and `workplace_type = REMOTE`.
2. **Given** an Indeed posting whose job types list is `["Full-time"]` and which is flagged as a
   remote location, **When** it is ingested, **Then** its canonical row carries
   `employment_type = FULL_TIME` and `workplace_type = REMOTE` — the same tokens as the LinkedIn
   row above.
3. **Given** a Glassdoor posting carrying a structured employment type of `FULL_TIME` and a
   non-empty remote work types list, **When** it is ingested, **Then** its canonical row carries
   `employment_type = FULL_TIME` and `workplace_type = REMOTE`.
4. **Given** an Indeed posting tagged both `Full-time` and `Part-time`, **When** it is ingested,
   **Then** `employment_type = FULL_TIME` — the higher-precedence token wins and `PART_TIME` is
   discarded; the posting is **not** returned by a filter for part-time work.
5. **Given** the same posting tagged in the reverse order (`Part-time` then `Full-time`), **When**
   it is ingested, **Then** `employment_type` is still `FULL_TIME` — precedence decides, never
   payload order.
6. **Given** a posting whose site states an employment type outside the canonical vocabulary
   (e.g. `Per-diem`), **When** it is ingested, **Then** `employment_type` is NULL, a warning is
   recorded naming the site and the unrecognized value, and the posting is still ingested with
   every other field intact.
7. **Given** a posting tagged both an unrecognized `Per-diem` and a recognized `Full-time`, **When**
   it is ingested, **Then** `employment_type = FULL_TIME` and a warning names only `Per-diem` — an
   unrecognized value is skipped, not treated as the winner.
8. **Given** a posting whose site says nothing about employment type or workplace type, **When**
   it is ingested, **Then** both columns are NULL — never a negative assertion the site did not
   make.
9. **Given** a LinkedIn posting whose employment status is `Other`, **When** it is ingested,
   **Then** `employment_type` is NULL and **no warning is emitted** — the site answered correctly
   and there is no vocabulary gap to report.
10. **Given** a LinkedIn posting whose remote-allowed flag is false while its workplace labels say
    `Remote`, **When** it is ingested, **Then** `workplace_type = REMOTE` (the labels win),
    `remote` remains false (unchanged shipped behavior), and a warning records the contradiction.

---

### User Story 2 - Distinguish employer-stated salaries from site estimates (Priority: P2)

A consumer filters to postings whose pay figures came from the employer, excluding the algorithmic
estimates two of the three sites attach to postings that never published a salary.

**Why this priority**: `scraped_jobs` already carries salary amounts, but today a canonical reader
cannot tell an employer-published salary from a site-generated guess — the two are
indistinguishable once projected. That makes the existing salary columns unsafe to filter on
strictly, so this repairs a gap in shipped data rather than adding a new axis. Ranked below P1
because it refines an existing capability instead of unlocking a missing one.

**Independent Test**: Ingest one posting per site with an employer-provided salary and one per site
with a site-estimated salary, then read `scraped_jobs` alone and confirm the two groups are
separable by `salary_disclosed` with no per-source lookup.

**Acceptance Scenarios**:

1. **Given** a LinkedIn posting whose salary is marked as provided by the employer, **When** it is
   ingested, **Then** `salary_disclosed` is true.
2. **Given** an Indeed posting whose salary snippet is attributed to the employer, **When** it is
   ingested, **Then** `salary_disclosed` is true; **and given** one attributed to Indeed's own
   estimate, **Then** `salary_disclosed` is false.
3. **Given** a Glassdoor posting whose salary source indicates an employer-provided figure, **When**
   it is ingested, **Then** `salary_disclosed` is true; **and given** one indicating a Glassdoor
   estimate, **Then** `salary_disclosed` is false.
4. **Given** a posting that quotes no salary at all, or whose site states no salary source, **When**
   it is ingested, **Then** `salary_disclosed` is NULL — not false, which would claim the site
   published an estimate it never published.
5. **Given** a posting whose salary source carries a token matching neither the employer nor the
   estimate indicators, **When** it is ingested, **Then** `salary_disclosed` is NULL and a warning
   names the site and the raw token — an unreadable source never resolves to false.

---

### User Story 3 - Read language and education requirements where a site supplies them (Priority: P3)

A consumer reads a posting's language and its stated education requirements from the canonical row,
and can tell "this site never says" apart from "this posting doesn't require it".

**Why this priority**: Both attributes come from exactly one site each (language from Indeed,
education from Glassdoor), so they are pass-through values needing no cross-site vocabulary
reconciliation, and they will be NULL for the majority of rows. Genuinely useful, lowest risk,
smallest reach — safe to land last.

**Independent Test**: Ingest postings from all three sites and confirm `language` is populated only
for Indeed rows, `education_requirements` only for Glassdoor rows, and both are NULL elsewhere
without any ingest failing.

**Acceptance Scenarios**:

1. **Given** an Indeed posting that states a language, **When** it is ingested, **Then** `language`
   carries that language code in canonical form.
2. **Given** a LinkedIn or Glassdoor posting, **When** it is ingested, **Then** `language` is NULL —
   neither site supplies the field.
3. **Given** a Glassdoor posting carrying education labels, **When** it is ingested, **Then**
   `education_requirements` carries that stated requirement as text.
4. **Given** a Glassdoor posting carrying several education labels, **When** it is ingested,
   **Then** `education_requirements` carries all of them joined in source order, separated by
   `"; "` — none is dropped and none is ranked above another.
5. **Given** a LinkedIn or Indeed posting, **When** it is ingested, **Then**
   `education_requirements` is NULL — neither site supplies the field.

---

### Edge Cases

- **A site lists more than one value.** A posting tagged both `Full-time` and `Part-time`, or both
  `Remote` and `Hybrid`, keeps only the **higher-precedence** token; the other is discarded and is
  not recoverable from the canonical row (FR-008, FR-008a, FR-008c). Selection MUST be
  order-independent, so the same payload always yields the same token.
- **A site lists the same value twice**, or lists two spellings that normalize to one token (e.g.
  `Remote` and `Fully Remote`). Both collapse to that one token; this is the normal case and does
  not warn.
- **A boolean stands in for a three-way distinction.** Indeed states only *remote / not remote* and
  cannot distinguish on-site from hybrid. Per FR-009 its "not remote" is recorded as `ONSITE` — an
  accepted mislabelling of hybrid postings, and the sole place this feature asserts more than the
  site stated.
- **`workplace_type` and the shipped `remote` column disagree.** A Glassdoor posting whose remote
  work types list says only *Hybrid* carries `remote = true` (existing 008 behavior) and
  `workplace_type = HYBRID`. Both are written as specified; `remote` is not corrected. See FR-009a.
- **An empty-but-present list.** A site sends an empty list rather than omitting the field. This is
  absence, not a value: the result is NULL and no warning is logged, because the site behaved
  normally.
- **An unrecognized token.** Handled exactly as `salary_period` already handles it: the value is
  skipped, a warning names the site and the raw value, every other field on the row is unaffected,
  and the ingest still succeeds. A new site vocabulary must surface as a visible gap on the first
  real scan, not silently null thousands of rows.
- **An unrecognized value outranks nothing.** Where a site states an unrecognized value alongside a
  recognized one, the recognized one wins and only the unrecognized one warns (FR-008b). An
  unparseable token never beats a parseable one to the column.
- **Every value stated is unrecognized.** The column is NULL and each unrecognized value warns —
  indistinguishable in the data from "the site said nothing", but distinguishable in the logs,
  which is what makes the gap findable.
- **Both Glassdoor employment-type fields are present.** The structured field wins outright and the
  header field is ignored — they are never merged into one set, even when both are recognized
  (FR-005). Disagreement between two fields of the same site is not an error and does not warn.
- **A posting quotes a salary but names no source.** `salary_disclosed` is NULL. The amounts remain
  exactly as ingested — this feature never alters an existing canonical column.
- **Re-scraping a posting already in the table.** Unchanged from today: `job_url` remains unique and
  the existing conflict behavior governs. This feature adds columns; it does not change how repeat
  postings are handled.

## Requirements *(mandatory)*

### Functional Requirements

**Canonical shape**

- **FR-001**: `scraped_jobs` MUST carry five additional attributes — `employment_type`,
  `workplace_type`, `language`, `education_requirements`, and `salary_disclosed` — each optional
  (NULL-permitting), and each independently readable without consulting any per-source table.
- **FR-002**: Every canonical row created after this feature lands MUST carry, for each of the five
  attributes, either a canonical value or an explicit NULL meaning *"this site did not say"*. No
  third state (missing, empty string, placeholder) is permitted.
- **FR-002a**: FR-002's guarantee binds **the completed feature — all five attributes populated —
  not each intermediate increment.** The attributes are deliverable in stages, and a stage that has
  added a column to the table without yet populating it leaves NULL meaning *"not implemented yet"*,
  which FR-002 forbids: an Indeed posting would read as "the site stated no language" when the site
  stated one. Therefore:
  - A column MUST NOT be added to the table in an increment that does not also populate it, **or**
    the increment MUST NOT be deployed where any consumer reads it.
  - No consumer may rely on NULL's meaning until all five attributes populate.

  This costs nothing today — the consuming service does not exist (spec Assumptions) — but it is
  the difference between an intermediate state and a shipped lie.
- **FR-003**: `salary_disclosed` MUST be tri-state: true (the employer stated the pay), false (the
  site estimated it), NULL (nothing was said). NULL MUST NOT be collapsed into false.

**Normalization**

- **FR-004**: `employment_type` MUST hold **exactly one** arrangement, drawn from one fixed,
  site-agnostic vocabulary of **seven** tokens: `FULL_TIME`, `PART_TIME`, `CONTRACT`, `TEMPORARY`,
  `INTERNSHIP`, `PERMANENT`, `VOLUNTEER`. A posting describing the same arrangement MUST yield the
  same token regardless of which site it came from.
- **FR-004a**: `PERMANENT` is a **tenure** statement, not an hours statement, and MUST NOT be
  folded into `FULL_TIME` — a permanent part-time job exists, and reporting `FULL_TIME` would
  assert hours the source never stated. It MUST rank **below** every hours token in the FR-008a
  precedence, so a posting stating both (`["Full-time", "Permanent"]` — the common Indeed pairing)
  yields `FULL_TIME`, and `PERMANENT` surfaces only when it is the sole signal. Promoting it above
  the hours tokens would silently re-label a large share of the Indeed corpus.

  The vocabulary grew from six to seven **by the process FR-005b/FR-005d designed**: `Permanent`
  arrived unmapped, warned, and was resolved against the 2026-07-17 scan. Growth remains a spec
  decision requiring evidence — never an implementation convenience.
- **FR-005**: `employment_type` MUST be populated from LinkedIn's formatted employment status,
  Indeed's job types list, and Glassdoor's structured employment type — falling back to Glassdoor's
  header job type when the structured field is absent. When both Glassdoor fields are present, the
  structured field wins and the header field is ignored entirely (the two are not merged).
- **FR-006**: `workplace_type` MUST hold **exactly one** workplace arrangement, drawn from one
  fixed, site-agnostic vocabulary: `REMOTE`, `HYBRID`, `ONSITE`.
- **FR-007**: `workplace_type` MUST be populated from LinkedIn's workplace type labels, Indeed's
  remote-location flag, and Glassdoor's remote work types list.
- **FR-008**: `employment_type` and `workplace_type` are **single-valued**. Where a site states
  several arrangements for one posting, the projection MUST select one by a fixed precedence and
  **discard the rest**. The same source input MUST always produce the same token, independent of
  the order values arrived in — precedence decides, never payload order. Where a site states none,
  the attribute is NULL.
- **FR-008a**: The precedence orders are fixed and MUST be applied as written, highest first:
  - `employment_type`: `FULL_TIME` › `PART_TIME` › `CONTRACT` › `TEMPORARY` › `INTERNSHIP` ›
    `PERMANENT` › `VOLUNTEER` — ordered by decreasing commitment, so a posting offering a full-time
    arrangement is described as full-time even when it also offers a lesser one. `PERMANENT` sits
    below every hours token deliberately (FR-004a): it answers a different question (tenure), and
    the hours answer is the more useful one whenever a site states both.
  - `workplace_type`: `REMOTE` › `HYBRID` › `ONSITE` — ordered by decreasing location freedom, so a
    posting that permits remote work is described as remote. This deliberately favours recall on
    remote filters, the most-used workplace filter, over recall on on-site filters.
- **FR-008b**: An unrecognized value MUST be skipped, never selected. Where a site states several
  values and only some are recognized, the highest-precedence **recognized** value wins and the
  unrecognized ones warn per FR-013. The attribute is NULL only when *no* stated value is
  recognized — a single unrecognized token MUST NOT suppress a recognized one.
- **FR-008d**: A source value MUST be classified as one of three kinds, not two:
  - **Mappable** — maps to a canonical token; competes for the column by precedence.
  - **Recognized-but-unmappable** — a value the site legitimately uses that intentionally
    corresponds to no canonical token, specifically LinkedIn's `Other` and Glassdoor's `OTHER`
    employment status. It is skipped, contributes no token, and **MUST NOT warn**. Where it is the
    only value stated, the attribute is NULL.
  - **Unrecognized** — a value not in either list. Skipped, and **warns** per FR-013.

  The distinction exists so warnings stay meaningful: `Other` is the site answering correctly, and
  warning on every such posting would bury the warnings that signal genuine vocabulary drift. The
  recognized-but-unmappable list is closed and enumerated in FR-005a; a value not on it is
  unrecognized by definition.
- **FR-008c**: **Accepted cost of single-valued columns**: a posting stating several arrangements
  is findable only under its winning token. A Full-time/Part-time posting does not answer a
  part-time filter, and a Remote/Hybrid posting does not answer a hybrid filter. The discarded
  values are not recorded anywhere on the canonical row; a consumer needing them must follow
  `source_row_id` back to the per-source row, where the site's full statement is preserved intact.
- **FR-009**: Indeed's remote flag MUST map to `REMOTE` when it indicates remote, and to `ONSITE`
  when it indicates not-remote. **Known limitation, accepted deliberately**: Indeed cannot express
  hybrid, so an Indeed posting that is in fact hybrid is recorded as `ONSITE`. This is a wrong
  value rather than a missing one, and it is the one place in this feature where the canonical row
  asserts something the site did not state. It is accepted so that on-site filters return Indeed
  results at all; the alternative (NULL) makes no Indeed posting filterable as on-site. Consumers
  MUST treat `ONSITE` on an Indeed row as "not remote", not as a confirmed on-site arrangement.
- **FR-009a**: `workplace_type` overlaps the shipped `remote` column, and the two MAY disagree on
  Glassdoor rows. `remote` is set true whenever Glassdoor's remote work types list is non-empty —
  including when that list says only *Hybrid*. Such a row will carry `remote = true` and
  `workplace_type = HYBRID`. **`remote` MUST NOT be changed to resolve this** (FR-018, FR-020):
  it is shipped behavior with existing readers, and altering it is outside this feature's scope.
  Where the two disagree, `workplace_type` is the more precise statement of what the site said.
  This discrepancy MUST be recorded in `docs/live-per-source-schemas.md` alongside the new columns
  so the future service's authors find it before depending on `remote`.
- **FR-009b**: LinkedIn states remoteness in **two independent fields**, and they can contradict.
  The shipped `remote` column derives from its remote-allowed boolean; `workplace_type` derives
  from its workplace-type labels. A posting may carry a false remote-allowed flag while its labels
  say `Remote`.
  - The **labels win** for `workplace_type`. They are the more specific statement and the only
    LinkedIn field able to express hybrid at all, consistent with FR-009a treating
    `workplace_type` as the more precise column.
  - `remote` MUST continue to derive from the remote-allowed boolean alone, unchanged (FR-018,
    FR-020). The two columns are therefore permitted to disagree on LinkedIn rows as well as
    Glassdoor ones.
  - A contradiction (labels imply remote-capable while the boolean says not remote, or the
    reverse) MUST record a warning naming the site, the boolean, and the labels. It MUST NOT fail
    the ingest or null either column: the disagreement is an upstream data problem worth surfacing,
    not a reason to discard a posting.
- **FR-009c**: Consequently, `workplace_type` is **not** a refinement of `remote` and MUST NOT be
  assumed consistent with it on any site. On LinkedIn the two read different source fields; on
  Glassdoor they read the same field under different rules (FR-009a); on Indeed alone do they share
  one source. A consumer MUST choose one column and not mix them within a single filter.
- **FR-010**: `salary_disclosed` MUST be derived from LinkedIn's employer-provided salary flag,
  Indeed's salary snippet source (employer versus site estimate), and Glassdoor's salary source —
  resolving to true only when the source identifies the employer as the origin of the figures.
- **FR-010a**: Each of the three states MUST be reached only by positive evidence:
  - **true** — the source explicitly attributes the figures to the employer.
  - **false** — the source explicitly attributes the figures to the site's own estimate. `false` is
    a *claim*, not a default: it asserts "this site estimated this pay", and MUST only be written
    when a recognized estimate indicator says so.
  - **NULL** — anything else: the field is absent or empty, no salary is quoted, or the field
    carries a token matching neither the employer nor the estimate indicators.
- **FR-010b**: A salary-source field that is present but carries an **unrecognized** token MUST
  yield NULL **and warn** (naming the site and the raw value) — never false. Inferring "the site
  estimated it" from a token that could not be read would assert something unknown, and would make
  a strict employer-only filter silently correct while an estimate-only filter silently wrong. This
  follows the shipped `salary_period` rule, where an unmappable token yields NULL rather than a
  guess. The warning is what surfaces a new site vocabulary on the first real scan.
- **FR-010c**: LinkedIn's employer-provided flag is a boolean and admits no unrecognized state:
  true → true, false → false, absent → NULL. Its `false` is the site explicitly stating the salary
  did not come from the employer, which satisfies FR-010a's positive-evidence bar.
- **FR-011**: `language` MUST be populated from Indeed's language field as a **bare lowercase base
  language code** (e.g. `en`), and MUST be NULL for LinkedIn and Glassdoor, which do not supply it.
- **FR-011a**: Normalization is: lowercase, trim, and discard any region subtag — `en-US`, `en_US`,
  `EN`, and `en` all yield `en`. The canonical question is *which language*, not *which regional
  variant*; preserving the subtag would split `en` and `en-US` into non-matching values for a
  distinction no filter has asked for. The site's exact original tag remains on the per-source row
  for anyone who needs the region.
- **FR-011b**: `language` is validated for **shape, not membership**. A well-formed base code is
  exactly **two or three ASCII letters** after normalization (the ISO 639-1 / 639-2 shape) — `en`,
  `fr`, `fil`. Any value of that shape is accepted as-is; there is **no** allow-list of permitted
  languages, and no check that the code names a real language.
- **FR-011c**: A value that is present but does not match that shape after normalization — digits,
  punctuation, a single letter, four or more letters, or an empty remainder once the region subtag
  is dropped — MUST yield NULL and warn, per FR-013. An absent or empty source value yields NULL
  **without** a warning, per FR-014. The shape rule is deliberately permissive: its job is to reject
  a value that is obviously not a language code, not to adjudicate which languages exist.
- **FR-012**: `education_requirements` MUST be populated from Glassdoor's education labels, falling
  back to Glassdoor's experience requirements description when no education labels exist, and MUST
  be NULL for LinkedIn and Indeed, which do not supply it. It is free text, not a controlled
  vocabulary.
- **FR-012b**: Glassdoor's education labels are a **list**. All labels MUST be joined into the one
  free-text value, in the order the site listed them, separated by `"; "` (semicolon and space).
  Nothing is discarded and no credential is ranked above another — the column is free text
  precisely so it can carry what the site said, and ranking would impose a normalization FR-012
  explicitly declines to make. A single label yields that label alone with no separator; empty or
  blank entries are omitted from the join; a list whose entries are all blank is treated as absent
  (NULL, no warning, per FR-014).
- **FR-012c**: `education_requirements` has **no controlled vocabulary and never warns**. Any text
  the site supplies is valid by definition, so there is no such thing as an unrecognized value —
  FR-013 does not apply to it. This distinguishes it from `employment_type` / `workplace_type`,
  where an unknown token signals vocabulary drift worth surfacing.
- **FR-012a**: **Known duplication, accepted deliberately**: the FR-012 fallback source is already
  the sole source of the shipped `experience_level` column. A Glassdoor posting with no education
  labels therefore carries the *same text* in both `experience_level` and
  `education_requirements`, under two different meanings. This is accepted so that
  `education_requirements` is populated for more Glassdoor rows. Two consequences MUST be
  understood by consumers: a consumer filtering on `education_requirements` will match experience
  prose that states no education requirement at all, and the two columns agreeing is not
  corroboration — it is one value counted twice. `experience_level` MUST NOT be changed to
  accommodate this (FR-020).
- **FR-013**: An unrecognized token in a controlled-vocabulary attribute MUST be skipped, record a
  warning naming the site and the offending value, and leave every other attribute on the row
  unaffected. It MUST NOT fail the ingest or lose the posting. Where the site stated several
  values, a recognized one still wins (FR-008b); the attribute is NULL only when *no* stated value
  was recognized.
- **FR-014**: An absent, empty, or unparseable source value MUST yield NULL without a warning where
  the site simply said nothing — matching how the shipped canonical columns treat absence.

**Per-site raw → canonical mappings**

- **FR-005a**: Source values MUST be matched on a **normalized token**: trimmed, uppercased, with
  spaces and hyphens folded to underscores (so `Full-time`, `full time`, and `FULL_TIME` are one
  token). Matching MUST NOT depend on the site's casing or punctuation. The mappings below are
  exhaustive — a token absent from them is unrecognized by definition (FR-008d) and warns.

  **`employment_type`**

  | Canonical | Accepted normalized tokens |
  |---|---|
  | `FULL_TIME` | `FULL_TIME`, `FULLTIME` |
  | `PART_TIME` | `PART_TIME`, `PARTTIME` |
  | `CONTRACT` | `CONTRACT`, `CONTRACTOR` |
  | `TEMPORARY` | `TEMPORARY`, `TEMP` |
  | `INTERNSHIP` | `INTERNSHIP`, `INTERN` |
  | `PERMANENT` | `PERMANENT` — *closed 2026-07-17; tenure axis, see FR-004a* |
  | `VOLUNTEER` | `VOLUNTEER` |
  | *(none — recognized-but-unmappable)* | `OTHER` → NULL, **no warning** (FR-008d) |

  **`workplace_type`**

  | Canonical | Accepted normalized tokens |
  |---|---|
  | `REMOTE` | `REMOTE`, `FULLY_REMOTE`, `WORK_FROM_HOME`, `URN:LI:FS_WORKPLACETYPE:2` |
  | `HYBRID` | `HYBRID`, `URN:LI:FS_WORKPLACETYPE:3` |
  | `ONSITE` | `ONSITE`, `ON_SITE`, `IN_PERSON`, `IN_OFFICE`, `URN:LI:FS_WORKPLACETYPE:1` |

  **LinkedIn sends URN enum codes, not labels** — *closed 2026-07-17*. Its live payload is a
  URN-keyed map whose values are the same URN strings:
  `{"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}`. There is no label anywhere in it.
  The normalized tokens are therefore `URN:LI:FS_WORKPLACETYPE:1` → `ONSITE`,
  `URN:LI:FS_WORKPLACETYPE:2` → `REMOTE`, `URN:LI:FS_WORKPLACETYPE:3` → `HYBRID`. The enum codes
  are **locale-proof**, which the `Remote`/`Hybrid`/`On-site` labels are not — mapping codes is
  strictly better than mapping the labels this table originally assumed.

  > `ON_SITE` is not redundant with `ONSITE`. LinkedIn's label is literally `On-site`,
  > which this rule's hyphen-folding turns into `ON_SITE` — so a table listing only
  > `ONSITE` would null **every** LinkedIn on-site posting and warn about each one,
  > manufacturing the appearance of vocabulary drift where none exists. Caught by the
  > projection unit tests during implementation; the original table contradicted this
  > requirement's own normalization rule.

  **`salary_disclosed`**

  | Site | Source | true | false | NULL |
  |---|---|---|---|---|
  | LinkedIn | employer-provided flag (boolean) | flag is true | flag is false | flag absent (FR-010c) |
  | Indeed | salary snippet source | `EMPLOYER`, **`EXTRACTION`** *(closed 2026-07-17)* | `ESTIMATE`, `ESTIMATED`, `INDEED_ESTIMATE` | absent/empty; unrecognized token → NULL + warn (FR-010b) |
  | Glassdoor | salary source | `EMPLOYER`, `EMPLOYER_PROVIDED`, `EMPLOYER_PROVIDED_SALARY` | `ESTIMATE`, `ESTIMATED`, `GLASSDOOR_ESTIMATE` | absent/empty; unrecognized token → NULL + warn (FR-010b) |

- **FR-005b**: **These mappings are reasoned, not observed.** Only one live source value is
  attested anywhere in this repository (Glassdoor `remoteWorkTypes: ["REMOTE"]`, in the 008 merge
  smoke test). Every other token above is extrapolated from the three sites' documented
  vocabularies — exactly the footing on which the shipped `salary_period` vocabulary was built, and
  exactly why unrecognized tokens warn instead of failing quietly. The warning is the mechanism by
  which the first real scan corrects this table.
- **FR-005c**: Several plausible site values are **deliberately left unrecognized** rather than
  guessed: `FREELANCE`, `PER_DIEM`, `APPRENTICESHIP`, `COMMISSION`, `NEW_GRAD`. Each has a
  defensible mapping and a defensible objection (is `FREELANCE` a `CONTRACT`?). Guessing wrong
  writes a **wrong token** that no warning ever surfaces; leaving them unrecognized writes NULL and
  warns, which is visible and correctable. They are resolved by evidence, not by argument.

  *`PERMANENT` was on this list and has been removed — the 2026-07-17 scan supplied the evidence
  and it now has its own token (FR-004a). That is this requirement working, not an exception to it.*
- **FR-005d**: ✅ **DONE — 2026-07-17.** The first scan after this feature landed MUST have its
  projection warnings reviewed, and this mapping table updated for whatever real vocabulary they
  reveal. Until that review, the five columns' population rates are unverified. This is a required
  step of the feature, not follow-up work.
- **FR-005e**: **Warning review outcome (2026-07-17 live three-site scan).** The vocabularies
  shipped *reasoned, not observed* (FR-005b), with unrecognized tokens warning so the first real
  scan would correct them. It did — all three findings are **CLOSED**:

  | # | Warning | Finding | Resolution |
  |---|---|---|---|
  | 1 | `projection_bad_value_shape` / silent NULL, LinkedIn | `workplace_types_labels` is a **URN map**, not labels. The original mapping assumed `localizedName` objects — **every LinkedIn row's `workplace_type` was NULL** | **CLOSED**: map enum codes `URN:LI:FS_WORKPLACETYPE:1/2/3` → `ONSITE`/`REMOTE`/`HYBRID` (FR-005a). Codes are locale-proof; labels are not |
  | 2 | `projection_unknown_employment_type`, Indeed | Indeed sends `"Permanent"` as a `job_types` entry | **CLOSED**: new canonical token `PERMANENT`, vocabulary 6 → 7 (FR-004, FR-004a). Tenure axis, ranked below the hours tokens |
  | 3 | `projection_unknown_salary_source`, Indeed | `salary_snippet_source` is `"EXTRACTION"` for Indeed's **entire** salary population | **CLOSED**: → `true`. Indeed parsed employer-authored prose; it estimated nothing, so FR-010a's tri-state rule ruled `false` out, and NULL would strand every Indeed salary as "provenance unknown" when it is known. `salary_disclosed` encodes provenance, not parse reliability |

  Finding 1 is why FR-005d exists: it produced **no wrong value** — only a silent absence — and
  would have shipped as "LinkedIn just doesn't report workplace type" had the review not run.
- **FR-005f**: **Known gap, not a projection defect**: `workplace_type` is NULL for **all** live
  Glassdoor rows because the scraper returns `remote_work_types` empty. The projection is correct
  to write NULL for a field the per-source row does not carry — NULL means "this site did not say",
  and per this system's data it did not. Closing it is **scraper-layer work** (the Chrome extension
  performs all scraping) and is **out of scope** here; recorded so a consumer does not read the
  absence as a canonical-projection bug.

**Population and invariants**

- **FR-015**: The five attributes MUST be populated at the same moment, and in the same atomic unit,
  as the rest of the canonical row — a canonical row MUST NOT exist with these attributes
  unpopulated pending later work.
- **FR-016**: The per-source tables MUST remain source-shaped and unnormalized. This feature MUST
  NOT add, alter, or normalize any per-source column; all normalization lands on the canonical row.
- **FR-017**: The five attributes MUST be derived from the same per-source values written to the
  per-source row in that transaction, so the canonical row and its source never disagree.

**Preserved behavior**

- **FR-018**: ✅ **VERIFIED 2026-07-17.** `GET /jobs` MUST behave exactly as it does today — same
  fields, same filtering, same ordering, same pagination. This feature MUST NOT change what existing
  readers of the canonical table see.
- **FR-018a**: **How it was verified, absent a baseline.** No pre-`031` capture existed, so the
  intended before/after diff was impossible. FR-018 was closed by two facts that together bind
  tighter than a diff:
  1. **The response shape cannot have changed.** It is defined by `ScrapedJobRead`, an explicit
     Pydantic field list, and `git diff` proves both it and `routers/jobs.py` untouched. No field
     can appear in a response whose model never gained one.
  2. **Rows that *do* carry the new columns are served without them.** With **518** rows holding a
     populated `employment_type`, both `GET /jobs/{id}` and `GET /jobs?limit=50` returned **22
     fields** with **zero** of the five present.

  Fact 2 is *stronger* than the planned diff: a before/after over pre-`031` data would only have
  compared rows whose new columns were NULL anyway, and so could not have caught a leak. This
  verifies the case the diff would have missed.
- **FR-019**: Ingest MUST behave exactly as it does today from the caller's perspective: same
  accepted payloads, same responses, same status codes, same failure modes. No posting that is
  ingested successfully today may fail because of this feature.
- **FR-020**: The existing 22 canonical columns MUST retain their current values and semantics. This
  feature is strictly additive.
- **FR-021**: The lifecycle invariants MUST continue to hold unchanged: the claim flag stays in sync
  across both rows, auto-expiration deletes both, and no canonical row outlives its per-source row.
- **FR-022**: Every existing smoke-test **assertion** MUST continue to pass unmodified. This feature
  changes no behavior any of them assert, so a failing pre-existing assertion is a real regression —
  never a test to update.
- **FR-022a**: Extending a smoke test **additively** is required, not forbidden. Constitution
  Principle II obliges permanent new behavior to be captured by a smoke test, and these five
  attributes are permanent. The distinction FR-022 draws is:
  - **Permitted** — adding new expectations and new test cases alongside the existing ones.
  - **Forbidden** — modifying, relaxing, or deleting an existing assertion to accommodate this
    feature. That is the regression signal, and it is what FR-022 exists to catch.

  The extension MUST be declared in the plan that causes it, per Principle II.
- **FR-023**: Rows ingested before this feature landed MUST be readable without error, carrying NULL
  for the five new attributes. [Backfill is out of scope — see Assumptions.]

### Key Entities

- **Canonical job row (`scraped_jobs`)**: one site-agnostic record per posting, derived from and
  atomically co-written with a per-source row. Gains five optional, **single-valued** attributes:
  two controlled vocabularies (employment type, workplace type), one tri-state flag (salary
  disclosed), one language code, and one free-text education requirement. All five match the shape
  of the 22 columns already there.
- **Per-source job row (`linkedin_jobs`, `indeed_jobs`, `glassdoor_jobs`)**: the faithful,
  site-shaped raw record. The origin of all five values and **unchanged** by this feature. It
  remains the only place a posting's *discarded* secondary arrangements survive (FR-008c).
- **Canonical vocabulary**: the fixed set of tokens an attribute may hold, shared across all three
  sites, deliberately closed — a value outside the set is skipped plus a warning, never an invented
  token.
- **Precedence order**: the fixed ranking (FR-008a) that reduces a site's several stated
  arrangements to the one canonical token, so the outcome depends on the values themselves and
  never on the order a payload happened to list them in.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a scan covering all three sites, 100% of newly created canonical rows carry
  either a canonical value or an explicit NULL for all five attributes — zero rows in an
  indeterminate state.
- **SC-002**: A consumer can select postings by employment type and salary disclosure across all
  three sites, and by workplace type across **LinkedIn and Indeed**, while reading only the
  canonical table — zero reads of any per-source table, and zero site-specific logic in the query.
- **SC-002a**: ⚠️ **Partially met — `workplace_type` does not cover Glassdoor.** Every live
  Glassdoor row carries NULL because the scraper returns `remote_work_types` empty (FR-005f), so a
  workplace filter silently excludes the entire Glassdoor corpus rather than returning it. The
  canonical projection is correct — NULL is the truthful answer for a field the per-source row does
  not carry — and the mapping is already in place, so the criterion is met the moment the scraper
  supplies the field. **It is unmet today, and this feature does not close it**: scraping is the
  Chrome extension's job (Principle: stack boundaries), and the fix is out of scope here.

  Recorded rather than quietly relaxed: SC-002 originally claimed all three sites for all three
  attributes, which the 2026-07-17 scan proved false. A criterion the system provably fails must
  say so.
- **SC-003**: Postings describing the same arrangement on different sites carry identical canonical
  tokens, verified by ingesting an equivalent full-time remote posting from each of the three sites
  and observing identical `employment_type` on all three, and identical `workplace_type` on
  LinkedIn and Indeed.

  Glassdoor's `workplace_type` is excluded from this comparison **only because its source field
  arrives empty** (SC-002a, FR-005f) — not because its mapping differs. Given a populated
  `remote_work_types`, Glassdoor yields the same token as the other two; the smoke test proves that
  against a fixture, which is why the projection needs no change when the scraper is fixed.
- **SC-003a**: Selection is deterministic: a posting stating several arrangements yields the same
  canonical token on every ingest regardless of the order the site listed them, verified by
  ingesting the same multi-tagged posting with its values in reversed order and observing an
  identical `employment_type` / `workplace_type`.
- **SC-004**: Every attribute a site does not supply is NULL in 100% of that site's rows — language
  is NULL for all LinkedIn and Glassdoor rows, education requirements NULL for all LinkedIn and
  Indeed rows.
- **SC-005**: Existing behavior is unchanged: the full smoke suite passes with no edits, and
  `GET /jobs` returns the same results for the same data as before the change.
- **SC-006**: No posting is lost to a value this feature cannot interpret: a scan containing
  unrecognized tokens ingests 100% of its postings, each unmappable attribute NULL and each
  accompanied by a warning identifying the site and the raw value.
- **SC-007**: ✅ **VERIFIED 2026-07-17 by construction** — `routers/jobs.py` is untouched (`git
  diff` empty), so the ingest path executes exactly the statements it did before. `INSERT_SCRAPED_JOB`
  gained five bind parameters, not a round trip. Ingest performs **the same number of database
  statements per posting as before** — one per-source INSERT and one canonical INSERT, unchanged. The five attributes add zero queries, zero
  round trips, and zero reads: every value is computed in memory from data the ingest already holds.
  Verified by inspecting the ingest path, not by timing — this is a claim about *structure*, which
  is checkable exactly, rather than about *duration*, which would need a benchmark harness this
  project does not have and this change does not warrant. (Previously stated as "throughput is
  materially unchanged", which named no threshold and so could not be passed or failed.)
- **SC-008**: The reasoned mapping is confirmed against reality: the first scan's projection
  warnings are reviewed, every distinct unrecognized value they name is either mapped or
  consciously left unmapped, and the mapping table records the outcome. Until this review, no claim
  about how often the five columns are populated is supported by evidence (FR-005b, FR-005d).
- **SC-009**: Warnings stay signal, not noise: a scan of postings whose sites answer normally —
  including postings whose employment status is `Other` — emits **zero** projection warnings for
  the five new attributes. Every warning emitted names a value the mapping genuinely does not
  cover.

## Assumptions

- **Scope stops at the data.** The filtering/matching service that will consume these attributes is
  explicitly **not** built here, per the feature request. This feature only guarantees the data is
  present, canonical, and readable from one table. No API surface, query parameter, or UI exposes
  the five attributes as part of this work.
- **No backfill.** Only rows ingested after this lands carry the new values; pre-existing rows keep
  NULL. Postings age out by shelf-life auto-expiration, so the table becomes fully populated on its
  own within one shelf-life without a migration touching existing rows. Should a backfill be wanted
  sooner, it is separate work.
- **Vocabularies follow the `salary_period` precedent.** The employment-type and workplace-type
  token sets are informed supersets covering the values the three sites are known to express,
  reconciled onto one spelling. As with `salary_period`, they are reasoned rather than exhaustively
  observed against live data (FR-005b), which is exactly why an unrecognized token warns instead of
  failing quietly, and why reviewing the first scan's warnings is a required step (FR-005d) rather
  than a nicety.
- **`language` is validated for shape, not membership.** Any well-formed base code is accepted;
  there is no allow-list of permitted languages, and no inference of language from description text
  (FR-011b).
- **`salary_disclosed` is about provenance, not presence.** It answers "who stated this pay figure",
  not "does this posting have pay". A posting with no salary is NULL, not false.
- **Language is recorded as the site states it**, normalized only for consistent casing/whitespace —
  no translation to a different standard and no inference from description text.
- **Education requirements stay free text.** Site education labels are not reconciled onto a
  controlled vocabulary; there is one supplying site, so there is nothing to reconcile against.
- **No new indexes.** These columns are added without indexes, consistent with the project rule
  forbidding indexes beyond primary-key/unique/foreign-key absent a demonstrated need. The
  consuming service does not exist yet, so no query has yet demonstrated one. Adding an index later
  is one migration away.

## Decisions

Three questions were settled explicitly during specification. Each carries a cost, accepted
knowingly and recorded here so it is not rediscovered later as a bug:

| # | Decision | Accepted cost |
|---|---|---|
| 1 | `employment_type` and `workplace_type` hold **one token by fixed precedence** (FR-004, FR-006, FR-008, FR-008a), not the full set of stated values. | Secondary arrangements are discarded: a Full-time/Part-time posting never answers a part-time filter, and a Remote/Hybrid posting never answers a hybrid filter. Recall on the losing token is lost outright at the canonical layer. In exchange, both columns keep the same single-valued shape as the other 22, and consumers filter by plain equality. The discarded values remain on the per-source row (FR-008c). |
| 2 | Indeed's "not remote" records **`ONSITE`** (FR-009), not NULL. | Indeed hybrid postings are silently mislabelled `ONSITE`. This is the one value in the feature the site did not actually state, and it departs from the 008 `remote` rule that absence is never asserted as a negative. Bought in exchange for on-site filters returning Indeed results at all. |
| 3 | `education_requirements` **keeps** the experience-description fallback (FR-012, FR-012a). | The same Glassdoor text lands in both `experience_level` and `education_requirements` for postings with no education labels. Education filters will match experience prose stating no education requirement. Bought in exchange for broader population. |

**Interaction worth noting**: decisions 1 and 2 compound on `workplace_type`. Precedence favours
`REMOTE`, and Indeed asserts `ONSITE` where it cannot see hybrid — so `HYBRID` is the token least
likely to be correct on any given row, and hybrid filtering is the weakest thing the canonical
column supports. If hybrid-accurate filtering is ever required, revisit decision 1 for
`workplace_type` first.

All three are reversible without touching the shipped columns, and all three trade precision or
recall for filter simplicity and coverage. Revisit them first if the future filtering service
reports poor results.
- **The source fields are all present and reachable.** Verified for this spec: all thirteen named
  source columns exist on their tables per `docs/live-per-source-schemas.md`, and all thirteen are
  already carried in the per-source values the canonical projection reads. No new extraction from
  raw payloads is required.
