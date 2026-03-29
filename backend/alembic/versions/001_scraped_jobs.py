"""create scraped_jobs table

Revision ID: 001
Revises:
Create Date: 2025-01-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scraped_jobs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("website", sa.String(), nullable=False, server_default="linkedin"),
        sa.Column("job_title", sa.String(), nullable=False),
        sa.Column("company", sa.String(), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("job_description", sa.Text(), nullable=True),
        sa.Column("job_url", sa.String(), nullable=True),
        sa.Column("apply_url", sa.String(), nullable=True),
        sa.Column("easy_apply", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("post_datetime", sa.DateTime(timezone=True), nullable=True),
        sa.Column("search_filters", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("voyager_raw", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("raw_description_hash", sa.String(64), nullable=True),
        sa.Column("ingest_source", sa.String(), nullable=False, server_default="extension"),
        # FK added in migration 003 after extension_run_logs exists
        sa.Column("scan_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default="false"),
        # Step 3 matching columns
        sa.Column("match_level", sa.String(), nullable=True),
        sa.Column("match_reason", sa.Text(), nullable=True),
        sa.Column("fit_score", sa.Float(), nullable=True),
        sa.Column("req_coverage", sa.Float(), nullable=True),
        sa.Column("confidence", sa.String(), nullable=True),
        sa.Column("skipped_reason", sa.String(), nullable=True),
        sa.Column("required_skills", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("nice_to_have_skills", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("critical_skills", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("extracted_yoe", sa.Float(), nullable=True),
        sa.Column("salary_min_extracted", sa.Float(), nullable=True),
        sa.Column("salary_max_extracted", sa.Float(), nullable=True),
        sa.Column("remote_type", sa.String(), nullable=True),
        sa.Column("seniority_level", sa.String(), nullable=True),
        sa.Column("job_type", sa.String(), nullable=True),
        sa.Column("jd_incomplete", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_unique_constraint("ix_scraped_jobs_job_url", "scraped_jobs", ["job_url"])
    op.create_index("ix_scraped_jobs_raw_description_hash", "scraped_jobs", ["raw_description_hash"])
    op.create_index("ix_scraped_jobs_company_title", "scraped_jobs", ["company", "job_title"])
    op.create_index("ix_scraped_jobs_post_datetime", "scraped_jobs", ["post_datetime"])
    op.create_index("ix_scraped_jobs_scan_run_id", "scraped_jobs", ["scan_run_id"])
    op.create_index("ix_scraped_jobs_dismissed", "scraped_jobs", ["dismissed"])
    op.create_index("ix_scraped_jobs_match_level", "scraped_jobs", ["match_level"])
    op.create_index("ix_scraped_jobs_matched_at", "scraped_jobs", ["matched_at"])


def downgrade() -> None:
    op.drop_index("ix_scraped_jobs_matched_at", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_match_level", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_dismissed", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_scan_run_id", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_post_datetime", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_company_title", table_name="scraped_jobs")
    op.drop_index("ix_scraped_jobs_raw_description_hash", table_name="scraped_jobs")
    op.drop_constraint("ix_scraped_jobs_job_url", "scraped_jobs", type_="unique")
    op.drop_table("scraped_jobs")
