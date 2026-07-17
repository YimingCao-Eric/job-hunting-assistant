"""Smoke test: the matched flag after the post-scrape claim was retired.

This file's purpose changed with feature 010. It used to assert that the
post-scrape run claims rows. The auto-claim is retired, so it now asserts the
inverse -- nothing claims automatically -- plus the flag invariants that the
retirement did NOT touch. The behavior change is named in spec 010 FR-011; these
edits are its deliberate consequence, not a test bent until it passed.

Verifies:
  - a post-scrape run leaves rows UNCLAIMED (FR-001/FR-002, SC-001) -- the point
    of the feature: a downstream service claims them itself
  - a completed cycle records {"claim_summary": None, "claim_retired": True}
    (FR-007) -- claim_summary is retained-and-None ("no counts"), never zeroed
  - an external claimer keeps the canonical row and its per-source origin in
    agreement (FR-011a, SC-008) -- unaffected by the retirement, must not be lost
  - the one-way claim pattern is idempotent (FR-004a) -- the contract a
    downstream claimer codes against
  - the flag's storage contract is intact on every per-source table (FR-003)

NOT asserted, deliberately: that a claim is irreversible. This system never
claims and never un-claims; whether an external claimer may reset the flag for
blacklist re-entry is out of scope (FR-004c) and owned by the downstream
service's RE-ENTRY-WRITE question. Do not add an assertion that forecloses it.
"""

from __future__ import annotations

import asyncio
import sys
from uuid import UUID, uuid4

from sqlalchemy import text

from auto_scrape.post_scrape_orchestrator import run_post_scrape_phase
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


