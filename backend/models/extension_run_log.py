import uuid

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class ExtensionRunLog(Base):
    __tablename__ = "extension_run_logs"

    __table_args__ = (
        Index("ix_extension_run_logs_started_at", "started_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    strategy: Mapped[str] = mapped_column(String, nullable=False, default="C")
    status: Mapped[str] = mapped_column(String, default="running")
    started_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    pages_scanned: Mapped[int] = mapped_column(Integer, default=0)
    scraped: Mapped[int] = mapped_column(Integer, default=0)
    new_jobs: Mapped[int] = mapped_column(Integer, default=0)
    existing: Mapped[int] = mapped_column(Integer, default=0)
    stale_skipped: Mapped[int] = mapped_column(Integer, default=0)
    jd_failed: Mapped[int] = mapped_column(Integer, default=0)
    early_stop: Mapped[bool] = mapped_column(Boolean, default=False)
    session_error: Mapped[str | None] = mapped_column(String, nullable=True)
    search_keyword: Mapped[str | None] = mapped_column(String, nullable=True)
    search_location: Mapped[str | None] = mapped_column(String, nullable=True)
    search_filters: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    errors: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    scan_all: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    scan_all_position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scan_all_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    debug_log: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
