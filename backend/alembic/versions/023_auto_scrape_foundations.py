"""Create auto-scrape foundation tables and columns

Revision ID: 023
Revises: 022
Create Date: 2026-04-28
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "auto_scrape_state",
        sa.Column("id", sa.Integer(), primary_key=True, server_default=sa.text("1")),
        sa.Column("state", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("last_sw_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("id = 1", name="ck_auto_scrape_state_singleton"),
    )

    op.execute("""
        INSERT INTO auto_scrape_state (id, state) VALUES (1, '{
          "enabled": false,
          "test_cycle_pending": false,
          "exit_requested": false,
          "config_change_pending": false,
          "cycle_id": 0,
          "cycle_phase": "idle",
          "extension_instance_id": null,
          "matrix_position": {"site_index": 0, "keyword_index": 0},
          "cycle_results": {"scans_attempted": 0, "scans_succeeded": 0, "scans_failed": 0, "failures_by_reason": {}},
          "consecutive_precheck_failures": 0,
          "next_cycle_at": 0,
          "last_cycle_summary_id": null,
          "last_cycle_completed_at": null,
          "min_cycle_interval_ms": 60000,
          "clean_cycles_count": 0
        }'::jsonb);
    """)

    op.create_table(
        "auto_scrape_cycles",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("cycle_id", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("phase_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("precheck_status", sa.Text(), nullable=True),
        sa.Column("precheck_details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "scans_attempted",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "scans_succeeded",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "scans_failed",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("failures_by_reason", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "run_log_ids",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=True,
        ),
        sa.Column("postcheck_status", sa.Text(), nullable=True),
        sa.Column("postcheck_details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("cleanup_results", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("dedup_task_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("match_results", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("apply_results", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('scrape_running', 'scrape_complete', 'postscrape_running', "
            "'post_scrape_complete', 'failed')",
            name="ck_auto_scrape_cycles_status",
        ),
    )
    op.create_index(
        "idx_auto_scrape_cycles_cycle_id",
        "auto_scrape_cycles",
        ["cycle_id"],
    )
    op.create_index(
        "idx_auto_scrape_cycles_started_at",
        "auto_scrape_cycles",
        ["started_at"],
        postgresql_ops={"started_at": "DESC"},
    )
    op.create_index(
        "idx_auto_scrape_cycles_running",
        "auto_scrape_cycles",
        ["status"],
        postgresql_where=sa.text(
            "status IN ('scrape_running', 'postscrape_running')"
        ),
    )

    op.create_table(
        "auto_scrape_config",
        sa.Column("id", sa.Integer(), primary_key=True, server_default=sa.text("1")),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("id = 1", name="ck_auto_scrape_config_singleton"),
    )

    op.execute("""
        INSERT INTO auto_scrape_config (id, config) VALUES (1, '{
          "enabled_sites": ["linkedin", "indeed", "glassdoor"],
          "keywords": ["software engineer", "AI engineer", "machine learning engineer"],
          "min_cycle_interval_minutes": 1,
          "inter_scan_delay_seconds": 30,
          "scan_timeout_minutes": 8,
          "max_consecutive_precheck_failures": 3,
          "max_consecutive_dead_session_cycles": 24,
          "run_dedup_after_scrape": true,
          "run_matching_after_dedup": true,
          "run_apply_after_matching": false
        }'::jsonb);
    """)

    op.create_table(
        "site_session_states",
        sa.Column("site", sa.Text(), primary_key=True),
        sa.Column("last_probe_status", sa.Text(), nullable=False),
        sa.Column(
            "last_probe_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "consecutive_failures",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "notified_user",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "backoff_multiplier",
            sa.Float(),
            nullable=False,
            server_default=sa.text("1.0"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "site IN ('linkedin', 'indeed', 'glassdoor')",
            name="ck_site_session_states_site",
        ),
        sa.CheckConstraint(
            "last_probe_status IN ('live', 'expired', 'captcha', 'rate_limited', 'unknown')",
            name="ck_site_session_states_probe_status",
        ),
    )
    op.execute("""
        INSERT INTO site_session_states (site, last_probe_status) VALUES
          ('linkedin', 'unknown'),
          ('indeed', 'unknown'),
          ('glassdoor', 'unknown');
    """)

    op.add_column(
        "extension_run_logs",
        sa.Column("failure_reason", sa.Text(), nullable=True),
    )
    op.add_column(
        "extension_run_logs",
        sa.Column("failure_category", sa.Text(), nullable=True),
    )

    op.execute(sa.text("CREATE SEQUENCE auto_scrape_cycle_id_seq START WITH 1"))


def downgrade() -> None:
    op.execute(sa.text("DROP SEQUENCE IF EXISTS auto_scrape_cycle_id_seq"))
    op.drop_column("extension_run_logs", "failure_category")
    op.drop_column("extension_run_logs", "failure_reason")
    op.drop_table("site_session_states")
    op.drop_table("auto_scrape_config")
    op.drop_index("idx_auto_scrape_cycles_running", table_name="auto_scrape_cycles")
    op.drop_index("idx_auto_scrape_cycles_started_at", table_name="auto_scrape_cycles")
    op.drop_index("idx_auto_scrape_cycles_cycle_id", table_name="auto_scrape_cycles")
    op.drop_table("auto_scrape_cycles")
    op.drop_table("auto_scrape_state")
