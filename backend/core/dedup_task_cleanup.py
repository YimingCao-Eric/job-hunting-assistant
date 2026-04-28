"""Mark orphaned dedup_tasks as failed after backend restart (B-18)."""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from core.database import AsyncSessionLocal
from models.dedup_task import DedupTask

logger = logging.getLogger(__name__)


async def mark_stale_dedup_tasks_failed() -> int:
    """
    SAFER BRANCH: do NOT auto-rerun orphaned tasks. We mark them as failed
    so the user must manually re-trigger via the dashboard. Auto-rerun
    would corrupt data if run_dedup is non-idempotent. To switch to
    auto-rerun, first verify run_dedup idempotency empirically.
    """
    async with AsyncSessionLocal() as db:
        stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        result = await db.execute(
            select(DedupTask).where(
                DedupTask.status == "running",
                DedupTask.last_heartbeat_at < stale_cutoff,
            )
        )
        stale = result.scalars().all()
        for task in stale:
            task.status = "failed"
            task.error_message = (
                "Backend restarted while task was running. "
                "Re-run dedup manually from the /dedup page."
            )
            task.completed_at = datetime.now(timezone.utc)
            logger.error(
                "Orphaned dedup task %s for scan %s marked failed; "
                "manual recovery required",
                task.id,
                task.scan_run_id,
            )
        if stale:
            await db.commit()
        return len(stale)
