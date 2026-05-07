"""Post-migration verification: confirms `matched` column was added correctly.

Run AFTER `alembic upgrade head` advances to revision 028. Verifies:
  - All three per-source tables have a `matched` column
  - Type is boolean
  - NOT NULL
  - Default is false

If any check fails, exit non-zero so deployment scripts halt.
"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from core.config import settings


REQUIRED_TABLES = ("linkedin_jobs", "indeed_jobs", "glassdoor_jobs")


async def verify_table(engine, table: str) -> list[str]:
    """Returns list of error strings (empty = pass)."""
    errors: list[str] = []
    async with engine.connect() as conn:
        result = await conn.execute(
            text("""
                SELECT data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = :t
                  AND column_name = 'matched'
            """),
            {"t": table},
        )
        row = result.first()

    if row is None:
        return [f"{table}: matched column missing"]

    data_type, is_nullable, column_default = row
    if data_type != "boolean":
        errors.append(f"{table}: matched type is {data_type!r}, expected boolean")
    if is_nullable != "NO":
        errors.append(f"{table}: matched is nullable, expected NOT NULL")

    if column_default is None:
        errors.append(f"{table}: matched has no default; expected DEFAULT FALSE")
    else:
        normalized = column_default.lower().strip()
        if normalized.startswith("(") and normalized.endswith(")"):
            normalized = normalized[1:-1].strip()
        valid_defaults = {
            "false",
            "'false'",
            "'f'",
            "false::boolean",
            "'false'::boolean",
        }
        if normalized not in valid_defaults:
            errors.append(
                f"{table}: matched default is {column_default!r}; "
                f"expected one of {sorted(valid_defaults)}"
            )

    return errors


async def main() -> None:
    engine = create_async_engine(settings.database_url)
    all_errors: list[str] = []
    try:
        for table in REQUIRED_TABLES:
            all_errors.extend(await verify_table(engine, table))
    finally:
        await engine.dispose()

    if all_errors:
        for err in all_errors:
            print(f"FAIL: {err}", file=sys.stderr)
        sys.exit(1)

    print(f"OK: matched column verified on {len(REQUIRED_TABLES)} tables")


if __name__ == "__main__":
    asyncio.run(main())
