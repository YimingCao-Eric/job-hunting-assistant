from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import Text, and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from core.auth import get_current_user
from core.database import get_db
from models.dedup_task import DedupTask
from models.extension_run_log import ExtensionRunLog
from models.scraped_job import ScrapedJob
from schemas.auto_scrape import CleanupInvalidEntriesResponse

router = APIRouter(prefix="/admin", tags=["admin"])


async def _delete_scraped_jobs_where(
    db: AsyncSession, where_clause: ColumnElement[bool]
) -> int:
    """Detach self-FK original_job_id pointers, then delete matched rows (same tx)."""
    ids_result = await db.execute(select(ScrapedJob.id).where(where_clause))
    ids_to_delete = list(ids_result.scalars().all())
    if not ids_to_delete:
        return 0
    await db.execute(
        update(ScrapedJob)
        .where(ScrapedJob.original_job_id.in_(ids_to_delete))
        .values(original_job_id=None)
    )
    del_result = await db.execute(
        delete(ScrapedJob).where(ScrapedJob.id.in_(ids_to_delete))
    )
    return del_result.rowcount or 0


@router.post("/cleanup-invalid-entries", response_model=CleanupInvalidEntriesResponse)
async def cleanup_invalid_entries(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    deleted_empty_core = await _delete_scraped_jobs_where(
        db,
        or_(
            ScrapedJob.job_title.is_(None),
            ScrapedJob.job_title == "",
            ScrapedJob.company.is_(None),
            ScrapedJob.company == "",
        ),
    )

    one_day_ago = datetime.now(timezone.utc) - timedelta(days=1)
    deleted_empty_jd = await _delete_scraped_jobs_where(
        db,
        and_(
            or_(
                ScrapedJob.job_description.is_(None),
                func.length(ScrapedJob.job_description.cast(Text)) < 50,
            ),
            ScrapedJob.created_at < one_day_ago,
        ),
    )

    deleted_mismatched = await _delete_scraped_jobs_where(
        db,
        or_(
            ScrapedJob.website.is_(None),
            ScrapedJob.website.notin_(["linkedin", "indeed", "glassdoor"]),
        ),
    )

    ten_min_ago = datetime.now(timezone.utc) - timedelta(minutes=10)
    now = datetime.now(timezone.utc)
    result4 = await db.execute(
        update(ExtensionRunLog)
        .where(
            ExtensionRunLog.status == "running",
            ExtensionRunLog.started_at < ten_min_ago,
        )
        .values(
            status="failed",
            error_message="Marked failed by cleanup-invalid-entries (>10 min stale)",
            completed_at=now,
            failure_reason="lazy_cleanup_timeout",
            failure_category="transient",
        )
    )
    marked_failed_run_logs = result4.rowcount or 0

    result5 = await db.execute(
        update(DedupTask)
        .where(
            DedupTask.status == "running",
            or_(
                DedupTask.last_heartbeat_at < ten_min_ago,
                DedupTask.last_heartbeat_at.is_(None),
            ),
        )
        .values(
            status="failed",
            error_message="Marked failed by cleanup-invalid-entries (>10 min stale heartbeat)",
            completed_at=now,
        )
    )
    marked_failed_dedup_tasks = result5.rowcount or 0

    return CleanupInvalidEntriesResponse(
        deleted_jobs_empty_core=deleted_empty_core,
        deleted_jobs_empty_jd=deleted_empty_jd,
        deleted_jobs_mismatched_website=deleted_mismatched,
        marked_failed_run_logs=marked_failed_run_logs,
        marked_failed_dedup_tasks=marked_failed_dedup_tasks,
    )
