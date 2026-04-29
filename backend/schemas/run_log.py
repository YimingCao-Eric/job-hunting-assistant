from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class RunLogCreate(BaseModel):
    strategy: str = "C"
    search_keyword: Optional[str] = None
    search_location: Optional[str] = None
    search_filters: dict | None = None
    scan_all: bool = False
    scan_all_position: int | None = None
    scan_all_total: int | None = None


class RunLogUpdate(BaseModel):
    status: str | None = None
    completed_at: datetime | None = None
    pages_scanned: int | None = None
    scraped: int | None = None
    new_jobs: int | None = None
    existing: int | None = None
    stale_skipped: int | None = None
    jd_failed: int | None = None
    session_error: str | None = None
    error_message: str | None = None
    errors: list | None = None
    search_keyword: str | None = None
    search_location: str | None = None
    search_filters: dict | None = None
    failure_reason: str | None = None
    failure_category: str | None = None


class RunLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    strategy: str
    status: str
    started_at: datetime
    completed_at: datetime | None = None
    pages_scanned: int
    scraped: int
    new_jobs: int
    existing: int
    stale_skipped: int
    jd_failed: int
    early_stop: Optional[bool] = None
    session_error: str | None = None
    search_keyword: str | None = None
    search_location: str | None = None
    search_filters: dict | None = None
    error_message: str | None = None
    errors: list | None = None
    created_at: datetime
    scan_all: bool = False
    scan_all_position: int | None = None
    scan_all_total: int | None = None
    debug_log: dict | None = None
    failure_reason: str | None = None
    failure_category: str | None = None
