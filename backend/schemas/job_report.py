from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class JobReportCreate(BaseModel):
    report_type: Literal[
        "match_level",
        "yoe",
        "missing_skills",
        "false_skills",
        "wrong_gate",
        "other",
    ]
    detail: dict = Field(default_factory=dict)


class JobReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: UUID
    report_type: str
    detail: dict
    status: str
    actioned_at: datetime | None
    created_at: datetime

    job_title: str | None = None
    company: str | None = None
    match_level: str | None = None
    match_skip_reason: str | None = None
    removal_stage: str | None = None


class JobReportActionRequest(BaseModel):
    action: Literal["dismiss"]


class JobReportsListResponse(BaseModel):
    items: list[JobReportRead]
    total: int


class JobReportStatsResponse(BaseModel):
    pending: int
    by_type: dict[str, int]
    total: int
