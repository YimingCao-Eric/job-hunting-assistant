# Phase 1 Data Model: Canonical Filter Columns on `scraped_jobs`

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Entity changes only. `scraped_jobs` goes from 22 → **27 columns**. No other entity changes; the
per-source tables are untouched (FR-016).

---

## Entity: `scraped_jobs` (derived) — five added attributes

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `employment_type` | `varchar(16)` | YES | *(none)* | One canonical arrangement token, or NULL |
| `workplace_type` | `varchar(16)` | YES | *(none)* | One canonical workplace token, or NULL |
| `language` | `varchar(8)` | YES | *(none)* | Bare lowercase base language code |
| `education_requirements` | `text` | YES | *(none)* | Free text; `"; "`-joined labels or prose |
| `salary_disclosed` | `boolean` | YES | *(none)* | Tri-state provenance of the salary figures |

**No column has a server default.** A default would manufacture the third state FR-002 forbids: the
absence of a value must read as NULL, not as a fabricated token.

### Added DDL (migration `031`, chained off `030`)

```sql
ALTER TABLE scraped_jobs
    ADD COLUMN employment_type        varchar(16),
    ADD COLUMN workplace_type         varchar(16),
    ADD COLUMN language               varchar(8),
    ADD COLUMN education_requirements text,
    ADD COLUMN salary_disclosed       boolean;
-- No indexes: CC-12 forbids speculative indexes absent a demonstrated need,
-- and the consuming service does not exist yet.
-- No DEFAULT: nullable-without-default is metadata-only in modern Postgres
-- (no rewrite, no long lock) and preserves NULL as "the site did not say".
```

Resulting table: 27 columns, still exactly **three** indexes (PK, `UNIQUE (job_url)`,
`ix_scraped_jobs_scan_run_id`).

---

## Validation rules

Derived from the spec; enforced in the **projection**, not the database (research.md R1 — a CHECK or
ENUM would turn "our vocabulary is incomplete" into "ingest is down", contradicting FR-013).

| Attribute | Rule | Source |
|---|---|---|
| `employment_type` | ∈ {`FULL_TIME`, `PART_TIME`, `CONTRACT`, `TEMPORARY`, `INTERNSHIP`, `PERMANENT`, `VOLUNTEER`} or NULL — **seven** tokens | FR-004, FR-004a |
| `workplace_type` | ∈ {`REMOTE`, `HYBRID`, `ONSITE`} or NULL | FR-006 |
| `language` | Bare lowercase base code (`en-US` → `en`); shape-validated, not membership-validated | FR-011a, FR-011b |
| `education_requirements` | Any text; **never** validated, **never** warns | FR-012c |
| `salary_disclosed` | `true` / `false` / NULL — each reached only by positive evidence | FR-010a |
| *all five* | Exactly one value or NULL; no empty string, no placeholder | FR-002 |

### Value classification (applies to the two vocabularies)

Every source value is exactly one of three kinds (FR-008d). **Order of operations is fixed**:
classify first, then rank by precedence (FR-008b).

1. **Mappable** → competes for the column by precedence.
2. **Recognized-but-unmappable** → `OTHER` only. Skipped. **Never warns.** Column is NULL if it was
   the only value stated.
3. **Unrecognized** → skipped, **warns**. Column is NULL only if *no* stated value was recognized.

### Precedence (FR-008a) — applied to mappable values only

- `employment_type`: `FULL_TIME` › `PART_TIME` › `CONTRACT` › `TEMPORARY` › `INTERNSHIP` ›
  `PERMANENT` › `VOLUNTEER` — `PERMANENT` sits below every hours token deliberately (FR-004a): it
  answers *tenure*, not hours, so `["Full-time","Permanent"]` yields `FULL_TIME` and `PERMANENT`
  surfaces only as the sole signal
- `workplace_type`: `REMOTE` › `HYBRID` › `ONSITE`

Selection is over a **set**, never a sequence: the same values in any payload order yield the same
token (FR-008, SC-003a).

---

## Projection rules (per site)

Input is the per-source **params dict** — the output of `build_*_params`, not `source_raw`. All 13
source fields are already present in those dicts (verified); no new extraction is required.

Token matching is on the **normalized token**: `strip().upper()`, then spaces and hyphens → `_`
(FR-005a).

### `employment_type`

| Site | Source key | Shape | Notes |
|---|---|---|---|
| LinkedIn | `formatted_employment_status` | `varchar(32)` | Single value |
| Indeed | `job_types` | jsonb list | Precedence over mappable entries |
| Glassdoor | `employment_type` → else `job_type` | jsonb lists | **Structured wins outright**; when present, `job_type` is ignored entirely — including when the structured value is `OTHER` (FR-005, FR-008d) |

> **Naming collision** (checklist CHK005): Glassdoor's *per-source* column is also named
> `employment_type`. In `_glassdoor_projection`, `p.get("employment_type")` is the **per-source
> jsonb list**, while the returned `"employment_type"` key is the **canonical token**. Same word,
> two meanings, one function. Worth a comment at the call site.

**Glassdoor fallback trigger** (checklist CHK017 — the spec left "absent" undefined): the fallback to
`job_type` fires when the structured field is NULL **or an empty list**. An empty list is absence
(spec Edge Cases: "empty-but-present list … is absence, not a value"), so it must not suppress the
fallback. A structured field holding only `OTHER` is *present*, so it does **not** fall back — it
yields NULL.

