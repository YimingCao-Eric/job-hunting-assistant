from __future__ import annotations

import copy
import logging
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import Select, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.auth import get_current_user
from core.auto_scrape_validation import (
    ConfigValidationError,
    get_limits,
    validate,
)
from core.database import get_db
from core.redis_client import publish_auto_scrape_cycle_wake
from models.auto_scrape_config import AutoScrapeConfig
from models.auto_scrape_cycle import AutoScrapeCycle
from models.auto_scrape_state import AutoScrapeState
from models.site_session_state import SiteSessionState
from schemas.auto_scrape import (
    AutoScrapeStateRead,
    AutoScrapeStateUpdate,
    CleanupOrphanCyclesRequest,
    ConfigLimitsResponse,
    ConfigRead,
    ConfigUpdate,
    ConfigUpdateResponse,
    CycleCreate,
    CycleCreateResponse,
    CycleRead,
    CycleUpdate,
    HeartbeatRequest,
    SessionStateUpdate,
    SiteSessionStateRead,
    WakeOrchestratorRequest,
)

logger = logging.getLogger(__name__)

# Phase 7: in-memory multi-instance tracker (lost on process restart)
_recent_instances: OrderedDict[str, datetime] = OrderedDict()
_INSTANCE_FRESH_WINDOW = timedelta(minutes=5)

router = APIRouter(prefix="/admin/auto-scrape", tags=["admin-auto-scrape"])

DEFAULT_CONFIG: dict = {
    "enabled_sites": ["linkedin", "indeed", "glassdoor"],
    "keywords": [
        "software engineer",
        "AI engineer",
        "machine learning engineer",
    ],
    "min_cycle_interval_minutes": 1,
    "inter_scan_delay_seconds": 30,
    "scan_timeout_minutes": 8,
    "max_consecutive_precheck_failures": 3,
    "max_consecutive_dead_session_cycles": 24,
    "run_dedup_after_scrape": True,
    "run_matching_after_dedup": True,
    "run_apply_after_matching": False,
}

_VALID_SITES = frozenset({"linkedin", "indeed", "glassdoor"})


def _merge_config(base: dict, patch: ConfigUpdate) -> dict:
    out = copy.deepcopy(base)
    data = patch.model_dump(exclude_unset=True)
    for k, v in data.items():
        out[k] = v
    return out


def _clear_consecutive_counters(state: dict) -> dict:
    s = copy.deepcopy(state)
    for key in list(s.keys()):
        if key.startswith("consecutive_"):
            s[key] = 0
    return s


def _next_cycle_estimated_at(state: dict) -> datetime | None:
    raw = state.get("next_cycle_at")
    if raw in (None, 0, "0"):
        return None
    try:
        ms = int(raw)
    except (TypeError, ValueError):
        return None
    if ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


async def _load_state_row(db: AsyncSession) -> AutoScrapeState:
    r = await db.execute(select(AutoScrapeState).where(AutoScrapeState.id == 1))
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=500, detail="auto_scrape_state missing")
    return row


async def _load_config_row(db: AsyncSession) -> AutoScrapeConfig:
    r = await db.execute(select(AutoScrapeConfig).where(AutoScrapeConfig.id == 1))
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=500, detail="auto_scrape_config missing")
    return row


