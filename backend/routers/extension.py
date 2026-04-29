import asyncio
import logging
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.auth import get_current_user
from core.config import settings
from core.config_file import read_config_file
from core.database import AsyncSessionLocal, get_db
from dedup.service import run_dedup
from models.dedup_task import DedupTask
from models.extension_run_log import ExtensionRunLog
from models.extension_state import ExtensionState
from schemas.config import SearchConfigRead
from schemas.extension import ExtensionStateRead, ExtensionStateUpdate, TriggerScanRequest
from schemas.debug_log import DebugLogAppend
from schemas.run_log import RunLogCreate, RunLogRead, RunLogUpdate
from routers.run_log_ws import broadcast_run_log_update

router = APIRouter(prefix="/extension", tags=["extension"])

logger = logging.getLogger(__name__)

# Fire-and-forget background tasks for post-scan dedup.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def _run_log_search_placeholder(value: str | None) -> str:
    if value is None or not str(value).strip():
        return "(setup pending)"
    return str(value)


async def _run_dedup_for_scan(log_id: UUID) -> None:
    """
    Runs full dedup after a scan completes. Uses its own DB session — the request
    session is closed after the PUT response.
    """
    task_id: UUID | None = None
    async with AsyncSessionLocal() as db:
        task = DedupTask(
            scan_run_id=log_id,
            status="running",
            trigger="post_scan",
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)
        task_id = task.id

    async def heartbeat_updater() -> None:
        while True:
            await asyncio.sleep(30)
            try:
                async with AsyncSessionLocal() as hb_db:
                    result = await hb_db.execute(
                        select(DedupTask).where(DedupTask.id == task_id)
                    )
                    fresh = result.scalar_one_or_none()
                    if fresh is None or fresh.status != "running":
                        return
                    fresh.last_heartbeat_at = datetime.now(timezone.utc)
                    await hb_db.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Dedup heartbeat update failed")

    hb_task = asyncio.create_task(heartbeat_updater())

    try:
        async with AsyncSessionLocal() as db:
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

        async with AsyncSessionLocal() as db:
            result = await db.execute(select(DedupTask).where(DedupTask.id == task_id))
            t = result.scalar_one_or_none()
            if t:
                t.status = "completed"
                t.completed_at = datetime.now(timezone.utc)
                await db.commit()
    except Exception as e:
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(DedupTask).where(DedupTask.id == task_id))
            t = result.scalar_one_or_none()
            if t:
                t.status = "failed"
                t.error_message = str(e)
                t.completed_at = datetime.now(timezone.utc)
                await db.commit()
        logger.exception("Auto dedup failed for scan run %s", log_id)
    finally:
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass


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
    # B-33: reject if a scan trigger is already pending in the mailbox.
    state_result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    state_row = state_result.scalar_one_or_none()
    if state_row is not None and state_row.scan_requested:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "scan_pending",
                "message": "A scan trigger is already pending; the extension hasn't picked it up yet. Retry in a few seconds.",
                "retry_after_ms": 3000,
            },
        )

    # B-33: reject if a run-log just finished (stop-cleanup race) or one is running.
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=5)
    recent = await db.execute(
        select(ExtensionRunLog)
        .where(ExtensionRunLog.completed_at.isnot(None))
        .where(ExtensionRunLog.completed_at > cutoff)
        .order_by(ExtensionRunLog.completed_at.desc())
        .limit(1)
    )
    if recent.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "stop_cooldown",
                "message": "A scan recently terminated; the extension is still cleaning up. Retry in 5 seconds.",
                "retry_after_ms": 5000,
            },
        )

    # Lazy cleanup of stale running run-logs (e.g. B-23: extension aborted while
    # backend was down, so the final failed PUT never landed). Real single-site
    # scans finish in minutes; anything still running after 5m is treated as stuck.
    stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    await db.execute(
        update(ExtensionRunLog)
        .where(ExtensionRunLog.status == "running")
        .where(ExtensionRunLog.started_at < stale_cutoff)
        .values(
            status="failed",
            error_message=(
                "Scan exceeded 5 minutes without completion; "
                "backend likely lost contact during scan. Please retry."
            ),
            completed_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()

    running = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.status == "running").limit(1)
    )
    if running.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "scan_in_progress",
                "message": "A scan is already in progress. Stop it first or wait for completion.",
                "retry_after_ms": 5000,
            },
        )

    row = state_row
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
    """
    Marks any running run-logs as failed AND sets stop_requested.

    The dual-path is intentional: stop must succeed even if the SW is
    dead/suspended, so the run-log is cleaned up here directly.
    trigger-scan doesn't need this because a scan can't start without a
    working SW anyway.
    """
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


