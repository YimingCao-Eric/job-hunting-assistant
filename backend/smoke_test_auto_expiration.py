"""Smoke test: auto-expiration deletes rows older than shelf_life_days.

Covers the per-source tables and their canonical scraped_jobs twins: a canonical row
must not outlive the per-source row it was projected from.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import text

from auto_scrape.auto_expiration import run_auto_expiration
from core.database import AsyncSessionLocal


async def test_expires_old_rows() -> None:
    async with AsyncSessionLocal() as db:
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print("[SKIP] need an extension_run_logs row for FK")
            return

    old_time = datetime.now(timezone.utc) - timedelta(days=30)
    old_id = uuid4()
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("""
                INSERT INTO linkedin_jobs (id, scan_run_id, job_url, scrape_time, matched)
                VALUES (:id, :sid, :url, :st, FALSE)
            """),
            {
                "id": old_id,
                "sid": run_id,
                "url": f"https://test.expire.{old_id}",
                "st": old_time,
            },
        )
        await db.commit()

    fresh_id = uuid4()
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("""
                INSERT INTO linkedin_jobs (id, scan_run_id, job_url, scrape_time, matched)
                VALUES (:id, :sid, :url, NOW(), FALSE)
            """),
            {
                "id": fresh_id,
                "sid": run_id,
                "url": f"https://test.fresh.{fresh_id}",
            },
        )
        await db.commit()

    async with AsyncSessionLocal() as db:
        results = await run_auto_expiration(db)
        await db.commit()

    assert "deleted_per_table" in results
    assert results["deleted_per_table"]["linkedin_jobs"] >= 1

    async with AsyncSessionLocal() as db:
        old_check = await db.execute(
            text("SELECT 1 FROM linkedin_jobs WHERE id = :id"), {"id": old_id}
        )
        assert old_check.scalar() is None, "old row should be deleted"

        fresh_check = await db.execute(
            text("SELECT 1 FROM linkedin_jobs WHERE id = :id"), {"id": fresh_id}
        )
        assert fresh_check.scalar() == 1, "fresh row should be preserved"
        await db.commit()

    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM linkedin_jobs WHERE id = :id"), {"id": fresh_id}
        )
        await db.commit()

    print("[OK] auto-expiration deletes old rows; preserves fresh rows")


async def _insert_pair(db, run_id, row_id, url, scrape_time_sql: str, params: dict):
    """Insert a linkedin_jobs row and its canonical twin, sharing one scrape_time.

    Mirrors what ingest's dual-write produces: the canonical row copies the per-source
    row's scrape_time rather than defaulting to its own now(). Expiration matches the two
    tables on that predicate, so a test that let them default separately would not be
    testing the real thing.
    """
    await db.execute(
        text(f"""
            INSERT INTO linkedin_jobs (id, scan_run_id, job_url, scrape_time, matched)
            VALUES (:id, :sid, :url, {scrape_time_sql}, FALSE)
        """),
        {"id": row_id, "sid": run_id, "url": url, **params},
    )
    await db.execute(
        text(f"""
            INSERT INTO scraped_jobs
                (source_site, source_row_id, scan_run_id, job_url, scrape_time, title)
            VALUES ('linkedin', :id, :sid, :url, {scrape_time_sql}, 'Expiry Fixture')
        """),
        {"id": row_id, "sid": run_id, "url": url, **params},
    )


async def test_expires_canonical_rows_too() -> None:
    """FR-027: expiring a per-source row also removes its canonical twin."""
    async with AsyncSessionLocal() as db:
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print("[SKIP] need an extension_run_logs row for FK")
            return

    old_id, fresh_id = uuid4(), uuid4()
    old_url, fresh_url = f"https://test.exp.old.{old_id}", f"https://test.exp.fresh.{fresh_id}"
    old_time = datetime.now(timezone.utc) - timedelta(days=30)

    async with AsyncSessionLocal() as db:
        await _insert_pair(db, run_id, old_id, old_url, ":st", {"st": old_time})
        await _insert_pair(db, run_id, fresh_id, fresh_url, "NOW()", {})
        await db.commit()

    async with AsyncSessionLocal() as db:
        results = await run_auto_expiration(db)
        await db.commit()

    assert results["deleted_per_table"]["scraped_jobs"] >= 1, (
        "expiration should report canonical deletions"
    )

    async with AsyncSessionLocal() as db:
        aged = (
            await db.execute(
                text("SELECT 1 FROM scraped_jobs WHERE job_url = :u"), {"u": old_url}
            )
        ).scalar()
        assert aged is None, (
            "canonical row outlived its expired per-source row -- the two tables are "
            "not being expired by the same predicate"
        )

        fresh = (
            await db.execute(
                text("SELECT 1 FROM scraped_jobs WHERE job_url = :u"), {"u": fresh_url}
            )
        ).scalar()
        assert fresh == 1, "fresh canonical row should be preserved"

        # The invariant SC-008 states: no canonical row whose per-source row is gone.
        orphans = (
            await db.execute(
                text("""
                    SELECT count(*) FROM scraped_jobs s
                     WHERE NOT EXISTS (SELECT 1 FROM linkedin_jobs  WHERE id = s.source_row_id)
                       AND NOT EXISTS (SELECT 1 FROM indeed_jobs    WHERE id = s.source_row_id)
                       AND NOT EXISTS (SELECT 1 FROM glassdoor_jobs WHERE id = s.source_row_id)
                """)
            )
        ).scalar()
        assert orphans == 0, f"{orphans} canonical rows have no per-source row"
        await db.commit()

    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM scraped_jobs WHERE job_url = :u"), {"u": fresh_url}
        )
        await db.execute(
            text("DELETE FROM linkedin_jobs WHERE id = :id"), {"id": fresh_id}
        )
        await db.commit()

    print("[OK] auto-expiration removes canonical rows with their per-source rows")
    print("[OK] no orphaned canonical rows remain (SC-008)")


async def main() -> None:
    await test_expires_old_rows()
    await test_expires_canonical_rows_too()
    print("[OK] all auto-expiration smoke tests complete")


if __name__ == "__main__":
    asyncio.run(main())
