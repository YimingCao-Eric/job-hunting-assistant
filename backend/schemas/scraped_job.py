from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ScrapedJobIngest(BaseModel):
    website: str = "linkedin"
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    # Nullable — JD may be missing; extension should skip ingest when empty when possible
    job_description: str | None = None
    job_url: str | None = None
    apply_url: str | None = None
    easy_apply: bool = False
    post_datetime: datetime | None = None
    search_filters: dict | None = None
    voyager_raw: dict | None = None
    scan_run_id: UUID | None = None
    skip_reason: str | None = None
    original_job_id: UUID | None = None


class ScrapedJobIngestResponse(BaseModel):
    id: UUID
    already_exists: bool
    content_duplicate: bool
    skip_reason: str | None = None


class ScrapedJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    website: str
    job_title: str
    company: str | None = None
    location: str | None = None
    job_description: str | None = None
    job_url: str | None = None
    apply_url: str | None = None
    easy_apply: bool
    post_datetime: datetime | None = None
    search_filters: dict | None = None
    raw_description_hash: str | None = None
    ingest_source: str
    scan_run_id: UUID | None = None
    original_job_id: UUID | None = None
    dismissed: bool
    skip_reason: str | None = None
    dedup_similarity_score: float | None = None
    dedup_original_job_id: UUID | None = None
    created_at: datetime
    updated_at: datetime

    match_level: str | None = None
    match_reason: str | None = None
    fit_score: float | None = None
    req_coverage: float | None = None
    confidence: str | None = None
    match_skip_reason: str | None = None
    required_skills: dict | None = None
    nice_to_have_skills: dict | None = None
    critical_skills: dict | None = None
    extracted_yoe: float | None = None
    salary_min_extracted: float | None = None
    salary_max_extracted: float | None = None
    remote_type: str | None = None
    seniority_level: str | None = None
    job_type: str | None = None
    jd_incomplete: bool
    matched_at: datetime | None = None


class JobsListResponse(BaseModel):
    items: list[ScrapedJobRead]
    total: int
    limit: int
    offset: int


class ScrapedJobDetail(ScrapedJobRead):
    """Full detail including voyager_raw — used for GET /jobs/{id}."""

    voyager_raw: dict | None = None


class JobUpdate(BaseModel):
    """Partial update for PUT /jobs/{job_id}. Omitted fields are left unchanged."""

    dismissed: bool | None = None

    fit_score: float | None = None
    match_level: str | None = None
    match_reason: str | None = None
    required_skills: dict | None = None
    nice_to_have_skills: dict | None = None
    critical_skills: dict | None = None
    extracted_yoe: float | None = None
    seniority_level: str | None = None
    job_type: str | None = None
    remote_type: str | None = None
    salary_min_extracted: float | None = None
    salary_max_extracted: float | None = None
    confidence: str | None = None
    req_coverage: float | None = None
    matched_at: datetime | None = None
    jd_incomplete: bool | None = None
    match_skip_reason: str | None = None
