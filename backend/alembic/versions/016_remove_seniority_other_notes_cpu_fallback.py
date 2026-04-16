"""Drop extracted_seniority; add other_notes; match_reports.total_cpu_fallback

Revision ID: 016
Revises: 015
Create Date: 2026-04-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    sj_cols = {c["name"] for c in inspect(bind).get_columns("scraped_jobs")}
    if "extracted_seniority" in sj_cols:
        op.drop_column("scraped_jobs", "extracted_seniority")
    if "other_notes" not in sj_cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("other_notes", sa.Text(), nullable=True),
        )

    mr_cols = {c["name"] for c in inspect(bind).get_columns("match_reports")}
    if "total_cpu_fallback" not in mr_cols:
        op.add_column(
            "match_reports",
            sa.Column(
                "total_cpu_fallback",
                sa.Integer(),
                server_default="0",
                nullable=False,
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    mr_cols = {c["name"] for c in inspect(bind).get_columns("match_reports")}
    if "total_cpu_fallback" in mr_cols:
        op.drop_column("match_reports", "total_cpu_fallback")

    sj_cols = {c["name"] for c in inspect(bind).get_columns("scraped_jobs")}
    if "other_notes" in sj_cols:
        op.drop_column("scraped_jobs", "other_notes")
    if "extracted_seniority" not in sj_cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("extracted_seniority", sa.String(), nullable=True),
        )
