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

Most canonical fields are a direct copy of a per-source value. The rest need real
transforms, and each is a place a silent error can hide:

  - company        Indeed only: mosaic's company wins, graphql's employer name is the
                   fallback. LinkedIn and Glassdoor are direct copies.
  - industry       LinkedIn flattens a jsonb list to its first entry; Indeed has no source
                   field at all; Glassdoor is a direct copy.
  - remote         Tri-state. Glassdoor has no boolean and is derived from a structured
                   list; absent means "the site didn't say", not "not remote".
  - salary_period  Normalized onto one five-value vocabulary; amounts are never converted.
  - posted_at      Unified from epoch-ms (LinkedIn, Indeed) and a calendar date
                   (Glassdoor) onto one UTC representation.

Migration 031 added five more, for a future filtering/matching service that reads this
table alone:

  - employment_type   One token from a closed seven-value vocabulary. Single-valued: where
                      a site states several, precedence picks one and DISCARDS the rest.
  - workplace_type    One of REMOTE/HYBRID/ONSITE. NOT a refinement of `remote` -- the
                      two read different fields on LinkedIn, the same field under
                      different rules on Glassdoor, and may legitimately disagree.
  - language          Indeed only. Bare base code; shape-validated, not membership.
  - education_requirements  Glassdoor only. Free text, never validated, never warns.
  - salary_disclosed  Tri-state provenance. False is a claim, never a default.

An absent or unmappable source value yields None rather than failing the ingest, so a
posting is never lost over a field the canonical shape allows to be empty.

NULL carries exactly one meaning on these columns: "this site did not say". It is never
"no", and never a default.
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


# --- Filter attributes (031) ------------------------------------------------------
#
# Two controlled vocabularies, each single-valued. Where a site states several
# arrangements, precedence picks exactly one and the rest are DISCARDED -- they survive
# only on the per-source row. That is a deliberate trade: these columns keep the same
# shape as the other 22 and answer plain equality, at the cost of recall on the losing
# token.
#
# Every source value is one of three kinds, and the distinction is what keeps warnings
# meaningful:
#
#   mappable                  -> competes for the column by precedence
#   recognized-but-unmappable -> skipped, NO warning. Only "OTHER". The site answered
#                                correctly; it just maps to no canonical token. Warning
#                                on it would fire for every such posting forever and
#                                bury the warnings that signal real vocabulary drift.
#   unrecognized              -> skipped, WARNS. A gap in the table below.
#
# Classification happens BEFORE ranking, so an unrecognized token can never outrank a
# recognized one, and a lone "OTHER" yields None rather than a warning.

EMPLOYMENT_PRECEDENCE = (
    "FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY", "INTERNSHIP", "PERMANENT", "VOLUNTEER",
)
WORKPLACE_PRECEDENCE = ("REMOTE", "HYBRID", "ONSITE")

# Source spellings -> canonical token, matched on the normalized token (see _norm_token).
#
# REASONED, NOT OBSERVED. Exactly one live source value is attested anywhere in this
# repository (Glassdoor remoteWorkTypes: ["REMOTE"]); the rest is extrapolated from the
# three sites' documented vocabularies -- the same footing the salary_period vocabulary
# above was built on. The warning is the mechanism that corrects this table from the
# first real scan; reviewing those warnings is a required step of the feature, not
# follow-up work.
_EMPLOYMENT_VOCAB = {
    "FULL_TIME": "FULL_TIME", "FULLTIME": "FULL_TIME",
    "PART_TIME": "PART_TIME", "PARTTIME": "PART_TIME",
    "CONTRACT": "CONTRACT", "CONTRACTOR": "CONTRACT",
    "TEMPORARY": "TEMPORARY", "TEMP": "TEMPORARY",
    "INTERNSHIP": "INTERNSHIP", "INTERN": "INTERNSHIP",
    # PERMANENT resolved from live data (2026-07-17 scan: Indeed sends "Permanent" as a
    # job_type). It is a tenure axis, not an hours axis, so it maps to its own token
    # rather than being forced into FULL_TIME -- a permanent PART-time job exists, and
    # claiming FULL_TIME would assert something the source did not say. Ranked LOW in
    # EMPLOYMENT_PRECEDENCE so the common ["Full-time","Permanent"] combo still yields
    # FULL_TIME; PERMANENT surfaces only when it is the sole signal.
    "PERMANENT": "PERMANENT",
    "VOLUNTEER": "VOLUNTEER",
}

