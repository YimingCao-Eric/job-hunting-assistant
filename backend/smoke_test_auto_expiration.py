"""Smoke test: auto-expiration deletes rows older than shelf_life_days."""

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


async def main() -> None:
    await test_expires_old_rows()
    print("[OK] all auto-expiration smoke tests complete")


if __name__ == "__main__":
    asyncio.run(main())
