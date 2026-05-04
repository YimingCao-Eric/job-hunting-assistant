"""per_source_scrape_tables

Revision ID: 025
Revises: 024
Create Date: 2026-05-03
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "025"
down_revision: Union[str, None] = "024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text("""
CREATE TABLE linkedin_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Identity
    job_posting_id                  VARCHAR(32),
    job_posting_url                 TEXT,

    -- Timing & lifecycle (epoch ms — parsing deferred)
    listed_at                       BIGINT,
    original_listed_at              BIGINT,
    job_state                       VARCHAR(32),
    job_application_limit_reached   BOOLEAN,
    expire_at                       BIGINT,
    closed_at                       BIGINT,

    -- Location
    formatted_location              TEXT,
    country_urn                     VARCHAR(64),
    location_urn                    VARCHAR(64),
    location_visibility             VARCHAR(32),
    postal_address                  JSONB,
    standardized_addresses          JSONB,
    job_region                      TEXT,

    -- Work mode
    work_remote_allowed             BOOLEAN,
    workplace_types_urns            JSONB,
    workplace_types_labels          JSONB,

    -- Employment & taxonomy
    formatted_employment_status     VARCHAR(32),
    employment_status_urn           VARCHAR(64),
    formatted_industries            JSONB,
    formatted_job_functions         JSONB,
    title                           TEXT,
    standardized_title              TEXT,
    formatted_experience_level      VARCHAR(32),
    skills_description              TEXT,

    -- Apply
    apply_method_type               VARCHAR(64),
    company_apply_url               TEXT,
    applicant_tracking_system       VARCHAR(64),
    top_level_company_apply_url     TEXT,

    -- Salary
    salary_min                      NUMERIC,
    salary_max                      NUMERIC,
    salary_currency                 VARCHAR(3),
    salary_period                   VARCHAR(16),
    salary_provided_by_employer     BOOLEAN,

    -- Description
    description_text                TEXT,

    -- Benefits
    inferred_benefits               JSONB,
    benefits                        JSONB,

    -- Company (resolved from included[])
    company_name                    TEXT,
    company_universal_name          VARCHAR(128),
    company_url                     TEXT,
    company_description             TEXT,

    -- Title / status / workplace URN companions (resolved from included[])
    title_entity_urn                VARCHAR(64),
    employment_status_label         VARCHAR(32),
    employment_status_entity_urn    VARCHAR(64),
    workplace_type_entity_urn       VARCHAR(64)
);
""")
    )
    op.execute(
        text("""
CREATE TABLE indeed_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Surface presence (derived at ingest)
    mosaic_present                  BOOLEAN NOT NULL DEFAULT FALSE,
    graphql_present                 BOOLEAN NOT NULL DEFAULT FALSE,

    -- Identity & URLs (mosaic)
    jobkey                          VARCHAR(32),
    link                            TEXT,
    view_job_link                   TEXT,
    more_loc_url                    TEXT,
    third_party_apply_url           TEXT,

    -- Timing (mosaic, epoch ms)
    pub_date                        BIGINT,
    create_date                     BIGINT,
    expiration_date                 BIGINT,
    expired                         BOOLEAN,

    -- Title & taxonomy (mosaic)
    title                           TEXT,
    display_title                   TEXT,
    norm_title                      TEXT,
    job_types                       JSONB,
    taxonomy_attributes             JSONB,

    -- Location (mosaic)
    formatted_location              TEXT,
    job_location_city               VARCHAR(128),
    job_location_state              VARCHAR(8),
    job_location_postal             VARCHAR(16),
    location_count                  INTEGER,
    additional_location_link        TEXT,
    remote_location                 BOOLEAN,

    -- Salary (mosaic)
    salary_min                      NUMERIC,
    salary_max                      NUMERIC,
    salary_period                   VARCHAR(16),
    salary_currency                 VARCHAR(3),
    salary_text                     TEXT,
    salary_snippet_source           VARCHAR(32),

    -- Employer (mosaic)
    company                         TEXT,

    -- Apply (mosaic)
    indeed_apply_enabled            BOOLEAN,
    indeed_applyable                BOOLEAN,
    apply_count                     INTEGER,
    screener_questions_url          TEXT,

    -- Pre-extracted requirements (mosaic)
    match_negative_taxonomy         JSONB,
    match_mismatching_entities      JSONB,
    num_hires                       INTEGER,

    -- Identity & URLs (graphql)
    employer_canonical_url          TEXT,

    -- Timing (graphql, alts)
    graphql_date_published          DATE,
    graphql_date_on_indeed          DATE,
    graphql_expired                 BOOLEAN,

    -- Title & taxonomy (graphql, alts)
    graphql_title                   TEXT,
    graphql_normalized_title        TEXT,
    attributes                      JSONB,

    -- Location (graphql, alts)
    location_formatted_long         TEXT,
    graphql_location_city           VARCHAR(128),
    graphql_location_postal_code    VARCHAR(16),
    graphql_location_street_address TEXT,
    graphql_location_admin1_code    VARCHAR(8),
    graphql_location_country_code   VARCHAR(2),

    -- Description (graphql)
    description_text                TEXT,
    language                        VARCHAR(8),

    -- Employer (graphql)
    employer_name                   TEXT,
    employer_company_page_url       TEXT,

    -- Source / provenance (graphql)
    source_name                     VARCHAR(64),

    -- Salary (graphql, alt)
    graphql_salary_period           VARCHAR(16),

    CONSTRAINT indeed_jobs_surface_present
        CHECK (mosaic_present OR graphql_present)
);
""")
    )
    op.execute(
        text("""
