import hashlib
import logging
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from time import monotonic
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import bindparam, exists, func, or_, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from models.job_report import JobReport
from models.scraped_job import ScrapedJob
from schemas.scraped_job import (
    JobUpdate,
    JobsListResponse,
    ScrapedJobDetail,
    ScrapedJobIngest,
    ScrapedJobIngestResponse,
    ScrapedJobRead,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_BLACKLIST_SKIP_REASONS = frozenset(
    {
        "blacklisted",
        "blacklisted_company",
        "blacklisted_location",
        "title_blacklisted",
        "job_type",
        "agency",
        "remote_mismatch",
        "contract_mismatch",
        "sponsorship",
    }
)


def _normalize_job_update_payload(data: dict) -> dict:
    if "extracted_salary_min" in data:
        v = data.pop("extracted_salary_min")
        if "salary_min_extracted" not in data:
            data["salary_min_extracted"] = v
    if "match_confidence" in data:
        v = data.pop("match_confidence")
        if "confidence" not in data:
            data["confidence"] = v
    return data


def _hash_description(text: str | None) -> str:
    raw = (text or "").strip().lower()
    return hashlib.sha256(raw.encode()).hexdigest()


def _resolve_linkedin_included(
    included: list | None,
    entity_urn: str | None,
) -> dict | None:
    """Find the entity in included[] whose entityUrn matches.
    Returns None if not found or if either input is missing.
    """
    if not included or not entity_urn:
        return None
    if not isinstance(included, list):
        return None
    for entity in included:
        if not isinstance(entity, dict):
            continue
        if entity.get("entityUrn") == entity_urn:
            return entity
    return None


def _parse_glassdoor_discover_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        d = datetime.fromisoformat(raw)
        return (
            d.replace(tzinfo=dt_timezone.utc)
            if d.tzinfo is None
            else d.astimezone(dt_timezone.utc)
        )
    except (ValueError, TypeError) as e:
        logger.warning(
            "ingest_discover_date_parse_failed %s",
            {"raw": raw, "error": str(e)},
        )
        return None


def _parse_iso_date(raw):
    """Parse ISO 'YYYY-MM-DD' string to datetime.date.
    Returns None for None / empty / unparseable; logs warning on parse failure."""
    from datetime import date

    if raw is None:
        return None
    if isinstance(raw, date):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        # date.fromisoformat handles 'YYYY-MM-DD' and rejects fancier forms cleanly.
        # If raw includes a time portion (e.g. '2026-04-01T00:00:00'), take the date prefix.
        return date.fromisoformat(raw[:10])
    except (ValueError, TypeError) as e:
        logger.warning(
            "ingest_iso_date_parse_failed %s",
            {"raw": raw, "error": str(e)},
        )
        return None


def _to_str_or_none(v):
    """Coerce ints/floats to str for VARCHAR columns. Pass through
    strings and None unchanged. asyncpg won't auto-coerce numeric →
    text, so any source field that's a JSON number but maps to a
    VARCHAR column must go through this."""
    if v is None:
        return None
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    return None


def _to_int_or_none(v):
    """Coerce strings to int for INTEGER columns, with None passthrough.
    Returns None for non-numeric strings, dicts, lists, etc."""
    if v is None:
        return None
    if isinstance(v, bool):  # bool is a subclass of int — exclude explicitly
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(s)
        except ValueError:
            try:
                return int(float(s))
            except (ValueError, TypeError):
                return None
    return None


def _linkedin_apply_method_type(apply_method: dict | None) -> str | None:
    if not isinstance(apply_method, dict):
        return None
    t = apply_method.get("$type")
    if not isinstance(t, str):
        return None
    return t.rsplit(".", 1)[-1] if "." in t else t


# Define column list once per table — single source of truth for
# the INSERT column order. Order must match the params dict keys.
LINKEDIN_COLS = [
    "job_url", "scan_run_id", "source_raw",  # JSONB
    "job_posting_id", "job_posting_url",
    "listed_at", "original_listed_at", "job_state",
    "job_application_limit_reached", "expire_at", "closed_at",
    "formatted_location", "country_urn", "location_urn",
    "location_visibility",
    "postal_address",          # JSONB
    "standardized_addresses",  # JSONB
    "job_region",
    "work_remote_allowed",
    "workplace_types_urns",  # JSONB
    "workplace_types_labels",  # JSONB
    "formatted_employment_status", "employment_status_urn",
    "formatted_industries",  # JSONB
    "formatted_job_functions",  # JSONB
    "title", "standardized_title", "formatted_experience_level",
    "skills_description",
    "apply_method_type", "company_apply_url",
    "applicant_tracking_system", "top_level_company_apply_url",
    "salary_min", "salary_max", "salary_currency", "salary_period",
    "salary_provided_by_employer",
    "description_text",
    "inferred_benefits",  # JSONB
    "benefits",  # JSONB
    "company_name", "company_universal_name", "company_url",
    "company_description",
    "title_entity_urn", "employment_status_label",
    "employment_status_entity_urn", "workplace_type_entity_urn",
]

# JSONB columns need explicit bindparam declarations so SQLAlchemy
# serializes Python dicts as JSON instead of str(dict) Python repr.
LINKEDIN_JSONB_COLS = [
    "source_raw",
    "postal_address",
    "standardized_addresses",
    "workplace_types_urns",
    "workplace_types_labels",
    "formatted_industries",
    "formatted_job_functions",
    "inferred_benefits",
    "benefits",
]

_cols_sql = ", ".join(LINKEDIN_COLS)
_vals_sql = ", ".join(f":{c}" for c in LINKEDIN_COLS)

INSERT_LINKEDIN_JOB = text(f"""
    WITH inserted AS (
        INSERT INTO linkedin_jobs ({_cols_sql})
        VALUES ({_vals_sql})
        ON CONFLICT (job_url) DO NOTHING
        RETURNING id
    )
    SELECT id, false AS already_exists FROM inserted
    UNION ALL
    SELECT id, true AS already_exists FROM linkedin_jobs
     WHERE job_url = :job_url AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
""").bindparams(*(bindparam(c, type_=JSONB) for c in LINKEDIN_JSONB_COLS))


INDEED_COLS = [
    "job_url", "scan_run_id", "source_raw",  # JSONB
    "mosaic_present", "graphql_present",
    "jobkey", "link", "view_job_link", "more_loc_url", "third_party_apply_url",
    "pub_date", "create_date", "expiration_date", "expired",
    "title", "display_title", "norm_title",
    "job_types",  # JSONB
    "taxonomy_attributes",  # JSONB
    "formatted_location", "job_location_city", "job_location_state",
    "job_location_postal", "location_count", "additional_location_link",
    "remote_location",
    "salary_min", "salary_max", "salary_period", "salary_currency",
    "salary_text", "salary_snippet_source",
    "company",
    "indeed_apply_enabled", "indeed_applyable", "apply_count",
    "screener_questions_url",
    "match_negative_taxonomy",  # JSONB
    "match_mismatching_entities",  # JSONB
    "num_hires",
    "employer_canonical_url",
    "graphql_date_published", "graphql_date_on_indeed", "graphql_expired",
    "graphql_title", "graphql_normalized_title",
    "attributes",  # JSONB
    "location_formatted_long", "graphql_location_city",
    "graphql_location_postal_code", "graphql_location_street_address",
    "graphql_location_admin1_code", "graphql_location_country_code",
    "description_text", "language",
    "employer_name", "employer_company_page_url",
    "source_name",
    "graphql_salary_period",
]

INDEED_JSONB_COLS = [
    "source_raw",
    "job_types",
    "taxonomy_attributes",
    "match_negative_taxonomy",
    "match_mismatching_entities",
    "attributes",
]

_indeed_cols_sql = ", ".join(INDEED_COLS)
_indeed_vals_sql = ", ".join(f":{c}" for c in INDEED_COLS)

INSERT_INDEED_JOB = text(f"""
    WITH inserted AS (
        INSERT INTO indeed_jobs ({_indeed_cols_sql})
        VALUES ({_indeed_vals_sql})
        ON CONFLICT (job_url) DO NOTHING
        RETURNING id
    )
    SELECT id, false AS already_exists FROM inserted
    UNION ALL
    SELECT id, true AS already_exists FROM indeed_jobs
     WHERE job_url = :job_url AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
""").bindparams(*(bindparam(c, type_=JSONB) for c in INDEED_JSONB_COLS))


GLASSDOOR_COLS = [
    "job_url", "scan_run_id", "source_raw",  # JSONB
    "listing_id", "goc_id", "job_country_id",
    "job_title", "normalized_job_title",
    "expired", "employer_active_status",
    "is_easy_apply", "job_link", "seo_job_link",
    "salary_currency", "salary_period", "salary_source",
    "pay_period_adjusted_pay",  # JSONB
    "location_name", "location",  # JSONB
    "employer_name", "employer_overview",
    "indeed_job_attribute",  # JSONB
    "skills_labels",  # JSONB
    "education_labels",  # JSONB
    "job_description_plain",
    "employer_benefits_overview", "employer_benefits_reviews",  # JSONB
    "title",
    "date_posted",
    "valid_through",
    "description",
    "experience_requirements_description",
    "experience_requirements_months",
    "education_requirements_credential",
    "employment_type",  # JSONB
    "jsonld_salary_currency_top",
    "jsonld_salary_currency",
    "jsonld_salary_min",
    "jsonld_salary_max",
    "jsonld_salary_period",
    "job_location",  # JSONB
    "job_location_type",
    "hiring_organization",  # JSONB
    "industry",
    "direct_apply",
    "job_benefits",
    "header_goc",
    "job_type",  # JSONB
    "job_type_keys",  # JSONB
    "remote_work_types",  # JSONB
    "header_expired",
    "header_easy_apply",
    "header_apply_url",
    "header_salary_source",
    "header_salary_currency",
    "header_salary_period",
    "header_employer",  # JSONB
    "map_address",
    "map_city_name",
    "map_country",
    "map_state_name",
    "map_location_name",
    "map_postal_code",
    "map_employer",  # JSONB
    "discover_date",
    "job_title_text",
    "jobview_job_description",
]

GLASSDOOR_JSONB_COLS = [
    "source_raw",
    "pay_period_adjusted_pay",
    "location",
    "indeed_job_attribute",
    "skills_labels",
    "education_labels",
    "employer_benefits_reviews",
    "employment_type",
    "job_location",
    "hiring_organization",
    "job_type",
    "job_type_keys",
    "remote_work_types",
    "header_employer",
    "map_employer",
]

_glassdoor_cols_sql = ", ".join(GLASSDOOR_COLS)
_glassdoor_vals_sql = ", ".join(f":{c}" for c in GLASSDOOR_COLS)

INSERT_GLASSDOOR_JOB = text(f"""
    WITH inserted AS (
        INSERT INTO glassdoor_jobs ({_glassdoor_cols_sql})
        VALUES ({_glassdoor_vals_sql})
        ON CONFLICT (job_url) DO NOTHING
        RETURNING id
    )
    SELECT id, false AS already_exists FROM inserted
    UNION ALL
    SELECT id, true AS already_exists FROM glassdoor_jobs
     WHERE job_url = :job_url AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
""").bindparams(*(bindparam(c, type_=JSONB) for c in GLASSDOOR_JSONB_COLS))


def build_linkedin_params(body: ScrapedJobIngest) -> dict:
    data = (body.source_raw or {}).get("data") or {}
    included = (body.source_raw or {}).get("included")

    title_entity = _resolve_linkedin_included(included, data.get("standardizedTitle"))
    emp_entity = _resolve_linkedin_included(included, data.get("employmentStatus"))
    company_details = data.get("companyDetails") or {}
    company_urn = None
    if isinstance(company_details, dict):
        candidate = company_details.get("company")
        if isinstance(candidate, str) and candidate.startswith("urn:li:"):
            company_urn = candidate
        else:
            for v in company_details.values():
                if isinstance(v, dict):
                    nested = v.get("company")
                    if isinstance(nested, str) and nested.startswith("urn:li:"):
                        company_urn = nested
                        break
    company_entity = _resolve_linkedin_included(included, company_urn)

    workplace_urns_raw = data.get("workplaceTypes")
    workplace_urns = workplace_urns_raw if isinstance(workplace_urns_raw, list) else []
    first_workplace_urn = workplace_urns[0] if workplace_urns else None
    workplace_entity = _resolve_linkedin_included(included, first_workplace_urn)

    si = data.get("salaryInsights") if isinstance(data.get("salaryInsights"), dict) else {}
    cb = si.get("compensationBreakdown")
    first_breakdown = (
        cb[0]
        if isinstance(cb, list) and cb and isinstance(cb[0], dict)
        else {}
    )
    desc_block = data.get("description") if isinstance(data.get("description"), dict) else {}
    apply_method = (
        data.get("applyMethod") if isinstance(data.get("applyMethod"), dict) else None
    )

    return {
        "job_url": _to_str_or_none(data.get("jobPostingUrl")),
        "scan_run_id": body.scan_run_id,
        "source_raw": body.source_raw,
        "job_posting_id": _to_str_or_none(data.get("jobPostingId")),
        "job_posting_url": _to_str_or_none(data.get("jobPostingUrl")),
        "listed_at": data.get("listedAt"),
        "original_listed_at": data.get("originalListedAt"),
        "job_state": _to_str_or_none(data.get("jobState")),
        "job_application_limit_reached": data.get("jobApplicationLimitReached"),
        "expire_at": data.get("expireAt"),
        "closed_at": data.get("closedAt"),
        "formatted_location": _to_str_or_none(data.get("formattedLocation")),
        "country_urn": _to_str_or_none(data.get("country")),
        "location_urn": _to_str_or_none(data.get("locationUrn")),
        "location_visibility": _to_str_or_none(data.get("locationVisibility")),
        "postal_address": data.get("postalAddress"),
        "standardized_addresses": data.get("standardizedAddresses"),
        "job_region": _to_str_or_none(data.get("jobRegion")),
        "work_remote_allowed": data.get("workRemoteAllowed"),
        "workplace_types_urns": data.get("workplaceTypes"),
        "workplace_types_labels": data.get("workplaceTypesResolutionResults"),
        "formatted_employment_status": _to_str_or_none(
            data.get("formattedEmploymentStatus")
        ),
        "employment_status_urn": _to_str_or_none(data.get("employmentStatus")),
        "formatted_industries": data.get("formattedIndustries"),
        "formatted_job_functions": data.get("formattedJobFunctions"),
        "title": _to_str_or_none(data.get("title")),
        "standardized_title": _to_str_or_none(
            (title_entity or {}).get("localizedName")
        ),
        "formatted_experience_level": _to_str_or_none(
            data.get("formattedExperienceLevel")
        ),
        "skills_description": _to_str_or_none(data.get("skillsDescription")),
        "apply_method_type": _to_str_or_none(
            _linkedin_apply_method_type(apply_method)
        ),
        "company_apply_url": _to_str_or_none(
            apply_method.get("companyApplyUrl") if apply_method else None
        ),
        "applicant_tracking_system": _to_str_or_none(
            data.get("applicantTrackingSystem")
        ),
        "top_level_company_apply_url": _to_str_or_none(data.get("companyApplyUrl")),
        "salary_min": first_breakdown.get("minSalary"),
        "salary_max": first_breakdown.get("maxSalary"),
        "salary_currency": _to_str_or_none(first_breakdown.get("currencyCode")),
        "salary_period": _to_str_or_none(first_breakdown.get("payPeriod")),
        "salary_provided_by_employer": si.get("providedByEmployer"),
        "description_text": _to_str_or_none(desc_block.get("text")),
        "inferred_benefits": data.get("inferredBenefits"),
        "benefits": data.get("benefits"),
        "company_name": _to_str_or_none((company_entity or {}).get("name")),
        "company_universal_name": _to_str_or_none(
            (company_entity or {}).get("universalName")
        ),
        "company_url": _to_str_or_none(
            (company_entity or {}).get("url")
            or (company_entity or {}).get("companyPageUrl")
        ),
        "company_description": _to_str_or_none(
            (company_entity or {}).get("description")
        ),
        "title_entity_urn": _to_str_or_none((title_entity or {}).get("entityUrn")),
        "employment_status_label": _to_str_or_none(
            (emp_entity or {}).get("localizedName")
        ),
        "employment_status_entity_urn": _to_str_or_none(
            (emp_entity or {}).get("entityUrn")
        ),
        "workplace_type_entity_urn": _to_str_or_none(
            (workplace_entity or {}).get("entityUrn")
        ),
    }


def build_indeed_params(body: ScrapedJobIngest) -> dict:
    mosaic = (body.source_raw or {}).get("mosaic") or {}
    graphql = (body.source_raw or {}).get("graphql") or {}
    mosaic_present = bool(mosaic)
    graphql_present = bool(graphql)
    if not (mosaic_present or graphql_present):
        raise HTTPException(
            status_code=400,
            detail=(
                "Indeed ingest has source_raw but both mosaic and graphql "
                "blocks are null/missing"
            ),
        )

    description_text = (graphql.get("description") or {}).get("text")

    jk = mosaic.get("jobkey")
    if jk is None and graphql_present:
        jk = graphql.get("jobKey") or graphql.get("jobkey")
    jobkey_str = _to_str_or_none(jk)
    if not jobkey_str:
        raise HTTPException(
            status_code=400,
            detail="Indeed ingest missing jobkey for job_url",
        )
    job_url = f"https://ca.indeed.com/viewjob?jk={jobkey_str}"

    ext = (
        mosaic.get("extractedSalary")
        if isinstance(mosaic.get("extractedSalary"), dict)
        else {}
    )
    snip = (
        mosaic.get("salarySnippet")
        if isinstance(mosaic.get("salarySnippet"), dict)
        else {}
    )
    jsm = (
        mosaic.get("jobSeekerMatchSummaryModel")
        if isinstance(mosaic.get("jobSeekerMatchSummaryModel"), dict)
        else {}
    )

    loc = graphql.get("location") if isinstance(graphql.get("location"), dict) else {}
    formatted = (
        loc.get("formatted") if isinstance(loc.get("formatted"), dict) else {}
    )

    emp = graphql.get("employer") if isinstance(graphql.get("employer"), dict) else {}
    src = graphql.get("source") if isinstance(graphql.get("source"), dict) else {}
    comp = (
        graphql.get("compensation")
        if isinstance(graphql.get("compensation"), dict)
        else {}
    )
    base = comp.get("baseSalary") if isinstance(comp.get("baseSalary"), dict) else {}

    return {
        "job_url": job_url,
        "scan_run_id": body.scan_run_id,
        "source_raw": body.source_raw,
        "mosaic_present": mosaic_present,
        "graphql_present": graphql_present,
        "jobkey": jobkey_str,
        "link": _to_str_or_none(mosaic.get("link")),
        "view_job_link": _to_str_or_none(mosaic.get("viewJobLink")),
        "more_loc_url": _to_str_or_none(mosaic.get("moreLocUrl")),
        "third_party_apply_url": _to_str_or_none(mosaic.get("thirdPartyApplyUrl")),
        "pub_date": mosaic.get("pubDate"),
        "create_date": mosaic.get("createDate"),
        "expiration_date": mosaic.get("expirationDate"),
        "expired": mosaic.get("expired"),
        "title": _to_str_or_none(mosaic.get("title")),
        "display_title": _to_str_or_none(mosaic.get("displayTitle")),
        "norm_title": _to_str_or_none(mosaic.get("normTitle")),
        "job_types": mosaic.get("jobTypes"),
        "taxonomy_attributes": mosaic.get("taxonomyAttributes"),
        "formatted_location": _to_str_or_none(mosaic.get("formattedLocation")),
        "job_location_city": _to_str_or_none(mosaic.get("jobLocationCity")),
        "job_location_state": _to_str_or_none(mosaic.get("jobLocationState")),
        "job_location_postal": _to_str_or_none(mosaic.get("jobLocationPostal")),
        "location_count": _to_int_or_none(mosaic.get("locationCount")),
        "additional_location_link": _to_str_or_none(mosaic.get("additionalLocationLink")),
        "remote_location": mosaic.get("remoteLocation"),
        "salary_min": ext.get("min"),
        "salary_max": ext.get("max"),
        "salary_period": _to_str_or_none(ext.get("type")),
        "salary_currency": _to_str_or_none(snip.get("currency")),
        "salary_text": _to_str_or_none(snip.get("salaryTextFormatted")),
        "salary_snippet_source": _to_str_or_none(snip.get("source")),
        "company": _to_str_or_none(mosaic.get("company")),
        "indeed_apply_enabled": mosaic.get("indeedApplyEnabled"),
        "indeed_applyable": mosaic.get("indeedApplyable"),
        "apply_count": _to_int_or_none(mosaic.get("applyCount")),
        "screener_questions_url": _to_str_or_none(mosaic.get("screenerQuestionsURL")),
        "match_negative_taxonomy": jsm.get("taxoEntityMatchesNegative"),
        "match_mismatching_entities": jsm.get("sortedMisMatchingEntityDisplayText"),
        "num_hires": _to_int_or_none(mosaic.get("numHires")),
        "employer_canonical_url": _to_str_or_none(graphql.get("url")),
        "graphql_date_published": _parse_iso_date(graphql.get("datePublished")),
        "graphql_date_on_indeed": _parse_iso_date(graphql.get("dateOnIndeed")),
        "graphql_expired": graphql.get("expired"),
        "graphql_title": _to_str_or_none(graphql.get("title")),
        "graphql_normalized_title": _to_str_or_none(graphql.get("normalizedTitle")),
        "attributes": graphql.get("attributes"),
        "location_formatted_long": _to_str_or_none(formatted.get("long")),
        "graphql_location_city": _to_str_or_none(loc.get("city")),
        "graphql_location_postal_code": _to_str_or_none(loc.get("postalCode")),
        "graphql_location_street_address": _to_str_or_none(loc.get("streetAddress")),
        "graphql_location_admin1_code": _to_str_or_none(loc.get("admin1Code")),
        "graphql_location_country_code": _to_str_or_none(loc.get("countryCode")),
        "description_text": _to_str_or_none(description_text),
        "language": _to_str_or_none(graphql.get("language")),
        "employer_name": _to_str_or_none(emp.get("name")),
        "employer_company_page_url": _to_str_or_none(emp.get("relativeCompanyPageUrl")),
        "source_name": _to_str_or_none(src.get("name")),
        "graphql_salary_period": _to_str_or_none(base.get("unitOfWork")),
    }


def build_glassdoor_params(body: ScrapedJobIngest) -> dict:
    jl = (body.source_raw or {}).get("jobListing") or {}
    listing_id = jl.get("jobDetailsData", {}).get("listingId")
    listing_id_str = _to_str_or_none(listing_id)
    if not listing_id_str:
        raise HTTPException(status_code=400, detail="Glassdoor ingest missing listing_id")
    job_url = (
        f"https://www.glassdoor.ca/job-listing/listing-{listing_id_str}.htm"
        f"?jl={listing_id_str}"
    )

    discover_date_raw = (
        jl.get("jobDetailsRawData", {})
        .get("jobview", {})
        .get("job", {})
        .get("discoverDate")
    )
    discover_date = _parse_glassdoor_discover_date(
        discover_date_raw if isinstance(discover_date_raw, str) else None
    )

    jdd = jl.get("jobDetailsData", {})
    jdd = jdd if isinstance(jdd, dict) else {}
    indeed_attr = jdd.get("indeedJobAttribute")
    indeed_attr = indeed_attr if isinstance(indeed_attr, dict) else {}

    raw = body.source_raw or {}
    jp = raw.get("json_ld")
    jp = jp if isinstance(jp, dict) else {}
    er = jp.get("experienceRequirements")
    er = er if isinstance(er, dict) else {}
    edreq = jp.get("educationRequirements")
    edreq = edreq if isinstance(edreq, dict) else {}
    bs = jp.get("baseSalary")
    bs = bs if isinstance(bs, dict) else {}
    bsval = bs.get("value")
    bsval = bsval if isinstance(bsval, dict) else {}

    jdrd = jl.get("jobDetailsRawData", {})
    jdrd = jdrd if isinstance(jdrd, dict) else {}
    jv = jdrd.get("jobview", {})
    jv = jv if isinstance(jv, dict) else {}
    header = jv.get("header", {})
    header = header if isinstance(header, dict) else {}
    mmap = jv.get("map", {})
    mmap = mmap if isinstance(mmap, dict) else {}
    jjob = jv.get("job", {})
    jjob = jjob if isinstance(jjob, dict) else {}

    return {
        "job_url": job_url,
        "scan_run_id": body.scan_run_id,
        "source_raw": body.source_raw,
        "listing_id": listing_id_str,
        "goc_id": _to_int_or_none(jdd.get("gocId")),
        "job_country_id": _to_int_or_none(jdd.get("jobCountryId")),
        "job_title": _to_str_or_none(jdd.get("jobTitle")),
        "normalized_job_title": _to_str_or_none(jdd.get("normalizedJobTitle")),
        "expired": jdd.get("expired"),
        "employer_active_status": _to_str_or_none(jdd.get("employerActiveStatus")),
        "is_easy_apply": jdd.get("isEasyApply"),
        "job_link": _to_str_or_none(jdd.get("jobLink")),
        "seo_job_link": _to_str_or_none(jdd.get("seoJobLink")),
        "salary_currency": _to_str_or_none(jdd.get("payCurrency")),
        "salary_period": _to_str_or_none(jdd.get("payPeriod")),
        "salary_source": _to_str_or_none(jdd.get("salarySource")),
        "pay_period_adjusted_pay": jdd.get("payPeriodAdjustedPay"),
        "location_name": _to_str_or_none(jdd.get("locationName")),
        "location": jdd.get("location"),
        "employer_name": _to_str_or_none(jdd.get("employerName")),
        "employer_overview": _to_str_or_none(jdd.get("employerOverview")),
        "indeed_job_attribute": jdd.get("indeedJobAttribute"),
        "skills_labels": indeed_attr.get("skillsLabel"),
        "education_labels": indeed_attr.get("educationLabel"),
        "job_description_plain": _to_str_or_none(jdd.get("jobDescription")),
        "employer_benefits_overview": _to_str_or_none(jdd.get("employerBenefitsOverview")),
        "employer_benefits_reviews": jdd.get("employerBenefitsReviews"),
        "title": _to_str_or_none(jp.get("title")),
        "date_posted": _parse_iso_date(jp.get("datePosted")),
        "valid_through": _parse_iso_date(jp.get("validThrough")),
        "description": _to_str_or_none(jp.get("description")),
        "experience_requirements_description": _to_str_or_none(er.get("description")),
        "experience_requirements_months": _to_int_or_none(
            er.get("monthsOfExperience")
        ),
        "education_requirements_credential": _to_str_or_none(
            edreq.get("credentialCategory")
        ),
        "employment_type": jp.get("employmentType"),
        "jsonld_salary_currency_top": _to_str_or_none(jp.get("salaryCurrency")),
        "jsonld_salary_currency": _to_str_or_none(bs.get("currency")),
        "jsonld_salary_min": bsval.get("minValue"),
        "jsonld_salary_max": bsval.get("maxValue"),
        "jsonld_salary_period": _to_str_or_none(bsval.get("unitText")),
        "job_location": jp.get("jobLocation"),
        "job_location_type": _to_str_or_none(jp.get("jobLocationType")),
        "hiring_organization": jp.get("hiringOrganization"),
        "industry": _to_str_or_none(jp.get("industry")),
        "direct_apply": jp.get("directApply"),
        "job_benefits": _to_str_or_none(jp.get("jobBenefits")),
        "header_goc": _to_str_or_none(header.get("goc")),
        "job_type": header.get("jobType"),
        "job_type_keys": header.get("jobTypeKeys"),
        "remote_work_types": header.get("remoteWorkTypes"),
        "header_expired": header.get("expired"),
        "header_easy_apply": header.get("easyApply"),
        "header_apply_url": _to_str_or_none(header.get("applyUrl")),
        "header_salary_source": _to_str_or_none(header.get("salarySource")),
        "header_salary_currency": _to_str_or_none(header.get("payCurrency")),
        "header_salary_period": _to_str_or_none(header.get("payPeriod")),
        "header_employer": header.get("employer"),
        "map_address": _to_str_or_none(mmap.get("address")),
        "map_city_name": _to_str_or_none(mmap.get("cityName")),
        "map_country": _to_str_or_none(mmap.get("country")),
        "map_state_name": _to_str_or_none(mmap.get("stateName")),
        "map_location_name": _to_str_or_none(mmap.get("locationName")),
        "map_postal_code": _to_str_or_none(mmap.get("postalCode")),
        "map_employer": mmap.get("employer"),
        "discover_date": discover_date,
        "job_title_text": _to_str_or_none(jjob.get("jobTitleText")),
        "jobview_job_description": _to_str_or_none(jjob.get("description")),
    }


@router.post("/ingest", response_model=ScrapedJobIngestResponse)
async def ingest_job(
    body: ScrapedJobIngest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    t_start = monotonic()
    body.job_title = body.job_title or "Unknown"
    log_context = {
        "website": body.website,
        "job_url": (body.job_url or "")[:200],
        "company": (body.company or "")[:100],
        "jd_len": len(body.job_description or ""),
        "scan_run_id": str(body.scan_run_id) if body.scan_run_id else None,
    }
    logger.info("ingest_start %s", log_context)

    try:
        if body.skip_reason:
            t_stage = monotonic()
            data = body.model_dump(exclude_unset=False, exclude={"source_raw"})
            data["job_url"] = None
            new_job = ScrapedJob(**data)
            new_job.ingest_source = "extension"
            db.add(new_job)
            await db.flush()
            logger.debug(
                "ingest_db_done %s",
                {**log_context, "took_ms": int((monotonic() - t_stage) * 1000)},
            )
            logger.info(
                "ingest_ok %s",
                {
                    **log_context,
                    "took_ms": int((monotonic() - t_start) * 1000),
                    "path": "skip_reason",
                },
            )
            return ScrapedJobIngestResponse(
                id=new_job.id,
                already_exists=False,
                content_duplicate=False,
                skip_reason=body.skip_reason,
            )

        if body.source_raw is None:
            logger.info("ingest_transition_fallback %s", {"website": body.website})
        else:
            site = (body.website or "").strip().lower()
            if site not in ("linkedin", "indeed", "glassdoor"):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Unsupported website for per-source ingest: "
                        f"{body.website!r}"
                    ),
                )
            if body.scan_run_id is None:
                raise HTTPException(
                    status_code=400,
                    detail="scan_run_id required for per-source ingest",
                )
            if site == "linkedin":
                try:
                    params = build_linkedin_params(body)
                    if not params.get("job_url"):
                        raise HTTPException(
                            status_code=400,
                            detail="LinkedIn ingest missing jobPostingUrl",
                        )
                    result = await db.execute(INSERT_LINKEDIN_JOB, params)
                    row = result.one()
                    logger.info(
                        "ingest_ok %s",
                        {
                            **log_context,
                            "took_ms": int((monotonic() - t_start) * 1000),
                            "path": "linkedin_jobs",
                        },
                    )
                    return ScrapedJobIngestResponse(
                        id=row.id,
                        already_exists=row.already_exists,
                        content_duplicate=False,
                        skip_reason=None,
                    )
                except (AttributeError, TypeError) as e:
                    logger.warning(
                        "ingest_malformed_source_raw %s",
                        {"website": body.website, "error": str(e)},
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=f"Malformed source_raw for website={body.website}",
                    ) from e
            elif site == "indeed":
                try:
                    params = build_indeed_params(body)
                    result = await db.execute(INSERT_INDEED_JOB, params)
                    row = result.one()
                    logger.info(
                        "ingest_ok %s",
                        {
                            **log_context,
                            "took_ms": int((monotonic() - t_start) * 1000),
                            "path": "indeed_jobs",
                        },
                    )
                    return ScrapedJobIngestResponse(
                        id=row.id,
                        already_exists=row.already_exists,
                        content_duplicate=False,
                        skip_reason=None,
                    )
                except (AttributeError, TypeError) as e:
                    logger.warning(
                        "ingest_malformed_source_raw %s",
                        {"website": body.website, "error": str(e)},
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=f"Malformed source_raw for website={body.website}",
                    ) from e
            elif site == "glassdoor":
                try:
                    params = build_glassdoor_params(body)
                    result = await db.execute(INSERT_GLASSDOOR_JOB, params)
                    row = result.one()
                    logger.info(
                        "ingest_ok %s",
                        {
                            **log_context,
                            "took_ms": int((monotonic() - t_start) * 1000),
                            "path": "glassdoor_jobs",
                        },
                    )
                    return ScrapedJobIngestResponse(
                        id=row.id,
                        already_exists=row.already_exists,
                        content_duplicate=False,
                        skip_reason=None,
                    )
                except (AttributeError, TypeError) as e:
                    logger.warning(
                        "ingest_malformed_source_raw %s",
                        {"website": body.website, "error": str(e)},
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=f"Malformed source_raw for website={body.website}",
                    ) from e

        t_dedup = monotonic()
        if body.job_url:
            existing = await db.execute(
                select(ScrapedJob).where(ScrapedJob.job_url == body.job_url)
            )
            row = existing.scalars().first()
            if row is not None:
                logger.debug(
                    "ingest_dedup_done %s",
                    {
                        **log_context,
                        "took_ms": int((monotonic() - t_dedup) * 1000),
                        "result": "url_duplicate",
                    },
                )
                logger.debug(
                    "ingest_embedding_done %s",
                    {**log_context, "took_ms": 0, "note": "n/a"},
                )
                logger.debug(
                    "ingest_db_done %s",
                    {**log_context, "took_ms": 0, "note": "no_write"},
                )
                logger.info(
                    "ingest_ok %s",
                    {
                        **log_context,
                        "took_ms": int((monotonic() - t_start) * 1000),
                        "path": "url_duplicate_hit",
                    },
                )
                return ScrapedJobIngestResponse(
                    id=row.id,
                    already_exists=True,
                    content_duplicate=False,
                    skip_reason="url_duplicate",
                )

        jd = body.job_description
        if jd is not None and not str(jd).strip():
            jd = None
            body = body.model_copy(update={"job_description": None})

        desc_hash = _hash_description(jd)

        hash_match = await db.execute(
            select(ScrapedJob).where(ScrapedJob.raw_description_hash == desc_hash)
        )
        content_dup_row = hash_match.scalars().first()
        content_duplicate = content_dup_row is not None

        logger.debug(
            "ingest_dedup_done %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_dedup) * 1000),
                "content_dup": content_duplicate,
            },
        )

        t_emb = monotonic()
        logger.debug(
            "ingest_embedding_done %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_emb) * 1000),
                "note": "n/a",
            },
        )

        payload = body.model_dump(exclude_unset=False, exclude={"source_raw"})
        payload.pop("original_job_id", None)
        if content_duplicate and content_dup_row is not None:
            payload["original_job_id"] = content_dup_row.id
        else:
            payload["original_job_id"] = None

        new_job = ScrapedJob(
            **payload,
            raw_description_hash=desc_hash,
        )
        new_job.ingest_source = "extension"

        t_db = monotonic()
        db.add(new_job)
        await db.flush()
        logger.debug(
            "ingest_db_done %s",
            {**log_context, "took_ms": int((monotonic() - t_db) * 1000)},
        )

        resp_skip = new_job.skip_reason or (
            "content_duplicate" if content_duplicate else None
        )
        logger.info(
            "ingest_ok %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_start) * 1000),
                "path": "insert",
            },
        )
        return ScrapedJobIngestResponse(
            id=new_job.id,
            already_exists=False,
            content_duplicate=content_duplicate,
            skip_reason=resp_skip,
        )
    except HTTPException:
        raise
    except Exception as e:
        total_ms = int((monotonic() - t_start) * 1000)
        logger.exception(
            "ingest_error took_ms=%s error_type=%s error_message=%s ctx=%s",
            total_ms,
            type(e).__name__,
            str(e)[:500],
            log_context,
        )
        raise