async def test_post_scrape_leaves_rows_unclaimed() -> None:
    """A post-scrape run does NOT claim rows: matched stays FALSE (FR-001, SC-001).

    This is the feature's central proof. Before feature 010 the run flipped every
    unclaimed row to TRUE, so a downstream filtering/matching service claiming with
    `WHERE matched = FALSE` found nothing after any cycle. Now the rows survive the
    cycle unclaimed and the service has a work queue.

    Runs the real orchestrator end to end -- nothing exercised it before.
    """
    async with AsyncSessionLocal() as db:
        await _verify_required_columns(db)
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print(
                "[SKIP] post_scrape_unclaimed: no extension_run_logs rows; "
                "need one for FK",
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
        # The canonical twins ingest would have written alongside them.
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            await db.execute(
                text(f"""
                    INSERT INTO scraped_jobs
                        (source_site, source_row_id, scan_run_id, job_url,
                         scrape_time, matched, title)
                    SELECT '{site}', id, scan_run_id, job_url, scrape_time, FALSE,
                           'Retired Claim Fixture'
                      FROM {table} WHERE id = :id
                """),
                {"id": ids[site]},
            )
        await db.commit()

    # A cycle the orchestrator will finalize. cycle_id is the human-facing NUMBER
    # and is NOT NULL; production draws it from this sequence (routers/auto_scrape.py
    # create_cycle), so the fixture does the same rather than inventing a value.
    async with AsyncSessionLocal() as db:
        cycle_pk = (
            await db.execute(
                text("""
                    INSERT INTO auto_scrape_cycles
                        (id, cycle_id, status, started_at, phase_heartbeat_at)
                    VALUES (gen_random_uuid(),
                            nextval('auto_scrape_cycle_id_seq'),
                            'postscrape_running', NOW(), NOW())
                    RETURNING id
                """)
            )
        ).scalar_one()
        await db.commit()

    await run_post_scrape_phase(cycle_pk)

    # The rows must have survived the cycle unclaimed -- per-source AND canonical.
    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            source_matched = (
                await db.execute(
                    text(f"SELECT matched FROM {table} WHERE id = :id"),
                    {"id": ids[site]},
                )
            ).scalar()
            assert source_matched is False, (
                f"{site}: post-scrape claimed the row; matched should still be FALSE "
                "-- the auto-claim is retired and the downstream service owns the claim"
            )
            canonical_matched = (
                await db.execute(
                    text(
                        "SELECT matched FROM scraped_jobs WHERE source_row_id = :id"
                    ),
                    {"id": ids[site]},
                )
            ).scalar()
            assert canonical_matched is False, (
                f"{site}: post-scrape claimed the canonical row; should still be FALSE"
            )

        # FR-007: the cycle reports a retired claim, never counts (not even zeroed).
        status, match_results = (
            await db.execute(
                text(
                    "SELECT status, match_results FROM auto_scrape_cycles "
                    "WHERE id = :id"
                ),
                {"id": cycle_pk},
            )
        ).one()
        assert status == "post_scrape_complete", (
            f"cycle should have finalized, got status={status!r}"
        )
        assert match_results == {"claim_summary": None, "claim_retired": True}, (
            f"cycle should report a retired claim, got {match_results!r}"
        )
        await db.commit()

    async with AsyncSessionLocal() as db:
        for site, table in [
            ("linkedin", "linkedin_jobs"),
            ("indeed", "indeed_jobs"),
            ("glassdoor", "glassdoor_jobs"),
        ]:
            await db.execute(
                text("DELETE FROM scraped_jobs WHERE source_row_id = :id"),
                {"id": ids[site]},
            )
            await db.execute(
                text(f"DELETE FROM {table} WHERE id = :id"), {"id": ids[site]}
            )
        await db.execute(
            text("DELETE FROM auto_scrape_cycles WHERE id = :id"), {"id": cycle_pk}
        )
        await db.commit()

    print("[OK] post-scrape leaves rows unclaimed; cycle reports claim retired")


async def test_external_claimer_keeps_rows_in_agreement() -> None:
    """A claimer flipping both sides in one transaction keeps them in agreement.

    Retained from before feature 010 (FR-011a): the canonical/per-source agreement
    invariant (spec 008 FR-028, SC-008) is untouched by retiring the auto-claim and
    must not be lost with it.

    What changed is the actor. The claim used to be performed here by JHA; now
    nothing in JHA claims, so this simulates the EXTERNAL claimer the flag is
    reserved for, and pins the contract it must honour (FR-004a): flip the canonical
    row and its per-source origin together, in a single transaction, so the two never
    disagree. That obligation is not new -- it is the existing agreement invariant
    plus the existing atomic-multi-table-write rule.
    """
    async with AsyncSessionLocal() as db:
        run_id = (
            await db.execute(text("SELECT id FROM extension_run_logs LIMIT 1"))
        ).scalar()
        await db.commit()
        if run_id is None:
            print("[SKIP] claim_canonical: no extension_run_logs rows", file=sys.stderr)
            return

    async with AsyncSessionLocal() as db:
        source_id = await _setup_test_row(db, "linkedin_jobs", run_id)
        url = (
            await db.execute(
                text("SELECT job_url FROM linkedin_jobs WHERE id = :id"),
                {"id": source_id},
            )
        ).scalar()
        # The canonical twin ingest would have written for this row.
        await db.execute(
            text("""
                INSERT INTO scraped_jobs
                    (source_site, source_row_id, scan_run_id, job_url, scrape_time,
                     matched, title)
                SELECT 'linkedin', id, scan_run_id, job_url, scrape_time, FALSE,
                       'Claim Fixture'
                  FROM linkedin_jobs WHERE id = :id
            """),
            {"id": source_id},
        )
        await db.commit()

    # The external claimer: both sides, one transaction, scoped to its own rows.
    # Scoped -- unlike the retired blanket claim, which flipped every unclaimed row
    # in the database and made this test mutate the whole corpus as a side effect.
    async with AsyncSessionLocal() as db:
        async with db.begin():
            await db.execute(
                text(
                    "UPDATE linkedin_jobs SET matched = TRUE "
                    "WHERE matched = FALSE AND id = :id"
                ),
                {"id": source_id},
            )
            await db.execute(
                text(
                    "UPDATE scraped_jobs SET matched = TRUE "
                    "WHERE matched = FALSE AND source_row_id = :id"
                ),
                {"id": source_id},
            )

    async with AsyncSessionLocal() as db:
        canonical_matched = (
            await db.execute(
                text("SELECT matched FROM scraped_jobs WHERE source_row_id = :id"),
                {"id": source_id},
            )
        ).scalar()
        assert canonical_matched is True, (
            "canonical row still reports unclaimed after its per-source row was claimed"
        )

        # The pair must never disagree about being claimed (spec 008 SC-010,
        # carried forward as spec 010 SC-008).
        disagreements = (
            await db.execute(
                text("""
                    SELECT count(*) FROM scraped_jobs s
                    JOIN linkedin_jobs l ON l.id = s.source_row_id
                     WHERE s.matched <> l.matched
                """)
            )
        ).scalar()
        assert disagreements == 0, (
            f"{disagreements} pairs disagree about matched between the two tables"
        )
        await db.commit()

    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM scraped_jobs WHERE source_row_id = :id"), {"id": source_id}
        )
        await db.execute(
            text("DELETE FROM linkedin_jobs WHERE id = :id"), {"id": source_id}
        )
        await db.commit()

    print(
        "[OK] external claimer reaches the canonical row; "
        "no matched disagreement (SC-008)"
    )


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


async def main() -> None:
    await test_post_scrape_leaves_rows_unclaimed()
    await test_external_claimer_keeps_rows_in_agreement()
    await test_idempotent_claim_scoped()
    print("[OK] all matched-flag smoke tests complete")


if __name__ == "__main__":
    asyncio.run(main())
