"""Auto-expiration: delete per-source rows older than shelf_life_days.

Deletes rows older than `system_settings.shelf_life_days` regardless of
`matched`. Shelf life is read via `core.system_settings.get_shelf_life_days`.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.system_settings import get_shelf_life_days


logger = logging.getLogger(__name__)


async def run_auto_expiration(db: AsyncSession) -> dict:
    """
    Delete per-source rows older than shelf_life_days.

    All three DELETEs run in one transaction (per matched-mechanism-
    updates-and-scan.md §2.4). Caller is responsible for the transaction
    boundary; this function uses the session's existing transaction.

    Returns a dict suitable for cycle.cleanup_results JSONB.
    """
    days = await get_shelf_life_days(db)

    deleted: dict[str, int] = {}
    for table in ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs"):
        result = await db.execute(
            text(
                f"DELETE FROM {table} "
                f"WHERE scrape_time < NOW() - make_interval(days => :d)"
            ),
            {"d": days},
        )
        deleted[table] = result.rowcount or 0

    logger.info("Auto-expiration: deleted %s (shelf_life=%d days)", deleted, days)
    return {"deleted_per_table": deleted, "shelf_life_days": days}
