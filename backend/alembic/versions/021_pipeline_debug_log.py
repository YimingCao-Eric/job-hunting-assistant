"""dedup_reports.debug_log, match_reports.debug_log — per-run trace JSONB

Revision ID: 021
Revises: 020
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("dedup_reports", sa.Column("debug_log", JSONB, nullable=True))
    op.add_column("match_reports", sa.Column("debug_log", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("match_reports", "debug_log")
    op.drop_column("dedup_reports", "debug_log")
