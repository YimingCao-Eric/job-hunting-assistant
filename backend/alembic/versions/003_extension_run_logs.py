"""create extension_run_logs table and add FK from scraped_jobs

Revision ID: 003
Revises: 002
Create Date: 2025-01-01 00:00:02.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "extension_run_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("strategy", sa.String(), nullable=False, server_default="C"),
        sa.Column("status", sa.String(), nullable=False, server_default="running"),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pages_scanned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("scraped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("new_jobs", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("existing", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stale_skipped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("jd_failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("early_stop", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("session_error", sa.String(), nullable=True),
        sa.Column("search_keyword", sa.String(), nullable=True),
        sa.Column("search_location", sa.String(), nullable=True),
        sa.Column("search_filters", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index("ix_extension_run_logs_started_at", "extension_run_logs", ["started_at"])

    op.create_foreign_key(
        "fk_scraped_jobs_scan_run_id",
        "scraped_jobs",
        "extension_run_logs",
        ["scan_run_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_scraped_jobs_scan_run_id", "scraped_jobs", type_="foreignkey")
    op.drop_index("ix_extension_run_logs_started_at", table_name="extension_run_logs")
    op.drop_table("extension_run_logs")
