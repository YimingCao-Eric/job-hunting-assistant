from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from models.job_report import JobReport
from models.scraped_job import ScrapedJob
from schemas.job_report import (
    JobReportActionRequest,
    JobReportCreate,
    JobReportRead,
    JobReportsListResponse,
    JobReportStatsResponse,
)

router = APIRouter(prefix="/jobs", tags=["job_reports"])

REPORT_TYPES = frozenset(
    {
        "match_level",
        "yoe",
        "missing_skills",
        "false_skills",
        "wrong_gate",
        "other",
    }
)

MATCH_LEVEL_VALUES = frozenset(
    {"strong_match", "possible_match", "stretch_match", "weak_match"}
)
GATE_NAME_VALUES = frozenset(
    {
        "yoe_gate",
        "language",
        "education_gate",
        "salary_gate",
        "visa_gate",
    }
)


def _validate_detail(report_type: str, detail: dict) -> dict:
    if not isinstance(detail, dict):
        raise HTTPException(status_code=400, detail="detail must be an object")
    out: dict = {}
    note = detail.get("note")
    if note is not None:
        if not isinstance(note, str):
            raise HTTPException(status_code=400, detail="detail.note must be a string")
        note = note.strip()
        if len(note) > 200:
            raise HTTPException(
                status_code=400, detail="detail.note must be at most 200 characters"
            )
        if note:
            out["note"] = note

    skills = detail.get("skills")
    if skills is not None:
        if report_type not in ("missing_skills", "false_skills"):
            raise HTTPException(
                status_code=400, detail="detail.skills is only valid for skill reports"
            )
        if not isinstance(skills, list):
            raise HTTPException(status_code=400, detail="detail.skills must be an array")
        if len(skills) > 10:
            raise HTTPException(
                status_code=400, detail="detail.skills may have at most 10 items"
            )
        norm: list[str] = []
        for s in skills:
            if not isinstance(s, str):
                raise HTTPException(
                    status_code=400, detail="each skill must be a string"
                )
            t = s.strip()
            if len(t) > 50:
                raise HTTPException(
                    status_code=400,
                    detail="each skill must be at most 50 characters",
                )
            if t:
                norm.append(t)
        if norm:
            out["skills"] = norm

    sl = detail.get("suggested_level")
    if sl is not None:
        if report_type != "match_level":
            raise HTTPException(
                status_code=400,
                detail="detail.suggested_level is only valid for match_level reports",
            )
        if not isinstance(sl, str) or sl not in MATCH_LEVEL_VALUES:
            raise HTTPException(status_code=400, detail="invalid suggested_level")
        out["suggested_level"] = sl

    yoe = detail.get("actual_yoe")
    if yoe is not None:
        if report_type != "yoe":
            raise HTTPException(
                status_code=400,
                detail="detail.actual_yoe is only valid for yoe reports",
            )
        if isinstance(yoe, bool) or not isinstance(yoe, (int, float)):
            raise HTTPException(
                status_code=400, detail="detail.actual_yoe must be a number"
            )
        out["actual_yoe"] = float(yoe)

    gn = detail.get("gate_name")
    if gn is not None:
        if report_type != "wrong_gate":
            raise HTTPException(
                status_code=400,
                detail="detail.gate_name is only valid for wrong_gate reports",
            )
        if not isinstance(gn, str) or gn not in GATE_NAME_VALUES:
            raise HTTPException(status_code=400, detail="invalid gate_name")
        out["gate_name"] = gn

    # Reject unknown top-level keys for clearer API behavior
    allowed = {"note", "skills", "suggested_level", "actual_yoe", "gate_name"}
    for k in detail:
        if k not in allowed:
            raise HTTPException(status_code=400, detail=f"unknown detail field: {k}")

    return out


async def _report_to_read(db: AsyncSession, row: JobReport) -> JobReportRead:
    job = await db.get(ScrapedJob, row.job_id)
    return JobReportRead(
        id=row.id,
        job_id=row.job_id,
        report_type=row.report_type,
        detail=row.detail or {},
        status=row.status,
        actioned_at=row.actioned_at,
        created_at=row.created_at,
        job_title=job.job_title if job else None,
        company=job.company if job else None,
        match_level=job.match_level if job else None,
        match_skip_reason=job.match_skip_reason if job else None,
        removal_stage=job.removal_stage if job else None,
    )


