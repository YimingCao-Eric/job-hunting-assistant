"""scraped_jobs_filter_columns

Add five nullable canonical columns to scraped_jobs so a future filtering/matching
service can read this table alone, without joining the per-source tables:

    employment_type, workplace_type, language, education_requirements, salary_disclosed

Strictly additive. The existing 22 columns keep their values and semantics; the
per-source tables are untouched (they stay source-shaped and unnormalized -- all
normalization belongs to this derived row).

No indexes. The project forbids indexes beyond primary-key/unique/foreign-key without a
demonstrated need (CC-12), and the consuming service does not exist yet, so no query has
demonstrated one. Each is one migration away if measurement justifies it -- the same call
030 made for source_site and posted_at.

No defaults. Nullable-without-default is a metadata-only operation in modern Postgres (no
table rewrite, no long lock, regardless of row count). A default would both rewrite the
table and manufacture a non-NULL value for postings whose sites said nothing, which would
destroy the one meaning NULL carries here: "this site did not say".

Existing rows keep NULL for all five. No backfill is owed: rows age out by shelf_life
auto-expiration, so the table populates itself within one shelf-life. Until then NULL is
briefly ambiguous between "the site did not say" and "this row predates 031"; scrape_time
separates the two.

Revision ID: 031
Revises: 030
Create Date: 2026-07-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "031"
down_revision: Union[str, None] = "030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Widths mirror the shipped column with the same role rather than being invented:
    # the two controlled vocabularies follow salary_period (varchar(16)); language
    # follows its only source, indeed_jobs.language (varchar(8)).
    op.add_column("scraped_jobs", sa.Column("employment_type", sa.String(16), nullable=True))
    op.add_column("scraped_jobs", sa.Column("workplace_type", sa.String(16), nullable=True))
    op.add_column("scraped_jobs", sa.Column("language", sa.String(8), nullable=True))
    # Unbounded by necessity: a "; "-join of N education labels, or a long free-prose
    # experience description. Matches experience_level, which already carries that prose.
    op.add_column("scraped_jobs", sa.Column("education_requirements", sa.Text(), nullable=True))
    # Tri-state: true (employer stated the pay) / false (the site estimated it) /
    # NULL (nothing was said). NULL is never collapsed into false.
    op.add_column("scraped_jobs", sa.Column("salary_disclosed", sa.Boolean(), nullable=True))


def downgrade() -> None:
    # Unlike 030's, this downgrade is real. Dropping five additive columns restores the
    # pre-031 schema exactly; there is no ~48-column legacy shape to reconstruct and no
    # code that would be left describing a table that no longer exists. The five columns'
    # values are lost, which is correct -- they are derived, and a re-scan recomputes them.
    op.drop_column("scraped_jobs", "salary_disclosed")
    op.drop_column("scraped_jobs", "education_requirements")
    op.drop_column("scraped_jobs", "language")
    op.drop_column("scraped_jobs", "workplace_type")
    op.drop_column("scraped_jobs", "employment_type")
