"""Accessor for the system_settings key-value table.

Uses raw SQL via SQLAlchemy text() to match the project's existing
pattern (per-source ingest in jobs.py also uses raw SQL).
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def get_setting(db: AsyncSession, key: str) -> str | None:
    """Returns the value for the given key, or None if not set."""
    result = await db.execute(
        text("SELECT value FROM system_settings WHERE key = :k"),
        {"k": key},
    )
    row = result.first()
    return row[0] if row else None


async def get_shelf_life_days(db: AsyncSession) -> int:
    """Convenience accessor with type coercion + safety default."""
    raw = await get_setting(db, "shelf_life_days")
    if raw is None:
        return 7
    try:
        days = int(raw)
        if days < 1:
            return 7
        return days
    except ValueError:
        return 7