CREATE TABLE glassdoor_jobs (
    -- Common
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_run_id                     UUID NOT NULL REFERENCES extension_run_logs(id) ON DELETE RESTRICT,
    job_url                         VARCHAR(2048) NOT NULL UNIQUE,
    scrape_time                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_raw                      JSONB,

    -- Identity & taxonomy IDs (jobDetailsData)
    listing_id                      VARCHAR(32),
    goc_id                          INTEGER,
    job_country_id                  INTEGER,

    -- Title (jobDetailsData)
    job_title                       TEXT,
    normalized_job_title            TEXT,

    -- Lifecycle (jobDetailsData)
    expired                         BOOLEAN,
    employer_active_status          VARCHAR(16),

    -- Apply (jobDetailsData)
    is_easy_apply                   BOOLEAN,
    job_link                        TEXT,
    seo_job_link                    TEXT,

    -- Salary (jobDetailsData)
    salary_currency                 VARCHAR(3),
    salary_period                   VARCHAR(16),
    salary_source                   VARCHAR(32),
    pay_period_adjusted_pay         JSONB,

    -- Location (jobDetailsData)
    location_name                   TEXT,
    location                        JSONB,

    -- Employer (jobDetailsData)
    employer_name                   TEXT,
    employer_overview               TEXT,

    -- Pre-extracted skills/education (jobDetailsData)
    indeed_job_attribute            JSONB,
    skills_labels                   JSONB,
    education_labels                JSONB,

    -- Description (jobDetailsData)
    job_description_plain           TEXT,

    -- Reviews & benefits (jobDetailsData)
    employer_benefits_overview      TEXT,
    employer_benefits_reviews       JSONB,

    -- JSON-LD JobPosting
    title                           TEXT,
    date_posted                     DATE,
    valid_through                   DATE,
    description                     TEXT,
    experience_requirements_description TEXT,
    experience_requirements_months  INTEGER,
    education_requirements_credential VARCHAR(64),
    employment_type                 JSONB,
    jsonld_salary_currency_top      VARCHAR(3),
    jsonld_salary_currency          VARCHAR(3),
    jsonld_salary_min               NUMERIC,
    jsonld_salary_max               NUMERIC,
    jsonld_salary_period            VARCHAR(16),
    job_location                    JSONB,
    job_location_type               VARCHAR(32),
    hiring_organization             JSONB,
    industry                        VARCHAR(64),
    direct_apply                    BOOLEAN,
    job_benefits                    TEXT,

    -- jobDetailsRawData.jobview.header
    header_goc                      VARCHAR(64),
    job_type                        JSONB,
    job_type_keys                   JSONB,
    remote_work_types               JSONB,
    header_expired                  BOOLEAN,
    header_easy_apply               BOOLEAN,
    header_apply_url                TEXT,
    header_salary_source            VARCHAR(32),
    header_salary_currency          VARCHAR(3),
    header_salary_period            VARCHAR(16),
    header_employer                 JSONB,

    -- jobDetailsRawData.jobview.map
    map_address                     TEXT,
    map_city_name                   VARCHAR(128),
    map_country                     VARCHAR(64),
    map_state_name                  VARCHAR(64),
    map_location_name               TEXT,
    map_postal_code                 VARCHAR(16),
    map_employer                    JSONB,

    -- jobDetailsRawData.jobview.job
    discover_date                   TIMESTAMPTZ,
    job_title_text                  TEXT,
    jobview_job_description         TEXT
);
""")
    )
    op.execute(text("CREATE INDEX ix_linkedin_jobs_scan_run_id  ON linkedin_jobs (scan_run_id)"))
    op.execute(text("CREATE INDEX ix_indeed_jobs_scan_run_id    ON indeed_jobs   (scan_run_id)"))
    op.execute(text("CREATE INDEX ix_glassdoor_jobs_scan_run_id ON glassdoor_jobs(scan_run_id)"))


def downgrade() -> None:
    op.drop_table("glassdoor_jobs")
    op.drop_table("indeed_jobs")
    op.drop_table("linkedin_jobs")
