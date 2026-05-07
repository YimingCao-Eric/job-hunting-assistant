"""Add matched column to per-source scrape tables

Revision ID: 028
Revises: 027
Create Date: 2026-05-05
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs"):
        op.execute(
            text(
                f"ALTER TABLE {table} ADD COLUMN matched BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )


def downgrade() -> None:
    for table in ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs"):
        op.execute(text(f"ALTER TABLE {table} DROP COLUMN IF EXISTS matched"))
