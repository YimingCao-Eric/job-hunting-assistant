"""dedup_similarity_score and dedup_reports

Revision ID: 011
Revises: 010
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column("dedup_similarity_score", sa.Float(), nullable=True),
    )

    op.create_table(
        "dedup_reports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("scan_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("trigger", sa.String(), nullable=False),
        sa.Column("total_processed", sa.Integer(), nullable=False),
        sa.Column("total_flagged", sa.Integer(), nullable=False),
        sa.Column("total_passed", sa.Integer(), nullable=False),
        sa.Column(
            "gate_results",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "skip_reason_counts",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["scan_run_id"],
            ["extension_run_logs.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_scraped_jobs_job_url "
        "ON scraped_jobs (job_url)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_scraped_jobs_raw_description_hash "
        "ON scraped_jobs (raw_description_hash)"
    )


def downgrade() -> None:
    op.drop_table("dedup_reports")
    op.drop_column("scraped_jobs", "dedup_similarity_score")
