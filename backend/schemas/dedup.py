from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class GateResult(BaseModel):
    checked: int
    flagged: int
    duration_ms: int


class DedupReportRead(BaseModel):
    id: int
    scan_run_id: UUID | None
    trigger: str
    total_processed: int
    total_flagged: int
    total_passed: int
    gate_results: dict[str, GateResult]
    skip_reason_counts: dict[str, int]
    duration_ms: int
    debug_log: dict | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
