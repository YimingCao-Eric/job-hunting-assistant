import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.config import settings
from core.config_file import read_config_file
from core.database import AsyncSessionLocal, get_db
from dedup.service import run_dedup
from models.extension_run_log import ExtensionRunLog
from models.extension_state import ExtensionState
from schemas.config import SearchConfigRead
from schemas.extension import ExtensionStateRead, ExtensionStateUpdate, TriggerScanRequest
from schemas.run_log import RunLogCreate, RunLogRead, RunLogUpdate

router = APIRouter(prefix="/extension", tags=["extension"])

logger = logging.getLogger(__name__)


async def _run_dedup_for_scan(log_id: UUID) -> None:
    """
    Runs full dedup after a scan completes. Uses its own DB session — the request
    session is closed after the PUT response.
    """
    async with AsyncSessionLocal() as db:
        try:
            config_data = await read_config_file()
            cfg = SearchConfigRead(**config_data)
            await run_dedup(
                db=db,
                config=cfg,
                settings=settings,
                scan_run_id=log_id,
                trigger="post_scan",
            )
            await db.commit()
        except Exception:
            logger.exception("Auto dedup failed for scan run %s", log_id)
            await db.rollback()


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

@router.get("/state", response_model=ExtensionStateRead)
async def get_state(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)
        await db.flush()
        await db.refresh(row)
    return row


@router.put("/state", response_model=ExtensionStateRead)
async def update_state(
    body: ExtensionStateUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)

    await db.flush()
    await db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Scan trigger
# ---------------------------------------------------------------------------

@router.post("/trigger-scan")
async def trigger_scan(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
    body: TriggerScanRequest | None = Body(default=None),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)
    row.scan_requested = True
    if body is None:
        row.scan_website = None
        row.scan_all = False
        row.scan_all_position = None
        row.scan_all_total = None
    else:
        row.scan_website = body.website
        row.scan_all = body.scan_all
        row.scan_all_position = body.scan_all_position
        row.scan_all_total = body.scan_all_total
    await db.flush()
    return {"ok": True, "scan_requested": True}


@router.get("/pending-scan")
async def pending_scan(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        return {
            "pending": False,
            "website": None,
            "scan_all": False,
            "scan_all_position": None,
            "scan_all_total": None,
        }
    if row.scan_requested:
        row.scan_requested = False
        w = row.scan_website
        sa = row.scan_all
        pos = row.scan_all_position
        tot = row.scan_all_total
        row.scan_website = None
        row.scan_all = False
        row.scan_all_position = None
        row.scan_all_total = None
        await db.flush()
        return {
            "pending": True,
            "website": w,
            "scan_all": sa,
            "scan_all_position": pos,
            "scan_all_total": tot,
        }
    return {
        "pending": False,
        "website": None,
        "scan_all": False,
        "scan_all_position": None,
        "scan_all_total": None,
    }


# ---------------------------------------------------------------------------
# Stop trigger
# ---------------------------------------------------------------------------

@router.post("/trigger-stop")
async def trigger_stop(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        row = ExtensionState(id=1)
        db.add(row)
    row.stop_requested = True
    await db.flush()
    await db.execute(
        update(ExtensionRunLog)
        .where(ExtensionRunLog.status == "running")
        .values(
            status="failed",
            error_message="Stopped by user",
            completed_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return {"ok": True}


@router.get("/pending-stop")
async def pending_stop(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        return {"pending": False}
    if row.stop_requested:
        row.stop_requested = False
        await db.flush()
        return {"pending": True}
    return {"pending": False}


# ---------------------------------------------------------------------------
# Run logs
# ---------------------------------------------------------------------------

class _RunLogStartResponse(BaseModel):
    id: UUID


@router.post("/run-log/start", response_model=_RunLogStartResponse)
async def start_run_log(
    body: RunLogCreate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    log = ExtensionRunLog(
        status="running",
        strategy=body.strategy,
        search_keyword=body.search_keyword,
        search_location=body.search_location,
        search_filters=body.search_filters,
        scan_all=body.scan_all,
        scan_all_position=body.scan_all_position,
        scan_all_total=body.scan_all_total,
    )
    db.add(log)
    await db.flush()
    return _RunLogStartResponse(id=log.id)


@router.put("/run-log/{log_id}", response_model=RunLogRead)
async def update_run_log(
    log_id: UUID,
    body: RunLogUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.id == log_id)
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=404, detail="Run log not found")

    prior_status = log.status

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(log, field, value)

    await db.flush()
    await db.refresh(log)

    if body.status == "completed" and prior_status != "completed":
        config_data = await read_config_file()
        cfg = SearchConfigRead(**config_data)
        if cfg.dedup_mode == "sync":
            should_dedup = True
            if log.scan_all:
                should_dedup = (
                    log.scan_all_position is not None
                    and log.scan_all_total is not None
                    and log.scan_all_position == log.scan_all_total
                )
            if should_dedup:
                background_tasks.add_task(_run_dedup_for_scan, log_id)

    return log


@router.get("/run-log", response_model=list[RunLogRead])
async def list_run_logs(
    limit: int = Query(10, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = select(ExtensionRunLog)
    if status is not None:
        stmt = stmt.where(ExtensionRunLog.status == status)
    stmt = stmt.order_by(ExtensionRunLog.started_at.desc()).offset(offset).limit(limit)

    result = await db.execute(stmt)
    return result.scalars().all()


# ---------------------------------------------------------------------------
# Session error
# ---------------------------------------------------------------------------

class _SessionErrorBody(BaseModel):
    error: str


@router.post("/session-error", status_code=200)
async def report_session_error(
    body: _SessionErrorBody,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ExtensionRunLog)
        .where(ExtensionRunLog.status == "running")
        .order_by(ExtensionRunLog.started_at.desc())
        .limit(1)
    )
    log = result.scalar_one_or_none()
    if log is not None:
        log.session_error = body.error
        await db.flush()

    return {"ok": True}
