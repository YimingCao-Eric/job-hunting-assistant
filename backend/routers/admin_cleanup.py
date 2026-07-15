from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from models.extension_run_log import ExtensionRunLog
from schemas.auto_scrape import CleanupInvalidEntriesResponse

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/cleanup-invalid-entries", response_model=CleanupInvalidEntriesResponse)
async def cleanup_invalid_entries(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Sweep stale run logs. The job-row sweeps are retired.

    This endpoint used to delete scraped jobs with empty core fields, stub descriptions,
    or a website outside the three-site allowlist. All three sweeps are gone:

      - Mismatched website: the condition can no longer arise. Ingest validates the site
        against the allowlist and rejects anything else, so source_site cannot hold a
        bad value.
      - Empty core fields and stub descriptions: these conditions *can* still arise, but
        no valid remedy is left. scraped_jobs is a derived table with exactly one
        canonical row per per-source row. Deleting only the canonical row would leave a
        per-source row with no counterpart, breaking the correspondence the rest of the
        system relies on; deleting the per-source row as well is not among the permitted
        mutations on the raw store, which is append-only apart from the matched claim
        and auto-expiration. With both options closed, retirement is the only option
        left. Aged rows are still reclaimed by auto-expiration, and a posting whose site
        supplied no title is a faithful record of a bad posting rather than corruption.

    The response keys are retained and return 0, so existing consumers keep working —
    the same approach already taken for marked_failed_dedup_tasks below.
    """
    deleted_empty_core = 0
    deleted_empty_jd = 0
    deleted_mismatched = 0

    ten_min_ago = datetime.now(timezone.utc) - timedelta(minutes=10)
    now = datetime.now(timezone.utc)
    result4 = await db.execute(
        update(ExtensionRunLog)
        .where(
            ExtensionRunLog.status == "running",
            ExtensionRunLog.started_at < ten_min_ago,
        )
        .values(
            status="failed",
            error_message="Marked failed by cleanup-invalid-entries (>10 min stale)",
            completed_at=now,
            failure_reason="lazy_cleanup_timeout",
            failure_category="transient",
        )
    )
    marked_failed_run_logs = result4.rowcount or 0

    # Dedup pipeline removed (search-only backend); dedup_tasks are no longer
    # written. Response key retained (always 0) for forward-compatibility.
    marked_failed_dedup_tasks = 0

    return CleanupInvalidEntriesResponse(
        deleted_jobs_empty_core=deleted_empty_core,
        deleted_jobs_empty_jd=deleted_empty_jd,
        deleted_jobs_mismatched_website=deleted_mismatched,
        marked_failed_run_logs=marked_failed_run_logs,
        marked_failed_dedup_tasks=marked_failed_dedup_tasks,
    )
