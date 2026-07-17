"""
Backend post-scrape orchestrator.

Claims cycles in scrape_complete and transitions them to post_scrape_complete.
Infrastructure: atomic claim, heartbeat, Redis subscriber, APScheduler poll.

Runs Phase 1 (auto-expiration), then finalizes. There is no claim phase: the
post-scrape matched-claim was retired (feature 010) once dedup/matching were
removed by the search-only split and nothing consumed the claim. `matched` now
stays FALSE after a scrape so a downstream filtering/matching service can claim
rows itself.

Cycle output is cleanup_results + match_results={"claim_summary": None,
"claim_retired": True}. `claim_summary` is retained as an explicit None -- "no
counts were produced" -- and must not be read as zero counts. Cycles completed
before the retirement keep their real per-site counts and are never rewritten.

Wake paths: Redis pub/sub (instant) + APScheduler 1-min poll (fallback).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import update

from core.config import settings
from core.database import AsyncSessionLocal
from core.redis_client import REDIS_CHANNEL_AUTO_SCRAPE
from auto_scrape.auto_expiration import run_auto_expiration
from models.auto_scrape_cycle import AutoScrapeCycle

logger = logging.getLogger(__name__)

_active_heartbeat_tasks: dict[UUID, asyncio.Task] = {}


async def redis_subscriber() -> None:
    """Subscribe to Redis; wake process_pending_cycles on messages."""
    if not settings.redis_url:
        logger.info(
            "Post-scrape: REDIS_URL unset; Redis subscriber disabled (poll-only)"
        )
        return

    import redis.asyncio as aioredis

    client: aioredis.Redis | None = None
    try:
        client = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = client.pubsub()
        await pubsub.subscribe(REDIS_CHANNEL_AUTO_SCRAPE)
        logger.info(
            "Post-scrape: subscribed to Redis channel %s",
            REDIS_CHANNEL_AUTO_SCRAPE,
        )
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            data = message.get("data", "")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            logger.info("Post-scrape wake signal: %s", data)
            try:
                await process_pending_cycles()
            except Exception:
                logger.exception(
                    "Post-scrape subscriber: process_pending_cycles error "
                    "(non-fatal; poll will retry)"
                )
    except asyncio.CancelledError:
        logger.info("Post-scrape: Redis subscriber cancelled")
        raise
    except Exception:
        logger.exception("Post-scrape: Redis subscriber exited with error")
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                logger.exception("Post-scrape: Redis client close failed")


async def process_pending_cycles() -> None:
    """Atomically claim scrape_complete cycles; run post-scrape for each."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(AutoScrapeCycle)
            .where(AutoScrapeCycle.status == "scrape_complete")
            .values(
                status="postscrape_running",
                phase_heartbeat_at=datetime.now(timezone.utc),
            )
            .returning(AutoScrapeCycle.id)
        )
        cycle_ids: list[UUID] = list(result.scalars().all())
        await db.commit()

    if not cycle_ids:
        return

    logger.info("Post-scrape: claimed %d cycle(s): %s", len(cycle_ids), cycle_ids)

    for cycle_id in cycle_ids:
        try:
            await run_post_scrape_phase(cycle_id)
        except Exception:
            logger.exception(
                "Post-scrape: top-level failure for cycle %s", cycle_id
            )
            try:
                async with AsyncSessionLocal() as db:
                    await db.execute(
                        update(AutoScrapeCycle)
                        .where(AutoScrapeCycle.id == cycle_id)
                        .where(AutoScrapeCycle.status == "postscrape_running")
                        .values(
                            status="failed",
                            error_message=(
                                "Top-level exception in run_post_scrape_phase"
                            ),
                            completed_at=datetime.now(timezone.utc),
                            phase_heartbeat_at=datetime.now(timezone.utc),
                        )
                    )
                    await db.commit()
            except Exception:
                logger.exception(
                    "Post-scrape: could not mark cycle %s failed", cycle_id
                )


async def _heartbeat_loop(cycle_id: UUID) -> None:
    while True:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            raise
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(
                    update(AutoScrapeCycle)
                    .where(AutoScrapeCycle.id == cycle_id)
                    .where(AutoScrapeCycle.status == "postscrape_running")
                    .values(phase_heartbeat_at=datetime.now(timezone.utc))
                )
                await db.commit()
        except Exception:
            logger.exception(
                "Post-scrape heartbeat failed for cycle %s (continuing)",
                cycle_id,
            )


async def _update_cycle(cycle_id: UUID, **fields: Any) -> None:
    fields["phase_heartbeat_at"] = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(AutoScrapeCycle)
            .where(AutoScrapeCycle.id == cycle_id)
            .values(**fields)
        )
        await db.commit()


async def run_post_scrape_phase(cycle_id: UUID) -> None:
    hb_task: asyncio.Task | None = None
    try:
        hb_task = asyncio.create_task(_heartbeat_loop(cycle_id))
        _active_heartbeat_tasks[cycle_id] = hb_task

        logger.info("Post-scrape cycle %s: start", cycle_id)

        async with AsyncSessionLocal() as db:
            async with db.begin():
                expiration_results = await run_auto_expiration(db)
        await _update_cycle(cycle_id, cleanup_results=expiration_results)

        # No claim phase. The marker lives ONLY in this finalize write: a cycle that
        # fails before finalizing must record no claim indication at all, while its
        # cleanup_results survive independently (FR-007a). Moving it earlier would
        # break that silently.
        await _update_cycle(
            cycle_id,
            status="post_scrape_complete",
            completed_at=datetime.now(timezone.utc),
            match_results={"claim_summary": None, "claim_retired": True},
        )
        logger.info(
            "Post-scrape cycle %s: post_scrape_complete (claim retired; "
            "matched left FALSE for the downstream claimer)",
            cycle_id,
        )

    except Exception as e:
        logger.exception("Post-scrape cycle %s: failed", cycle_id)
        try:
            await _update_cycle(
                cycle_id,
                status="failed",
                error_message=f"Post-scrape phase failed: {type(e).__name__}: {e}",
                completed_at=datetime.now(timezone.utc),
            )
        except Exception:
            logger.exception(
                "Post-scrape cycle %s: could not persist failure state", cycle_id
            )

    finally:
        if hb_task is not None:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception(
                    "Post-scrape: heartbeat task for %s raised on cancel",
                    cycle_id,
                )
        _active_heartbeat_tasks.pop(cycle_id, None)
