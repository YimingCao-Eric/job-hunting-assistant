import asyncio
import logging
import os
import time
import uuid
from collections import deque
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.auth import get_current_user
from core.config import settings
from core.config_file import read_config_file
from core.database import get_db
from core.profile_file import get_empty_profile, read_profile
from matching.extractor import cpu_extract_jd, llm_extract_jd, record_skill_candidates
from matching.gates import run_hard_gates
from matching.pipeline import (
    run_cpu_score_pipeline,
    run_cpu_work,
    run_llm_extraction_gates,
    run_llm_score_pipeline,
)
from matching.scorer import cpu_prescore
from models.match_report import MatchReport
from models.scraped_job import ScrapedJob
from profile.service import load_skill_aliases
from routers.dedup import DEDUP_SERVICE_SKIP_REASONS
from schemas.config import SearchConfigRead
from schemas.debug_log import DebugLogAppend
from schemas.match_report import MatchReportRead
from schemas.scraped_job import ScrapedJobRead

logger = logging.getLogger(__name__)

# Concurrency limit for Step B LLM extraction.
# At 8 workers: ~104 RPM, safely under gpt-4o-mini's 500 RPM limit.
# Lower to 6 if 429 rate-limit errors appear in logs.
STEP_B_CONCURRENCY = 8


class MatchingLogHandler(logging.Handler):
    """Ring buffer of recent matching-pipeline log lines for GET /match/logs."""

    _buffer: deque[str] = deque(maxlen=2000)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            MatchingLogHandler._buffer.append(self.format(record))
        except Exception:
            self.handleError(record)

    @classmethod
    def get_lines(cls) -> list[str]:
        return list(cls._buffer)


_log_handler = MatchingLogHandler()
_log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logging.getLogger("matching").addHandler(_log_handler)
logging.getLogger("routers.matching").addHandler(_log_handler)

# Tracks live matching pipeline tasks so (a) they're not GC'd mid-run and
# (b) /match/status can report what's running without reconstructing state.
# Key: asyncio.Task, Value: mode string ("cpu_only" | "llm_extraction_gates" | "cpu_score" | "llm_score")
_BACKGROUND_TASKS: dict[asyncio.Task, str] = {}

router = APIRouter(tags=["matching"])


class MatchRequest(BaseModel):
    """Body for POST /jobs/match (queued background run)."""

    mode: str | None = None
    # cpu_only = B-CPU extraction + CPU gates (Button 1)
    # llm_extraction_gates = B-LLM extraction + LLM gates (Button 2)
    # cpu_score            = CPU pre-score only (Button 3)
    # llm_score            = Step D LLM re-score (Button 4)
    # None                 = legacy Step B extraction (backward compat)


class MatchRunStarted(BaseModel):
    status: str = "started"
    mode: str | None = None


class MatchStatus(BaseModel):
    """Reports whether a matching pipeline task is currently running."""

    running: bool
    mode: str | None = None


def _merge_profile_raw(raw: dict) -> dict:
    base = get_empty_profile()
    if not isinstance(raw, dict):
        return base
    merged = dict(base)
    for k, v in raw.items():
        merged[k] = v
    return merged