@router.get("/state", response_model=AutoScrapeStateRead)
async def get_state(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    return await _load_state_row(db)


@router.put("/state", response_model=AutoScrapeStateRead)
async def put_state(
    body: AutoScrapeStateUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    row.state = body.state
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/heartbeat")
async def heartbeat(
    body: HeartbeatRequest = Body(default=HeartbeatRequest()),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    await db.execute(
        text(
            "UPDATE auto_scrape_state SET last_sw_heartbeat_at = :ts "
            "WHERE id = 1"
        ),
        {"ts": datetime.now(timezone.utc)},
    )
    now = datetime.now(timezone.utc)
    if body.extension_instance_id is not None:
        row = await _load_state_row(db)
        stored_id = row.state.get("extension_instance_id")
        if stored_id != body.extension_instance_id:
            new_state = {**row.state, "extension_instance_id": body.extension_instance_id}
            row.state = new_state
            flag_modified(row, "state")
        _recent_instances[body.extension_instance_id] = now
    cutoff = now - _INSTANCE_FRESH_WINDOW
    stale_keys = [iid for iid, ts in _recent_instances.items() if ts < cutoff]
    for iid in stale_keys:
        del _recent_instances[iid]
    return {"ok": True}


@router.get("/instances")
async def get_recent_instances(_user: dict = Depends(get_current_user)):
    """Extension instance_ids that heartbeated within the last 5 minutes."""
    now = datetime.now(timezone.utc)
    cutoff = now - _INSTANCE_FRESH_WINDOW
    fresh = {iid: ts for iid, ts in _recent_instances.items() if ts >= cutoff}
    return {
        "instances": [
            {"instance_id": iid, "last_heartbeat_at": ts.isoformat()}
            for iid, ts in fresh.items()
        ],
        "count": len(fresh),
    }


@router.post("/wake-orchestrator")
async def wake_orchestrator(
    body: WakeOrchestratorRequest = Body(default=WakeOrchestratorRequest()),
    _user: dict = Depends(get_current_user),
):
    """
    Publish to Redis so the post-scrape subscriber can run immediately.
    Best-effort: if Redis is down, the 1-min APScheduler poll still claims cycles.
    """
    payload = f"cycle_id={body.cycle_id}" if body.cycle_id is not None else "wake"
    published = await publish_auto_scrape_cycle_wake(payload)
    logger.info(
        "wake-orchestrator: Redis publish ok=%s payload=%s", published, payload
    )
    return {"ok": True, "redis_publish": published}


@router.get("/config", response_model=ConfigRead)
async def get_config(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_config_row(db)
    return row


@router.put("/config", response_model=ConfigUpdateResponse)
async def put_config(
    body: ConfigUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_config_row(db)
    merged = _merge_config(row.config, body)
    try:
        merged, warnings = validate(merged)
    except ConfigValidationError as e:
        raise HTTPException(status_code=422, detail={"field_errors": e.field_errors})
    row.config = merged
    flag_modified(row, "config")
    await db.flush()
    await db.refresh(row)
    st = await _load_state_row(db)
    return ConfigUpdateResponse(
        config=row.config,
        warnings=warnings,
        next_cycle_estimated_at=_next_cycle_estimated_at(st.state),
    )


@router.post("/config/reset", response_model=ConfigRead)
async def reset_config(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_config_row(db)
    row.config = copy.deepcopy(DEFAULT_CONFIG)
    flag_modified(row, "config")
    await db.flush()
    await db.refresh(row)
    return row


@router.get("/config/limits", response_model=ConfigLimitsResponse)
async def get_config_limits(_user: dict = Depends(get_current_user)):
    data = get_limits()
    derived = {**data["derived_limits"], "valid_sites": data["valid_sites"]}
    return ConfigLimitsResponse(limits=data["limits"], derived_limits=derived)


@router.post("/cycle", response_model=CycleCreateResponse)
async def create_cycle(
    body: CycleCreate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(text("SELECT nextval('auto_scrape_cycle_id_seq')"))
    cycle_id = int(result.scalar_one())
    now = datetime.now(timezone.utc)
    cycle = AutoScrapeCycle(
        cycle_id=cycle_id,
        started_at=body.started_at,
        status="scrape_running",
        phase_heartbeat_at=now,
    )
    db.add(cycle)
    await db.flush()
    return CycleCreateResponse(id=cycle.id, cycle_id=cycle_id)


def _cycle_update_values(body: CycleUpdate, heartbeat: datetime) -> dict:
    data = body.model_dump(exclude_unset=True)
    data.pop("status", None)
    vals = {k: v for k, v in data.items() if v is not None}
    vals["phase_heartbeat_at"] = heartbeat
    return vals


@router.put("/cycle/{cycle_row_id}", response_model=CycleRead)
async def update_cycle(
    cycle_row_id: UUID,
    body: CycleUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    data = body.model_dump(exclude_unset=True)
    new_status = data.get("status")

    if new_status == "scrape_complete":
        vals = _cycle_update_values(body, now)
        vals["status"] = "scrape_complete"
        res = await db.execute(
            update(AutoScrapeCycle)
            .where(
                AutoScrapeCycle.id == cycle_row_id,
                AutoScrapeCycle.status == "scrape_running",
            )
            .values(**vals)
        )
        if res.rowcount:
            await db.flush()
            out = await db.execute(
                select(AutoScrapeCycle).where(AutoScrapeCycle.id == cycle_row_id)
            )
            return out.scalar_one()
        existing = await db.execute(
            select(AutoScrapeCycle).where(AutoScrapeCycle.id == cycle_row_id)
        )
        row = existing.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="cycle not found")
        if row.status == "scrape_complete":
            return row
        raise HTTPException(
            status_code=409,
            detail="cycle must be in scrape_running to complete scrape phase",
        )

    vals = _cycle_update_values(body, now)
    if new_status is not None:
        vals["status"] = new_status
    res = await db.execute(
        update(AutoScrapeCycle)
        .where(AutoScrapeCycle.id == cycle_row_id)
        .values(**vals)
    )
    if not res.rowcount:
        raise HTTPException(status_code=404, detail="cycle not found")
    await db.flush()
    out = await db.execute(
        select(AutoScrapeCycle).where(AutoScrapeCycle.id == cycle_row_id)
    )
    return out.scalar_one()


@router.get("/cycles", response_model=list[CycleRead])
async def list_cycles(
    limit: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    q: Select[tuple[AutoScrapeCycle]] = (
        select(AutoScrapeCycle)
        .order_by(AutoScrapeCycle.started_at.desc())
        .limit(limit)
    )
    r = await db.execute(q)
    return list(r.scalars().all())


@router.post("/cleanup-orphan-cycles")
async def cleanup_orphan_cycles(
    body: CleanupOrphanCyclesRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    sid = row.state.get("extension_instance_id")
    if sid == body.current_instance_id:
        return {"marked_failed": 0}
    res = await db.execute(
        update(AutoScrapeCycle)
        .where(AutoScrapeCycle.status == "scrape_running")
        .values(
            status="failed",
            error_message="Orphan cycle: extension instance mismatch",
            completed_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return {"marked_failed": res.rowcount}


@router.post("/enable", response_model=AutoScrapeStateRead)
async def enable(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    st = _clear_consecutive_counters(row.state)
    st["enabled"] = True
    # Phase 7: explicit reset so re-enable after auto-pause clears precheck counter
    st["consecutive_precheck_failures"] = 0
    st["config_change_pending"] = False
    row.state = st
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/pause", response_model=AutoScrapeStateRead)
async def pause(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    st = {**row.state, "enabled": False, "config_change_pending": False}
    row.state = st
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/shutdown", response_model=AutoScrapeStateRead)
async def shutdown(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    st = {**row.state, "exit_requested": True, "config_change_pending": False}
    row.state = st
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/test-cycle", response_model=AutoScrapeStateRead)
async def test_cycle(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    st = {**row.state, "test_cycle_pending": True}
    row.state = st
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/restart-cycle", response_model=AutoScrapeStateRead)
async def restart_cycle(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    st = {**row.state, "config_change_pending": True}
    row.state = st
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/reset-counters", response_model=AutoScrapeStateRead)
async def reset_counters(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await _load_state_row(db)
    row.state = _clear_consecutive_counters(row.state)
    flag_modified(row, "state")
    await db.flush()
    await db.refresh(row)
    return row


@router.post("/reset-session/{site}", response_model=SiteSessionStateRead)
async def reset_session(
    site: str,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    if site not in _VALID_SITES:
        raise HTTPException(status_code=404, detail="unknown site")
    r = await db.execute(select(SiteSessionState).where(SiteSessionState.site == site))
    row = r.scalar_one()
    row.consecutive_failures = 0
    row.notified_user = False
    row.backoff_multiplier = 1.0
    row.last_probe_status = "unknown"
    row.last_probe_at = datetime.now(timezone.utc)
    row.updated_at = datetime.now(timezone.utc)
    await db.flush()
    await db.refresh(row)
    return row


@router.get("/sessions", response_model=list[SiteSessionStateRead])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    r = await db.execute(select(SiteSessionState).order_by(SiteSessionState.site))
    return list(r.scalars().all())


async def _send_session_died_notification(site: str, status: str) -> None:
    try:
        from notifier import notifier

        await notifier.send(
            profile_id=1,
            event="scraper.error",
            payload={
                "site": site,
                "error": status,
                "message": f"{site} session died ({status})",
            },
        )
    except Exception:
        logger.exception("Notifier call failed (non-fatal)")


@router.put("/sessions/{site}", response_model=SiteSessionStateRead)
async def update_session_state(
    site: str,
    body: SessionStateUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    if site not in _VALID_SITES:
        raise HTTPException(status_code=404, detail="unknown site")

    r = await db.execute(select(SiteSessionState).where(SiteSessionState.site == site))
    row = r.scalar_one()

    new_status = body.last_probe_status
    old_status = row.last_probe_status

    row.last_probe_status = new_status
    row.last_probe_at = datetime.now(timezone.utc)
    row.updated_at = datetime.now(timezone.utc)

    if new_status == "live":
        row.consecutive_failures = 0
        row.notified_user = False
    elif new_status in ("expired", "captcha"):
        row.consecutive_failures += 1
        if old_status == "live" and not row.notified_user:
            await _send_session_died_notification(site, new_status)
            row.notified_user = True
    elif new_status == "rate_limited":
        row.backoff_multiplier = min(row.backoff_multiplier * 2.0, 64.0)

    await db.flush()
    await db.refresh(row)
    return row
