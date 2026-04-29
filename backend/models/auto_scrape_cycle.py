import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import text

from core.database import Base


class AutoScrapeCycle(Base):
    __tablename__ = "auto_scrape_cycles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    cycle_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(String, nullable=False)
    phase_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    precheck_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    precheck_details: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    scans_attempted: Mapped[int] = mapped_column(default=0, server_default="0")
    scans_succeeded: Mapped[int] = mapped_column(default=0, server_default="0")
    scans_failed: Mapped[int] = mapped_column(default=0, server_default="0")
    failures_by_reason: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    run_log_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=True
    )
    postcheck_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    postcheck_details: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    cleanup_results: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    dedup_task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    match_results: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    apply_results: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
