"""Unified matching pipeline stages (CPU work, LLM extraction + gates, CPU score)."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config_file import read_config_file
from core.profile_file import get_empty_profile, read_profile
from matching.extractor import cpu_extract_jd, llm_extract_jd, record_skill_candidates
from matching.gates import language_gate_jd, run_hard_gates
from matching.llm_scorer import llm_score_job
from matching.scorer import cpu_prescore
from models.match_report import MatchReport
from models.scraped_job import ScrapedJob
from profile.service import load_skill_aliases
from schemas.config import SearchConfigRead

logger = logging.getLogger(__name__)

STEP_B_CONCURRENCY = 8

LLM_GATE_REASONS = frozenset({"education_gate", "visa_gate"})


def _merge_profile_raw(raw: dict) -> dict:
    base = get_empty_profile()
    if not isinstance(raw, dict):
        return base
    merged = dict(base)
    for k, v in raw.items():
        merged[k] = v
    return merged


def _coerce_skill_list(raw: object) -> list[str]:
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


def _apply_cpu_extract(job: ScrapedJob, data: dict, mode: str) -> None:
    job.extracted_yoe = data.get("extracted_yoe")
    job.salary_min_extracted = data.get("extracted_salary_min")
    job.salary_max_extracted = data.get("extracted_salary_max")
    job.education_req_degree = data.get("education_req_degree")
    job.education_req_field = data.get("education_req_field")
    job.education_field_qualified = data.get("education_field_qualified")
    job.visa_req = data.get("visa_req")
    job.required_skills = data.get("required_skills") or []
    job.nice_to_have_skills = data.get("nice_to_have_skills") or []
    job.other_notes = data.get("other_notes")
    job.jd_incomplete = bool(data.get("jd_incomplete", False))
    eff_mode = data.get("_step_b_matching_mode")
    job.matching_mode = eff_mode if eff_mode in ("llm", "cpu") else mode
    job.match_skip_reason = None
    job.removal_stage = None


async def run_cpu_work(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """Button 1 matching leg: B-CPU extraction + language gate + CPU hard gates."""
    t0 = time.monotonic()
    config_data = await read_config_file()
    cfg = SearchConfigRead(**config_data)
    config_dict = cfg.model_dump()
    profile = _merge_profile_raw(read_profile())
    aliases = load_skill_aliases()

    result = await db.execute(
        select(ScrapedJob)
        .where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.matched_at.is_(None),
            ScrapedJob.dismissed.is_(False),
        )
        .order_by(ScrapedJob.created_at.desc())
    )
    jobs: list[ScrapedJob] = list(result.scalars().all())
    n_jobs = len(jobs)
    gate_skip_counts: dict[str, int] = {}
    processed = 0
    failed = 0

    for i, job in enumerate(jobs):
        logger.info(
            "[pipeline/cpu_work] Job %s/%s | id=%s | title=%r",
            i + 1,
            n_jobs,
            job.id,
            job.job_title,
        )
        try:
            data = cpu_extract_jd(
                job.job_title or "",
                job.job_description,
                aliases,
            )
            data["_step_b_matching_mode"] = "cpu"
            _apply_cpu_extract(job, data, "cpu")

            lang_skip = language_gate_jd(job.job_description, config_dict)
            if lang_skip:
                job.match_skip_reason = lang_skip
                job.removal_stage = "cpu_work"
                job.matching_mode = "cpu"
                job.matched_at = datetime.now(timezone.utc)
                gate_skip_counts[lang_skip] = gate_skip_counts.get(lang_skip, 0) + 1
                await db.flush()
                await record_skill_candidates(
                    db,
                    job.required_skills or [],
                    job.nice_to_have_skills or [],
                )
                processed += 1
                continue

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
                job.removal_stage = "cpu_work"
                gate_skip_counts[gate] = gate_skip_counts.get(gate, 0) + 1

            job.matching_mode = "cpu"
            job.matched_at = datetime.now(timezone.utc)
            await db.flush()
            await record_skill_candidates(
                db,
                job.required_skills or [],
                job.nice_to_have_skills or [],
            )
            processed += 1
        except Exception as e:
            logger.error(
                "[pipeline/cpu_work] B-CPU failed job %s %r: %s",
                job.id,
                job.job_title,
                e,
                exc_info=True,
            )
            failed += 1
            job.jd_incomplete = True
            job.match_skip_reason = "extraction_failed"
            job.removal_stage = "cpu_work"
            job.matching_mode = "cpu"
            job.matched_at = datetime.now(timezone.utc)
            await db.flush()

    await db.commit()
    duration_ms = int((time.monotonic() - t0) * 1000)
    total_gate_skipped = sum(gate_skip_counts.values())
    report = MatchReport(
        dedup_run_id=dedup_run_id,
        trigger=trigger,
        matching_mode="cpu_work",
        total_processed=processed,
        total_gate_skipped=total_gate_skipped,
        total_cpu_decided=0,
        total_llm_scored=0,
        total_failed=failed,
        total_cpu_fallback=0,
        match_level_counts={
            "strong_match": 0,
            "possible_match": 0,
            "stretch_match": 0,
            "weak_match": 0,
        },
        gate_skip_counts=gate_skip_counts or None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "[pipeline/cpu_work] Run complete | processed=%s | gate_skipped=%s | "
        "failed=%s | report_id=%s | duration_ms=%s",
        processed,
        total_gate_skipped,
        failed,
        report.id,
        duration_ms,
    )
    return report


async def run_llm_extraction_gates(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """Button 2: B-LLM extraction + hard gates on gate-surviving, pre-score jobs."""
    t0 = time.monotonic()
    config_data = await read_config_file()
    cfg = SearchConfigRead(**config_data)
    config_dict = cfg.model_dump()
    profile = _merge_profile_raw(read_profile())
    aliases = load_skill_aliases()

    result = await db.execute(
        select(ScrapedJob)
        .where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.match_skip_reason.is_(None),
            ScrapedJob.matched_at.is_not(None),
            ScrapedJob.match_level.is_(None),
            ScrapedJob.dismissed.is_(False),
        )
        .order_by(ScrapedJob.created_at.desc())
    )
    jobs: list[ScrapedJob] = list(result.scalars().all())
    n_jobs = len(jobs)
    gate_skip_counts: dict[str, int] = {}

    sem = asyncio.Semaphore(STEP_B_CONCURRENCY)
    db_lock = asyncio.Lock()

    async def process_one(i: int, job: ScrapedJob) -> str:
        async with sem:
            logger.info(
                "[pipeline/llm] Job %s/%s | id=%s | title=%r",
                i + 1,
                n_jobs,
                job.id,
                job.job_title,
            )
            outcome = "ok"
            try:
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
                        "[pipeline/llm] Timeout — CPU fallback | id=%s",
                        job.id,
                    )
                    data = cpu_extract_jd(
                        job.job_title or "",
                        job.job_description,
                        aliases,
                    )
                    data["_step_b_matching_mode"] = "cpu"
                    outcome = "cpu_fallback"
                _apply_cpu_extract(job, data, "llm")

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
                        "llm_extraction" if gate in LLM_GATE_REASONS else "cpu_work"
                    )
                    async with db_lock:
                        gate_skip_counts[gate] = gate_skip_counts.get(gate, 0) + 1
                else:
                    job.removal_stage = None

                async with db_lock:
                    await db.flush()
                    await record_skill_candidates(
                        db,
                        job.required_skills or [],
                        job.nice_to_have_skills or [],
                    )
                return outcome
            except Exception as e:
                logger.error(
                    "[pipeline/llm] FAILED | id=%s | error=%s",
                    job.id,
                    e,
                    exc_info=True,
                )
                job.jd_incomplete = True
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
                "[pipeline/llm] gather slot %s | id=%s | error=%s",
                i,
                getattr(jb, "id", None),
                o,
                exc_info=(type(o), o, o.__traceback__),
            )

    processed = sum(1 for o in outcomes if o in ("ok", "cpu_fallback"))
    total_cpu_fallback = sum(1 for o in outcomes if o == "cpu_fallback")
    total_failed = sum(1 for o in outcomes if o == "fail" or isinstance(o, Exception))
    total_gate_skipped = sum(gate_skip_counts.values())

    await db.commit()
    duration_ms = int((time.monotonic() - t0) * 1000)
    report = MatchReport(
        dedup_run_id=dedup_run_id,
        trigger=trigger,
        matching_mode="llm_extraction_gates",
        total_processed=processed,
        total_gate_skipped=total_gate_skipped,
        total_cpu_decided=0,
        total_llm_scored=0,
        total_failed=total_failed,
        total_cpu_fallback=total_cpu_fallback,
        match_level_counts={
            "strong_match": 0,
            "possible_match": 0,
            "stretch_match": 0,
            "weak_match": 0,
        },
        gate_skip_counts=gate_skip_counts or None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "[pipeline/llm] Run complete | processed=%s | gate_skipped=%s | "
        "failed=%s | cpu_fallback=%s | report_id=%s | duration_ms=%s",
        processed,
        total_gate_skipped,
        total_failed,
        total_cpu_fallback,
        report.id,
        duration_ms,
    )
    return report


async def run_cpu_score_pipeline(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """Button 3: CPU pre-score; persists match_report."""
    t0 = time.monotonic()
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
            ScrapedJob.dismissed.is_(False),
        )
    )
    jobs: list[ScrapedJob] = list(result.scalars().all())

    level_counts: dict[str, int] = {}
    total_cpu_decided = 0
    total_send_to_llm = 0

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

    await db.commit()
    duration_ms = int((time.monotonic() - t0) * 1000)
    report = MatchReport(
        dedup_run_id=dedup_run_id,
        trigger=trigger,
        matching_mode="cpu_score",
        total_processed=len(jobs),
        total_gate_skipped=0,
        total_cpu_decided=total_cpu_decided,
        total_llm_scored=total_send_to_llm,
        total_failed=0,
        total_cpu_fallback=0,
        match_level_counts=level_counts,
        gate_skip_counts=None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "[pipeline/cpu_score] Run complete | scored=%s | cpu_decided=%s | "
        "send_to_llm=%s | report_id=%s | duration_ms=%s",
        len(jobs),
        total_cpu_decided,
        total_send_to_llm,
        report.id,
        duration_ms,
    )
    return report


async def run_llm_score_pipeline(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """Button 4: LLM re-score for CPU middle-range and jd_incomplete jobs."""
    import os

    from openai import AsyncOpenAI
    from core.database import AsyncSessionLocal

    t0 = time.monotonic()
    config_data = await read_config_file()
    cfg = SearchConfigRead(**config_data)
    config_dict = cfg.model_dump()
    strong_threshold = float(config_dict.get("cpu_strong_threshold", 0.85))

    profile = _merge_profile_raw(read_profile())

    # Exclude zero required-skill overlap (definitive weak; no LLM benefit).
    not_zero_overlap = or_(
        ScrapedJob.fit_score.is_(None),
        ScrapedJob.fit_score != 0.0,
        ScrapedJob.req_coverage.is_(None),
        ScrapedJob.req_coverage != 0.0,
    )
    middle_band = and_(
        ScrapedJob.match_level.in_(["stretch_match", "weak_match"]),
        or_(
            ScrapedJob.fit_score.is_(None),
            and_(
                ScrapedJob.fit_score > 0,
                ScrapedJob.fit_score < strong_threshold,
            ),
        ),
        not_zero_overlap,
    )
    jd_stretch = and_(
        ScrapedJob.jd_incomplete == True,  # noqa: E712
        ScrapedJob.match_level == "stretch_match",
        not_zero_overlap,
    )

    result = await db.execute(
        select(ScrapedJob)
        .where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.matched_at.is_not(None),
            ScrapedJob.match_skip_reason.is_(None),
            ScrapedJob.match_level.is_not(None),
            ScrapedJob.match_level != "strong_match",
            ScrapedJob.confidence.is_(None),
            ScrapedJob.dismissed == False,  # noqa: E712
            or_(middle_band, jd_stretch),
        )
        .order_by(ScrapedJob.created_at.desc())
    )
    jobs: list[ScrapedJob] = list(result.scalars().all())
    job_ids = [j.id for j in jobs]
    eligible_total = len(job_ids)
    db.expunge_all()

    logger.info("[pipeline/llm_score] Starting | total=%s", eligible_total)

    match_level_counts: dict[str, int] = {}
    total_scored = 0
    total_failed = 0
    sem = asyncio.Semaphore(STEP_B_CONCURRENCY)
    counts_lock = asyncio.Lock()
    api_key = os.environ.get("OPENAI_API_KEY")

    async def process_one(job_id) -> None:
        nonlocal total_scored, total_failed
        async with sem:
            for attempt in range(2):
                try:
                    if not api_key:
                        raise RuntimeError("OPENAI_API_KEY is not set")
                    async with AsyncSessionLocal() as wdb:
                        row = await wdb.get(ScrapedJob, job_id)
                        if row is None:
                            return
                        title_snip = (row.job_title or "")[:40]
                        fit_pct = round((row.fit_score or 0) * 100)
                    async with AsyncOpenAI(api_key=api_key) as client:
                        llm_result = await llm_score_job(
                            row, profile, config_dict, client
                        )
                    async with AsyncSessionLocal() as wdb:
                        row2 = await wdb.get(ScrapedJob, job_id)
                        if row2 is None:
                            return
                        row2.match_level = llm_result["match_level"]
                        row2.match_reason = llm_result["match_reason"]
                        row2.blocking_gap = llm_result.get("blocking_gap")
                        row2.gap_adjacency = llm_result.get("gap_adjacency") or []
                        row2.confidence = llm_result.get("confidence")
                        row2.matching_mode = "llm"
                        await wdb.commit()
                    async with counts_lock:
                        total_scored += 1
                        lvl = llm_result["match_level"]
                        match_level_counts[lvl] = match_level_counts.get(lvl, 0) + 1
                    logger.info(
                        "[pipeline/llm_score] %s | fit=%s%% | id=%s | %r",
                        llm_result["match_level"],
                        fit_pct,
                        job_id,
                        title_snip,
                    )
                    return
                except Exception as e:
                    if attempt == 0:
                        logger.warning(
                            "[pipeline/llm_score] Retry job %s: %s",
                            job_id,
                            e,
                        )
                        await asyncio.sleep(1)
                    else:
                        logger.error(
                            "[pipeline/llm_score] Failed job %s: %s",
                            job_id,
                            e,
                            exc_info=True,
                        )
                        async with counts_lock:
                            total_failed += 1

    await asyncio.gather(*[process_one(jid) for jid in job_ids])

    duration_ms = int((time.monotonic() - t0) * 1000)
    level_keys = (
        "strong_match",
        "possible_match",
        "stretch_match",
        "weak_match",
    )
    merged_level_counts = {k: match_level_counts.get(k, 0) for k in level_keys}
    report = MatchReport(
        dedup_run_id=dedup_run_id,
        trigger=trigger,
        matching_mode="llm_score",
        total_processed=eligible_total,
        total_gate_skipped=0,
        total_cpu_decided=0,
        total_llm_scored=total_scored,
        total_failed=total_failed,
        total_cpu_fallback=0,
        match_level_counts=merged_level_counts,
        gate_skip_counts=None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "[pipeline/llm_score] Complete | scored=%s failed=%s duration_ms=%s | report_id=%s",
        total_scored,
        total_failed,
        duration_ms,
        report.id,
    )
    return report
