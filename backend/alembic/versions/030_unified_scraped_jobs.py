"""unified_scraped_jobs

Redesign scraped_jobs into a unified, site-agnostic table populated by dual-write at
ingest. Replaces the legacy LinkedIn-shaped table (48 columns of single-site vocabulary
plus retired dedup/matching attributes) with one canonical row per posting per site.

Drop-and-recreate is safe: the legacy table holds 0 rows, so there is nothing to
preserve and no backfill is owed.

ONE-WAY MIGRATION. downgrade() does not restore the legacy schema — see below.

Revision ID: 030
Revises: 029
Create Date: 2026-07-15
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "030"
down_revision: Union[str, None] = "029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS scraped_jobs CASCADE"))

    op.execute(
        text("""
CREATE TABLE scraped_jobs (
    -- Provenance.
    -- source_site alone identifies the origin table; there is deliberately no
    -- source_table column.
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_site         VARCHAR(16) NOT NULL,
    -- Polymorphic: references linkedin_jobs | indeed_jobs | glassdoor_jobs depending
    -- on source_site. A Postgres FK targets exactly one table, so NO foreign key and
    -- NO ON DELETE CASCADE is possible here. The 1:1 correspondence with the
    -- per-source row is a code invariant, upheld by matched predicates at ingest,
    -- claim, and auto-expiration -- not by the database.
    source_row_id       UUID NOT NULL,
    site_job_id         VARCHAR(32),
    scan_run_id         UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url             VARCHAR(2048) NOT NULL UNIQUE,
    -- Always written explicitly from the per-source row's scrape_time, never allowed
    -- to fall back on this default. Auto-expiration deletes from this table using the
    -- same predicate as the per-source tables, so the two values must be identical.
    scrape_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Mutable state. Exactly three mutations are permitted on this table: the matched
    -- claim-flip (kept in sync with the per-source row), the user-set dismissed flag,
    -- and auto-expiration DELETE. No other in-place update.
    matched             BOOLEAN NOT NULL DEFAULT FALSE,
    dismissed           BOOLEAN NOT NULL DEFAULT FALSE,

    -- Canonical business fields.
    title               TEXT,
    company             TEXT,
    location_text       TEXT,
    description         TEXT,
    -- Tri-state: TRUE / FALSE / NULL. NULL means the site did not say, which is not
    -- the same claim as "not remote".
    remote              BOOLEAN,
    apply_url           TEXT,
    experience_level    TEXT,
    industry            TEXT,

    -- Salary. Amounts are stored as the source quoted them, against the normalized
    -- period; never converted between periods or annualized.
    salary_min          NUMERIC,
    salary_max          NUMERIC,
    salary_currency     VARCHAR(3),
    -- Normalized vocabulary, exactly five values:
    -- HOURLY | DAILY | WEEKLY | MONTHLY | ANNUAL. NULL when the source token is
    -- unrecognized (amounts are still retained).
    salary_period       VARCHAR(16),

    -- Normalized to one point-in-time representation across all three sites.
    posted_at           TIMESTAMPTZ

    -- No source_raw: raw payloads stay on the per-source rows, reachable via
    -- source_row_id. No dedup or matching columns.
)
""")
    )

    # Exactly three indexes: primary key, unique, and the foreign key. The project
    # forbids speculative indexes beyond these without a demonstrated need, so the
    # source_site and posted_at indexes suggested by docs/live-per-source-schemas.md
    # are deliberately NOT created. source_site has cardinality 3 (an index would
    # rarely beat a sequential scan); posted_at is speculative until a slow query
    # exists. Both are one migration away if measurement justifies them.
    op.execute(
        text("CREATE INDEX ix_scraped_jobs_scan_run_id ON scraped_jobs(scan_run_id)")
    )


def downgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS scraped_jobs CASCADE"))
    raise NotImplementedError(
        "Migration 030 is one-way. The legacy scraped_jobs schema spanned ~48 columns "
        "of dedup and matching attributes whose code was deleted by the search-only "
        "split; recreating it would produce a table no code can use, reconstructed "
        "from a schema no current doc describes. The table held 0 rows at migration "
        "time, so nothing was lost. To recover, revert the code and restore from a "
        "backup rather than downgrading."
    )
