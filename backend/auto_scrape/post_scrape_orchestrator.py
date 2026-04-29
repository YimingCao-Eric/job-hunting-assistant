"""
Backend post-scrape orchestrator.

Claims cycles in scrape_complete and transitions them to post_scrape_complete.
Infrastructure: atomic claim, heartbeat, Redis subscriber, APScheduler poll.

Phase 4.5: dedup and matching pipeline bodies are no-ops pending redesign;
when pipelines return, re-fill _run_dedup_for_cycle, _run_matching_for_cycle,
and _compute_match_results only.

Wake paths: Redis pub/sub (instant) + APScheduler 1-min poll (fallback).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import update

from core.config import settings
from core.config_file import read_config_file
from core.database import AsyncSessionLocal
from core.redis_client import REDIS_CHANNEL_AUTO_SCRAPE
from dedup.service import run_dedup  # noqa: F401 — Phase 4 redesign will use
from matching.pipeline import (  # noqa: F401
    run_cpu_score_pipeline,
    run_cpu_work,
    run_llm_extraction_gates,
    run_llm_score_pipeline,
)
from models.auto_scrape_cycle import AutoScrapeCycle
from schemas.config import SearchConfigRead

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


async def _run_dedup_for_cycle(cycle_id: UUID) -> UUID | None:
    """
    Phase 4.5: dedup pipeline disabled pending redesign.
    Returns None so cycle.dedup_task_id stays NULL.
    """
    logger.info(
        "Post-scrape cycle %s: dedup skipped (Phase 4.5: pipeline disabled)",
        cycle_id,
    )
    return None


async def _run_matching_for_cycle(
    cycle_id: UUID, llm_enabled: bool, has_openai_key: bool
) -> None:
    """Phase 4.5: matching pipeline disabled pending redesign."""
    logger.info(
        "Post-scrape cycle %s: matching skipped (Phase 4.5: pipeline disabled)",
        cycle_id,
    )


async def _compute_match_results(
    post_scrape_started_at: datetime,
) -> dict[str, Any]:
    """Phase 4.5: matching disabled, so no aggregation. Return empty dict."""
    return {}


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
    post_scrape_started_at = datetime.now(timezone.utc)
    hb_task: asyncio.Task | None = None
    try:
        hb_task = asyncio.create_task(_heartbeat_loop(cycle_id))
        _active_heartbeat_tasks[cycle_id] = hb_task

        config_data = await read_config_file()
        cfg = SearchConfigRead(**config_data)
        llm_enabled = bool(cfg.llm)
        has_openai_key = bool(os.environ.get("OPENAI_API_KEY"))

        logger.info(
            "Post-scrape cycle %s: start (llm=%s, openai_key=%s)",
            cycle_id,
            llm_enabled,
            has_openai_key,
        )

        dedup_task_id = await _run_dedup_for_cycle(cycle_id)
        await _update_cycle(cycle_id, dedup_task_id=dedup_task_id)
        logger.info("Post-scrape cycle %s: dedup finished", cycle_id)

        await _run_matching_for_cycle(cycle_id, llm_enabled, has_openai_key)
        logger.info("Post-scrape cycle %s: matching finished", cycle_id)

        match_results = await _compute_match_results(post_scrape_started_at)
        await _update_cycle(cycle_id, match_results=match_results)
        logger.info(
            "Post-scrape cycle %s: match_results=%s", cycle_id, match_results
        )

        await _update_cycle(
            cycle_id,
            status="post_scrape_complete",
            completed_at=datetime.now(timezone.utc),
        )
        logger.info("Post-scrape cycle %s: post_scrape_complete", cycle_id)

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
