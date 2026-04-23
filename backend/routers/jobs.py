import hashlib
import logging
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from time import monotonic
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from models.job_report import JobReport
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

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_BLACKLIST_SKIP_REASONS = frozenset(
    {
        "blacklisted",
        "blacklisted_company",
        "blacklisted_location",
        "title_blacklisted",
        "job_type",
        "agency",
        "remote_mismatch",
        "contract_mismatch",
        "sponsorship",
    }
)


def _normalize_job_update_payload(data: dict) -> dict:
    if "extracted_salary_min" in data:
        v = data.pop("extracted_salary_min")
        if "salary_min_extracted" not in data:
            data["salary_min_extracted"] = v
    if "match_confidence" in data:
        v = data.pop("match_confidence")
        if "confidence" not in data:
            data["confidence"] = v
    return data


def _hash_description(text: str | None) -> str:
    raw = (text or "").strip().lower()
    return hashlib.sha256(raw.encode()).hexdigest()


@router.post("/ingest", response_model=ScrapedJobIngestResponse)
async def ingest_job(
    body: ScrapedJobIngest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    t_start = monotonic()
    body.job_title = body.job_title or "Unknown"
    log_context = {
        "website": body.website,
        "job_url": (body.job_url or "")[:200],
        "company": (body.company or "")[:100],
        "jd_len": len(body.job_description or ""),
        "scan_run_id": str(body.scan_run_id) if body.scan_run_id else None,
    }
    logger.info("ingest_start %s", log_context)

    try:
        if body.skip_reason:
            t_stage = monotonic()
            data = body.model_dump(exclude_unset=False)
            data["job_url"] = None
            new_job = ScrapedJob(**data)
            new_job.ingest_source = "extension"
            db.add(new_job)
            await db.flush()
            logger.debug(
                "ingest_db_done %s",
                {**log_context, "took_ms": int((monotonic() - t_stage) * 1000)},
            )
            logger.info(
                "ingest_ok %s",
                {
                    **log_context,
                    "took_ms": int((monotonic() - t_start) * 1000),
                    "path": "skip_reason",
                },
            )
            return ScrapedJobIngestResponse(
                id=new_job.id,
                already_exists=False,
                content_duplicate=False,
                skip_reason=body.skip_reason,
            )

        t_dedup = monotonic()
        if body.job_url:
            existing = await db.execute(
                select(ScrapedJob).where(ScrapedJob.job_url == body.job_url)
            )
            row = existing.scalars().first()
            if row is not None:
                logger.debug(
                    "ingest_dedup_done %s",
                    {
                        **log_context,
                        "took_ms": int((monotonic() - t_dedup) * 1000),
                        "result": "url_duplicate",
                    },
                )
                logger.debug(
                    "ingest_embedding_done %s",
                    {**log_context, "took_ms": 0, "note": "n/a"},
                )
                logger.debug(
                    "ingest_db_done %s",
                    {**log_context, "took_ms": 0, "note": "no_write"},
                )
                logger.info(
                    "ingest_ok %s",
                    {
                        **log_context,
                        "took_ms": int((monotonic() - t_start) * 1000),
                        "path": "url_duplicate_hit",
                    },
                )
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
        content_dup_row = hash_match.scalars().first()
        content_duplicate = content_dup_row is not None

        logger.debug(
            "ingest_dedup_done %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_dedup) * 1000),
                "content_dup": content_duplicate,
            },
        )

        t_emb = monotonic()
        logger.debug(
            "ingest_embedding_done %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_emb) * 1000),
                "note": "n/a",
            },
        )

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

        t_db = monotonic()
        db.add(new_job)
        await db.flush()
        logger.debug(
            "ingest_db_done %s",
            {**log_context, "took_ms": int((monotonic() - t_db) * 1000)},
        )

        resp_skip = new_job.skip_reason or (
            "content_duplicate" if content_duplicate else None
        )
        logger.info(
            "ingest_ok %s",
            {
                **log_context,
                "took_ms": int((monotonic() - t_start) * 1000),
                "path": "insert",
            },
        )
        return ScrapedJobIngestResponse(
            id=new_job.id,
            already_exists=False,
            content_duplicate=content_duplicate,
            skip_reason=resp_skip,
        )
    except Exception as e:
        total_ms = int((monotonic() - t_start) * 1000)
        logger.exception(
            "ingest_error took_ms=%s error_type=%s error_message=%s ctx=%s",
            total_ms,
            type(e).__name__,
            str(e)[:500],
            log_context,
        )
        raise


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
    skip_reason_filter: str | None = None,
    match_skip_reason_filter: str | None = None,
    blacklist_filter: bool | None = None,
    blacklist_reason: str | None = None,
    dedup_type: str | None = None,
    removal_stage: str | None = None,
    matching_mode: str | None = None,
    match_level: str | None = None,
    match_status: str | None = None,
    llm_step_d: bool | None = Query(
        None,
        description="If true, only jobs scored by Step D (matching_mode=llm and LLM confidence set).",
    ),
    jd_incomplete: bool | None = Query(
        None,
        description="If true/false, filter by jd_incomplete flag.",
    ),
    order_by: str | None = Query(
        None,
        description='Sort field: "fit_score" (desc, nulls last) or "created_at" (desc).',
    ),
    limit: int = Query(25, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    sort_key = order_by if order_by in ("fit_score", "created_at") else "created_at"
    if sort_key == "fit_score":
        order_clause = (
            ScrapedJob.fit_score.desc().nulls_last(),
            ScrapedJob.created_at.desc(),
        )
    else:
        order_clause = (ScrapedJob.created_at.desc(),)

    conditions = []
    if dedup_status == "removed":
        conditions.append(
            or_(
                ScrapedJob.skip_reason.isnot(None),
                ScrapedJob.dismissed == True,  # noqa: E712
                ScrapedJob.match_skip_reason.isnot(None),
            )
        )
    elif dedup_status == "passed":
        conditions.append(ScrapedJob.skip_reason.is_(None))
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
        conditions.append(ScrapedJob.dismissed == False)  # noqa: E712
    elif dedup_status == "all":
        pass
    else:
        conditions.append(ScrapedJob.skip_reason.is_(None))

    if dedup_status == "removed" and skip_reason_filter:
        _dedup_reasons = frozenset(
            {
                "already_scraped",
                "job_type",
                "blacklisted",
                "blacklisted_company",
                "blacklisted_location",
                "title_blacklisted",
                "agency",
                "title_mismatch",
                "contract_mismatch",
                "remote_mismatch",
                "sponsorship",
            }
        )
        _gate_reasons = frozenset(
            {
                "yoe_gate",
                "salary_gate",
                "education_gate",
                "visa_gate",
                "extraction_failed",
                "scoring_failed",
            }
        )
        if skip_reason_filter in _dedup_reasons:
            conditions.append(ScrapedJob.skip_reason == skip_reason_filter)
        elif skip_reason_filter == "language":
            conditions.append(
                or_(
                    ScrapedJob.match_skip_reason == "language",
                    ScrapedJob.skip_reason == "language",
                )
            )
        elif skip_reason_filter in _gate_reasons:
            conditions.append(ScrapedJob.match_skip_reason == skip_reason_filter)
            conditions.append(ScrapedJob.skip_reason.is_(None))

    if match_skip_reason_filter:
        conditions.append(ScrapedJob.match_skip_reason == match_skip_reason_filter)
        conditions.append(ScrapedJob.skip_reason.is_(None))

    if removal_stage:
        conditions.append(ScrapedJob.removal_stage == removal_stage)

    if matching_mode:
        conditions.append(ScrapedJob.matching_mode == matching_mode)

    if blacklist_filter:
        conditions.append(
            or_(
                ScrapedJob.dismissed == True,  # noqa: E712
                ScrapedJob.skip_reason.in_(_BLACKLIST_SKIP_REASONS),
            )
        )

    if blacklist_reason:
        _br_map = {
            "blacklisted_company": "blacklisted_company",
            "blacklisted_location": "blacklisted_location",
            "title_blacklisted": "title_blacklisted",
            "job_type": "job_type",
            "agency": "agency",
            "remote": "remote_mismatch",
            "contract": "contract_mismatch",
            "sponsorship": "sponsorship",
        }
        if blacklist_reason == "dismissed":
            conditions.append(ScrapedJob.dismissed == True)  # noqa: E712
        elif blacklist_reason in _br_map:
            conditions.append(ScrapedJob.skip_reason == _br_map[blacklist_reason])
        elif blacklist_reason == "blacklisted":
            conditions.append(ScrapedJob.skip_reason == "blacklisted")

    if dedup_type in ("hash_exact", "cosine"):
        conditions.append(ScrapedJob.skip_reason == "already_scraped")
        if dedup_type == "hash_exact":
            conditions.append(ScrapedJob.dedup_similarity_score.is_(None))
        else:
            conditions.append(ScrapedJob.dedup_similarity_score.isnot(None))

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

    if match_level:
        conditions.append(ScrapedJob.match_level == match_level)
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
    if match_status == "unscored":
        conditions.append(ScrapedJob.match_level.is_(None))
        conditions.append(ScrapedJob.match_skip_reason.is_(None))
    elif match_status == "scored":
        conditions.append(ScrapedJob.match_level.is_not(None))
    elif match_status == "gate_skipped":
        conditions.append(ScrapedJob.match_skip_reason.is_not(None))
        conditions.append(ScrapedJob.match_level.is_(None))

    if llm_step_d is True:
        conditions.append(ScrapedJob.matching_mode == "llm")
        conditions.append(ScrapedJob.confidence.isnot(None))

    if jd_incomplete is not None:
        conditions.append(ScrapedJob.jd_incomplete == jd_incomplete)

    pending_report_exists = exists().where(
        JobReport.job_id == ScrapedJob.id,
        JobReport.status == "pending",
    )

    if conditions:
        count_stmt = select(func.count()).select_from(ScrapedJob).where(*conditions)
        stmt = (
            select(ScrapedJob, pending_report_exists.label("has_report"))
            .where(*conditions)
            .order_by(*order_clause)
            .offset(offset)
            .limit(limit)
        )
    else:
        count_stmt = select(func.count()).select_from(ScrapedJob)
        stmt = (
            select(ScrapedJob, pending_report_exists.label("has_report"))
            .order_by(*order_clause)
            .offset(offset)
            .limit(limit)
        )

    total = (await db.execute(count_stmt)).scalar_one()

    result = await db.execute(stmt)
    items = [
        ScrapedJobRead.model_validate(job).model_copy(update={"has_report": bool(hr)})
        for job, hr in result.all()
    ]
    return JobsListResponse(
        items=items,
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
    has_report_row = await db.execute(
        select(
            exists().where(
                JobReport.job_id == job_id,
                JobReport.status == "pending",
            )
        )
    )
    has_report = bool(has_report_row.scalar_one())
    return ScrapedJobDetail.model_validate(job).model_copy(
        update={"has_report": has_report}
    )


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

    payload = _normalize_job_update_payload(body.model_dump(exclude_unset=True))
    for field, value in payload.items():
        setattr(job, field, value)

    await db.flush()
    await db.refresh(job)
    return job
