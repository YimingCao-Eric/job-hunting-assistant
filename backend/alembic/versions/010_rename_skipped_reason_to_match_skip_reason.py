"""rename skipped_reason to match_skip_reason on scraped_jobs

Revision ID: 010
Revises: 009
Create Date: 2026-03-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        'ALTER TABLE scraped_jobs RENAME COLUMN skipped_reason TO match_skip_reason'
    )


def downgrade() -> None:
    op.execute(
        'ALTER TABLE scraped_jobs RENAME COLUMN match_skip_reason TO skipped_reason'
    )