@router.get("/reports/stats", response_model=JobReportStatsResponse)
async def job_reports_stats(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    pending = (
        await db.execute(
            select(func.count()).select_from(JobReport).where(
                JobReport.status == "pending"
            )
        )
    ).scalar_one()

    total = (
        await db.execute(select(func.count()).select_from(JobReport))
    ).scalar_one()

    by_type: dict[str, int] = {t: 0 for t in sorted(REPORT_TYPES)}
    rows = (
        await db.execute(
            select(JobReport.report_type, func.count())
            .where(JobReport.status == "pending")
            .group_by(JobReport.report_type)
        )
    ).all()
    for rt, n in rows:
        by_type[rt] = int(n)

    return JobReportStatsResponse(pending=int(pending), by_type=by_type, total=int(total))


@router.get("/reports", response_model=JobReportsListResponse)
async def list_job_reports(
    status: Literal["pending", "actioned", "dismissed", "all"] = Query("pending"),
    report_type: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    conditions = []
    if status != "all":
        conditions.append(JobReport.status == status)
    if report_type:
        if report_type not in REPORT_TYPES:
            raise HTTPException(status_code=400, detail="invalid report_type filter")
        conditions.append(JobReport.report_type == report_type)

    base = select(JobReport, ScrapedJob).join(
        ScrapedJob, JobReport.job_id == ScrapedJob.id
    )
    count_stmt = select(func.count()).select_from(JobReport).join(
        ScrapedJob, JobReport.job_id == ScrapedJob.id
    )
    if conditions:
        base = base.where(*conditions)
        count_stmt = count_stmt.where(*conditions)

    total = (await db.execute(count_stmt)).scalar_one()

    stmt = (
        base.order_by(JobReport.created_at.desc()).offset(offset).limit(limit)
    )
    result = await db.execute(stmt)
    items: list[JobReportRead] = []
    for jr, sj in result.all():
        items.append(
            JobReportRead(
                id=jr.id,
                job_id=jr.job_id,
                report_type=jr.report_type,
                detail=jr.detail or {},
                status=jr.status,
                actioned_at=jr.actioned_at,
                created_at=jr.created_at,
                job_title=sj.job_title,
                company=sj.company,
                match_level=sj.match_level,
                match_skip_reason=sj.match_skip_reason,
                removal_stage=sj.removal_stage,
            )
        )
    return JobReportsListResponse(items=items, total=total)


@router.put("/reports/{report_id}/action", response_model=JobReportRead)
async def action_job_report(
    report_id: int,
    body: JobReportActionRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(JobReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Report not found")

    if body.action == "dismiss":
        now = datetime.now(timezone.utc)
        row.status = "dismissed"
        row.actioned_at = now
        await db.flush()
        await db.refresh(row)
        return await _report_to_read(db, row)

    raise HTTPException(status_code=400, detail="unsupported action")


@router.post("/{job_id}/report", response_model=JobReportRead)
async def create_job_report(
    job_id: UUID,
    body: JobReportCreate,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    job = await db.get(ScrapedJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    if body.report_type == "wrong_gate":
        if job.match_skip_reason is None and job.removal_stage is None:
            raise HTTPException(
                status_code=422,
                detail="wrong_gate is only allowed when the job was removed (skip reason or removal stage)",
            )

    detail = _validate_detail(body.report_type, body.detail)

    existing = (
        await db.execute(
            select(JobReport).where(
                JobReport.job_id == job_id,
                JobReport.report_type == body.report_type,
                JobReport.status == "pending",
            )
        )
    ).scalar_one_or_none()

    if existing:
        existing.detail = detail
        await db.flush()
        await db.refresh(existing)
        return await _report_to_read(db, existing)

    row = JobReport(
        job_id=job_id,
        report_type=body.report_type,
        detail=detail,
        status="pending",
    )
    db.add(row)
    await db.flush()
    await db.refresh(row)
    return await _report_to_read(db, row)
