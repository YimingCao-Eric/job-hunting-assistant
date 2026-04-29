from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class SiteSessionState(Base):
    __tablename__ = "site_session_states"

    site: Mapped[str] = mapped_column(Text, primary_key=True)
    last_probe_status: Mapped[str] = mapped_column(Text, nullable=False)
    last_probe_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    consecutive_failures: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    notified_user: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    backoff_multiplier: Mapped[float] = mapped_column(
        Float, default=1.0, server_default="1.0", nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
