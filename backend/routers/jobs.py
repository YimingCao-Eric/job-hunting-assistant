import hashlib
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from models.scraped_job import ScrapedJob
from schemas.scraped_job import (
    JobUpdate,
    JobsListResponse,
    ScrapedJobDetail,
    ScrapedJobIngest,
    ScrapedJobIngestResponse,
    ScrapedJobRead,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _hash_description(text: str | None) -> str:
    raw = (text or "").strip().lower()
    return hashlib.sha256(raw.encode()).hexdigest()


@router.post("/ingest", response_model=ScrapedJobIngestResponse)
async def ingest_job(
    body: ScrapedJobIngest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    body.job_title = body.job_title or "Unknown"

    if body.skip_reason:
        data = body.model_dump(exclude_unset=False)
        data["job_url"] = None
        new_job = ScrapedJob(**data)
        new_job.ingest_source = "extension"
        db.add(new_job)
        await db.flush()
        return ScrapedJobIngestResponse(
            id=new_job.id,
            already_exists=False,
            content_duplicate=False,
            skip_reason=body.skip_reason,
        )

    if body.job_url:
        existing = await db.execute(
            select(ScrapedJob).where(ScrapedJob.job_url == body.job_url)
        )
        row = existing.scalar_one_or_none()
        if row is not None:
            return ScrapedJobIngestResponse(
                id=row.id,
                already_exists=True,
                content_duplicate=False,
                skip_reason="url_duplicate",
            )

    jd = body.job_description
    if jd is not None and not str(jd).strip():
        jd = None
        body = body.model_copy(update={"job_description": None})

    desc_hash = _hash_description(jd)

    hash_match = await db.execute(
        select(ScrapedJob).where(ScrapedJob.raw_description_hash == desc_hash)
    )
    content_dup_row = hash_match.scalar_one_or_none()
    content_duplicate = content_dup_row is not None

    payload = body.model_dump(exclude_unset=False)
    payload.pop("original_job_id", None)
    if content_duplicate and content_dup_row is not None:
        payload["original_job_id"] = content_dup_row.id
    else:
        payload["original_job_id"] = None

    new_job = ScrapedJob(
        **payload,
        raw_description_hash=desc_hash,
    )
    new_job.ingest_source = "extension"

    db.add(new_job)
    await db.flush()

    resp_skip = new_job.skip_reason or (
        "content_duplicate" if content_duplicate else None
    )
    return ScrapedJobIngestResponse(
        id=new_job.id,
        already_exists=False,
        content_duplicate=content_duplicate,
        skip_reason=resp_skip,
    )


@router.get("", response_model=JobsListResponse)
async def list_jobs(
    website: str | None = None,
    dismissed: bool | None = None,
    scan_run_id: UUID | None = None,
    easy_apply: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    scraped_from: date | None = None,
    scraped_to: date | None = None,
    dedup_status: str | None = None,
    limit: int = Query(25, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    conditions = []
    if dedup_status == "removed":
        conditions.append(ScrapedJob.skip_reason.isnot(None))
    elif dedup_status == "passed":
        conditions.append(ScrapedJob.skip_reason.is_(None))
    elif dedup_status == "all":
        pass
    else:
        conditions.append(ScrapedJob.skip_reason.is_(None))

    if website:
        conditions.append(ScrapedJob.website == website)
    if dismissed is not None:
        conditions.append(ScrapedJob.dismissed == dismissed)
    if scan_run_id is not None:
        conditions.append(ScrapedJob.scan_run_id == scan_run_id)
    if easy_apply is not None:
        conditions.append(ScrapedJob.easy_apply == easy_apply)
    if date_from is not None:
        conditions.append(ScrapedJob.post_datetime >= date_from)
    if date_to is not None:
        conditions.append(ScrapedJob.post_datetime <= date_to)
    if scraped_from is not None:
        lo = datetime.combine(scraped_from, time.min, tzinfo=dt_timezone.utc)
        conditions.append(ScrapedJob.created_at >= lo)
    if scraped_to is not None:
        hi = datetime.combine(scraped_to, time.min, tzinfo=dt_timezone.utc) + timedelta(
            days=1
        )
        conditions.append(ScrapedJob.created_at < hi)

    if conditions:
        count_stmt = select(func.count()).select_from(ScrapedJob).where(*conditions)
        stmt = (
            select(ScrapedJob)
            .where(*conditions)
            .order_by(ScrapedJob.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    else:
        count_stmt = select(func.count()).select_from(ScrapedJob)
        stmt = (
            select(ScrapedJob)
            .order_by(ScrapedJob.created_at.desc())
            .offset(offset)
            .limit(limit)
        )

    total = (await db.execute(count_stmt)).scalar_one()

    result = await db.execute(stmt)
    items = result.scalars().all()
    return JobsListResponse(
        items=list(items),
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/skipped", response_model=list[ScrapedJobRead])
async def list_skipped_jobs(
    scan_run_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = (
        select(ScrapedJob)
        .where(
            ScrapedJob.scan_run_id == scan_run_id,
            ScrapedJob.skip_reason.is_not(None),
        )
        .order_by(ScrapedJob.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/{job_id}", response_model=ScrapedJobDetail)
async def get_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    result = await db.execute(select(ScrapedJob).where(ScrapedJob.id == job_id))
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.put("/{job_id}", response_model=ScrapedJobRead)
async def update_job(
    job_id: UUID,
    body: JobUpdate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    job = await db.get(ScrapedJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(job, field, value)

    await db.flush()
    await db.refresh(job)
    return job
