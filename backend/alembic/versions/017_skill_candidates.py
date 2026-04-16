"""skill_candidates table for skill discovery / alias evolution

Revision ID: 017
Revises: 016
Create Date: 2026-04-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "skill_candidates",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("skill_name", sa.String(), nullable=False),
        sa.Column("count", sa.Integer(), server_default="1", nullable=False),
        sa.Column("req_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("nth_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("in_aliases", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("suggested_canonical", sa.String(), nullable=True),
        sa.Column("merge_target", sa.String(), nullable=True),
        sa.Column(
            "first_seen",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_skill_candidates_skill_name",
        "skill_candidates",
        ["skill_name"],
        unique=True,
    )
    op.create_index("ix_skill_candidates_count", "skill_candidates", ["count"])
    op.create_index("ix_skill_candidates_status", "skill_candidates", ["status"])
    op.create_index(
        "ix_skill_candidates_in_aliases",
        "skill_candidates",
        ["in_aliases"],
    )


def downgrade() -> None:
    op.drop_index("ix_skill_candidates_in_aliases", table_name="skill_candidates")
    op.drop_index("ix_skill_candidates_status", table_name="skill_candidates")
    op.drop_index("ix_skill_candidates_count", table_name="skill_candidates")
    op.drop_index("ix_skill_candidates_skill_name", table_name="skill_candidates")
    op.drop_table("skill_candidates")