def _coerce_skill_list(raw: object) -> list[str]:
    """Normalise JSONB skill payloads to list[str] for Step C."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw if x is not None and str(x).strip()]
    if isinstance(raw, dict):
        out: list[str] = []
        for v in raw.values():
            if isinstance(v, list):
                out.extend(str(x) for x in v if x is not None and str(x).strip())
            elif v is not None and str(v).strip():
                out.append(str(v))
        return out
    return []


def _profile_skill_strings(profile: dict) -> list[str]:
    raw = (profile.get("_extracted") or {}).get("skills") or []
    if isinstance(raw, list):
        return [str(x) for x in raw if x is not None and str(x).strip()]
    return _coerce_skill_list(raw)


async def _run_step_b_extraction_all_passed(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """
    Step B for HTTP POST /jobs/match: JD extraction only for passed dedup jobs
    (``skip_reason IS NULL``). Does not run hard gates (use POST /jobs/match/gates).
    """
    t0 = time.monotonic()
    config_data = await read_config_file()
    cfg = SearchConfigRead(**config_data)
    llm = bool(cfg.llm)

    profile_raw = read_profile()
    profile = _merge_profile_raw(profile_raw)
    aliases = load_skill_aliases()

    result = await db.execute(
        select(ScrapedJob)
        .where(ScrapedJob.skip_reason.is_(None))
        .order_by(ScrapedJob.created_at.desc())
    )
    jobs: list[ScrapedJob] = list(result.scalars().all())

    mode = "llm" if llm else "cpu"
    n_jobs = len(jobs)

    logger.info(
        "[match/run] Starting Step B | mode=%s | jobs=%s",
        "llm" if llm else "cpu",
        n_jobs,
    )

    sem = asyncio.Semaphore(STEP_B_CONCURRENCY)
    db_lock = asyncio.Lock()

    async def process_one(i: int, job: ScrapedJob) -> str:
        async with sem:
            logger.info(
                "[match/run] Job %s/%s | id=%s | title=%r",
                i + 1,
                n_jobs,
                job.id,
                job.job_title,
            )
            outcome = "ok"
            try:
                if llm:
                    try:
                        data = await asyncio.wait_for(
                            llm_extract_jd(
                                job.job_title or "",
                                job.job_description,
                                aliases,
                                profile,
                                job_id=str(job.id),
                            ),
                            timeout=150.0,
                        )
                    except TimeoutError:
                        logger.warning(
                            "[match/run] Job %s/%s timed out after 150s — "
                            "falling back to CPU | id=%s | title=%r",
                            i + 1,
                            n_jobs,
                            job.id,
                            job.job_title,
                        )
                        data = cpu_extract_jd(
                            job.job_title or "",
                            job.job_description,
                            aliases,
                        )
                        data["_step_b_matching_mode"] = "cpu"
                        outcome = "cpu_fallback"
                else:
                    data = cpu_extract_jd(
                        job.job_title or "",
                        job.job_description,
                        aliases,
                    )
                job.extracted_yoe = data.get("extracted_yoe")
                job.salary_min_extracted = data.get("extracted_salary_min")
                job.education_req_degree = data.get("education_req_degree")
                job.education_req_field = data.get("education_req_field")
                job.education_field_qualified = data.get("education_field_qualified")
                job.visa_req = data.get("visa_req")
                job.required_skills = data.get("required_skills") or []
                job.nice_to_have_skills = data.get("nice_to_have_skills") or []
                job.jd_incomplete = bool(data.get("jd_incomplete", False))
                eff_mode = data.get("_step_b_matching_mode")
                job.matching_mode = (
                    eff_mode if eff_mode in ("llm", "cpu") else mode
                )
                job.matched_at = datetime.now(timezone.utc)
                job.match_skip_reason = None
                logger.info(
                    "[match/run] Job %s/%s extracted | mode=%s | "
                    "skills_req=%s | skills_nth=%s | salary=%s | incomplete=%s",
                    i + 1,
                    n_jobs,
                    job.matching_mode,
                    len(data.get("required_skills") or []),
                    len(data.get("nice_to_have_skills") or []),
                    data.get("extracted_salary_min"),
                    data.get("jd_incomplete"),
                )
                async with db_lock:
                    await db.flush()
                    await record_skill_candidates(
                        db,
                        job.required_skills or [],
                        job.nice_to_have_skills or [],
                    )
                logger.info(
                    "[match/run] Job %s/%s written to DB | id=%s",
                    i + 1,
                    n_jobs,
                    job.id,
                )
                return outcome
            except Exception as e:
                logger.error(
                    "[match/run] Job %s/%s FAILED | id=%s | error=%s",
                    i + 1,
                    n_jobs,
                    job.id,
                    e,
                    exc_info=True,
                )
                job.jd_incomplete = True
                job.matched_at = datetime.now(timezone.utc)
                async with db_lock:
                    await db.flush()
                return "fail"

    outcomes = await asyncio.gather(
        *[process_one(i, job) for i, job in enumerate(jobs)],
        return_exceptions=True,
    )
    for i, o in enumerate(outcomes):
        if isinstance(o, Exception):
            jb = jobs[i] if i < len(jobs) else None
            logger.error(
                "[match/run] Unhandled exception in gather slot %s | id=%s | error=%s",
                i,
                getattr(jb, "id", None),
                o,
                exc_info=(type(o), o, o.__traceback__),
            )
    processed = sum(
        1 for o in outcomes if o in ("ok", "cpu_fallback")
    )
    total_cpu_fallback = sum(1 for o in outcomes if o == "cpu_fallback")
    total_failed = sum(
        1 for o in outcomes if o == "fail" or isinstance(o, Exception)
    )
    gate_skipped = 0

    await db.commit()

    duration_ms = int((time.monotonic() - t0) * 1000)
    avg_per_job = round(duration_ms / max(processed, 1))
    logger.info(
        "[match/run] Run complete | processed=%s | cpu_fallback=%s | failed=%s | "
        "duration=%sms | avg_per_job=%sms",
        processed,
        total_cpu_fallback,
        total_failed,
        duration_ms,
        avg_per_job,
    )
    counts = {
        "strong_match": 0,
        "possible_match": 0,
        "stretch_match": 0,
        "weak_match": 0,
    }
    report = MatchReport(
        dedup_run_id=dedup_run_id,
        trigger=trigger,
        matching_mode=mode,
        total_processed=processed,
        total_gate_skipped=gate_skipped,
        total_cpu_decided=0,
        total_llm_scored=0,
        total_failed=total_failed,
        total_cpu_fallback=total_cpu_fallback,
        match_level_counts=counts,
        gate_skip_counts=None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "[match/run] Match report persisted | report_id=%s | matching_mode=%s",
        report.id,
        mode,
    )
    return report


async def _matching_background(mode: str | None) -> None:
    """Run matching in a fresh DB session (request session is closed after HTTP response)."""
    from core.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            if mode == "cpu_only":
                await run_cpu_work(db, trigger="manual")
            elif mode == "llm_extraction_gates":
                await run_llm_extraction_gates(db, trigger="manual")
            elif mode == "cpu_score":
                await run_cpu_score_pipeline(db, trigger="manual")
            elif mode == "llm_score":
                await run_llm_score_pipeline(db, trigger="manual")
            else:
                await _run_step_b_extraction_all_passed(db, trigger="manual")
    except Exception:
        logger.exception(
            "[match/run] Background matching task failed | mode=%r",
            mode,
        )


@router.get("/jobs/match", status_code=501)
async def match_jobs_get_not_implemented(_user: dict = Depends(get_current_user)):
    return {"detail": "Matching pipeline not yet implemented"}


@router.post("/jobs/match", response_model=MatchRunStarted)
async def match_jobs_run(
    body: MatchRequest = MatchRequest(),
    _user: dict = Depends(get_current_user),
):
    if body.mode is not None and body.mode not in (
        "cpu_only",
        "llm_extraction_gates",
        "cpu_score",
        "llm_score",
    ):
        raise HTTPException(status_code=422, detail="Invalid matching mode")

    if body.mode == "llm_extraction_gates":
        config_data = await read_config_file()
        cfg = SearchConfigRead(**config_data)
        if not cfg.llm:
            raise HTTPException(
                status_code=400,
                detail="LLM is disabled in config; enable llm to run this stage",
            )

    if body.mode == "llm_score":
        config_data = await read_config_file()
        cfg = SearchConfigRead(**config_data)
        if not cfg.llm:
            raise HTTPException(
                status_code=422,
                detail="LLM mode must be enabled in config to run LLM scoring",
            )
        if not os.environ.get("OPENAI_API_KEY"):
            raise HTTPException(
                status_code=422,
                detail="OPENAI_API_KEY must be set to run LLM scoring",
            )

    mode_label = body.mode or "default"
    task = asyncio.create_task(_matching_background(body.mode))
    _BACKGROUND_TASKS[task] = mode_label
    task.add_done_callback(lambda t: _BACKGROUND_TASKS.pop(t, None))
    return MatchRunStarted(status="started", mode=body.mode)


@router.get("/jobs/match/extracted-count")
async def match_extracted_job_count(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Count passed dedup jobs that have completed Step B (matched_at set)."""
    q = await db.execute(
        select(func.count()).select_from(ScrapedJob).where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.matched_at.is_not(None),
        )
    )
    return {"count": int(q.scalar_one() or 0)}


