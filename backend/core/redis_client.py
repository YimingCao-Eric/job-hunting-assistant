"""Redis helpers for auto-scrape wake signals (optional when REDIS_URL unset)."""

from __future__ import annotations

import logging

from core.config import settings

logger = logging.getLogger(__name__)

REDIS_CHANNEL_AUTO_SCRAPE = "auto_scrape:cycle_complete"


async def publish_auto_scrape_cycle_wake(payload: str) -> bool:
    """Publish best-effort. Returns True if published, False if Redis disabled or error."""
    if not settings.redis_url:
        logger.debug("REDIS_URL unset; skip Redis publish (%s)", payload)
        return False
    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
        )
        try:
            await client.publish(REDIS_CHANNEL_AUTO_SCRAPE, payload)
            return True
        finally:
            await client.aclose()
    except Exception:
        logger.exception(
            "Redis publish failed (non-fatal; APScheduler poll fallback)"
        )
        return False