@router.get("/pending")
async def pending_combined(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """
    Atomically read-and-clear both scan and stop flags in one transaction.
    Same semantics as GET /pending-scan and GET /pending-stop combined.
    """
    result = await db.execute(select(ExtensionState).where(ExtensionState.id == 1))
    row = result.scalar_one_or_none()
    if row is None:
        return {
            "scan": {
                "pending": False,
                "website": None,
                "scan_all": False,
                "scan_all_position": None,
                "scan_all_total": None,
            },
            "stop": {"pending": False},
        }

    scan_pending = bool(row.scan_requested)
    stop_pending = bool(row.stop_requested)

    w = None
    sa = False
    pos = None
    tot = None
    if scan_pending:
        w = row.scan_website
        sa = row.scan_all
        pos = row.scan_all_position
        tot = row.scan_all_total

    row.scan_requested = False
    row.scan_website = None
    row.scan_all = False
    row.scan_all_position = None
    row.scan_all_total = None
    row.stop_requested = False
    await db.flush()

    return {
        "scan": {
            "pending": scan_pending,
            "website": w if scan_pending else None,
            "scan_all": sa if scan_pending else False,
            "scan_all_position": pos if scan_pending else None,
            "scan_all_total": tot if scan_pending else None,
        },
        "stop": {"pending": stop_pending},
    }


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
        search_keyword=_run_log_search_placeholder(body.search_keyword),
        search_location=_run_log_search_placeholder(body.search_location),
        search_filters=body.search_filters,
        scan_all=body.scan_all,
        scan_all_position=body.scan_all_position,
        scan_all_total=body.scan_all_total,
    )
    db.add(log)
    await db.flush()
    return _RunLogStartResponse(id=log.id)


@router.post("/run-log/{log_id}/debug")
async def append_debug_log(
    log_id: UUID,
    payload: DebugLogAppend,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Append debug events to a run log. Ring-buffered at 10k events."""
    result = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.id == log_id)
    )
    run_log = result.scalar_one_or_none()
    if not run_log:
        raise HTTPException(status_code=404, detail="run log not found")

    existing = (run_log.debug_log or {}).get("events", [])
    if not isinstance(existing, list):
        existing = []
    new_events = [e.model_dump(mode="json") for e in payload.events]
    combined = [*existing, *new_events]
    if len(combined) > settings.debug_log_ring_size:
        combined = combined[-settings.debug_log_ring_size :]

    run_log.debug_log = {"events": combined}
    flag_modified(run_log, "debug_log")

    await db.commit()
    return {
        "ok": True,
        "total_events": len(combined),
        "accepted": len(payload.events),
    }


@router.put("/run-log/{log_id}", response_model=RunLogRead)
async def update_run_log(
    log_id: UUID,
    body: RunLogUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ExtensionRunLog).where(ExtensionRunLog.id == log_id)
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=404, detail="Run log not found")

    dumped = body.model_dump(exclude_unset=True)
    if log.status == "completed" and "status" not in dumped:
        return log

    prior_status = log.status

    for field, value in dumped.items():
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
                task = asyncio.create_task(_run_dedup_for_scan(log_id))
                _BACKGROUND_TASKS.add(task)
                task.add_done_callback(_BACKGROUND_TASKS.discard)

    await broadcast_run_log_update(log)
    return log


@router.get("/run-log", response_model=list[RunLogRead])
async def list_run_logs(
    limit: int = Query(10, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = None,
    include_debug_log: bool = Query(True),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = select(ExtensionRunLog)
    if status is not None:
        stmt = stmt.where(ExtensionRunLog.status == status)
    stmt = stmt.order_by(ExtensionRunLog.started_at.desc()).offset(offset).limit(limit)

    result = await db.execute(stmt)
    rows = result.scalars().all()
    if not include_debug_log:
        return [
            RunLogRead.model_validate(r).model_copy(update={"debug_log": None})
            for r in rows
        ]
    return [RunLogRead.model_validate(r) for r in rows]


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
