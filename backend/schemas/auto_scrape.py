from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class AutoScrapeStateUpdate(BaseModel):
    """Full state replacement (the SW pushes its full state object)."""

    state: dict[str, Any]


class HeartbeatRequest(BaseModel):
    extension_instance_id: Optional[str] = None


class WakeOrchestratorRequest(BaseModel):
    cycle_id: Optional[int] = None


class CycleCreate(BaseModel):
    started_at: datetime
    status: Literal["scrape_running"] = "scrape_running"


class CycleUpdate(BaseModel):
    status: Optional[
        Literal[
            "scrape_running",
            "scrape_complete",
            "postscrape_running",
            "post_scrape_complete",
            "failed",
        ]
    ] = None
    completed_at: Optional[datetime] = None
    phase_heartbeat_at: Optional[datetime] = None
    precheck_status: Optional[str] = None
    precheck_details: Optional[dict[str, Any]] = None
    scans_attempted: Optional[int] = None
    scans_succeeded: Optional[int] = None
    scans_failed: Optional[int] = None
    failures_by_reason: Optional[dict[str, int]] = None
    run_log_ids: Optional[list[UUID]] = None
    postcheck_status: Optional[str] = None
    postcheck_details: Optional[dict[str, Any]] = None
    cleanup_results: Optional[dict[str, Any]] = None
    dedup_task_id: Optional[UUID] = None
    match_results: Optional[dict[str, Any]] = None
    apply_results: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    notes: Optional[str] = None


class ConfigUpdate(BaseModel):
    enabled_sites: Optional[list[str]] = None
    keywords: Optional[list[str]] = None
    min_cycle_interval_minutes: Optional[int] = None
    inter_scan_delay_seconds: Optional[int] = None
    scan_timeout_minutes: Optional[int] = None
    max_consecutive_precheck_failures: Optional[int] = None
    max_consecutive_dead_session_cycles: Optional[int] = None
    run_dedup_after_scrape: Optional[bool] = None
    run_matching_after_dedup: Optional[bool] = None
    run_apply_after_matching: Optional[bool] = None


class SessionStateUpdate(BaseModel):
    last_probe_status: Literal["live", "expired", "captcha", "rate_limited", "unknown"]


class CleanupOrphanCyclesRequest(BaseModel):
    current_instance_id: str


class AutoScrapeStateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    state: dict[str, Any]
    last_sw_heartbeat_at: Optional[datetime]
    updated_at: datetime


class CycleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    cycle_id: int
    started_at: datetime
    completed_at: Optional[datetime]
    status: str
    phase_heartbeat_at: Optional[datetime]
    precheck_status: Optional[str]
    precheck_details: Optional[dict[str, Any]]
    scans_attempted: int
    scans_succeeded: int
    scans_failed: int
    failures_by_reason: Optional[dict[str, int]]
    run_log_ids: Optional[list[UUID]]
    postcheck_status: Optional[str]
    postcheck_details: Optional[dict[str, Any]]
    cleanup_results: Optional[dict[str, Any]]
    dedup_task_id: Optional[UUID]
    match_results: Optional[dict[str, Any]]
    apply_results: Optional[dict[str, Any]]
    error_message: Optional[str]
    notes: Optional[str]


class CycleCreateResponse(BaseModel):
    id: UUID
    cycle_id: int


class ConfigRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    config: dict[str, Any]
    updated_at: datetime


class ConfigUpdateResponse(BaseModel):
    config: dict[str, Any]
    warnings: list[str]
    next_cycle_estimated_at: Optional[datetime]


class ConfigLimitsResponse(BaseModel):
    limits: dict[str, dict[str, Any]]
    derived_limits: dict[str, Any]


class SiteSessionStateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    site: str
    last_probe_status: str
    last_probe_at: datetime
    consecutive_failures: int
    notified_user: bool
    backoff_multiplier: float
    updated_at: datetime


class CleanupInvalidEntriesResponse(BaseModel):
    deleted_jobs_empty_core: int
    deleted_jobs_empty_jd: int
    deleted_jobs_mismatched_website: int
    marked_failed_run_logs: int
    marked_failed_dedup_tasks: int
