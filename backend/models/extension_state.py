from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class ExtensionState(Base):
    __tablename__ = "extension_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    current_search_date: Mapped[str | None] = mapped_column(String, nullable=True)
    current_page: Mapped[int] = mapped_column(Integer, default=1)
    search_exhausted: Mapped[bool] = mapped_column(Boolean, default=False)
    consecutive_empty_runs: Mapped[int] = mapped_column(Integer, default=0)
    last_search_time: Mapped[str | None] = mapped_column(String, nullable=True)
    today_searches: Mapped[int] = mapped_column(Integer, default=0)
    scan_requested: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    stop_requested: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    scan_website: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
