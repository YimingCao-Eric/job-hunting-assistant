"""Allow NULL scan_run_id on dedup_tasks for global post-cycle dedup

Revision ID: 024
Revises: 023
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "024"
down_revision: Union[str, None] = "023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "dedup_tasks",
        "scan_run_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "dedup_tasks",
        "scan_run_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
