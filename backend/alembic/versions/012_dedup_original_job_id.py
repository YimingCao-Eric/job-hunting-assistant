"""add dedup_original_job_id to scraped_jobs

Revision ID: 012
Revises: 011
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column(
            "dedup_original_job_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_scraped_jobs_dedup_original_job_id",
        "scraped_jobs",
        "scraped_jobs",
        ["dedup_original_job_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_scraped_jobs_dedup_original_job_id",
        "scraped_jobs",
        type_="foreignkey",
    )
    op.drop_column("scraped_jobs", "dedup_original_job_id")
