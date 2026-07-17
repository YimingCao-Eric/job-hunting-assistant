# Contract: The Five Canonical Filter Columns

**Feature**: [spec.md](../spec.md) | **Data model**: [data-model.md](../data-model.md)
**Audience**: authors of the future filtering/matching service — the consumer this feature exists to serve.
**Status**: contract of `scraped_jobs` as of migration `031`.

This feature ships **no HTTP interface**. `GET /jobs` is unchanged and does not expose these
columns (`ScrapedJobRead` is deliberately not extended). The interface being published here is the
**table itself**: read `scraped_jobs`, join nothing.

That makes this document the deliverable. Everything below is a promise you can rely on, or a
caveat you must not ignore.

---

## What you can rely on

1. **Read `scraped_jobs` alone.** All five attributes are site-agnostic and populated at ingest.
   You never need `linkedin_jobs` / `indeed_jobs` / `glassdoor_jobs` to filter on them.
2. **Plain equality works.** Every column is single-valued. `WHERE employment_type = 'FULL_TIME'`
   is the whole query — no set membership, no `LIKE`, no per-site branch.
3. **Closed vocabularies.**
   - `employment_type` ∈ `FULL_TIME` | `PART_TIME` | `CONTRACT` | `TEMPORARY` | `INTERNSHIP` | **`PERMANENT`** | `VOLUNTEER` | NULL — **seven** tokens
   - `workplace_type` ∈ `REMOTE` | `HYBRID` | `ONSITE` | NULL
   A value outside these sets is never written. Ever.

   **`PERMANENT` answers a different question than the other six.** It is a *tenure* statement, not
   an hours statement — a permanent part-time job exists. It is never inferred: it appears only
   when a site states permanence **and says nothing about hours**. A posting tagged both
   (`["Full-time", "Permanent"]`, Indeed's common pairing) reads `FULL_TIME`, because hours outrank
   tenure in precedence. So `employment_type = 'PERMANENT'` does **not** mean "not full-time" — it
   means "the site told us the tenure and not the hours". If you are filtering for full-time work,
   `PERMANENT` rows are *unknown hours*, not exclusions.
4. **Same job, same token, any site.** A full-time remote posting reads `FULL_TIME` / `REMOTE`
   whether it came from LinkedIn, Indeed, or Glassdoor.
5. **Values never change under you.** These attributes are write-once at ingest. Re-scraping a known
   `job_url` is a no-op (`ON CONFLICT DO NOTHING`), so a row's five values are fixed for its
   lifetime.
6. **NULL always means "no value", never "0" or "false".** No column has a server default.

---

## What you must NOT assume

### 1. NULL is not "no". It is "we don't know".

`employment_type IS NULL` does **not** mean the job isn't full-time. It means the site didn't say,
*or* said something we couldn't map, *or* said `Other`. A strict filter (`= 'FULL_TIME'`) is
correct. An exclusion filter (`!= 'PART_TIME'`) silently drops every NULL row — usually not what you
want. Reach for `IS DISTINCT FROM` deliberately, not by accident.

### 2. `workplace_type` is NOT a refinement of `remote`. Never mix them. (FR-009c)

They disagree by design, differently on each site:

| Site | `remote` reads | `workplace_type` reads | How they diverge |
|---|---|---|---|
| LinkedIn | `work_remote_allowed` (boolean) | `workplace_types_labels` (list) | **Different source fields.** Can flatly contradict; labels win for `workplace_type`, `remote` is left as-is |
| Indeed | `remote_location` | `remote_location` | Same field — consistent |
| Glassdoor | `remote_work_types` non-empty → `true` | `remote_work_types` mapped | A **hybrid-only** posting is `remote = true` **and** `workplace_type = HYBRID` |

Pick one column per filter and stay there. `WHERE remote = true AND workplace_type = 'REMOTE'` is
not redundant — it is a third, narrower population than either predicate alone.

### 3. `workplace_type = 'ONSITE'` on an **Indeed** row means only "not remote". (FR-009)

Indeed cannot express hybrid. Every non-remote Indeed posting is recorded `ONSITE`, so Indeed
hybrid postings are mislabelled. This is the one value in the table asserting more than the site
said. Treat Indeed `ONSITE` as "not remote", never as confirmed on-site.

### 4. `salary_disclosed` on **Glassdoor** may describe a different figure than the row's salary. (research.md R2)

Glassdoor's `salary_source` comes from `jobDetailsData`; the row's `salary_min`/`salary_max` come
from the employer's JSON-LD. They are two payloads describing potentially different numbers. The
flag is trustworthy about Glassdoor's own figure — which may not be the one beside it. Inherited
from feature 008 (`salary_period` has the same split), not introduced here.

For LinkedIn and Indeed, `salary_disclosed` describes the row's own amounts and is sound.

**Indeed's `true` means "the employer wrote the pay, in prose"** — its entire salary population
arrives as `salarySnippet.source = "EXTRACTION"`, meaning Indeed parsed the figure out of the job
description. That is employer-authored, so it is `true`: the column encodes **provenance, not parse
reliability**. It does not promise the number was scraped correctly, only that the employer — not
Indeed — is the one who stated it.

### 5. `salary_disclosed = true` does not guarantee amounts exist.

The flag is about **provenance**, not presence. Check `salary_min IS NOT NULL` separately.

### 6. `education_requirements` may be identical to `experience_level`. (FR-012a)

When a Glassdoor posting has no education labels, this column falls back to the same experience
prose `experience_level` already carries. The two agreeing is **not corroboration** — it is one
value counted twice, and the text may state no education requirement at all. Filtering education on
free-text prose will produce false matches.

### 7. Multi-valued postings are lossy. (FR-008c)

A posting tagged both `Full-time` and `Part-time` stores only `FULL_TIME` (precedence:
`FULL_TIME` › `PART_TIME` › `CONTRACT` › `TEMPORARY` › `INTERNSHIP` › `PERMANENT` › `VOLUNTEER`;
workplace: `REMOTE` › `HYBRID` › `ONSITE`). It will **not** answer a part-time filter. The discarded
values survive only on the per-source row — follow `source_row_id`, keyed by `source_site`.

Practical consequence: `HYBRID` is the least reliable token in the table. Precedence prefers
`REMOTE` over it, and Indeed asserts `ONSITE` where it cannot see hybrid. Do not build a
hybrid-accurate product on this column without revisiting the spec's Decisions §1.

### 8. NULL is temporarily ambiguous for old rows. (research.md R3)

Rows ingested before `031` carry NULL for all five — indistinguishable from "the site didn't say".
Filter `scrape_time >= <031 deploy time>` if you need certainty. Self-heals within one shelf-life as
old rows expire.

### 9. Coverage is uneven by construction.

`language` is Indeed-only. `education_requirements` is Glassdoor-only. Both are NULL for every row
from the other two sites — that is correct behavior, not missing data. A filter on either silently
restricts you to one site.

### 10. `workplace_type` is NULL on **every live Glassdoor row** — today.

Not by design, and not a projection bug: the scraper returns `remote_work_types` empty, so there is
nothing to map and NULL is the truthful answer. The mapping exists and works — the moment the
extension supplies the field, Glassdoor populates with no change here.

**What this means for you right now**: any `workplace_type` filter silently excludes the entire
Glassdoor corpus. Not "returns Glassdoor rows that don't match" — excludes them, because NULL
matches no equality predicate. If your result set needs Glassdoor coverage, either avoid filtering
on `workplace_type` or `OR workplace_type IS NULL` deliberately, knowing you are then including
every LinkedIn/Indeed posting whose site was silent too.

Tracked as FR-005f / SC-002a. Fixing it is scraper-layer work.

---

## Column reference

| Column | Type | Populated for | NULL when |
|---|---|---|---|
| `employment_type` | `varchar(16)` | all three sites | site silent; only `Other`; nothing recognized |
| `workplace_type` | `varchar(16)` | **LinkedIn + Indeed only** *(today)* | site silent; nothing recognized; **every live Glassdoor row** — see §10 |
| `language` | `varchar(8)` | **Indeed only** | LinkedIn/Glassdoor rows; absent; unparseable |
| `education_requirements` | `text` | **Glassdoor only** | LinkedIn/Indeed rows; no labels and no experience prose |
| `salary_disclosed` | `boolean` | all three sites | source absent/unrecognized; no salary quoted |

## Indexes

**None on these columns**, by design (CC-12 — no speculative indexes absent demonstrated need). The
table has exactly three indexes: PK, `UNIQUE (job_url)`, `ix_scraped_jobs_scan_run_id`.

If your query is slow, that is the demonstrated need the rule was waiting for. Bring the
measurement; an index is one migration away.

## Stability

Additive-only, per Principle VII's forward-compatibility rule. Expect new columns; do not expect
these to be repurposed or removed. **The two vocabularies may gain tokens** — FR-005b/FR-005d admit
the mapping shipped reasoned rather than observed, to be corrected from live scan warnings. Treat
both vocabularies as closed-but-growing: match known tokens, and do not assume the current sets are
final.

**This has already happened once.** The 2026-07-17 warning review (FR-005e) closed three gaps
against live data:

| Change | Consumer impact |
|---|---|
| `employment_type` gained **`PERMANENT`** (6 → 7 tokens) | An exhaustive match written against the original six now has an unhandled case |
| LinkedIn `workplace_type` now maps from **URN enum codes**, not labels (the original mapping assumed labels and NULLed every LinkedIn row) | LinkedIn `workplace_type` went from always-NULL to populated — a filter that "worked" before was returning nothing |
| Indeed `salary_disclosed` resolves **`EXTRACTION` → `true`** | Indeed's entire salary population flipped from NULL to `true` |

Take the warning seriously: **do not write an exhaustive enum over these vocabularies without a
default branch.** Handle unknown tokens as "unrecognized", not as an error — the next scan may add
one.
