"""Matching claim-and-flag helper.

Atomically claims unmatched rows from all three per-source tables
via UPDATE-RETURNING (see docs/step1-schema-design.md §10.X).

Pattern (per Issue 2.4 Solution A): all three UPDATEs run in one
transaction. Caller manages the transaction boundary.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


logger = logging.getLogger(__name__)

_RETURN_COLS = "id, job_url, scan_run_id, scrape_time"


async def claim_unmatched_rows(db: AsyncSession) -> dict[str, list[dict[str, Any]]]:
    """
    Atomically claim all unmatched rows from all three per-source tables.

    Transaction: this function does NOT begin a transaction. Caller is
    expected to wrap calls in `async with db.begin():` so all three
    UPDATEs commit together or roll back together.
    """
    claimed: dict[str, list[dict[str, Any]]] = {
        "linkedin": [],
        "indeed": [],
        "glassdoor": [],
    }

    table_for_site = {
        "linkedin": "linkedin_jobs",
        "indeed": "indeed_jobs",
        "glassdoor": "glassdoor_jobs",
    }

    for site, table in table_for_site.items():
        result = await db.execute(
            text(
                f"UPDATE {table} SET matched = TRUE "
                f"WHERE matched = FALSE "
                f"RETURNING {_RETURN_COLS}"
            )
        )
        claimed[site] = [dict(r._mapping) for r in result]

    counts = {site: len(rows) for site, rows in claimed.items()}
    logger.info("Claimed unmatched rows: %s", counts)
    return claimed
