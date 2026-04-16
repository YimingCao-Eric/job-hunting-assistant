"""education_field_qualified on scraped_jobs

Revision ID: 015
Revises: 014
Create Date: 2026-04-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("scraped_jobs")}
    if "education_field_qualified" not in cols:
        op.add_column(
            "scraped_jobs",
            sa.Column("education_field_qualified", sa.Boolean(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("scraped_jobs")}
    if "education_field_qualified" in cols:
        op.drop_column("scraped_jobs", "education_field_qualified")
