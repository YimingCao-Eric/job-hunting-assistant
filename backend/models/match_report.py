from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class MatchReport(Base):
    __tablename__ = "match_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dedup_run_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("dedup_reports.id", ondelete="SET NULL"),
        nullable=True,
    )
    trigger: Mapped[str] = mapped_column(String, nullable=False)
    matching_mode: Mapped[str] = mapped_column(String, nullable=False)
    total_processed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_gate_skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cpu_decided: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_llm_scored: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cpu_fallback: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    match_level_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    gate_skip_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    debug_log: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