@router.get("", response_model=JobsListResponse)
async def list_jobs(
    website: str | None = None,
    dismissed: bool | None = None,
    scan_run_id: UUID | None = None,
    easy_apply: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    scraped_from: date | None = None,
    scraped_to: date | None = None,
    dedup_status: str | None = None,
    skip_reason_filter: str | None = None,
    match_skip_reason_filter: str | None = None,
    blacklist_filter: bool | None = None,
    blacklist_reason: str | None = None,
    dedup_type: str | None = None,
    removal_stage: str | None = None,
    matching_mode: str | None = None,
    match_level: str | None = None,
    match_status: str | None = None,
    llm_step_d: bool | None = Query(
        None,
        description="If true, only jobs scored by Step D (matching_mode=llm and LLM confidence set).",
    ),
    jd_incomplete: bool | None = Query(
        None,
        description="If true/false, filter by jd_incomplete flag.",
    ),
    order_by: str | None = Query(
        None,
        description='Sort field: "fit_score" (desc, nulls last) or "created_at" (desc).',
    ),
    limit: int = Query(25, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    sort_key = order_by if order_by in ("fit_score", "created_at") else "created_at"
    if sort_key == "fit_score":
        order_clause = (
            ScrapedJob.fit_score.desc().nulls_last(),
            ScrapedJob.created_at.desc(),
        )
    else:
        order_clause = (ScrapedJob.created_at.desc(),)

    conditions = []
    if dedup_status == "removed":
        conditions.append(
            or_(
                ScrapedJob.skip_reason.isnot(None),
                ScrapedJob.dismissed == True,  # noqa: E712
                ScrapedJob.match_skip_reason.isnot(None),
            )
        )
    elif dedup_status == "passed":
        conditions.append(ScrapedJob.skip_reason.is_(None))
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
        conditions.append(ScrapedJob.dismissed == False)  # noqa: E712
    elif dedup_status == "all":
        pass
    else:
        conditions.append(ScrapedJob.skip_reason.is_(None))

    if dedup_status == "removed" and skip_reason_filter:
        _dedup_reasons = frozenset(
            {
                "already_scraped",
                "job_type",
                "blacklisted",
                "blacklisted_company",
                "blacklisted_location",
                "title_blacklisted",
                "agency",
                "title_mismatch",
                "contract_mismatch",
                "remote_mismatch",
                "sponsorship",
            }
        )
        _gate_reasons = frozenset(
            {
                "yoe_gate",
                "salary_gate",
                "education_gate",
                "visa_gate",
                "extraction_failed",
                "scoring_failed",
            }
        )
        if skip_reason_filter in _dedup_reasons:
            conditions.append(ScrapedJob.skip_reason == skip_reason_filter)
        elif skip_reason_filter == "language":
            conditions.append(
                or_(
                    ScrapedJob.match_skip_reason == "language",
                    ScrapedJob.skip_reason == "language",
                )
            )
        elif skip_reason_filter in _gate_reasons:
            conditions.append(ScrapedJob.match_skip_reason == skip_reason_filter)
            conditions.append(ScrapedJob.skip_reason.is_(None))

    if match_skip_reason_filter:
        conditions.append(ScrapedJob.match_skip_reason == match_skip_reason_filter)
        conditions.append(ScrapedJob.skip_reason.is_(None))

    if removal_stage:
        conditions.append(ScrapedJob.removal_stage == removal_stage)

    if matching_mode:
        conditions.append(ScrapedJob.matching_mode == matching_mode)

    if blacklist_filter:
        conditions.append(
            or_(
                ScrapedJob.dismissed == True,  # noqa: E712
                ScrapedJob.skip_reason.in_(_BLACKLIST_SKIP_REASONS),
            )
        )

    if blacklist_reason:
        _br_map = {
            "blacklisted_company": "blacklisted_company",
            "blacklisted_location": "blacklisted_location",
            "title_blacklisted": "title_blacklisted",
            "job_type": "job_type",
            "agency": "agency",
            "remote": "remote_mismatch",
            "contract": "contract_mismatch",
            "sponsorship": "sponsorship",
        }
        if blacklist_reason == "dismissed":
            conditions.append(ScrapedJob.dismissed == True)  # noqa: E712
        elif blacklist_reason in _br_map:
            conditions.append(ScrapedJob.skip_reason == _br_map[blacklist_reason])
        elif blacklist_reason == "blacklisted":
            conditions.append(ScrapedJob.skip_reason == "blacklisted")

    if dedup_type in ("hash_exact", "cosine"):
        conditions.append(ScrapedJob.skip_reason == "already_scraped")
        if dedup_type == "hash_exact":
            conditions.append(ScrapedJob.dedup_similarity_score.is_(None))
        else:
            conditions.append(ScrapedJob.dedup_similarity_score.isnot(None))

    if website:
        conditions.append(ScrapedJob.website == website)
    if dismissed is not None:
        conditions.append(ScrapedJob.dismissed == dismissed)
    if scan_run_id is not None:
        conditions.append(ScrapedJob.scan_run_id == scan_run_id)
    if easy_apply is not None:
        conditions.append(ScrapedJob.easy_apply == easy_apply)
    if date_from is not None:
        conditions.append(ScrapedJob.post_datetime >= date_from)
    if date_to is not None:
        conditions.append(ScrapedJob.post_datetime <= date_to)
    if scraped_from is not None:
        lo = datetime.combine(scraped_from, time.min, tzinfo=dt_timezone.utc)
        conditions.append(ScrapedJob.created_at >= lo)
    if scraped_to is not None:
        hi = datetime.combine(scraped_to, time.min, tzinfo=dt_timezone.utc) + timedelta(
            days=1
        )
        conditions.append(ScrapedJob.created_at < hi)

    if match_level:
        conditions.append(ScrapedJob.match_level == match_level)
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
    if match_status == "unscored":
        conditions.append(ScrapedJob.match_level.is_(None))
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
    elif match_status == "scored":
        conditions.append(ScrapedJob.match_level.is_not(None))
    elif match_status == "gate_skipped":
        conditions.append(ScrapedJob.match_skip_reason.is_not(None))
        conditions.append(ScrapedJob.match_level.is_(None))

    if llm_step_d is True:
        conditions.append(ScrapedJob.matching_mode == "llm")
        conditions.append(ScrapedJob.confidence.isnot(None))

    if jd_incomplete is not None:
        conditions.append(ScrapedJob.jd_incomplete == jd_incomplete)

    pending_report_exists = exists().where(
        JobReport.job_id == ScrapedJob.id,
        JobReport.status == "pending",
    )

    if conditions:
        count_stmt = select(func.count()).select_from(ScrapedJob).where(*conditions)
        stmt = (
            select(ScrapedJob, pending_report_exists.label("has_report"))
            .where(*conditions)
            .order_by(*order_clause)
            .offset(offset)
            .limit(limit)
        )
    else:
        count_stmt = select(func.count()).select_from(ScrapedJob)
        stmt = (
            select(ScrapedJob, pending_report_exists.label("has_report"))
            .order_by(*order_clause)
            .offset(offset)
            .limit(limit)
        )

    total = (await db.execute(count_stmt)).scalar_one()

    result = await db.execute(stmt)
    items = [
        ScrapedJobRead.model_validate(job).model_copy(update={"has_report": bool(hr)})
        for job, hr in result.all()
    ]
    return JobsListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/skipped", response_model=list[ScrapedJobRead])
async def list_skipped_jobs(
    scan_run_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = (
        select(ScrapedJob)
        .where(
            ScrapedJob.scan_run_id == scan_run_id,
            ScrapedJob.skip_reason.is_not(None),
        )
        .order_by(ScrapedJob.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/{job_id}", response_model=ScrapedJobDetail)
async def get_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ScrapedJob).where(ScrapedJob.id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    has_report_row = await db.execute(
        select(
            exists().where(
                JobReport.job_id == job_id,
                JobReport.status == "pending",
            )
        )
    )
    has_report = bool(has_report_row.scalar_one())
    return ScrapedJobDetail.model_validate(job).model_copy(
        update={"has_report": has_report}
    )


@router.put("/{job_id}", response_model=ScrapedJobRead)
async def update_job(
    job_id: UUID,
    body: JobUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    job = await db.get(ScrapedJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    payload = _normalize_job_update_payload(body.model_dump(exclude_unset=True))
    for field, value in payload.items():
        setattr(job, field, value)

    await db.flush()
    await db.refresh(job)
    return job
