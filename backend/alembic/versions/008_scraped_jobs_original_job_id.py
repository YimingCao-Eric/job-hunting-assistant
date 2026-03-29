"""add original_job_id self-FK to scraped_jobs

Revision ID: 008
Revises: 007
Create Date: 2026-03-27 00:00:01.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column("original_job_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_scraped_jobs_original_job_id",
        "scraped_jobs",
        "scraped_jobs",
        ["original_job_id"],
        ["id"],
        use_alter=True,
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_scraped_jobs_original_job_id",
        "scraped_jobs",
        type_="foreignkey",
    )
    op.drop_column("scraped_jobs", "original_job_id")
