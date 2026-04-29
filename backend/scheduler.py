"""APScheduler jobs for auto-scrape maintenance (Phase 1)."""

import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import and_, or_, update

from core.database import AsyncSessionLocal
from models.auto_scrape_cycle import AutoScrapeCycle

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def cleanup_stale_postscrape() -> None:
    cutoff_10 = datetime.now(timezone.utc) - timedelta(minutes=10)
    cutoff_5 = datetime.now(timezone.utc) - timedelta(minutes=5)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(AutoScrapeCycle)
            .where(
                AutoScrapeCycle.status == "postscrape_running",
                or_(
                    AutoScrapeCycle.phase_heartbeat_at < cutoff_10,
                    and_(
                        AutoScrapeCycle.phase_heartbeat_at.is_(None),
                        AutoScrapeCycle.started_at < cutoff_5,
                    ),
                ),
            )
            .values(
                status="failed",
                error_message="Post-scrape orchestrator died mid-phase (stale heartbeat)",
                completed_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()
        if result.rowcount:
            logger.warning(
                "Marked %d stuck postscrape cycles as failed", result.rowcount
            )


async def poll_for_pending_cycles() -> None:
    try:
        from auto_scrape.post_scrape_orchestrator import process_pending_cycles

        await process_pending_cycles()
    except Exception:
        logger.exception("APScheduler post-scrape poll failed")


def setup_scheduler() -> None:
    if scheduler.running:
        return
    scheduler.add_job(
        cleanup_stale_postscrape,
        "interval",
        minutes=1,
        id="auto_scrape_cleanup_stale_postscrape",
        replace_existing=True,
    )
    scheduler.add_job(
        poll_for_pending_cycles,
        "interval",
        minutes=1,
        id="auto_scrape_poll_pending_cycles",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("APScheduler started (auto-scrape jobs)")


def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
