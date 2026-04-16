from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class SkillCandidateRead(BaseModel):
    id: int
    skill_name: str
    count: int
    req_count: int
    nth_count: int
    in_aliases: bool
    status: str
    suggested_canonical: Optional[str] = None
    merge_target: Optional[str] = None
    first_seen: datetime
    last_seen: datetime
    reviewed_at: Optional[datetime] = None


class SkillCandidatesListResponse(BaseModel):
    items: list[SkillCandidateRead]
    total: int
    total_unknown: int
    total_known: int


class SkillCandidateStatsResponse(BaseModel):
    total_unique_skills: int
    total_in_aliases: int
    total_unknown: int
    total_occurrences: int
    top_unknown: list[dict[str, Any]]
    pending_review: int


class SkillCandidateApproveRequest(BaseModel):
    suggested_canonical: Optional[str] = None


class SkillCandidateMergeRequest(BaseModel):
    merge_target: str


class RefreshAliasesResponse(BaseModel):
    updated: int