### `workplace_type`

| Site | Source key | Shape | Notes |
|---|---|---|---|
| LinkedIn | `workplace_types_labels` | **URN map** *(as built)* | `{"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}` — a self-referential URN map, **not** labels. Codes **1=ONSITE, 2=REMOTE, 3=HYBRID**. Wins over `work_remote_allowed`; warn on contradiction (FR-009b) |
| Indeed | `remote_location` | boolean | `true` → `REMOTE`; `false` → `ONSITE`; NULL → NULL (FR-009) |
| Glassdoor | `remote_work_types` | jsonb list | Precedence over mappable entries. **Empty on every live row** — the scraper does not supply it, so live Glassdoor `workplace_type` is always NULL (FR-005f, SC-002a). Mapping is correct and needs no change when the scraper is fixed |

> **[as-built]** This table originally specified LinkedIn as a jsonb list of labels
> (`Remote`/`Hybrid`/`On-site`). The 2026-07-17 warning review proved otherwise: LinkedIn sends URN
> enum codes with no label anywhere, so the label mapping NULLed **every** LinkedIn row — silently,
> since a shape it could not read produced no token and no warning. Mapping the codes is also
> strictly better: URNs are locale-proof, labels are not. See FR-005e finding 1.

### `language`

| Site | Source key | Rule |
|---|---|---|
| Indeed | `language` | Lowercase, trim, drop region subtag (`en_US`/`en-US` → `en`) |
| LinkedIn, Glassdoor | *(none)* | NULL — neither site supplies it (FR-011) |

### `education_requirements`

| Site | Source key | Rule |
|---|---|---|
| Glassdoor | `education_labels` → else `experience_requirements_description` | Join all non-blank labels with `"; "` in source order; all-blank list → absent → fallback |
| LinkedIn, Indeed | *(none)* | NULL (FR-012) |

> **Known duplication** (FR-012a): when the fallback fires, this column holds the *same text* as
> `experience_level`, which already projects `experience_requirements_description` for Glassdoor.
> Accepted deliberately; `experience_level` must not change (FR-020).

### `salary_disclosed`

| Site | Source key | `true` | `false` | NULL |
|---|---|---|---|---|
| LinkedIn | `salary_provided_by_employer` (boolean) | `true` | `false` | absent (FR-010c) |
| Indeed | `salary_snippet_source` | `EMPLOYER`, **`EXTRACTION`** *(as built)* | `ESTIMATE`, `ESTIMATED`, `INDEED_ESTIMATE` | absent/empty; unrecognized → NULL **+ warn** |
| Glassdoor | `salary_source` | `EMPLOYER`, `EMPLOYER_PROVIDED`, `EMPLOYER_PROVIDED_SALARY` | `ESTIMATE`, `ESTIMATED`, `GLASSDOOR_ESTIMATE` | absent/empty; unrecognized → NULL **+ warn** |

> **Known limitation, Glassdoor** (research.md R2 — verified): `salary_source` comes from
> `jobDetailsData`, while the row's `salary_min`/`max` come from the employer's JSON-LD `baseSalary`.
> The flag describes a *potentially different figure* than the amounts beside it. Inherited from 008
> (`salary_period` has the same split), implemented as specified, documented — not fixed here.
>
> **[as-built] `EXTRACTION` → `true`** (FR-005e finding 3). Indeed's *entire* live salary population
> arrives with `salary_snippet_source = "EXTRACTION"` — Indeed parsed the pay out of the job
> description, i.e. employer-authored prose. FR-010a's tri-state rule decided it: `false` claims
> "the site estimated this pay", which is untrue (Indeed computed nothing), so `false` was ruled
> out; NULL would strand every Indeed salary as "provenance unknown" when the provenance is known.
> The column encodes **provenance, not parse reliability**.

---

## State transitions

**None added.** The five attributes are write-once at ingest and never mutate. The permitted
mutations on `scraped_jobs` remain exactly three (Principle V): `matched` false→true, `dismissed`
set by the user, auto-expiration DELETE.

**Re-scrape** (checklist CHK040 — verified, needs no new rule): the canonical INSERT is
`ON CONFLICT (job_url) DO NOTHING` (`jobs.py:340`), so re-ingesting a known URL is a no-op. The five
attributes on an existing row are **never recomputed**. A posting whose site later corrects its
employment type keeps the original value until the row expires and is re-scraped fresh.

---

## Lifecycle & invariants (all unchanged)

- Written in the **same atomic dual-write** as the rest of the canonical row — same transaction, same
  params dict, same `INSERT` (FR-015, FR-017). Nothing new to coordinate.
- Projected from the **params dict**, so the canonical row and its per-source row can never disagree
  about what the site said.
- Per-source tables stay source-shaped; all five transforms land on the derived row (CC-10, CC-11).
- No change to expiration, claim, or dismissal.

## Backward compatibility

- **Existing rows**: keep NULL for all five (FR-023). Readable, never rewritten, no backfill.
- **NULL is overloaded** for one shelf-life — "site didn't say" vs "row predates `031`" (research.md
  R3). Disambiguate with `scrape_time >= <031 deploy time>`; self-heals as rows age out.
- **`GET /jobs` response is byte-identical**: `ScrapedJobRead` is deliberately not extended
  (`schemas/scraped_job.py:43`). The columns exist in the table and the ORM but reach no API.
