"""Per-site projection: per-source row -> canonical scraped_jobs row.

Pure functions. No ORM, no HTTP, no I/O — callable from a unit test without a database.

**Input is the per-source params dict**, i.e. what `build_linkedin_params` /
`build_indeed_params` / `build_glassdoor_params` in `routers/jobs.py` already produce — not
the raw `source_raw` payload. Those builders have already done the messy extraction
(entity resolution, mosaic-vs-graphql precedence, type coercion). Re-parsing `source_raw`
here would duplicate that logic and create two sources of truth that drift. The canonical
row is a projection *of the per-source row*, so it is derived from the same values that row
is written with.

Field lineage per site is defined by docs/live-per-source-schemas.md, which is authoritative.

Most canonical fields are a direct copy of a per-source value. Five need real transforms,
and each is a place a silent error can hide:

  - company        Indeed only: mosaic's company wins, graphql's employer name is the
                   fallback. LinkedIn and Glassdoor are direct copies.
  - industry       LinkedIn flattens a jsonb list to its first entry; Indeed has no source
                   field at all; Glassdoor is a direct copy.
  - remote         Tri-state. Glassdoor has no boolean and is derived from a structured
                   list; absent means "the site didn't say", not "not remote".
  - salary_period  Normalized onto one five-value vocabulary; amounts are never converted.
  - posted_at      Unified from epoch-ms (LinkedIn, Indeed) and a calendar date
                   (Glassdoor) onto one UTC representation.

An absent or unmappable source value yields None rather than failing the ingest, so a
posting is never lost over a field the canonical shape allows to be empty.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timezone
from typing import Any

logger = logging.getLogger(__name__)

# The canonical pay-period vocabulary: exactly these five values, or NULL.
HOURLY = "HOURLY"
DAILY = "DAILY"
WEEKLY = "WEEKLY"
MONTHLY = "MONTHLY"
ANNUAL = "ANNUAL"

# Source spellings -> canonical period. The three sites use different vocabularies for
# the same period (YEARLY / YEAR / ANNUAL all mean the same thing), so normalize on the
# uppercased token.
#
# These tokens are a reasoned superset extrapolated from the two worked examples in the
# mapping doc; they were not observed against live data. That is why an unrecognized
# token logs rather than failing silently -- the warning is what makes a gap visible on
# the first real scan instead of quietly nulling every affected posting's period.
_PERIOD_VOCAB = {
    "HOURLY": HOURLY, "HOUR": HOURLY, "PER_HOUR": HOURLY, "HOURLY_RATE": HOURLY,
    "DAILY": DAILY, "DAY": DAILY, "PER_DAY": DAILY,
    "WEEKLY": WEEKLY, "WEEK": WEEKLY, "PER_WEEK": WEEKLY,
    "MONTHLY": MONTHLY, "MONTH": MONTHLY, "PER_MONTH": MONTHLY,
    "YEARLY": ANNUAL, "YEAR": ANNUAL, "ANNUAL": ANNUAL, "ANNUALLY": ANNUAL,
    "PER_YEAR": ANNUAL, "YEARLY_RATE": ANNUAL,
}

# Epoch-ms values outside this range are almost certainly a unit error (seconds mistaken
# for milliseconds, or a sentinel) rather than a real posting date.
_MIN_EPOCH_MS = 946_684_800_000        # 2000-01-01
_MAX_EPOCH_MS = 4_102_444_800_000      # 2100-01-01


def normalize_salary_period(raw: Any, *, site: str) -> str | None:
    """Map a site's pay-period token onto the canonical five, or None.

    An unmappable token keeps the salary amounts and drops only the period: a wrong
    period is worse than an absent one, and discarding the amounts would lose real data.
    """
    if raw is None:
        return None
    token = str(raw).strip().upper().replace("-", "_").replace(" ", "_")
    if not token:
        return None
    canonical = _PERIOD_VOCAB.get(token)
    if canonical is None:
        logger.warning(
            "projection_unknown_salary_period %s",
            {"site": site, "raw": str(raw)[:64]},
        )
    return canonical


def epoch_ms_to_datetime(raw: Any, *, site: str, field: str) -> datetime | None:
    """Convert an epoch-millisecond value to an aware UTC datetime, or None."""
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        logger.warning(
            "projection_bad_posted_at %s",
            {"site": site, "field": field, "raw": str(raw)[:64], "reason": "not_numeric"},
        )
        return None
    if not (_MIN_EPOCH_MS <= raw <= _MAX_EPOCH_MS):
        logger.warning(
            "projection_bad_posted_at %s",
            {"site": site, "field": field, "raw": str(raw)[:64], "reason": "out_of_range"},
        )
        return None
    try:
        return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        logger.warning(
            "projection_bad_posted_at %s",
            {"site": site, "field": field, "raw": str(raw)[:64], "reason": "unconvertible"},
        )
        return None


def date_to_datetime(raw: Any, *, site: str, field: str) -> datetime | None:
    """Promote a calendar date to midnight **UTC**, or None.

    UTC is pinned deliberately. Casting a bare date to timestamptz in Postgres resolves
    midnight in the server's TimeZone setting, which would make posted_at depend on
    deployment configuration and quietly shift a Glassdoor posting relative to the
    epoch-ms values from the other two sites, which are inherently UTC.
    """
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if isinstance(raw, date):
        return datetime.combine(raw, time.min, tzinfo=timezone.utc)
    logger.warning(
        "projection_bad_posted_at %s",
        {"site": site, "field": field, "raw": str(raw)[:64], "reason": "not_a_date"},
    )
    return None


def _first_jsonb_text(raw: Any) -> str | None:
    """Flatten a jsonb list to its first element as text; None when absent or empty."""
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw or None
    if isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, str) and item.strip():
                return item
        return None
    return None

# Canonical column order. Single source of truth for the INSERT column list in
# routers/jobs.py — the params dict returned below has exactly these keys.
# `matched` and `dismissed` are omitted deliberately: both are NOT NULL DEFAULT FALSE and
# are always false at ingest, so the database supplies them.
CANONICAL_COLS = [
    "source_site",
    "source_row_id",
    "site_job_id",
    "scan_run_id",
    "job_url",
    "scrape_time",
    "title",
    "company",
    "location_text",
    "description",
    "remote",
    "apply_url",
    "experience_level",
    "industry",
    "salary_min",
    "salary_max",
    "salary_currency",
    "salary_period",
    "posted_at",
]

SUPPORTED_SITES = ("linkedin", "indeed", "glassdoor")


def _linkedin_projection(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "site_job_id": p.get("job_posting_id"),
        "title": p.get("title"),
        "location_text": p.get("formatted_location"),
        "description": p.get("description_text"),
        "apply_url": p.get("company_apply_url"),
        "experience_level": p.get("formatted_experience_level"),
        "salary_min": p.get("salary_min"),
        "salary_max": p.get("salary_max"),
        "salary_currency": p.get("salary_currency"),
        "company": p.get("company_name"),
        "industry": _first_jsonb_text(p.get("formatted_industries")),
        "remote": p.get("work_remote_allowed"),
        "salary_period": normalize_salary_period(p.get("salary_period"), site="linkedin"),
        "posted_at": epoch_ms_to_datetime(
            p.get("listed_at"), site="linkedin", field="listed_at"
        ),
    }


def _indeed_projection(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "site_job_id": p.get("jobkey"),
        "title": p.get("title"),
        "location_text": p.get("formatted_location"),
        "description": p.get("description_text"),
        "apply_url": p.get("third_party_apply_url"),
        # Indeed exposes no experience level; the mapping doc designates NULL rather than
        # a substitute.
        "experience_level": None,
        "salary_min": p.get("salary_min"),
        "salary_max": p.get("salary_max"),
        "salary_currency": p.get("salary_currency"),
        # Precedence: the mosaic payload's company wins; the graphql employer name is a
        # fallback for when mosaic did not carry one. Not a coalesce on falsiness -- an
        # empty-string company still means mosaic answered.
        "company": p.get("company") if p.get("company") is not None else p.get("employer_name"),
        # Indeed exposes no industry field; the mapping designates NULL.
        "industry": None,
        "remote": p.get("remote_location"),
        "salary_period": normalize_salary_period(p.get("salary_period"), site="indeed"),
        "posted_at": epoch_ms_to_datetime(
            p.get("pub_date"), site="indeed", field="pub_date"
        ),
    }


def _glassdoor_projection(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "site_job_id": p.get("listing_id"),
        "title": p.get("title"),
        "location_text": p.get("location_name"),
        "description": p.get("description"),
        "apply_url": p.get("header_apply_url"),
        "experience_level": p.get("experience_requirements_description"),
        "salary_min": p.get("jsonld_salary_min"),
        "salary_max": p.get("jsonld_salary_max"),
        "salary_currency": p.get("jsonld_salary_currency_top"),
        "company": p.get("employer_name"),
        "industry": p.get("industry"),
        # Glassdoor has no remote boolean, only a structured list of remote work types.
        # A non-empty list means remote; absent means the site did not say, which is NOT
        # the same claim as "not remote" -- hence None rather than False. The list itself
        # is not preserved in the canonical field; it stays on the per-source row.
        "remote": True if p.get("remote_work_types") else None,
        "salary_period": normalize_salary_period(p.get("salary_period"), site="glassdoor"),
        # date_posted arrives as a datetime.date (the builder parses the ISO string).
        "posted_at": date_to_datetime(
            p.get("date_posted"), site="glassdoor", field="date_posted"
        ),
    }


_PROJECTORS = {
    "linkedin": _linkedin_projection,
    "indeed": _indeed_projection,
    "glassdoor": _glassdoor_projection,
}


def project_to_canonical(
    site: str,
    params: dict[str, Any],
    source_row_id: uuid.UUID,
    scrape_time: datetime,
) -> dict[str, Any]:
    """Project a per-source params dict onto canonical scraped_jobs params.

    Args:
        site: one of SUPPORTED_SITES; becomes `source_site`, which identifies the origin
            table on its own (there is no source_table column).
        params: the dict returned by the site's `build_*_params`.
        source_row_id: the per-source row's id, from its INSERT ... RETURNING.
        scrape_time: the per-source row's scrape_time, from the same RETURNING. Must be
            the value that row actually holds, never a fresh now(): auto-expiration deletes
            from both tables with the same timestamp predicate, so a divergence here leaves
            orphaned canonical rows at the shelf-life boundary.

    Returns:
        A dict whose keys are exactly CANONICAL_COLS.
    """
    projector = _PROJECTORS.get(site)
    if projector is None:
        raise ValueError(
            f"No projection for site {site!r}; expected one of {SUPPORTED_SITES}"
        )

    projected = projector(params)

    canonical = {
        "source_site": site,
        "source_row_id": source_row_id,
        "scan_run_id": params.get("scan_run_id"),
        "job_url": params.get("job_url"),
        "scrape_time": scrape_time,
        **projected,
    }

    # Guard the contract with the INSERT statement: a missing or stray key here surfaces as
    # a confusing bind-parameter error at execution time instead of a clear one.
    missing = set(CANONICAL_COLS) - set(canonical)
    extra = set(canonical) - set(CANONICAL_COLS)
    if missing or extra:
        raise ValueError(
            f"Projection for {site!r} produced wrong keys "
            f"(missing={sorted(missing)}, extra={sorted(extra)})"
        )

    return canonical