_WORKPLACE_VOCAB = {
    "REMOTE": "REMOTE", "FULLY_REMOTE": "REMOTE", "WORK_FROM_HOME": "REMOTE",
    "HYBRID": "HYBRID",
    # ON_SITE is not a duplicate of ONSITE: LinkedIn's label is literally "On-site",
    # which _norm_token folds to ON_SITE. Listing only ONSITE would null every LinkedIn
    # on-site posting *and* warn about it -- a spurious gap that looks like real
    # vocabulary drift. Both spellings are live.
    "ONSITE": "ONSITE", "ON_SITE": "ONSITE",
    "IN_PERSON": "ONSITE", "IN_OFFICE": "ONSITE",
    # LinkedIn sends its workplace enum as bare URNs, not localized labels. The live
    # payload (confirmed against a 2026-07-17 scan, 467 rows) is
    # {"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"} -- a URN-keyed map whose
    # VALUES are the same URN strings, with no localizedName anywhere. _as_values pulls the
    # value, _label_of passes the string through, _norm_token uppercases (":" survives), so
    # the token reaching this table is URN:LI:FS_WORKPLACETYPE:N. Map the enum codes
    # directly: they are locale-proof, unlike the "Remote"/"Hybrid"/"On-site" labels the
    # 031 fixture wrongly assumed LinkedIn would send. 1=onsite, 2=remote, 3=hybrid.
    "URN:LI:FS_WORKPLACETYPE:1": "ONSITE",
    "URN:LI:FS_WORKPLACETYPE:2": "REMOTE",
    "URN:LI:FS_WORKPLACETYPE:3": "HYBRID",
}

# Values a site legitimately uses that intentionally correspond to no canonical token.
# Closed set: a value not here and not in the vocab is unrecognized by definition.
_UNMAPPABLE = frozenset({"OTHER"})

# Salary provenance. Each state needs positive evidence: an unrecognized token yields
# None, never False. False is a claim -- "this site estimated the pay" -- and inferring
# it from a token we could not read would assert something unknown.
_SALARY_EMPLOYER = frozenset({
    "EMPLOYER", "EMPLOYER_PROVIDED", "EMPLOYER_PROVIDED_SALARY",
    # Indeed's salarySnippet.source = "EXTRACTION" (the entire Indeed salary population on
    # the 2026-07-17 scan). It means Indeed parsed the pay out of the job description --
    # employer-authored prose. The tri-state rule rules out False outright: EXTRACTION is
    # NOT a site estimate, so claiming False would assert something untrue. It counts as
    # employer-disclosed (True): the employer stated the pay, just in prose rather than a
    # structured field. salary_disclosed encodes provenance, not parse reliability.
    "EXTRACTION",
})
_SALARY_ESTIMATE = frozenset({
    "ESTIMATE", "ESTIMATED", "INDEED_ESTIMATE", "GLASSDOOR_ESTIMATE",
})

# Deliberately NOT mapped, pending evidence from a real scan: FREELANCE, PER_DIEM,
# APPRENTICESHIP, COMMISSION, NEW_GRAD. Each has a defensible mapping and a defensible
# objection (is FREELANCE a CONTRACT?). Guessing wrong writes a wrong token that no
# warning ever surfaces; leaving them unrecognized writes None and warns, which is
# visible and correctable. Resolve them with data, not argument.
#
# PERMANENT (employment_type) and EXTRACTION (salary_disclosed) were on this list until
# the 2026-07-17 scan attested both on live Indeed rows. Each is now resolved with data:
# PERMANENT -> its own employment token (a tenure axis, see _EMPLOYMENT_VOCAB); EXTRACTION
# -> True (employer-authored prose, see _SALARY_EMPLOYER). The warning each used to emit
# is what made them visible -- exactly the mechanism working as designed.


def _norm_token(raw: Any) -> str | None:
    """Normalize a source value to a matchable token, or None.

    Uppercase, trimmed, with spaces and hyphens folded to underscores, so "Full-time",
    "full time", and "FULL_TIME" are one token. Matching never depends on a site's
    casing or punctuation.
    """
    if raw is None or isinstance(raw, bool):
        return None
    if not isinstance(raw, str):
        return None
    token = raw.strip().upper().replace("-", "_").replace(" ", "_")
    return token or None


