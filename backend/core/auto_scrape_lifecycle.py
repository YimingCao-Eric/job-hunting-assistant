"""Startup maintenance for auto-scrape cycle rows."""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm.attributes import flag_modified

from core.database import AsyncSessionLocal
from models.auto_scrape_cycle import AutoScrapeCycle
from models.auto_scrape_state import AutoScrapeState

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
        if result.rowcount:
            logger.info(
                "Cleaned up %d stale auto-scrape cycles at startup", result.rowcount
            )
            row = await db.scalar(
                select(AutoScrapeState).where(AutoScrapeState.id == 1)
            )
            if row is not None:
                st = {**row.state, "cycle_phase": "idle"}
                row.state = st
                flag_modified(row, "state")
        await db.commit()
