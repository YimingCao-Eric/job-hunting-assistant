"""cycle5_drops

Drop cycle-5 user-instructed columns from per-source scrape tables.
Spec: docs/step1-source-tables.md (cycle 5).

LinkedIn (4):
  expire_at, job_state, job_application_limit_reached, closed_at
Indeed (8):
  create_date, graphql_date_published, graphql_date_on_indeed,
  expired, match_negative_taxonomy, match_mismatching_entities,
  more_loc_url, apply_count
Glassdoor (2):
  expired, employer_active_status

Total: 14 columns dropped.

Uses DROP COLUMN IF EXISTS so upgrade is safe when a database already
had these columns removed outside Alembic or via a partial apply.

Revision ID: 026
Revises: 025
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "026"
down_revision: Union[str, None] = "025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LINKEDIN_DROPS = [
    "expire_at",
    "job_state",
    "job_application_limit_reached",
    "closed_at",
]

INDEED_DROPS = [
    "create_date",
    "graphql_date_published",
    "graphql_date_on_indeed",
    "expired",
    "match_negative_taxonomy",
    "match_mismatching_entities",
    "more_loc_url",
    "apply_count",
]

GLASSDOOR_DROPS = [
    "expired",
    "employer_active_status",
]


def upgrade() -> None:
    conn = op.get_bind()
    for table, cols in (
        ("linkedin_jobs", LINKEDIN_DROPS),
        ("indeed_jobs", INDEED_DROPS),
        ("glassdoor_jobs", GLASSDOOR_DROPS),
    ):
        for col in cols:
            conn.execute(sa.text(f'ALTER TABLE "{table}" DROP COLUMN IF EXISTS "{col}"'))


def downgrade() -> None:
    raise NotImplementedError(
        "Cycle-5 drops are one-way. Restore from a pre-migration "
        "backup if needed."
    )
