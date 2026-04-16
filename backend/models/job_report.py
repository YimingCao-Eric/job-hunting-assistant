import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from core.database import Base


class JobReport(Base):
    __tablename__ = "job_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scraped_jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    report_type: Mapped[str] = mapped_column(String, nullable=False)
    detail: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(
        String, nullable=False, server_default="pending"
    )
    actioned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