@router.post("/jobs/match/gates")
async def run_gates_endpoint(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Run hard gates on extracted jobs that are not yet gate-evaluated."""
    config_dict = await read_config_file()
    profile = _merge_profile_raw(read_profile())

    result = await db.execute(
        select(ScrapedJob).where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.matched_at.is_not(None),
            ScrapedJob.match_skip_reason.is_(None),
        )
    )
    jobs = list(result.scalars().all())

    gate_skipped = 0
    would_pass = 0
    gate_counts: dict[str, int] = {
        "yoe_gate": 0,
        "salary_gate": 0,
        "education_gate": 0,
        "visa_gate": 0,
    }

    for job in jobs:
        extracted = {
            "extracted_yoe": job.extracted_yoe,
            "extracted_salary_min": job.salary_min_extracted,
            "education_req_degree": job.education_req_degree,
            "education_field_qualified": job.education_field_qualified,
            "visa_req": job.visa_req,
        }
        gate = run_hard_gates(extracted, profile, config_dict)
        if gate:
            job.match_skip_reason = gate
            job.removal_stage = (
                "llm_extraction" if gate in ("education_gate", "visa_gate") else "cpu_work"
            )
            gate_skipped += 1
            gate_counts[gate] = gate_counts.get(gate, 0) + 1
        else:
            would_pass += 1

    await db.commit()

    return {
        "gate_skipped": gate_skipped,
        "would_pass": would_pass,
        "gate_counts": gate_counts,
        "total_checked": len(jobs),
    }


@router.post("/jobs/match/reset-gates")
async def reset_gates(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Clear match_skip_reason only so gates can be re-run; keeps extraction fields."""
    result = await db.execute(
        select(ScrapedJob).where(ScrapedJob.match_skip_reason.isnot(None))
    )
    jobs = list(result.scalars().all())
    count = len(jobs)
    for job in jobs:
        job.match_skip_reason = None
    await db.commit()
    logger.info("[match/reset-gates] Cleared match_skip_reason | count=%s", count)
    return {"reset_count": count}


@router.post("/jobs/match/score")
async def run_score_c(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Step C: CPU pre-score for passed, extracted, gate-ok jobs not yet scored."""
    config_data = await read_config_file()
    cfg = SearchConfigRead(**config_data)
    config_dict = cfg.model_dump()

    profile = _merge_profile_raw(read_profile())
    profile_skills = _profile_skill_strings(profile)

    result = await db.execute(
        select(ScrapedJob).where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.matched_at.is_not(None),
            ScrapedJob.match_skip_reason.is_(None),
            ScrapedJob.match_level.is_(None),
        )
    )
    jobs = list(result.scalars().all())

    if not jobs:
        return {
            "total_scored": 0,
            "total_cpu_decided": 0,
            "total_send_to_llm": 0,
            "match_level_counts": {},
            "duration_ms": 0,
        }

    start_ms = int(time.time() * 1000)
    total_cpu_decided = 0
    total_send_to_llm = 0
    level_counts: dict[str, int] = {}

    for job in jobs:
        extracted = {
            "required_skills": _coerce_skill_list(job.required_skills),
            "nice_to_have_skills": _coerce_skill_list(job.nice_to_have_skills),
        }

        score = cpu_prescore(extracted, profile_skills, config_dict)

        job.fit_score = score.fit_score
        job.req_coverage = score.req_coverage
        job.match_level = score.match_level
        job.match_reason = score.match_reason

        if score.send_to_llm:
            total_send_to_llm += 1
        else:
            total_cpu_decided += 1

        level_counts[score.match_level] = level_counts.get(score.match_level, 0) + 1

        logger.info(
            "[score/c] job_id=%s fit=%s req=%s level=%s llm=%s",
            job.id,
            score.fit_score,
            score.req_coverage,
            score.match_level,
            score.send_to_llm,
        )

    await db.commit()

    duration_ms = int(time.time() * 1000) - start_ms

    logger.info(
        "[score/c] Complete | scored=%s | cpu_decided=%s | send_to_llm=%s | duration=%sms",
        len(jobs),
        total_cpu_decided,
        total_send_to_llm,
        duration_ms,
    )

    return {
        "total_scored": len(jobs),
        "total_cpu_decided": total_cpu_decided,
        "total_send_to_llm": total_send_to_llm,
        "match_level_counts": level_counts,
        "duration_ms": duration_ms,
    }


@router.post("/jobs/match/reset-score")
async def reset_score(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Clear fit/match score fields only; keeps extraction and gate results."""
    result = await db.execute(
        select(ScrapedJob).where(ScrapedJob.match_level.isnot(None))
    )
    jobs = list(result.scalars().all())
    count = len(jobs)

    for job in jobs:
        job.fit_score = None
        job.req_coverage = None
        job.match_level = None
        job.match_reason = None
        job.confidence = None
        job.blocking_gap = None
        job.gap_adjacency = None

    await db.commit()
    logger.info("[score/reset] Cleared scoring fields | count=%s", count)
    return {"reset_count": count}


@router.post("/jobs/match/undo-button1")
async def undo_button1(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Full pipeline reset: dedup service skip reasons + all matching fields (not dismissed)."""
    r1 = await db.execute(
        update(ScrapedJob)
        .where(ScrapedJob.skip_reason.in_(DEDUP_SERVICE_SKIP_REASONS))
        .values(
            skip_reason=None,
            dedup_similarity_score=None,
            dedup_original_job_id=None,
        )
    )
    r2 = await db.execute(
        update(ScrapedJob)
        .values(
            match_level=None,
            match_reason=None,
            confidence=None,
            fit_score=None,
            req_coverage=None,
            match_skip_reason=None,
            matching_mode=None,
            matched_at=None,
            extracted_yoe=None,
            salary_min_extracted=None,
            salary_max_extracted=None,
            education_req_degree=None,
            education_req_field=None,
            education_field_qualified=None,
            visa_req=None,
            required_skills=None,
            nice_to_have_skills=None,
            critical_skills=None,
            jd_incomplete=False,
            blocking_gap=None,
            gap_adjacency=None,
            other_notes=None,
            seniority_level=None,
            job_type=None,
            remote_type=None,
            removal_stage=None,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    logger.info(
        "[match/undo-button1] dedup_rows=%s | matching_rows=%s",
        r1.rowcount,
        r2.rowcount,
    )
    return {"reset_count": int(r2.rowcount or 0)}


@router.post("/jobs/match/undo-button2")
async def undo_button2(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    r_scores = await db.execute(
        update(ScrapedJob)
        .values(
            fit_score=None,
            req_coverage=None,
            match_level=None,
            match_reason=None,
            confidence=None,
            blocking_gap=None,
            gap_adjacency=None,
        )
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(ScrapedJob)
        .where(ScrapedJob.match_skip_reason.in_(["education_gate", "visa_gate"]))
        .values(match_skip_reason=None, removal_stage=None)
        .execution_options(synchronize_session=False)
    )
    r3 = await db.execute(
        update(ScrapedJob)
        .where(ScrapedJob.matching_mode == "llm")
        .values(matching_mode="cpu")
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    logger.info("[match/undo-button2] Reverted LLM stage | llm_rows=%s", r3.rowcount)
    return {"reset_count": int(r_scores.rowcount or 0)}


@router.post("/jobs/match/undo-button3")
async def undo_button3(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """Clear Button 3 CPU scores and any downstream Button 4 fields; does not touch matching_mode."""
    r = await db.execute(
        update(ScrapedJob)
        .where(
            or_(
                ScrapedJob.fit_score.isnot(None),
                ScrapedJob.match_level.isnot(None),
            ),
        )
        .values(
            fit_score=None,
            req_coverage=None,
            match_level=None,
            match_reason=None,
            confidence=None,
            blocking_gap=None,
            gap_adjacency=None,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    logger.info("[match/undo-button3] Cleared score fields | rows=%s", r.rowcount)
    return {"reset_count": r.rowcount or 0}


@router.post("/jobs/match/undo-button4")
async def undo_button4(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    """
    Clear Step D LLM scoring fields. Does not change matching_mode — that reflects
    JD extraction (Button 1/2), not scoring; only undo-button2 reverts extraction mode.
    """
    r = await db.execute(
        update(ScrapedJob)
        .where(
            ScrapedJob.matching_mode == "llm",
            ScrapedJob.confidence.isnot(None),
        )
        .values(
            match_level=None,
            match_reason=None,
            blocking_gap=None,
            gap_adjacency=None,
            confidence=None,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    logger.info("[match/undo-button4] Cleared LLM scores | rows=%s", r.rowcount)
    return {"reset_count": int(r.rowcount or 0)}


@router.post("/jobs/match/dismiss/{job_id}", response_model=ScrapedJobRead)
async def dismiss_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    job = await db.get(ScrapedJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    eligible = job.match_level is not None or job.match_skip_reason is not None
    if not eligible:
        raise HTTPException(
            status_code=422,
            detail="Job must be scored or gate-failed to dismiss",
        )
    job.dismissed = True
    await db.commit()
    await db.refresh(job)
    return job


@router.post("/jobs/match/undismiss/{job_id}", response_model=ScrapedJobRead)
async def undismiss_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    job = await db.get(ScrapedJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job.dismissed = False
    if job.match_skip_reason is not None:
        await db.commit()
        await db.refresh(job)
        return job
    job.skip_reason = None
    job.match_skip_reason = None
    job.required_skills = None
    job.nice_to_have_skills = None
    job.extracted_yoe = None
    job.salary_min_extracted = None
    job.salary_max_extracted = None
    job.education_req_degree = None
    job.education_req_field = None
    job.education_field_qualified = None
    job.visa_req = None
    job.jd_incomplete = False
    job.fit_score = None
    job.req_coverage = None
    job.match_level = None
    job.match_reason = None
    job.confidence = None
    job.blocking_gap = None
    job.gap_adjacency = None
    job.matching_mode = None
    job.matched_at = None
    job.removal_stage = None
    await db.commit()
    await db.refresh(job)
    return job


@router.post("/jobs/match/reset")
async def reset_matching(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = (
        update(ScrapedJob)
        .values(
            match_level=None,
            match_reason=None,
            confidence=None,
            fit_score=None,
            req_coverage=None,
            match_skip_reason=None,
            matching_mode=None,
            matched_at=None,
            extracted_yoe=None,
            salary_min_extracted=None,
            salary_max_extracted=None,
            education_req_degree=None,
            education_req_field=None,
            education_field_qualified=None,
            visa_req=None,
            required_skills=None,
            nice_to_have_skills=None,
            critical_skills=None,
            jd_incomplete=False,
            blocking_gap=None,
            gap_adjacency=None,
            other_notes=None,
            seniority_level=None,
            job_type=None,
            remote_type=None,
            removal_stage=None,
        )
        .execution_options(synchronize_session=False)
    )
    logger.info("[match/reset] Resetting matching fields on all jobs")
    result = await db.execute(stmt)
    await db.commit()
    reset_count = result.rowcount
    logger.info("[match/reset] Reset complete | count=%s", reset_count)
    return {"reset_count": reset_count}


@router.get("/match/reports", response_model=list[MatchReportRead])
async def list_match_reports(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    stmt = (
        select(MatchReport)
        .order_by(MatchReport.created_at.desc())
        .limit(50)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/match/status", response_model=MatchStatus)
async def match_status(_user: dict = Depends(get_current_user)):
    """Return { running: bool, mode: str|null } for the most recent live task.

    If multiple are live (rare — UI disables buttons during a run), returns the
    first encountered. If none are live, returns { running: false, mode: null }.
    """
    for task, mode in _BACKGROUND_TASKS.items():
        if not task.done():
            return MatchStatus(running=True, mode=mode)
    return MatchStatus(running=False, mode=None)


@router.get("/match/logs")
async def get_match_logs(_user: dict = Depends(get_current_user)):
    return {"lines": MatchingLogHandler.get_lines()}


@router.get("/match/reports/{report_id}", response_model=MatchReportRead)
async def get_match_report(
    report_id: int,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(MatchReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Match report not found")
    return row


@router.post("/match/reports/{report_id}/debug")
async def append_match_debug_log(
    report_id: int,
    payload: DebugLogAppend,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(MatchReport, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="match report not found")
    existing = (row.debug_log or {}).get("events", [])
    if not isinstance(existing, list):
        existing = []
    new_events = [e.model_dump(mode="json") for e in payload.events]
    combined = [*existing, *new_events]
    if len(combined) > settings.debug_log_ring_size:
        combined = combined[-settings.debug_log_ring_size :]
    row.debug_log = {"events": combined}
    flag_modified(row, "debug_log")
    await db.commit()
    return {"ok": True, "total_events": len(combined), "accepted": len(payload.events)}