def _as_values(raw: Any) -> list[Any]:
    """Accept a scalar, a jsonb list, or a jsonb resolution map uniformly.

    Absent/empty yields no values: an empty container is absence, not a value -- the site
    said nothing, so there is nothing to warn about.

    The dict case is LinkedIn's. `workplace_types_labels` carries
    `workplaceTypesResolutionResults`, a resolution map keyed by URN. The live shape
    (confirmed against a 2026-07-17 scan) is a self-referential URN map, NOT the
    localizedName objects the 031 fixture assumed:

        {"*urn:li:fs_workplaceType:2": "urn:li:fs_workplaceType:2"}

    So the values are bare URN strings, which _label_of passes straight through and the
    vocabulary maps by enum code (URN:LI:FS_WORKPLACETYPE:N). The dict values may also be
    resolved-entity objects on other LinkedIn payloads (the standard localizedName shape
    company/title entities use); _label_of handles both. Reading the map's values is a
    container concern, not a vocabulary guess: whatever comes out still has to survive the
    mapping table below or warn.
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return list(raw)
    if isinstance(raw, dict):
        return list(raw.values())
    return [raw]


def _label_of(value: Any) -> Any:
    """Unwrap a resolved entity to its label; pass strings through untouched.

    A resolution map's values are objects, not strings. Prefer `localizedName` (LinkedIn's
    convention), then `name`. Anything else is returned as-is so the caller's shape check
    can report it rather than this function silently swallowing it.
    """
    if isinstance(value, dict):
        for key in ("localizedName", "name", "label"):
            label = value.get(key)
            if isinstance(label, str):
                return label
    return value


def _select_by_precedence(
    raw: Any,
    *,
    vocab: dict[str, str],
    precedence: tuple[str, ...],
    site: str,
    event: str,
) -> str | None:
    """Map a site's stated arrangement(s) onto one canonical token, or None.

    Classify every stated value first, then rank the mappable ones by `precedence`.
    Selection is over a set, never a sequence: the same values in any payload order
    yield the same token.
    """
    mapped: set[str] = set()
    for value in _as_values(raw):
        label = _label_of(value)
        token = _norm_token(label)
        if token is None:
            # A value we could not even read as text. NOT the same as absence, and it
            # must never pass silently: an unreadable *shape* (a jsonb object where a
            # label was expected, a number, a nested list) means the site changed its
            # payload structure, which nulls the column for every affected posting. A
            # silent skip here is the one failure mode nothing downstream can detect --
            # the review in FR-005d greps warnings, so a gap that does not warn is
            # invisible. An empty/blank string is genuinely absence and stays quiet.
            if label is not None and not (isinstance(label, str) and not label.strip()):
                logger.warning(
                    "projection_bad_value_shape %s",
                    {
                        "site": site,
                        "field": event.removeprefix("projection_unknown_"),
                        "raw": str(value)[:64],
                        "type": type(value).__name__,
                    },
                )
            continue
        canonical = vocab.get(token)
        if canonical is not None:
            mapped.add(canonical)
        elif token in _UNMAPPABLE:
            continue  # recognized, maps to nothing, and correctly so -- no warning
        else:
            logger.warning("%s %s", event, {"site": site, "raw": str(label)[:64]})
    for candidate in precedence:
        if candidate in mapped:
            return candidate
    return None


def normalize_employment_type(raw: Any, *, site: str) -> str | None:
    """Map a site's employment status onto the canonical six, or None.

    Single-valued: a posting tagged both Full-time and Part-time yields FULL_TIME and
    will NOT answer a part-time filter. The discarded value stays on the per-source row.
    """
    return _select_by_precedence(
        raw,
        vocab=_EMPLOYMENT_VOCAB,
        precedence=EMPLOYMENT_PRECEDENCE,
        site=site,
        event="projection_unknown_employment_type",
    )


def normalize_workplace_type(raw: Any, *, site: str) -> str | None:
    """Map a site's workplace arrangement onto REMOTE / HYBRID / ONSITE, or None.

    Precedence favours REMOTE, which trades recall on hybrid for recall on the
    most-used filter.
    """
    return _select_by_precedence(
        raw,
        vocab=_WORKPLACE_VOCAB,
        precedence=WORKPLACE_PRECEDENCE,
        site=site,
        event="projection_unknown_workplace_type",
    )


def derive_salary_disclosed(raw: Any, *, site: str) -> bool | None:
    """Decide who stated the salary: the employer (True), the site (False), or unknown.

    Positive evidence only. An unrecognized token yields None and warns rather than
    defaulting to False, which would claim the site published an estimate it never
    published.
    """
    token = _norm_token(raw)
    if token is None:
        return None
    if token in _SALARY_EMPLOYER:
        return True
    if token in _SALARY_ESTIMATE:
        return False
    logger.warning(
        "projection_unknown_salary_source %s",
        {"site": site, "raw": str(raw)[:64]},
    )
    return None


def normalize_language(raw: Any, *, site: str) -> str | None:
    """Reduce a language tag to its bare lowercase base code, or None.

    en-US / en_US / EN / en all yield "en". The region subtag is dropped: the canonical
    question is *which language*, not *which regional variant*, and keeping the subtag
    would split en from en-US into non-matching values for a distinction no filter has
    asked for. The site's exact tag stays on the per-source row.

    Validated for SHAPE, not membership: any 2-3 ASCII letters is accepted. There is no
    allow-list of real languages, and no inference from description text. The shape rule
    exists to reject a value that is obviously not a language code, not to adjudicate
    which languages exist.
    """
    if raw is None or isinstance(raw, bool) or not isinstance(raw, str):
        if raw is not None:
            logger.warning(
                "projection_bad_language %s",
                {"site": site, "raw": str(raw)[:64], "reason": "not_a_string"},
            )
        return None
    base = raw.strip().replace("_", "-").split("-", 1)[0].lower()
    if not base:
        return None  # absent/empty: the site said nothing -- not a warning
    if not (2 <= len(base) <= 3 and base.isascii() and base.isalpha()):
        logger.warning(
            "projection_bad_language %s",
            {"site": site, "raw": str(raw)[:64], "reason": "bad_shape"},
        )
        return None
    return base


def join_education_labels(raw: Any) -> str | None:
    """Join a site's education labels into one free-text value, or None.

    Every label is kept, in source order, joined by "; ". Nothing is ranked above
    anything else -- the column is free text precisely so it can carry what the site
    said, and ranking credentials would impose a normalization this feature declines to
    make.

    Never warns and never validates: any text a site supplies is valid by definition, so
    there is no such thing as an unrecognized value here.
    """
    labels = [
        value.strip()
        for value in _as_values(raw)
        if isinstance(value, str) and value.strip()
    ]
    if not labels:
        return None  # absent, empty, or all-blank: the site said nothing
    return "; ".join(labels)


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
    # Filter attributes (031). This list and every site projection must move together:
    # project_to_canonical raises on a mismatch, so a name added here without the
    # matching key in all three projections fails EVERY ingest, not just a test.
    "employment_type",
    "workplace_type",
    "language",
    "education_requirements",
    "salary_disclosed",
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
        "employment_type": normalize_employment_type(
            p.get("formatted_employment_status"), site="linkedin"
        ),
        # The labels win over work_remote_allowed. They are the more specific statement
        # and the only LinkedIn field that can express hybrid at all. `remote` keeps
        # reading the boolean (unchanged 030 behaviour), so the two columns are allowed
        # to disagree -- see _linkedin_workplace_type.
        "workplace_type": _linkedin_workplace_type(p),
        # LinkedIn supplies neither, so the mapping designates NULL rather than a
        # substitute -- the same call 030 made for Indeed's experience_level/industry.
        "language": None,
        "education_requirements": None,
        "salary_disclosed": p.get("salary_provided_by_employer"),
    }


def _linkedin_workplace_type(p: dict[str, Any]) -> str | None:
    """Project LinkedIn's workplace labels, warning when they contradict the boolean.

    LinkedIn states remoteness twice, in two independent fields, and they can flatly
    disagree: work_remote_allowed=False alongside workplace_types_labels=["Remote"].

    The labels win here. The contradiction is logged rather than resolved: it is an
    upstream data problem worth surfacing, not a reason to null the column or drop the
    posting. The event is named apart from the projection_unknown_* family on purpose --
    it reports a site contradicting itself, not a gap in our vocabulary, and folding it
    in would pollute the mapping review with warnings that need no mapping change.
    """
    labels = p.get("workplace_types_labels")
    workplace = normalize_workplace_type(labels, site="linkedin")
    remote_allowed = p.get("work_remote_allowed")
    if workplace is not None and isinstance(remote_allowed, bool):
        labels_say_remote = workplace == "REMOTE"
        if labels_say_remote != remote_allowed:
            logger.warning(
                "projection_workplace_remote_conflict %s",
                {
                    "site": "linkedin",
                    "remote_allowed": remote_allowed,
                    "labels": str(labels)[:64],
                    "workplace_type": workplace,
                },
            )
    return workplace


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
        "employment_type": normalize_employment_type(p.get("job_types"), site="indeed"),
        # Indeed exposes only remote / not-remote and cannot express hybrid, so an
        # Indeed posting that is in fact hybrid is recorded ONSITE. That is a WRONG
        # value rather than a missing one, and the only place this projection asserts
        # more than the site said -- accepted so that on-site filters return Indeed
        # results at all. Read ONSITE here as "not remote", not as confirmed on-site.
        "workplace_type": _indeed_workplace_type(p.get("remote_location")),
        "language": normalize_language(p.get("language"), site="indeed"),
        # Indeed exposes no education requirements; the mapping designates NULL.
        "education_requirements": None,
        "salary_disclosed": derive_salary_disclosed(
            p.get("salary_snippet_source"), site="indeed"
        ),
    }


def _indeed_workplace_type(remote_location: Any) -> str | None:
    """Map Indeed's remote boolean onto the canonical vocabulary.

    Not a tri-state pass-through: False becomes ONSITE, an assertion Indeed did not
    quite make (see _indeed_projection). Absent stays None -- the site said nothing.
    """
    if not isinstance(remote_location, bool):
        return None
    return "REMOTE" if remote_location else "ONSITE"


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
        # NAME COLLISION, read carefully: p["employment_type"] is Glassdoor's PER-SOURCE
        # jsonb list (the JSON-LD employmentType), while the "employment_type" key this
        # function returns is the CANONICAL token. Same word, two meanings, one dict.
        "employment_type": _glassdoor_employment_type(p),
        "workplace_type": normalize_workplace_type(
            p.get("remote_work_types"), site="glassdoor"
        ),
        # Glassdoor supplies no language; the mapping designates NULL.
        "language": None,
        # All education labels joined, else the experience prose.
        #
        # Known duplication: on that fallback this carries the same text as
        # experience_level above, which projects the same source field. Accepted
        # deliberately, to populate education_requirements for more Glassdoor rows. Two
        # consequences: a consumer filtering education will match experience prose that
        # states no education requirement, and the two columns agreeing is not
        # corroboration -- it is one value counted twice. experience_level must not
        # change to accommodate this.
        "education_requirements": _glassdoor_education(p),
        # KNOWN LIMITATION, verified and inherited rather than introduced:
        # salary_source comes from jobDetailsData, while this row's salary_min/max come
        # from the employer-authored JSON-LD baseSalary -- two different payloads. So a
        # Glassdoor row can carry employer-sourced amounts flagged as a site estimate,
        # or the reverse. 030 already splits this way (salary_period reads
        # jobDetailsData.payPeriod while the amounts read JSON-LD), so 031 adds a fourth
        # column to an existing split. Reconciling it would change shipped 030 semantics
        # under a feature that promises to be additive; do not "fix" it here.
        "salary_disclosed": derive_salary_disclosed(
            p.get("salary_source"), site="glassdoor"
        ),
    }


def _glassdoor_education(p: dict[str, Any]) -> str | None:
    """Project Glassdoor's education requirements: labels first, experience prose next.

    Blank is absence, not a value: an experience description of "" or "   " yields None
    rather than an empty string, because the canonical row permits exactly a value or
    NULL -- no third state.
    """
    joined = join_education_labels(p.get("education_labels"))
    if joined is not None:
        return joined
    fallback = p.get("experience_requirements_description")
    if isinstance(fallback, str) and fallback.strip():
        return fallback
    return None


def _glassdoor_employment_type(p: dict[str, Any]) -> str | None:
    """Project Glassdoor's employment type: structured field first, header as fallback.

    Glassdoor states employment type in two independent fields. The structured one
    (JSON-LD employmentType) wins OUTRIGHT: when it is present the header job_type is
    ignored entirely, and the two are never merged into one selection.

    "Present" means non-empty. An empty list is absence -- the site said nothing there,
    so the fallback fires. A structured field holding only "OTHER" is *present* and
    answered, so it does NOT fall back: it yields None, silently.
    """
    structured = p.get("employment_type")  # per-source jsonb list, not the canonical col
    if _as_values(structured):
        return normalize_employment_type(structured, site="glassdoor")
    return normalize_employment_type(p.get("job_type"), site="glassdoor")


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
