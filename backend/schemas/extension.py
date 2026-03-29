from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ExtensionStateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    current_search_date: str | None = None
    current_page: int
    search_exhausted: bool
    consecutive_empty_runs: int
    last_search_time: str | None = None
    today_searches: int
    scan_requested: bool = False
    stop_requested: bool = False
    scan_website: str | None = None
    updated_at: datetime


class ExtensionStateUpdate(BaseModel):
    current_search_date: str | None = None
    current_page: int | None = None
    search_exhausted: bool | None = None
    consecutive_empty_runs: int | None = None
    last_search_time: str | None = None
    today_searches: int | None = None
    scan_requested: bool | None = None
    stop_requested: bool | None = None
    scan_website: str | None = None
