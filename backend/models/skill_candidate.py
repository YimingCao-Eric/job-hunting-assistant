from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from core.database import Base


class SkillCandidate(Base):
    __tablename__ = "skill_candidates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_name: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    req_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    nth_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    in_aliases: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="pending", nullable=False, index=True)
    suggested_canonical: Mapped[str | None] = mapped_column(String, nullable=True)
    merge_target: Mapped[str | None] = mapped_column(String, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
