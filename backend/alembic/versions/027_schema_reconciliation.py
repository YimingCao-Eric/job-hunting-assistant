"""schema_reconciliation

Drop surplus columns from per-source scrape tables per docs/step1-source-tables.md
("Other previously-dropped fields"). Uses DROP COLUMN IF EXISTS.

linkedin_jobs.job_url is intentionally NOT dropped here — ingest still relies on
UNIQUE(job_url) and ON CONFLICT (job_url); reconcile with job_posting_url in a
follow-up migration after code changes.

Revision ID: 027
Revises: 026
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "027"
down_revision: Union[str, None] = "026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LINKEDIN_DROPS = [
    "benefits",
    "employment_status_entity_urn",
    "employment_status_label",
    "job_region",
    "postal_address",
    "standardized_addresses",
    "title_entity_urn",
    "top_level_company_apply_url",
    "workplace_type_entity_urn",
]

INDEED_DROPS = [
    "display_title",
    "graphql_expired",
    "graphql_location_admin1_code",
    "graphql_location_city",
    "graphql_location_postal_code",
    "graphql_salary_period",
    "graphql_title",
    "indeed_applyable",
    "salary_text",
]

GLASSDOOR_DROPS = [
    "discover_date",
    "education_requirements_credential",
    "experience_requirements_months",
    "header_easy_apply",
    "header_expired",
    "header_salary_currency",
    "header_salary_period",
    "header_salary_source",
    "job_description_plain",
    "job_title",
    "job_title_text",
    "jobview_job_description",
    "jsonld_salary_currency",
    "jsonld_salary_period",
    "map_address",
    "map_employer",
    "map_location_name",
    "map_postal_code",
    "salary_currency",
    "valid_through",
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
        "Schema reconciliation drops are one-way. Restore from backup if needed."
    )
