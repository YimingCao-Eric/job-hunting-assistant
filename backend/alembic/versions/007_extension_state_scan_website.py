"""add scan_website column to extension_state

Revision ID: 007
Revises: 006
Create Date: 2026-03-27 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "extension_state",
        sa.Column("scan_website", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("extension_state", "scan_website")
