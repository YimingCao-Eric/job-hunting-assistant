"""matching columns on scraped_jobs and match_reports table

Revision ID: 014
Revises: 013
Create Date: 2026-04-08

Adds only columns that are not already present from 001+ (see scraped_jobs).
Existing: match_level, match_reason, fit_score, req_coverage, confidence,
required_skills, nice_to_have_skills, critical_skills, extracted_yoe,
salary_min_extracted, salary_max_extracted, remote_type, seniority_level,
job_type, jd_incomplete, matched_at, match_skip_reason (010).

New: extracted_seniority, education_req_degree, education_req_field, visa_req,
blocking_gap, gap_adjacency, matching_mode.

Also creates match_reports.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _cols(table: str) -> set[str]:
    bind = op.get_bind()
    return {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    cols = _cols("scraped_jobs")

    if "extracted_seniority" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("extracted_seniority", sa.String(), nullable=True),
        )
    if "education_req_degree" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("education_req_degree", sa.String(), nullable=True),
        )
    if "education_req_field" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("education_req_field", sa.String(), nullable=True),
        )
    if "visa_req" not in cols:
        op.add_column("scraped_jobs", sa.Column("visa_req", sa.String(), nullable=True))
    if "blocking_gap" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("blocking_gap", sa.String(), nullable=True),
        )
    if "gap_adjacency" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column(
                "gap_adjacency",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
        )
    if "matching_mode" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("matching_mode", sa.String(), nullable=True),
        )

    bind = op.get_bind()
    inspector = inspect(bind)
    if "match_reports" not in inspector.get_table_names():
        op.create_table(
            "match_reports",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column(
                "dedup_run_id",
                sa.Integer(),
                nullable=True,
            ),
            sa.Column("trigger", sa.String(), nullable=False),
            sa.Column("matching_mode", sa.String(), nullable=False),
            sa.Column(
                "total_processed",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "total_gate_skipped",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "total_cpu_decided",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "total_llm_scored",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "total_failed",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "match_level_counts",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
            sa.Column(
                "gate_skip_counts",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["dedup_run_id"],
                ["dedup_reports.id"],
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "match_reports" in inspector.get_table_names():
        op.drop_table("match_reports")

    cols = _cols("scraped_jobs")
    for name in (
        "matching_mode",
        "gap_adjacency",
        "blocking_gap",
        "visa_req",
        "education_req_field",
        "education_req_degree",
        "extracted_seniority",
    ):
        if name in cols:
            op.drop_column("scraped_jobs", name)
