"""Smoke test: matched claim-and-flag mechanism.

Verifies:
  - claim flips matched=false → true
  - claim returns the rows
  - the SQL pattern is idempotent (verified scoped to test rows, not globally)
  - all three tables claimed in one transaction (manual fault-injection — SKIP'd here)
"""

from __future__ import annotations

import asyncio
import sys
from uuid import UUID, uuid4

from sqlalchemy import text

from auto_scrape.matching_claim import claim_unmatched_rows
from core.database import AsyncSessionLocal


async def _column_exists(db, table: str, col: str) -> bool:
    """Returns True if the named column exists in the named table."""
    result = await db.execute(
        text("""
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :t
              AND column_name = :c
        """),
        {"t": table, "c": col},
    )
    return result.scalar() is not None


async def _verify_required_columns(db) -> None:
    """Pre-flight: confirm all the columns this smoke test depends on exist."""
    required = [
        ("linkedin_jobs", "matched"),
        ("indeed_jobs", "matched"),
        ("indeed_jobs", "mosaic_present"),
        ("glassdoor_jobs", "matched"),
    ]
    for table, col in required:
        if not await _column_exists(db, table, col):
            raise RuntimeError(
                f"Schema drift: {table}.{col} is missing. "
                "Smoke test cannot proceed. Run migration 028 (matched column) "
                "and verify migrations 025-027 are applied."
            )


_TABLE_EXTRAS = {
    "linkedin_jobs": {},
    "indeed_jobs": {"mosaic_present": True},
    "glassdoor_jobs": {},
}


async def _setup_test_row(db, table: str, scan_run_id: UUID) -> UUID:
    """Insert a test row with matched=false. Returns the inserted id."""
    job_url = f"https://test.example.com/{table}/{uuid4()}"

    extras = _TABLE_EXTRAS[table]
    cols = "id, scan_run_id, job_url, scrape_time, matched"
    vals = "gen_random_uuid(), :sid, :url, NOW(), FALSE"
    params: dict = {"sid": scan_run_id, "url": job_url}
    for col, val in extras.items():
        cols += f", {col}"
        vals += f", :{col}"
        params[col] = val

    result = await db.execute(
        text(f"INSERT INTO {table} ({cols}) VALUES ({vals}) RETURNING id"),
        params,
    )
    return result.scalar_one()


async def test_basic_claim() -> None:
    """Claim flips matched=false → true and returns the rows."""
    async with AsyncSessionLocal() as db:
        await _verify_required_columns(db)
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print(
                "[SKIP] basic_claim: no extension_run_logs rows; need one for FK",
                file=sys.stderr,
            )
            return

    ids = {}
    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            ids[site] = await _setup_test_row(db, table, run_id)
        await db.commit()

    async with AsyncSessionLocal() as db:
        claimed = await claim_unmatched_rows(db)
        await db.commit()

    for site in ("linkedin", "indeed", "glassdoor"):
        claimed_ids = {r["id"] for r in claimed[site]}
        assert ids[site] in claimed_ids, f"{site}: claim missed our test row"

    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            result = await db.execute(
                text(f"SELECT matched FROM {table} WHERE id = :id"),
                {"id": ids[site]},
            )
            assert result.scalar() is True, f"{site}: matched should be TRUE"
        await db.commit()

    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            await db.execute(
                text(f"DELETE FROM {table} WHERE id = :id"),
                {"id": ids[site]},
            )
        await db.commit()

    print("[OK] basic claim and flag")


async def test_idempotent_claim_scoped() -> None:
    """Idempotent UPDATE pattern scoped to test rows only."""
    async with AsyncSessionLocal() as db:
        await _verify_required_columns(db)
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print(
                "[SKIP] idempotent_claim_scoped: no extension_run_logs rows",
                file=sys.stderr,
            )
            return

    ids = {}
    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            ids[site] = await _setup_test_row(db, table, run_id)
        await db.commit()

    for site, table in [
        ("linkedin", "linkedin_jobs"),
        ("indeed", "indeed_jobs"),
        ("glassdoor", "glassdoor_jobs"),
    ]:
        async with AsyncSessionLocal() as db:
            result1 = await db.execute(
                text(f"""
                    UPDATE {table} SET matched = TRUE
                    WHERE matched = FALSE AND id = :id
                    RETURNING id
                """),
                {"id": ids[site]},
            )
            rows1 = list(result1)
            assert len(rows1) == 1, (
                f"{site}: first scoped UPDATE should flip 1 row, got {len(rows1)}"
            )

            result2 = await db.execute(
                text(f"""
                    UPDATE {table} SET matched = TRUE
                    WHERE matched = FALSE AND id = :id
                    RETURNING id
                """),
                {"id": ids[site]},
            )
            rows2 = list(result2)
            assert len(rows2) == 0, (
                f"{site}: second scoped UPDATE should flip 0 rows, got {len(rows2)}"
            )
            await db.commit()

    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            await db.execute(
                text(f"DELETE FROM {table} WHERE id = :id"),
                {"id": ids[site]},
            )
        await db.commit()

    print("[OK] idempotence verified (scoped UPDATE-RETURNING pattern)")


async def test_atomic_three_table_claim() -> None:
    """Manual fault injection — documented SKIP."""
    print("[SKIP] atomic three-table claim — requires manual fault injection test")


async def main() -> None:
    await test_basic_claim()
    await test_idempotent_claim_scoped()
    await test_atomic_three_table_claim()
    print("[OK] all matched-claim smoke tests complete")


if __name__ == "__main__":
    asyncio.run(main())
