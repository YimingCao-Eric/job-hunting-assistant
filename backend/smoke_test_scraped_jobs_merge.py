"""HTTP + DB smoke tests for the scraped_jobs dual-write.

    docker compose exec -T backend python smoke_test_scraped_jobs_merge.py

Covers, for all three sites:
  - dual-write: one per-source row AND one canonical row per ingest, cross-referenced
  - scrape_time copied byte-identically from the per-source row (expiration symmetry
    depends on it)
  - per-site projection of the direct-copy fields
  - re-scrape of a known job_url is a no-op in both tables
  - atomicity: a canonical write that fails takes the per-source write down with it
  - preserved rejections: unknown site and missing scan_run_id are still 400s
  - the five transforms: company (incl. Indeed's fallback), industry, remote (incl.
    Glassdoor's tri-state NULL), salary_period normalization, posted_at normalization
  - cross-site ordering: posted_at from all three sites sorts against each other
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy import text

from core.database import AsyncSessionLocal

FAILED = False


def ok(msg: str) -> None:
    print(f"[OK] {msg}")


def fail(msg: str) -> None:
    global FAILED
    FAILED = True
    print(f"[FAIL] {msg}", file=sys.stderr)


BASE = os.environ.get("SMOKE_BASE_URL", "http://localhost:8000").rstrip("/")
HEADERS = {
    "Authorization": "Bearer dev-token",
    "Content-Type": "application/json",
}

# Unique per run so repeated runs never collide on the job_url unique constraint.
TAG = uuid.uuid4().hex[:10].upper()

TABLE_FOR_SITE = {
    "linkedin": "linkedin_jobs",
    "indeed": "indeed_jobs",
    "glassdoor": "glassdoor_jobs",
}


def linkedin_payload(run_id: str, tag: str) -> dict:
    return {
        "website": "linkedin",
        "scan_run_id": run_id,
        "source_raw": {
            "data": {
                "jobPostingUrl": f"https://www.linkedin.com/jobs/view/{tag}",
                "jobPostingId": tag,
                "title": "Staff Backend Engineer",
                "formattedLocation": "Toronto, ON, Canada",
                "listedAt": 1751328000000,
                "workRemoteAllowed": True,
                # 031 filter attributes. This is LinkedIn's REAL workplace shape, taken
                # from the 2026-07-17 scan (467 rows): a URN-keyed map whose VALUES are
                # the same URN strings, with no localizedName anywhere. 2 = remote.
                #
                # The original 031 fixture guessed a localizedName resolution map and was
                # wrong -- the warning review caught it. The fixture now carries what
                # LinkedIn actually sends, so the happy path exercises the real code path
                # rather than an invented one.
                "workplaceTypesResolutionResults": {
                    "*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"
                },
                "formattedEmploymentStatus": "Full-time",
                "formattedExperienceLevel": "Mid-Senior level",
                "formattedIndustries": ["Software Development"],
                "description": {"text": "Build and operate distributed services."},
                "applyMethod": {
                    "$type": "com.linkedin.voyager.jobs.OffsiteApply",
                    "companyApplyUrl": f"https://example.com/apply/{tag}",
                },
                "salaryInsights": {
                    "compensationBreakdown": [
                        {
                            "minSalary": 150000,
                            "maxSalary": 190000,
                            "currencyCode": "CAD",
                            "payPeriod": "YEARLY",
                        }
                    ],
                    # 031: LinkedIn's boolean admits no unrecognized state.
                    "providedByEmployer": True,
                },
                "companyDetails": {"company": "urn:li:fs_normalized_company:999001"},
            },
            "included": [
                {
                    "entityUrn": "urn:li:fs_normalized_company:999001",
                    "name": "Acme Systems",
                }
            ],
        },
    }


def indeed_payload(run_id: str, tag: str) -> dict:
    return {
        "website": "indeed",
        "scan_run_id": run_id,
        "source_raw": {
            "mosaic": {
                "jobkey": tag,
                "title": "Senior Data Engineer",
                "formattedLocation": "Vancouver, BC",
                "company": "Mosaic Data Co",
                "thirdPartyApplyUrl": f"https://example.com/apply/{tag}",
                "pubDate": 1751414400000,
                "remoteLocation": False,
                "extractedSalary": {"min": 55, "max": 75, "type": "HOURLY"},
                # source "EXTRACTION" is preserved from the 008 fixture deliberately --
                # it is a shape Indeed genuinely sends, and it maps to NEITHER employer
                # nor estimate. Changing it to "EMPLOYER" would make salary_disclosed
                # look better here while hiding a real gap. See CASES below.
                "salarySnippet": {"currency": "CAD", "source": "EXTRACTION"},
                # 031: Indeed states employment type as a list.
                "jobTypes": ["Full-time"],
            },
            "graphql": {
                "description": {"text": "Own the data platform end to end."},
                "employer": {"name": "GraphQL Fallback Employer"},
                # 031: Indeed is the only site that supplies a language.
                "language": "en",
            },
        },
    }


def glassdoor_payload(run_id: str, tag: str) -> dict:
    return {
        "website": "glassdoor",
        "scan_run_id": run_id,
        "source_raw": {
            "jobListing": {
                "jobDetailsData": {
                    "listingId": tag,
                    "locationName": "Montreal, QC",
                    "employerName": "Glass Corp",
                    "payPeriod": "ANNUAL",
                    # 031. NOTE the payload split this fixture makes visible: salarySource
                    # lives here in jobDetailsData, while the salary AMOUNTS this row
                    # stores come from json_ld.baseSalary below. Two different payloads
                    # describing potentially different figures -- salary_disclosed
                    # inherits that split from 030's salary_period (also read from here).
                    "salarySource": "EMPLOYER_PROVIDED",
                },
                "jobDetailsRawData": {
                    "jobview": {
                        "header": {
                            "applyUrl": f"https://example.com/apply/{tag}",
                            # NOTE: live Glassdoor does NOT send this -- the scraper
                            # returns remoteWorkTypes empty, so every real Glassdoor row
                            # has workplace_type = NULL (spec FR-005f / SC-002a). This
                            # fixture populates it deliberately, to exercise the
                            # projection ahead of that scraper gap: the mapping is
                            # correct and will work unchanged the moment the extension
                            # supplies the field.
                            #
                            # So a green assertion here does NOT mean Glassdoor workplace
                            # filtering works in production. It means the projection is
                            # ready for when it can. Do not read this test as coverage of
                            # live behaviour -- and do not "fix" the gap here; it is
                            # scraper-layer work.
                            "remoteWorkTypes": ["REMOTE"],
                            # 031: header jobType is the FALLBACK for employment_type.
                            # json_ld employmentType (below) is present, so it wins
                            # outright and this value must be ignored entirely -- never
                            # merged. If FULL_TIME ever shows up in employment_type for
                            # this fixture, the precedence broke.
                            "jobType": ["Full-time"],
                            "indeedJobAttribute": {
                                "educationLabel": ["Bachelor's degree", "Master's degree"],
                            },
                        }
                    }
                },
            },
            "json_ld": {
                "title": "Platform Engineer",
                "datePosted": "2026-07-01",
                "description": "Design resilient platform infrastructure.",
                "industry": "Information Technology",
                "salaryCurrency": "CAD",
                "baseSalary": {"value": {"minValue": 120000, "maxValue": 160000}},
                "experienceRequirements": {"description": "5+ years backend"},
                # 031: the structured employment type. Present, so it beats the header's
                # jobType outright (PART_TIME here vs Full-time there, deliberately
                # different so "structured wins" is actually proven rather than assumed).
                "employmentType": ["PART_TIME"],
            },
        },
    }


# Fixture epoch-ms values, resolved so the expectations below are readable:
#   1751328000000 ms -> 2025-07-01T00:00:00Z  (LinkedIn listed_at)
#   1751414400000 ms -> 2025-07-02T00:00:00Z  (Indeed pub_date)
LI_POSTED_AT = datetime(2025, 7, 1, tzinfo=timezone.utc)
IN_POSTED_AT = datetime(2025, 7, 2, tzinfo=timezone.utc)
# Glassdoor's json_ld datePosted is the calendar date "2026-07-01" -> midnight UTC.
GD_POSTED_AT = datetime(2026, 7, 1, tzinfo=timezone.utc)

# site -> (payload builder, expected canonical values — direct copies AND transforms)
CASES = {
    "linkedin": (
        linkedin_payload,
        {
            "title": "Staff Backend Engineer",
            "location_text": "Toronto, ON, Canada",
            "description": "Build and operate distributed services.",
            "experience_level": "Mid-Senior level",
            "salary_min": 150000,
            "salary_max": 190000,
            "salary_currency": "CAD",
            # Transforms
            "company": "Acme Systems",
            # formattedIndustries is a jsonb list; flattened to its first entry.
            "industry": "Software Development",
            "remote": True,
            # "YEARLY" -> canonical ANNUAL
            "salary_period": "ANNUAL",
            "posted_at": LI_POSTED_AT,
            # --- 031 filter attributes ---
            # "Full-time" -> FULL_TIME
            "employment_type": "FULL_TIME",
            # Read out of the URN enum (workplaceType:2 = remote), not a label list.
            # Agrees with workRemoteAllowed here, so no conflict warning fires.
            "workplace_type": "REMOTE",
            # LinkedIn supplies neither.
            "language": None,
            "education_requirements": None,
            "salary_disclosed": True,
        },
    ),
    "indeed": (
        indeed_payload,
        {
            "title": "Senior Data Engineer",
            "location_text": "Vancouver, BC",
            "description": "Own the data platform end to end.",
            # Indeed exposes no experience level; the mapping designates NULL.
            "experience_level": None,
            "salary_min": 55,
            "salary_max": 75,
            "salary_currency": "CAD",
            # Transforms. mosaic company wins over graphql employer_name here.
            "company": "Mosaic Data Co",
            # Indeed has no industry source field at all.
            "industry": None,
            "remote": False,
            "salary_period": "HOURLY",
            "posted_at": IN_POSTED_AT,
            # --- 031 filter attributes ---
            # jobTypes ["Full-time"] -> FULL_TIME (same token LinkedIn yields)
            "employment_type": "FULL_TIME",
            # remoteLocation=False -> ONSITE. Accepted mislabel: Indeed cannot express
            # hybrid, so this asserts "not remote", not "confirmed on-site".
            "workplace_type": "ONSITE",
            # Indeed is the only site supplying a language.
            "language": "en",
            # Indeed exposes no education requirements.
            "education_requirements": None,
            # INTENTIONAL BEHAVIOR CHANGE, declared (Constitution II). This asserted
            # None while salarySnippet.source = "EXTRACTION" was unmapped; the
            # 2026-07-17 scan resolved it to True and spec.md FR-005a records the
            # decision as CLOSED.
            #
            # Indeed parsed the pay out of the job description -- employer-authored
            # prose. The tri-state rule forced the call: False means "the site estimated
            # this pay", which is plainly untrue (Indeed computed nothing), so False was
            # ruled out; None would strand Indeed's entire salary population as
            # "provenance unknown" when the provenance is known. salary_disclosed
            # encodes provenance, not parse reliability.
            #
            # The old assertion was not weakened to make code pass -- the code changed
            # first, for a recorded reason, and the assertion followed.
            "salary_disclosed": True,
        },
    ),
    "glassdoor": (
        glassdoor_payload,
        {
            "title": "Platform Engineer",
            "location_text": "Montreal, QC",
            "description": "Design resilient platform infrastructure.",
            "experience_level": "5+ years backend",
            "salary_min": 120000,
            "salary_max": 160000,
            "salary_currency": "CAD",
            # Transforms
            "company": "Glass Corp",
            "industry": "Information Technology",
            # Derived: remote_work_types is non-empty.
            "remote": True,
            "salary_period": "ANNUAL",
            "posted_at": GD_POSTED_AT,
            # --- 031 filter attributes ---
            # json_ld employmentType ["PART_TIME"] wins OUTRIGHT over the header's
            # jobType ["Full-time"]. FULL_TIME here would mean the structured field
            # stopped winning, or the two got merged -- both are bugs.
            "employment_type": "PART_TIME",
            "workplace_type": "REMOTE",
            # Glassdoor supplies no language.
            "language": None,
            # Both education labels joined in source order, none dropped.
            "education_requirements": "Bachelor's degree; Master's degree",
            "salary_disclosed": True,
        },
    ),
}


async def _get_run_id() -> str | None:
    async with AsyncSessionLocal() as db:
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
    return str(run_id) if run_id else None


async def _cleanup(tags: list[str]) -> None:
    async with AsyncSessionLocal() as db:
        for tbl in ("scraped_jobs", "linkedin_jobs", "indeed_jobs", "glassdoor_jobs"):
            for tag in tags:
                await db.execute(
                    text(f"DELETE FROM {tbl} WHERE job_url LIKE :pat"),
                    {"pat": f"%{tag}%"},
                )
        await db.commit()


async def test_dual_write_and_projection(client: httpx.AsyncClient, run_id: str) -> None:
    """Each ingest writes both rows; they agree; direct-copy fields project correctly."""
    for site, (builder, expected) in CASES.items():
        tag = f"MERGE{site[:2].upper()}{TAG}"
        per_source = TABLE_FOR_SITE[site]

        r = await client.post(
            "/jobs/ingest", headers=HEADERS, json=builder(run_id, tag)
        )
        if r.status_code != 200:
            fail(f"{site}: ingest returned {r.status_code}: {r.text[:200]}")
            continue
        body = r.json()
        if body.get("already_exists") is not False:
            fail(f"{site}: expected already_exists=false on first ingest, got {body}")
            continue

        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    text(f"""
                        SELECT s.id                                AS canonical_id,
                               s.source_site,
                               s.site_job_id,
                               s.title, s.location_text, s.description,
                               s.experience_level,
                               s.salary_min, s.salary_max, s.salary_currency,
                               s.company, s.industry, s.remote,
                               s.salary_period, s.posted_at,
                               s.employment_type, s.workplace_type, s.language,
                               s.education_requirements, s.salary_disclosed,
                               s.matched, s.dismissed,
                               (s.source_row_id = p.id)            AS row_ref_ok,
                               (s.scrape_time  = p.scrape_time)    AS scrape_time_same,
                               (s.scan_run_id  = p.scan_run_id)    AS scan_run_ok,
                               (s.job_url      = p.job_url)        AS url_ok
                          FROM scraped_jobs s
                          JOIN {per_source} p ON p.id = s.source_row_id
                         WHERE s.job_url LIKE :pat
                    """),
                    {"pat": f"%{tag}%"},
                )
            ).mappings().all()
            await db.commit()

        if len(row) != 1:
            fail(f"{site}: expected exactly 1 joined canonical row, got {len(row)}")
            continue
        c = row[0]

        if not c["row_ref_ok"]:
            fail(f"{site}: source_row_id does not reference the per-source row")
        if not c["scan_run_ok"] or not c["url_ok"]:
            fail(f"{site}: scan_run_id/job_url disagree with the per-source row")

        # The invariant auto-expiration depends on: both tables are deleted by the same
        # timestamp predicate, so a divergence here strands canonical rows at the
        # shelf-life boundary.
        if not c["scrape_time_same"]:
            fail(f"{site}: scrape_time NOT identical to the per-source row")
        else:
            ok(f"{site}: scrape_time copied byte-identically from the per-source row")

        if c["source_site"] != site:
            fail(f"{site}: source_site is {c['source_site']!r}")
        if c["site_job_id"] != tag:
            fail(f"{site}: site_job_id is {c['site_job_id']!r}, expected {tag!r}")

        for field, want in expected.items():
            got = c[field]
            # Numerics come back as Decimal, booleans/datetimes come back native.
            if (
                got is not None
                and want is not None
                and isinstance(want, (int, float))
                and not isinstance(want, bool)
            ):
                got = type(want)(got)
            if got != want:
                fail(f"{site}: {field} is {got!r}, expected {want!r}")

        if c["matched"] is not False or c["dismissed"] is not False:
            fail(f"{site}: matched/dismissed should both be false at ingest")

        ok(f"{site}: dual-write produced one per-source row + one canonical row, mapped")


async def test_filter_attribute_edge_cases(
    client: httpx.AsyncClient, run_id: str, tags: list[str]
) -> None:
    """The 031 branches the happy-path fixtures never reach.

    Every one of these renders as a perfectly plausible row when it is wrong. A
    FULL_TIME that should have been PART_TIME, or a `false` that should have been NULL,
    looks exactly like real data -- which is why they are asserted end-to-end through
    the API and the database rather than only in the unit tests.
    """
    # Precedence, through the real ingest path: a posting tagged both Full-time and
    # Part-time keeps only the higher-precedence token. The other is DISCARDED and is
    # not recoverable from the canonical row (it stays on the per-source row).
    tag = f"MULTITYPE{TAG}"
    tags.append(tag)
    payload = indeed_payload(run_id, tag)
    payload["source_raw"]["mosaic"]["jobTypes"] = ["Part-time", "Full-time"]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"multi employment type: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT s.employment_type, i.job_types "
            "FROM scraped_jobs s JOIN indeed_jobs i ON i.id = s.source_row_id "
            "WHERE s.job_url LIKE :pat",
            tag,
        )
        if row["employment_type"] != "FULL_TIME":
            fail(
                f"multi employment type: got {row['employment_type']!r}, expected "
                "FULL_TIME -- precedence must beat payload order (Part-time came first)"
            )
        else:
            ok("multi-valued employment type -> FULL_TIME by precedence, not by order")
        # The discarded value must survive on the raw row -- that is the entire escape
        # hatch the lossy canonical column depends on.
        if not row["job_types"] or "Part-time" not in row["job_types"]:
            fail("multi employment type: the discarded value was lost from the raw row")
        else:
            ok("discarded 'Part-time' still recoverable from the per-source row")

    # LinkedIn's workplace enum, end to end, in the shape the 2026-07-17 scan proved it
    # actually sends: a URN map, not labels. The happy-path case only covers code 2
    # (remote); onsite and hybrid postings are the majority of the corpus and were the
    # ones silently NULLed before the warning review caught the wrong shape.
    for code, expected, remote_allowed in (
        (1, "ONSITE", False),
        (3, "HYBRID", False),
    ):
        tag = f"URNTYPE{code}{TAG}"
        tags.append(tag)
        payload = linkedin_payload(run_id, tag)
        payload["source_raw"]["data"]["workplaceTypesResolutionResults"] = {
            f"*urn:li:fs_workplaceType:{code}": f"urn:li:fs_workplaceType:{code}"
        }
        payload["source_raw"]["data"]["workRemoteAllowed"] = remote_allowed
        r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
        if r.status_code != 200:
            fail(f"linkedin URN workplaceType:{code}: ingest returned {r.status_code}")
            continue
        got = await _scalar(
            "SELECT workplace_type FROM scraped_jobs WHERE job_url LIKE :pat", tag
        )
        if got != expected:
            fail(
                f"linkedin URN workplaceType:{code}: got {got!r}, expected {expected!r} "
                "-- the workplace enum must map from URN codes, not labels"
            )
        else:
            ok(f"linkedin URN workplaceType:{code} -> {expected} via the real payload shape")

    # 'Other' is a value LinkedIn legitimately sends. It must yield NULL *silently* --
    # a warning here would fire for every such posting forever and bury the warnings
    # that signal real vocabulary drift.
    tag = f"OTHERTYPE{TAG}"
    tags.append(tag)
    payload = linkedin_payload(run_id, tag)
    payload["source_raw"]["data"]["formattedEmploymentStatus"] = "Other"
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"'Other' employment status: ingest returned {r.status_code}")
    else:
        got = await _scalar(
            "SELECT employment_type FROM scraped_jobs WHERE job_url LIKE :pat", tag
        )
        if got is not None:
            fail(f"'Other' employment status: expected NULL, got {got!r}")
        else:
            ok("'Other' -> NULL employment_type, posting still ingested")

    # EXTRACTION is Indeed's entire live salary population, resolved to True by the
    # 2026-07-17 review. Asserted end to end alongside the amounts it describes: unlike
    # Glassdoor, Indeed's source flag and its salary figures come from the same payload,
    # so True here genuinely describes the numbers on this row.
    tag = f"EXTRACTSAL{TAG}"
    tags.append(tag)
    payload = indeed_payload(run_id, tag)
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"indeed EXTRACTION salary: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT s.salary_disclosed, s.salary_min, i.salary_snippet_source "
            "FROM scraped_jobs s JOIN indeed_jobs i ON i.id = s.source_row_id "
            "WHERE s.job_url LIKE :pat",
            tag,
        )
        if row["salary_snippet_source"] != "EXTRACTION":
            fail(f"fixture drift: expected EXTRACTION, got {row['salary_snippet_source']!r}")
        elif row["salary_disclosed"] is not True:
            fail(
                f"EXTRACTION: salary_disclosed is {row['salary_disclosed']!r}, expected "
                "True -- Indeed parsed employer-authored prose, it estimated nothing"
            )
        elif row["salary_min"] is None:
            fail("EXTRACTION: the amounts it describes are missing")
        else:
            ok("indeed EXTRACTION -> salary_disclosed True, raw source preserved")

    # An unrecognized salary source must NOT resolve to False. False claims "this site
    # estimated the pay" -- a claim an unreadable token cannot support.
    tag = f"BADSALSRC{TAG}"
    tags.append(tag)
    payload = indeed_payload(run_id, tag)
    payload["source_raw"]["mosaic"]["salarySnippet"]["source"] = "SOME_NEW_SOURCE"
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"unknown salary source: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT salary_disclosed, salary_min FROM scraped_jobs WHERE job_url LIKE :pat",
            tag,
        )
        if row["salary_disclosed"] is False:
            fail(
                "unknown salary source resolved to False -- it must be NULL; False "
                "asserts the site published an estimate it never published"
            )
        elif row["salary_disclosed"] is not None:
            fail(f"unknown salary source: expected NULL, got {row['salary_disclosed']!r}")
        elif row["salary_min"] is None:
            fail("unknown salary source: the amounts were dropped; only the flag should be")
        else:
            ok("unknown salary source -> NULL (never False), amounts retained")

    # A site that says nothing about a filter attribute yields NULL -- never a negative
    # assertion it did not make.
    tag = f"NOFILTER{TAG}"
    tags.append(tag)
    payload = linkedin_payload(run_id, tag)
    del payload["source_raw"]["data"]["formattedEmploymentStatus"]
    del payload["source_raw"]["data"]["workplaceTypesResolutionResults"]
    del payload["source_raw"]["data"]["salaryInsights"]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"silent site: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT employment_type, workplace_type, salary_disclosed "
            "FROM scraped_jobs WHERE job_url LIKE :pat",
            tag,
        )
        wrong = {k: v for k, v in row.items() if v is not None}
        if wrong:
            fail(f"silent site: expected all NULL, got {wrong!r}")
        else:
            ok("site that says nothing -> NULL, not a negative assertion")

    # Glassdoor: no education labels -> the experience prose fills the column, which
    # means education_requirements and experience_level carry IDENTICAL text. That
    # duplication is deliberate (accepted to populate education for more rows); it is
    # asserted so nobody "fixes" it without reading why.
    tag = f"EDUPROSE{TAG}"
    tags.append(tag)
    payload = glassdoor_payload(run_id, tag)
    del payload["source_raw"]["jobListing"]["jobDetailsRawData"]["jobview"]["header"][
        "indeedJobAttribute"
    ]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"education fallback: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT education_requirements, experience_level "
            "FROM scraped_jobs WHERE job_url LIKE :pat",
            tag,
        )
        if row["education_requirements"] != "5+ years backend":
            fail(
                f"education fallback: got {row['education_requirements']!r}, expected "
                "the experience prose"
            )
        elif row["education_requirements"] != row["experience_level"]:
            fail("education fallback: expected the SAME text in both columns")
        else:
            ok(
                "education falls back to experience prose, duplicating experience_level "
                "(deliberate -- FR-012a)"
            )


async def test_transform_edge_cases(client: httpx.AsyncClient, run_id: str) -> None:
    """The branches the happy-path fixtures never reach.

    Each of these is a silent failure mode: a wrong company or a false-instead-of-null
    remote renders perfectly well and looks like real data.
    """
    # Indeed company fallback: mosaic carries no company, so graphql's employer name
    # must be used. The happy-path case only proves mosaic *wins*, not that the fallback
    # exists at all.
    tag = f"FALLBACK{TAG}"
    payload = indeed_payload(run_id, tag)
    del payload["source_raw"]["mosaic"]["company"]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"indeed fallback: ingest returned {r.status_code}")
    else:
        got = await _scalar(
            "SELECT company FROM scraped_jobs WHERE job_url LIKE :pat", tag
        )
        if got != "GraphQL Fallback Employer":
            fail(f"indeed company fallback: got {got!r}, expected the graphql employer")
        else:
            ok("indeed: company falls back to graphql employer_name when mosaic has none")

    # Glassdoor remote when the site says nothing: must be NULL, never False. NULL means
    # "unknown"; False would assert the posting is not remote, which the site never said.
    tag = f"NOREMOTE{TAG}"
    payload = glassdoor_payload(run_id, tag)
    del payload["source_raw"]["jobListing"]["jobDetailsRawData"]["jobview"]["header"][
        "remoteWorkTypes"
    ]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"glassdoor no-remote: ingest returned {r.status_code}")
    else:
        got = await _scalar(
            "SELECT remote FROM scraped_jobs WHERE job_url LIKE :pat", tag
        )
        if got is not None:
            fail(
                f"glassdoor remote with no remote_work_types: got {got!r}, expected None "
                "(absent means the site didn't say, not 'not remote')"
            )
        else:
            ok("glassdoor: remote is NULL (not False) when the site says nothing")

    # An unrecognized period must keep the amounts and drop only the period.
    tag = f"BADPERIOD{TAG}"
    payload = indeed_payload(run_id, tag)
    payload["source_raw"]["mosaic"]["extractedSalary"]["type"] = "FORTNIGHTLY"
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"unknown period: ingest returned {r.status_code}")
    else:
        row = await _row(
            "SELECT salary_period, salary_min FROM scraped_jobs WHERE job_url LIKE :pat",
            tag,
        )
        if row["salary_period"] is not None:
            fail(f"unknown period: expected NULL, got {row['salary_period']!r}")
        elif row["salary_min"] is None:
            fail("unknown period: amounts were dropped; only the period should be")
        else:
            ok("unknown period -> NULL period, amounts retained")

    # A posting with no salary at all must still produce a row (FR-017).
    tag = f"NOSALARY{TAG}"
    payload = linkedin_payload(run_id, tag)
    del payload["source_raw"]["data"]["salaryInsights"]
    r = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    if r.status_code != 200:
        fail(f"no salary: ingest returned {r.status_code}; an absent field must not fail")
    else:
        row = await _row(
            "SELECT salary_min, title FROM scraped_jobs WHERE job_url LIKE :pat", tag
        )
        if row is None or row["title"] is None:
            fail("no salary: row missing or unmapped; absent fields must not fail ingest")
        elif row["salary_min"] is not None:
            fail(f"no salary: expected NULL salary_min, got {row['salary_min']!r}")
        else:
            ok("posting with no salary still creates a row (absent != failure)")


async def _scalar(sql: str, tag: str):
    async with AsyncSessionLocal() as db:
        v = (await db.execute(text(sql), {"pat": f"%{tag}%"})).scalar()
        await db.commit()
    return v


async def _row(sql: str, tag: str):
    async with AsyncSessionLocal() as db:
        r = (await db.execute(text(sql), {"pat": f"%{tag}%"})).mappings().first()
        await db.commit()
    return r


async def test_cross_site_ordering(client: httpx.AsyncClient, run_id: str) -> None:
    """SC-004: posted_at from all three sites sorts correctly against each other.

    This is the payoff of normalizing epoch-ms and calendar dates onto one representation.
    Deferred here from the read-path phase, where posted_at did not yet exist.
    """
    # Scoped to this run's tag: a leftover MERGE row from an earlier failed run would
    # otherwise make the ordering assertion nondeterministic.
    rows = await _rows_all(
        """
        SELECT source_site, posted_at
          FROM scraped_jobs
         WHERE posted_at IS NOT NULL AND job_url LIKE :pat
         ORDER BY posted_at DESC
        """,
        {"pat": f"%MERGE%{TAG}%"},
    )
    if len(rows) != 3:
        fail(f"cross-site ordering: expected 3 dated rows, got {len(rows)}")
        return

    sites = [r["source_site"] for r in rows]
    # Fixture dates: glassdoor 2026-07-01 > indeed 2025-07-02 > linkedin 2025-07-01.
    # A 1970 value would mean seconds/milliseconds confusion; clustering by site would
    # mean a per-site scale error.
    if sites != ["glassdoor", "indeed", "linkedin"]:
        fail(
            f"cross-site ordering: got {sites}, expected "
            "['glassdoor', 'indeed', 'linkedin'] by posted_at DESC"
        )
        return
    if any(r["posted_at"].year < 2000 for r in rows):
        fail(f"cross-site ordering: a 1970-era date means ms/s confusion: {rows}")
        return
    ok(f"SC-004: posted_at from all three sites sorts correctly ({sites})")


async def _rows_all(sql: str, params: dict | None = None):
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text(sql), params or {})).mappings().all()
        await db.commit()
    return rows


async def test_rescrape_is_noop(client: httpx.AsyncClient, run_id: str) -> None:
    """A second ingest of a known job_url creates no duplicate in either table."""
    tag = f"RESCRAPE{TAG}"
    payload = linkedin_payload(run_id, tag)

    first = await client.post("/jobs/ingest", headers=HEADERS, json=payload)
    second = await client.post("/jobs/ingest", headers=HEADERS, json=payload)

    if first.status_code != 200 or second.status_code != 200:
        fail(f"re-scrape: HTTP {first.status_code}/{second.status_code}")
        return
    if second.json().get("already_exists") is not True:
        fail(f"re-scrape: expected already_exists=true, got {second.json()}")
        return
    if first.json().get("id") != second.json().get("id"):
        fail("re-scrape: returned a different id on the second ingest")
        return

    async with AsyncSessionLocal() as db:
        counts = (
            await db.execute(
                text("""
                    SELECT (SELECT count(*) FROM scraped_jobs  WHERE job_url LIKE :pat) AS canonical,
                           (SELECT count(*) FROM linkedin_jobs WHERE job_url LIKE :pat) AS per_source
                """),
                {"pat": f"%{tag}%"},
            )
        ).mappings().one()
        await db.commit()

    if counts["canonical"] != 1 or counts["per_source"] != 1:
        fail(f"re-scrape: expected 1 row per table, got {dict(counts)}")
        return
    ok("re-scrape: already_exists=true, no duplicate in either table")


async def test_atomicity(client: httpx.AsyncClient, run_id: str) -> None:
    """A failing canonical write must roll the per-source write back with it.

    Fault injection: a temporary CHECK constraint that only the canonical INSERT can
    violate. The per-source insert is untouched by it, so if the two writes were not
    sharing a transaction the per-source row would survive -- which is exactly the
    defect this asserts against.
    """
    tag = f"ATOMIC{TAG}"
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "ALTER TABLE scraped_jobs ADD CONSTRAINT tmp_atomicity_probe "
                "CHECK (site_job_id <> :tag)".replace(":tag", f"'{tag}'")
            )
        )
        await db.commit()

    try:
        r = await client.post(
            "/jobs/ingest", headers=HEADERS, json=linkedin_payload(run_id, tag)
        )
        if r.status_code < 400:
            fail(f"atomicity: ingest should have failed, got HTTP {r.status_code}")
            return

        async with AsyncSessionLocal() as db:
            counts = (
                await db.execute(
                    text("""
                        SELECT (SELECT count(*) FROM linkedin_jobs WHERE job_url LIKE :pat) AS per_source,
                               (SELECT count(*) FROM scraped_jobs  WHERE job_url LIKE :pat) AS canonical
                    """),
                    {"pat": f"%{tag}%"},
                )
            ).mappings().one()
            await db.commit()

        if counts["per_source"] != 0:
            fail(
                "atomicity: per-source row SURVIVED a failed canonical write "
                f"({dict(counts)}) -- the two writes are not in one transaction"
            )
            return
        if counts["canonical"] != 0:
            fail(f"atomicity: canonical row present after failure ({dict(counts)})")
            return
        ok("atomicity: failed canonical write rolled the per-source write back")
    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("ALTER TABLE scraped_jobs DROP CONSTRAINT IF EXISTS tmp_atomicity_probe")
            )
            await db.commit()


async def test_preserved_rejections(client: httpx.AsyncClient, run_id: str) -> None:
    """Unknown site and missing scan_run_id are still 400s, writing to neither store.

    These are unchanged behaviors, but they live in the branch immediately beside the
    legacy path that was removed, so a regression here would otherwise be silent.
    """
    bad_site = linkedin_payload(run_id, f"BADSITE{TAG}")
    bad_site["website"] = "monster"
    r = await client.post("/jobs/ingest", headers=HEADERS, json=bad_site)
    if r.status_code != 400:
        fail(f"unknown site: expected 400, got {r.status_code}")
    else:
        ok("unknown site rejected with 400")

    no_run = linkedin_payload(run_id, f"NORUN{TAG}")
    no_run["scan_run_id"] = None
    r = await client.post("/jobs/ingest", headers=HEADERS, json=no_run)
    if r.status_code != 400:
        fail(f"missing scan_run_id: expected 400, got {r.status_code}")
    else:
        ok("missing scan_run_id rejected with 400")

    no_raw = {"website": "linkedin", "scan_run_id": run_id, "job_title": "Legacy"}
    r = await client.post("/jobs/ingest", headers=HEADERS, json=no_raw)
    if r.status_code != 400:
        fail(f"missing source_raw: expected 400, got {r.status_code}")
    else:
        ok("missing source_raw rejected with 400 (legacy fallback removed)")


async def test_skip_reason_is_noop(client: httpx.AsyncClient, run_id: str) -> None:
    """skip_reason is accepted and discarded: 200, and no row anywhere."""
    before = await _count_all()
    r = await client.post(
        "/jobs/ingest",
        headers=HEADERS,
        json={
            "website": "linkedin",
            "scan_run_id": run_id,
            "job_title": "Skipped Card",
            "job_url": None,
            "skip_reason": "jd_failed",
        },
    )
    if r.status_code != 200:
        fail(
            f"skip_reason: expected 200 no-op, got {r.status_code}. Rejecting costs the "
            "extension ~6s of retry backoff per skipped card."
        )
        return
    if r.json().get("skip_reason") != "jd_failed":
        fail(f"skip_reason: response should echo the reason, got {r.json()}")
        return

    after = await _count_all()
    if after != before:
        fail(f"skip_reason: wrote rows ({before} -> {after}); it must record nothing")
        return
    ok("skip_reason: 200 no-op, recorded nothing")


async def _count_all() -> dict:
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                text("""
                    SELECT (SELECT count(*) FROM scraped_jobs)   AS canonical,
                           (SELECT count(*) FROM linkedin_jobs)  AS linkedin,
                           (SELECT count(*) FROM indeed_jobs)    AS indeed,
                           (SELECT count(*) FROM glassdoor_jobs) AS glassdoor
                """)
            )
        ).mappings().one()
        await db.commit()
    return dict(row)


async def main() -> None:
    run_id = await _get_run_id()
    if run_id is None:
        print("[SKIP] need an extension_run_logs row for the scan_run_id FK")
        return

    tags = [
        f"MERGE{s[:2].upper()}{TAG}" for s in CASES
    ] + [
        f"RESCRAPE{TAG}", f"ATOMIC{TAG}", f"BADSITE{TAG}", f"NORUN{TAG}",
        f"FALLBACK{TAG}", f"NOREMOTE{TAG}", f"BADPERIOD{TAG}", f"NOSALARY{TAG}",
    ]

    async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as client:
        try:
            await test_dual_write_and_projection(client, run_id)
            # Depends on the MERGE* rows the projection test just created.
            await test_cross_site_ordering(client, run_id)
            await test_filter_attribute_edge_cases(client, run_id, tags)
            await test_transform_edge_cases(client, run_id)
            await test_rescrape_is_noop(client, run_id)
            await test_atomicity(client, run_id)
            await test_preserved_rejections(client, run_id)
            await test_skip_reason_is_noop(client, run_id)
        finally:
            await _cleanup(tags)

    if FAILED:
        print("\n[FAIL] scraped_jobs merge smoke tests FAILED", file=sys.stderr)
        sys.exit(1)
    print("\n[OK] all scraped_jobs merge smoke tests passed")


if __name__ == "__main__":
    asyncio.run(main())
