import uuid

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class DedupReport(Base):
    __tablename__ = "dedup_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scan_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("extension_run_logs.id", ondelete="SET NULL"),
        nullable=True,
    )
    trigger: Mapped[str] = mapped_column(String, nullable=False)
    total_processed: Mapped[int] = mapped_column(Integer, nullable=False)
    total_flagged: Mapped[int] = mapped_column(Integer, nullable=False)
    total_passed: Mapped[int] = mapped_column(Integer, nullable=False)
    gate_results: Mapped[dict] = mapped_column(JSONB, nullable=False)
    skip_reason_counts: Mapped[dict] = mapped_column(JSONB, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
