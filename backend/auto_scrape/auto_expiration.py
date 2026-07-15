"""Auto-expiration: delete scraped rows older than shelf_life_days.

Deletes rows older than `system_settings.shelf_life_days` regardless of
`matched`. Shelf life is read via `core.system_settings.get_shelf_life_days`.

Covers the three per-source tables **and** the derived `scraped_jobs` table, so a
canonical row never outlives the per-source row it was projected from.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.system_settings import get_shelf_life_days


logger = logging.getLogger(__name__)


async def run_auto_expiration(db: AsyncSession) -> dict:
    """
    Delete scraped rows older than shelf_life_days.

    All DELETEs run in one transaction (per matched-mechanism-
    updates-and-scan.md §2.4). Caller is responsible for the transaction
    boundary; this function uses the session's existing transaction.

    `scraped_jobs` is expired by the **same** predicate as the per-source tables rather
    than by chasing `source_row_id`. That column is polymorphic across the three
    per-source tables, so no foreign key -- and therefore no ON DELETE CASCADE -- can
    exist to do this for us. Matching on the predicate works because ingest copies
    `scrape_time` from the per-source row byte-for-byte, so both tables see the identical
    timestamp and select the identical set. If that copy ever regresses to a fresh
    `now()`, the two sets drift at the shelf-life boundary and canonical rows are
    orphaned -- which is what `smoke_test_scraped_jobs_merge.py` guards.

    Returns a dict suitable for cycle.cleanup_results JSONB.
    """
    days = await get_shelf_life_days(db)

    deleted: dict[str, int] = {}
    for table in ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs", "scraped_jobs"):
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
