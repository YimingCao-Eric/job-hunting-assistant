"""job_reports — user issue reports per job

Revision ID: 019
Revises: 018
Create Date: 2026-04-16
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "job_reports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("report_type", sa.String(), nullable=False),
        sa.Column(
            "detail",
            JSONB,
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("actioned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["scraped_jobs.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_job_reports_job_id", "job_reports", ["job_id"])
    op.create_index("ix_job_reports_status", "job_reports", ["status"])
    op.create_index("ix_job_reports_report_type", "job_reports", ["report_type"])
    op.create_index(
        "uq_job_reports_job_type_pending",
        "job_reports",
        ["job_id", "report_type"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_job_reports_job_type_pending", table_name="job_reports")
    op.drop_index("ix_job_reports_report_type", table_name="job_reports")
    op.drop_index("ix_job_reports_status", table_name="job_reports")
    op.drop_index("ix_job_reports_job_id", table_name="job_reports")
    op.drop_table("job_reports")
