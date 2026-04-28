"""dedup_tasks table for crash recovery (B-18)

Revision ID: 022
Revises: 021
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dedup_tasks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scan_run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("extension_run_logs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_heartbeat_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("trigger", sa.String(), nullable=True),
    )
    op.create_index("ix_dedup_tasks_status", "dedup_tasks", ["status"])
    op.create_index("ix_dedup_tasks_scan_run_id", "dedup_tasks", ["scan_run_id"])


def downgrade() -> None:
    op.drop_index("ix_dedup_tasks_scan_run_id", table_name="dedup_tasks")
    op.drop_index("ix_dedup_tasks_status", table_name="dedup_tasks")
    op.drop_table("dedup_tasks")
