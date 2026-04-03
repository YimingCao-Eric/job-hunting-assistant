from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.config import settings
from core.config_file import read_config_file
from core.database import get_db
from dedup.service import resolve_dedup_chains_in_db, run_dedup
from models.dedup_report import DedupReport
from models.scraped_job import ScrapedJob
from schemas.config import SearchConfigRead
from schemas.dedup import DedupReportRead, GateResult

router = APIRouter(tags=["dedup"])

# Skip reasons set only by the dedup service — never ingest-time reasons.
DEDUP_SERVICE_SKIP_REASONS = (
    "already_scraped",
    "language",
    "job_type",
    "blacklisted",
    "title_blacklisted",
    "agency",
    "title_mismatch",
    "contract_mismatch",
    "remote_mismatch",
    "sponsorship",
)


def _report_to_read(r: DedupReport) -> DedupReportRead:
    graw = r.gate_results or {}
    gate_results = {
        k: GateResult(**v) if isinstance(v, dict) else v for k, v in graw.items()
    }
    return DedupReportRead(
        id=r.id,
        scan_run_id=r.scan_run_id,
        trigger=r.trigger,
        total_processed=r.total_processed,
        total_flagged=r.total_flagged,
        total_passed=r.total_passed,
        gate_results=gate_results,
        skip_reason_counts=dict(r.skip_reason_counts or {}),
        duration_ms=r.duration_ms,
        created_at=r.created_at,
    )


@router.post("/jobs/dedup/reset")
async def reset_dedup(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
) -> dict[str, int]:
    """
    Clears dedup-assigned skip_reason and dedup fields for rows flagged only by
    the dedup pipeline. Does not touch ingest-time skip reasons.
    """
    result = await db.execute(
        update(ScrapedJob)
        .where(ScrapedJob.skip_reason.in_(DEDUP_SERVICE_SKIP_REASONS))
        .values(
            skip_reason=None,
            dedup_similarity_score=None,
            dedup_original_job_id=None,
        )
    )
    return {"reset_count": result.rowcount}


@router.post("/jobs/dedup", response_model=DedupReportRead)
async def trigger_dedup(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    config_data = await read_config_file()
    config = SearchConfigRead(**config_data)
    return await run_dedup(db, config, settings, scan_run_id=None, trigger="manual")


@router.post("/jobs/dedup/resolve-chains")
async def resolve_dedup_chains(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
) -> dict[str, int]:
    """
    One-time repair for rows where dedup_original_job_id points to another removed job.
    Walks each chain to the passed (canonical) job and updates dedup_original_job_id.
    Safe to call multiple times (idempotent when chains are already flat).
    """
    resolved_count = await resolve_dedup_chains_in_db(db)
    return {"resolved_count": resolved_count}


@router.get("/dedup/reports", response_model=list[DedupReportRead])
async def list_dedup_reports(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(DedupReport).order_by(DedupReport.created_at.desc())
    )
    rows = result.scalars().all()
    return [_report_to_read(r) for r in rows]


@router.get("/dedup/reports/{report_id}", response_model=DedupReportRead)
async def get_dedup_report(
    report_id: int,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    r = await db.get(DedupReport, report_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Dedup report not found")
    return _report_to_read(r)
