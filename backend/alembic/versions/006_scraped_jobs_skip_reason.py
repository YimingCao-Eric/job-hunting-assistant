"""add skip_reason column to scraped_jobs

Revision ID: 006
Revises: 005
Create Date: 2025-01-01 00:00:05.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column("skip_reason", sa.String(), nullable=True),
    )
    op.create_index("ix_scraped_jobs_skip_reason", "scraped_jobs", ["skip_reason"])


def downgrade() -> None:
    op.drop_index("ix_scraped_jobs_skip_reason", table_name="scraped_jobs")
    op.drop_column("scraped_jobs", "skip_reason")
