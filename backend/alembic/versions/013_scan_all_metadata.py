"""scan_all metadata on extension_run_logs and extension_state

Revision ID: 013
Revises: 012
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "extension_run_logs",
        sa.Column("scan_all", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("extension_run_logs", sa.Column("scan_all_position", sa.Integer(), nullable=True))
    op.add_column("extension_run_logs", sa.Column("scan_all_total", sa.Integer(), nullable=True))

    op.add_column(
        "extension_state",
        sa.Column("scan_all", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("extension_state", sa.Column("scan_all_position", sa.Integer(), nullable=True))
    op.add_column("extension_state", sa.Column("scan_all_total", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("extension_state", "scan_all_total")
    op.drop_column("extension_state", "scan_all_position")
    op.drop_column("extension_state", "scan_all")

    op.drop_column("extension_run_logs", "scan_all_total")
    op.drop_column("extension_run_logs", "scan_all_position")
    op.drop_column("extension_run_logs", "scan_all")
