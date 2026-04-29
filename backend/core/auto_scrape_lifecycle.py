"""Startup maintenance for auto-scrape cycle rows."""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from core.database import AsyncSessionLocal
from models.auto_scrape_cycle import AutoScrapeCycle

logger = logging.getLogger(__name__)


async def cleanup_stale_cycles_at_startup() -> None:
    """
    Mark cycles stuck in scrape_running/postscrape_running for more than 2 hours
    as failed (backend restart / shutdown).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(AutoScrapeCycle)
            .where(
                AutoScrapeCycle.status.in_(["scrape_running", "postscrape_running"]),
                AutoScrapeCycle.started_at < cutoff,
            )
            .values(
                status="failed",
                error_message="Interrupted by backend restart or shutdown",
                completed_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()
        if result.rowcount:
            logger.info(
                "Cleaned up %d stale auto-scrape cycles at startup", result.rowcount
            )
