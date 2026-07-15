from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_serializer


class ScrapedJobIngest(BaseModel):
    website: str = "linkedin"
    scan_run_id: UUID | None = None
    # Site-specific raw response. Required for ingest; a request without it is rejected.
    # What gets extracted from each site's shape is defined by build_linkedin_params /
    # build_indeed_params / build_glassdoor_params in routers/jobs.py, and the per-source
    # columns those feed are catalogued in docs/live-per-source-schemas.md.
    source_raw: dict | None = None

    # Legacy fields. The extension still sends these, so they stay on the model, but the
    # per-source ingest path ignores every one of them -- the site payload in source_raw
    # is the only input it reads. `skip_reason` is the exception: it still selects the
    # no-op branch that acknowledges a skipped card without recording it.
    # These can go once the extension stops sending them.
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    job_description: str | None = None
    job_url: str | None = None
    apply_url: str | None = None
    easy_apply: bool = False
    post_datetime: datetime | None = None
    search_filters: dict | None = None
    voyager_raw: dict | None = None
    skip_reason: str | None = None
    original_job_id: UUID | None = None


class ScrapedJobIngestResponse(BaseModel):
    id: UUID
    already_exists: bool
    content_duplicate: bool
    skip_reason: str | None = None


class ScrapedJobRead(BaseModel):
    """A canonical scraped posting, site-agnostic.

    Field names are the unified store's, replacing the retired store's LinkedIn-shaped
    vocabulary (website -> source_site, job_title -> title, location -> location_text,
    job_description -> description, post_datetime -> posted_at, created_at -> scrape_time).
    """

    model_config = ConfigDict(from_attributes=True)

    # Provenance
    id: UUID
    source_site: str
    source_row_id: UUID
    site_job_id: str | None = None
    scan_run_id: UUID
    job_url: str
    scrape_time: datetime

    # State
    matched: bool
    dismissed: bool

    # Business fields
    title: str | None = None
    company: str | None = None
    location_text: str | None = None
    description: str | None = None
    # Tri-state: True / False / None (the site did not say).
    remote: bool | None = None
    apply_url: str | None = None
    experience_level: str | None = None
    industry: str | None = None

    # Salary, as the source quoted it against its normalized period — never converted.
    salary_min: Decimal | None = None
    salary_max: Decimal | None = None
    salary_currency: str | None = None
    salary_period: str | None = None

    posted_at: datetime | None = None

    @field_serializer("salary_min", "salary_max")
    def _plain_decimal(self, v: Decimal | None) -> str | None:
        """Emit salaries in plain notation, never scientific.

        asyncpg decodes Postgres NUMERIC into a Decimal whose exponent may be positive
        for round numbers -- 120000 comes back as Decimal('1.2E+5'). The value is
        correct, but Pydantic serializes Decimal via str(), so the JSON would carry
        "1.2E+5" for a round salary and "55" for a non-round one: two formats from one
        field, and the scientific one is a parsing trap for any consumer.
        """
        return None if v is None else format(v, "f")


class JobsListResponse(BaseModel):
    items: list[ScrapedJobRead]
    total: int
    limit: int
    offset: int


class JobUpdate(BaseModel):
    """Partial update for PUT /jobs/{job_id}. Omitted fields are left unchanged."""

    dismissed: bool | None = None
