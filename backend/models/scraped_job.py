import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from core.database import Base


class ScrapedJob(Base):
    __tablename__ = "scraped_jobs"

    __table_args__ = (
        UniqueConstraint("job_url", name="ix_scraped_jobs_job_url"),
        Index("ix_scraped_jobs_raw_description_hash", "raw_description_hash"),
        Index("ix_scraped_jobs_company_title", "company", "job_title"),
        Index("ix_scraped_jobs_post_datetime", "post_datetime"),
        Index("ix_scraped_jobs_scan_run_id", "scan_run_id"),
        Index("ix_scraped_jobs_dismissed", "dismissed"),
        Index("ix_scraped_jobs_match_level", "match_level"),
        Index("ix_scraped_jobs_matched_at", "matched_at"),
        Index("ix_scraped_jobs_skip_reason", "skip_reason"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    website: Mapped[str] = mapped_column(String, nullable=False, default="linkedin")
    job_title: Mapped[str] = mapped_column(String, nullable=False)
    company: Mapped[str | None] = mapped_column(String, nullable=True)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    job_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_url: Mapped[str | None] = mapped_column(String, nullable=True, unique=True)
    apply_url: Mapped[str | None] = mapped_column(String, nullable=True)
    easy_apply: Mapped[bool] = mapped_column(Boolean, default=False)
    post_datetime: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    search_filters: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    voyager_raw: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_description_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    ingest_source: Mapped[str] = mapped_column(
        String, default="extension", server_default=text("'extension'")
    )
    scan_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("extension_run_logs.id"),
        nullable=True,
    )
    original_job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "scraped_jobs.id",
            use_alter=True,
            name="fk_scraped_jobs_original_job_id",
        ),
        nullable=True,
    )
    dismissed: Mapped[bool] = mapped_column(Boolean, default=False)
    skip_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    dedup_similarity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    dedup_original_job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scraped_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Step 3 matching columns
    match_level: Mapped[str | None] = mapped_column(String, nullable=True)
    match_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    fit_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    req_coverage: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[str | None] = mapped_column(String, nullable=True)
    # Matching-phase skip — set by the LLM matching pipeline when a job is
    # filtered out post-scrape (e.g. wrong seniority, outside salary range).
    # Distinct from skip_reason (scrape-time skip: phantom, duplicate, etc.).
    match_skip_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    required_skills: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    nice_to_have_skills: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    critical_skills: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    extracted_yoe: Mapped[float | None] = mapped_column(Float, nullable=True)
    salary_min_extracted: Mapped[float | None] = mapped_column(Float, nullable=True)
    salary_max_extracted: Mapped[float | None] = mapped_column(Float, nullable=True)
    remote_type: Mapped[str | None] = mapped_column(String, nullable=True)
    seniority_level: Mapped[str | None] = mapped_column(String, nullable=True)
    job_type: Mapped[str | None] = mapped_column(String, nullable=True)
    jd_incomplete: Mapped[bool] = mapped_column(Boolean, default=False)
    matched_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
