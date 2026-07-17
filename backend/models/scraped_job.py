import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from core.database import Base


class ScrapedJob(Base):
    """Unified, site-agnostic scraped posting — one canonical row per posting per site.

    A **derived** table, not a raw one. Every row is written by dual-write at ingest:
    the per-source row (linkedin_jobs / indeed_jobs / glassdoor_jobs) and this row are
    inserted in one transaction, committing together or not at all. The per-source
    tables remain the faithful, source-shaped store of record; this table is the
    comparable projection that the Jobs listing reads and that matching will consume.

    Exactly three mutations are permitted:
      1. `matched` false -> true (claim), kept in sync with the per-source row
      2. `dismissed` set by the user
      3. auto-expiration DELETE
    No other in-place update.

    Invariants (upheld by code, not by the database — see `source_row_id`):
      - a row exists here iff its per-source row exists
      - a row never outlives its per-source row
      - `matched` agrees with the per-source row at all times
      - `scrape_time` is identical to the per-source row's
    """

    __tablename__ = "scraped_jobs"

    # Exactly three indexes: primary key, unique, and the foreign key. Speculative
    # indexes beyond these need a demonstrated need; none exists at 0 rows. Notably
    # absent, and deliberately so: source_site (cardinality 3) and posted_at.
    __table_args__ = (
        UniqueConstraint("job_url", name="scraped_jobs_job_url_key"),
        Index("ix_scraped_jobs_scan_run_id", "scan_run_id"),
    )

    # --- Provenance ---------------------------------------------------------

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )

    # 'linkedin' | 'indeed' | 'glassdoor'. Identifies the origin table on its own;
    # there is deliberately no source_table column.
    source_site: Mapped[str] = mapped_column(String(16), nullable=False)

    # The per-source row's id. Polymorphic across the three per-source tables, so no
    # ForeignKey is declared -- a Postgres FK targets exactly one table. This is why
    # the 1:1 correspondence cannot be delegated to ON DELETE CASCADE and is instead
    # held by matched predicates at ingest, claim, and auto-expiration.
    source_row_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # Site-native id: job_posting_id (LinkedIn) / jobkey (Indeed) / listing_id (Glassdoor)
    site_job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)

    scan_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("extension_run_logs.id", ondelete="RESTRICT"),
        nullable=False,
    )

    job_url: Mapped[str] = mapped_column(String(2048), nullable=False)

    # Always written explicitly from the per-source row; the server_default is a
    # backstop, never the intended source. Auto-expiration deletes from this table
    # with the same predicate as the per-source tables, so the values must match.
    scrape_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # --- Mutable state ------------------------------------------------------

    matched: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    dismissed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    # --- Canonical business fields ------------------------------------------

    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    company: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Tri-state: True / False / None. None means the site did not say, which is not
    # the same claim as "not remote".
    remote: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    apply_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    experience_level: Mapped[str | None] = mapped_column(Text, nullable=True)
    industry: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- Salary -------------------------------------------------------------
    # Amounts as the source quoted them, against the normalized period. Never
    # converted between periods, never annualized.

    salary_min: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    salary_max: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    salary_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)

    # Normalized vocabulary, exactly five values:
    # HOURLY | DAILY | WEEKLY | MONTHLY | ANNUAL. None when the source token is
    # unrecognized -- the amounts are still retained.
    salary_period: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # --- Dates --------------------------------------------------------------

    # Normalized to one point-in-time representation across all three sites: from
    # epoch-ms (LinkedIn listed_at, Indeed pub_date) and from a calendar date
    # (Glassdoor date_posted). The raw source form is never stored here.
    posted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # --- Filter attributes (migration 031) ----------------------------------
    #
    # Five nullable attributes that let a filtering/matching service read this table
    # alone. Deliberately NOT exposed by ScrapedJobRead: they exist in the table and on
    # this model, but GET /jobs is byte-identical to before 031. That omission is load
    # bearing -- "completing" the response schema would change the API contract.
    #
    # NULL means "this site did not say" -- never "no". It is not a default; no column
    # here has one.

    # Exactly one of: FULL_TIME | PART_TIME | CONTRACT | TEMPORARY | INTERNSHIP |
    # VOLUNTEER. Single-valued: where a site states several arrangements, precedence
    # picks one and the rest are discarded (they survive on the per-source row).
    # LinkedIn's/Glassdoor's literal "Other" is recognized-but-unmappable -> None,
    # without a warning: the site answered correctly, it just maps to no token.
    employment_type: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # Exactly one of: REMOTE | HYBRID | ONSITE.
    #
    # NOT a refinement of `remote`, and the two may legitimately disagree:
    #   - LinkedIn: `remote` reads work_remote_allowed; this reads
    #     workplace_types_labels -- different source fields, labels win here
    #   - Glassdoor: a hybrid-only posting is remote=True *and* workplace_type=HYBRID
    #   - Indeed: same source, so consistent -- but ONSITE there means only "not
    #     remote" (Indeed cannot express hybrid)
    # Consumers must pick one column per filter and not mix them.
    workplace_type: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # Bare lowercase base code (en-US -> en). Validated for shape, not membership:
    # any 2-3 ASCII letters is accepted; there is no allow-list of real languages.
    # Indeed-only -- LinkedIn and Glassdoor do not supply it.
    language: Mapped[str | None] = mapped_column(String(8), nullable=True)

    # Free text, no vocabulary, never validated. Glassdoor-only: all education labels
    # joined with "; ", else the experience-requirements prose.
    #
    # Known duplication: on that fallback this holds the same text as experience_level,
    # which projects the same source field. The two agreeing is not corroboration --
    # it is one value counted twice.
    education_requirements: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Tri-state provenance of the salary figures, never collapsed:
    #   True  -> the source attributes them to the employer
    #   False -> the source attributes them to the site's own estimate
    #   None  -> nothing was said, or the token was unrecognized
    # `False` is a claim, not a default. It is about provenance, not presence: True
    # does not imply salary_min/max exist.
    #
    # Known limitation (Glassdoor): salary_source comes from jobDetailsData while
    # salary_min/max come from the employer's JSON-LD baseSalary -- two payloads, so
    # this flag may describe a different figure than the amounts beside it. Inherited
    # from 030 (salary_period splits the same way), not introduced by 031.
    salary_disclosed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # No source_raw: raw payloads stay on the per-source rows, reachable via
    # source_row_id. No dedup or matching columns -- when matching returns, its
    # attributes belong here rather than on the per-source tables.
