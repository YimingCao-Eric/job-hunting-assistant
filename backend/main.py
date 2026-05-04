import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, update

import core.trace  # noqa: F401 — register stdlib → trace bridge handlers on startup
from auto_scrape.post_scrape_orchestrator import redis_subscriber
from core.auto_scrape_lifecycle import cleanup_stale_cycles_at_startup
from core.config import settings
from core.database import AsyncSessionLocal, run_migrations
from core.dedup_task_cleanup import mark_stale_dedup_tasks_failed
from models.extension_run_log import ExtensionRunLog
from routers import admin_cleanup as admin_cleanup_router
from routers import auto_scrape as auto_scrape_router
from routers import config as config_router
from routers import dedup as dedup_router
from routers import extension as extension_router
from routers import run_log_ws as run_log_ws_router
from routers import job_reports as job_reports_router
from routers import jobs as jobs_router
from routers import matching as matching_router
from routers import profile as profile_router
from routers import skills as skills_router
from scheduler import setup_scheduler, shutdown_scheduler

logging.getLogger("matching").setLevel(logging.DEBUG)
logging.getLogger("routers.matching").setLevel(logging.DEBUG)
logging.getLogger("routers.jobs").setLevel(logging.INFO)
logging.getLogger("scheduler").setLevel(logging.INFO)
logging.getLogger("apscheduler").setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    Path(settings.config_path).parent.mkdir(parents=True, exist_ok=True)

    await run_migrations()

    async with AsyncSessionLocal() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
        result = await session.execute(
            update(ExtensionRunLog)
            .where(
                ExtensionRunLog.status == "running",
                ExtensionRunLog.started_at < cutoff,
            )
            .values(
                status="failed",
                completed_at=datetime.now(timezone.utc),
                session_error="Auto-cleaned: stale on startup",
            )
        )
        await session.commit()
        if result.rowcount:
            print(f"[JHA] Cleaned {result.rowcount} stale run(s) on startup")

    # B-18: mark stale dedup_tasks failed — safer branch (no auto-rerun). See
    # core.dedup_task_cleanup.mark_stale_dedup_tasks_failed.
    n_orphan = await mark_stale_dedup_tasks_failed()
    if n_orphan:
        print(f"[JHA] Marked {n_orphan} orphaned dedup task(s) failed on startup")

    await cleanup_stale_cycles_at_startup()

    setup_scheduler()
    redis_sub_task: asyncio.Task | None = None
    if settings.redis_url:
        redis_sub_task = asyncio.create_task(
            redis_subscriber(),
            name="post_scrape_redis_subscriber",
        )

    try:
        yield
    finally:
        if redis_sub_task is not None:
            redis_sub_task.cancel()
            try:
                await redis_sub_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logging.getLogger(__name__).exception(
                    "Error during redis_subscriber shutdown"
                )
        shutdown_scheduler()


# Backend logging — attach a stdout handler at INFO level so structured
# ingest_* events (per step1-schema-design.md §10) surface in
# `docker compose logs backend`. Without this, logger.info() calls are
# discarded by the root logger's default WARNING level + missing handler.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
    force=True,  # override any prior basicConfig (e.g. uvicorn-set defaults)
)

app = FastAPI(title="Job Hunting Assistant API", lifespan=lifespan)

# Vite uses 5173 by default (or the next free port). Browser requests from those
# origins must be allowed or fetch() fails with a CORS error (surfacing as "is the
# backend running?" in the UI). Chrome extension + any localhost dev port:
_cors_origin_regex = (
    r"^(?:chrome-extension://[a-zA-Z0-9]+|http://(?:localhost|127\.0\.0\.1):\d+)$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:8000"],
    allow_origin_regex=_cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(matching_router.router)
app.include_router(skills_router.router)
app.include_router(profile_router.router)
app.include_router(job_reports_router.router)
app.include_router(jobs_router.router)
app.include_router(config_router.router)
app.include_router(extension_router.router)
app.include_router(run_log_ws_router.router)
app.include_router(dedup_router.router)
app.include_router(auto_scrape_router.router)
app.include_router(admin_cleanup_router.router)


@app.get("/health")
async def health():
    db_status = "ok"
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        db_status = "error"
    return {"status": "ok", "db": db_status}
