from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MatchReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dedup_run_id: int | None = None
    trigger: str
    matching_mode: str
    total_processed: int
    total_gate_skipped: int
    total_cpu_decided: int
    total_llm_scored: int
    total_failed: int
    total_cpu_fallback: int = 0
    match_level_counts: dict | None = None
    gate_skip_counts: dict | None = None
    duration_ms: int | None = None
    created_at: datetime
