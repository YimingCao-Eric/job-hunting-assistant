"""create extension_state table

Revision ID: 002
Revises: 001
Create Date: 2025-01-01 00:00:01.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "extension_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("current_search_date", sa.String(), nullable=True),
        sa.Column("current_page", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("search_exhausted", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("consecutive_empty_runs", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_search_time", sa.String(), nullable=True),
        sa.Column("today_searches", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.execute(
        "INSERT INTO extension_state "
        "(id, current_page, search_exhausted, consecutive_empty_runs, today_searches) "
        "VALUES (1, 1, false, 0, 0)"
    )


def downgrade() -> None:
    op.drop_table("extension_state")
