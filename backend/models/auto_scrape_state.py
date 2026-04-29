from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class AutoScrapeState(Base):
    """Singleton (id=1) mailbox for service-worker orchestrator state."""

    __tablename__ = "auto_scrape_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    state: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    last_sw_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
