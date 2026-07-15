"""Matching claim-and-flag helper.

Atomically claims unmatched rows from all three per-source tables
via UPDATE-RETURNING, and mirrors the claim onto their canonical
`scraped_jobs` rows.

Pattern (per Issue 2.4 Solution A): all UPDATEs run in one
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
    Atomically claim all unmatched rows from all three per-source tables, and record the
    same claim on their canonical `scraped_jobs` rows.

    Transaction: this function does NOT begin a transaction. Caller is
    expected to wrap calls in `async with db.begin():` so all the
    UPDATEs commit together or roll back together.

    The canonical rows must be flipped here, not left to a later step. `matched` is
    copied at ingest, when it is always false, so nothing else would ever set it true --
    the canonical flag would be permanently wrong for exactly the rows matching has
    already processed, and a future matching run would re-claim them.
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

    # Mirror onto the canonical rows. A blanket UPDATE is equivalent to targeting the
    # rows just returned: dual-write keeps scraped_jobs 1:1 with the per-source tables
    # and both sides start false, so "every unmatched canonical row" is exactly "the
    # canonical twin of every row claimed above". It also needs no large IN-list.
    canonical_result = await db.execute(
        text("UPDATE scraped_jobs SET matched = TRUE WHERE matched = FALSE")
    )
    canonical_claimed = canonical_result.rowcount or 0

    counts = {site: len(rows) for site, rows in claimed.items()}
    logger.info(
        "Claimed unmatched rows: %s (canonical scraped_jobs: %d)",
        counts,
        canonical_claimed,
    )
    return claimed
