"""Run Step B (JD extraction) on passed jobs."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config_file import read_config_file
from core.profile_file import get_empty_profile, read_profile
from matching.extractor import cpu_extract_jd, llm_extract_jd
from models.match_report import MatchReport
from models.scraped_job import ScrapedJob
from profile.service import load_skill_aliases
from schemas.config import SearchConfigRead

logger = logging.getLogger(__name__)


def _merge_profile_raw(raw: dict) -> dict:
    base = get_empty_profile()
    if not isinstance(raw, dict):
        return base
    merged = dict(base)
    for k, v in raw.items():
        merged[k] = v
    return merged


async def run_step_b_extraction(
    db: AsyncSession,
    *,
    trigger: str,
    dedup_run_id: int | None = None,
) -> MatchReport:
    """Extract JD fields for all passed jobs where ``matched_at`` is null."""
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

    processed = 0
    failed = 0
    mode = "llm" if llm else "cpu"

    for job in jobs:
        if job.matched_at is not None:
            continue
        try:
            if llm:
                data = await llm_extract_jd(
                    job.job_title or "",
                    job.job_description,
                    aliases,
                    profile,
                )
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
            job.matching_mode = mode
            job.matched_at = datetime.now(timezone.utc)
            processed += 1
            await db.flush()
        except Exception:
            logger.exception("Step B extraction failed for job %s", job.id)
            failed += 1
            job.jd_incomplete = True
            job.matched_at = datetime.now(timezone.utc)
            await db.flush()

    duration_ms = int((time.monotonic() - t0) * 1000)
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
        total_gate_skipped=0,
        total_cpu_decided=0,
        total_llm_scored=0,
        total_failed=failed,
        total_cpu_fallback=0,
        match_level_counts=counts,
        gate_skip_counts=None,
        duration_ms=duration_ms,
    )
    db.add(report)
    await db.flush()
    await db.refresh(report)
    return report
