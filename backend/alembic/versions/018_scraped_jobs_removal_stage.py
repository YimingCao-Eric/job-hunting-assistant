"""scraped_jobs.removal_stage — pipeline stage that removed job

Revision ID: 018
Revises: 017
Create Date: 2026-04-15
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column("removal_stage", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scraped_jobs", "removal_stage")
