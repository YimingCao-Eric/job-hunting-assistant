from __future__ import annotations

import logging
import time
import uuid
from collections import Counter, defaultdict
from collections.abc import Sequence
from datetime import datetime

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import Settings
from core.trace import JhaTrace, flush_trace_to_report, trace_scope
from models.dedup_report import DedupReport
from models.scraped_job import ScrapedJob
from schemas.config import SearchConfigRead
from schemas.dedup import DedupReportRead, GateResult

logger = logging.getLogger(__name__)

PASS1_GATE_ORDER = (
    "title_mismatch",
    "contract_mismatch",
    "remote_mismatch",
    "sponsorship",
    "agency_jd",
)

JOB_TYPE_TERMS = (
    "intern",
    "co-op",
    "coop",
    "student",
    "co op",
    "apprentice",
    "trainee",
)

AGENCY_COMPANY_TERMS = (
    "staffing",
    "recruiting",
    "recruitment",
    "talent",
    "manpower",
    "hays",
    "robert half",
    "randstad",
    "adecco",
    "kelly services",
)

CONTRACT_TERMS = (
    "contract",
    "contractor",
    "freelance",
    "1-year term",
    "fixed term",
    "temporary",
    "temp role",
)

REMOTE_MISMATCH_TERMS = (
    "onsite",
    "on-site",
    "on site",
    "in-office",
    "in office",
    "must relocate",
    "required to be in",
    "days in office",
)

SPONSORSHIP_TERMS = (
    "no sponsorship",
    "no visa",
    "cannot sponsor",
    "unable to sponsor",
    "must be authorized",
    "must be legally authorized",
    "citizens only",
    "permanent residents only",
)

AGENCY_JD_TERMS = (
    "on behalf of our client",
    "our client is",
    "staffing agency",
    "recruiting on behalf",
    "placed by",
    "through our agency",
)


def run_pass_0(
    job_title: str,
    company: str,
    location: str,
    config: SearchConfigRead,
) -> str | None:
    company_l = (company or "").lower()
    location_l = (location or "").lower()
    title_l = (job_title or "").lower()

    for c in config.blacklist_companies or []:
        if c.lower() == company_l:
            return "blacklisted_company"
    for term in config.blacklist_locations or []:
        if term.lower() in location_l:
            return "blacklisted_location"

    for term in config.blacklist_titles or []:
        if term.lower() in title_l:
            return "title_blacklisted"

    for term in JOB_TYPE_TERMS:
        if term in title_l:
            return "job_type"

    if config.no_agency:
        for term in AGENCY_COMPANY_TERMS:
            if term in company_l:
                return "agency"

    return None


def run_pass_1(
    job_title: str,
    job_description: str | None,
    config: SearchConfigRead,
) -> tuple[str | None, dict[str, int]]:
    """
    Returns (skip_reason or None, per-gate duration_ms for gates that ran).
    Empty JD: no checks, return (None, {}).
    """
    jd = (job_description or "").strip()
    if not jd:
        return None, {}

    title_l = (job_title or "").lower()
    jd_l = jd.lower()
    timings: dict[str, int] = {}

    t0 = time.monotonic()
    targets = config.target_titles or []
    if targets:
        if not any(term.lower() in title_l for term in targets):
            timings["title_mismatch"] = int((time.monotonic() - t0) * 1000)
            return "title_mismatch", timings
    timings["title_mismatch"] = int((time.monotonic() - t0) * 1000)

    if config.no_contract:
        t0 = time.monotonic()
        blob = f"{title_l} {jd_l}"
        if any(term in blob for term in CONTRACT_TERMS):
            timings["contract_mismatch"] = int((time.monotonic() - t0) * 1000)
            return "contract_mismatch", timings
        timings["contract_mismatch"] = int((time.monotonic() - t0) * 1000)
    else:
        timings["contract_mismatch"] = 0

    if config.remote_only:
        t0 = time.monotonic()
        if any(term in jd_l for term in REMOTE_MISMATCH_TERMS):
            timings["remote_mismatch"] = int((time.monotonic() - t0) * 1000)
            return "remote_mismatch", timings
        timings["remote_mismatch"] = int((time.monotonic() - t0) * 1000)
    else:
        timings["remote_mismatch"] = 0

    if config.needs_sponsorship:
        t0 = time.monotonic()
        if any(term in jd_l for term in SPONSORSHIP_TERMS):
            timings["sponsorship"] = int((time.monotonic() - t0) * 1000)
            return "sponsorship", timings
        timings["sponsorship"] = int((time.monotonic() - t0) * 1000)
    else:
        timings["sponsorship"] = 0

    if config.no_agency:
        t0 = time.monotonic()
        if any(term in jd_l for term in AGENCY_JD_TERMS):
            timings["agency_jd"] = int((time.monotonic() - t0) * 1000)
            return "agency", timings
        timings["agency_jd"] = int((time.monotonic() - t0) * 1000)
    else:
        timings["agency_jd"] = 0

    return None, timings


def _empty_gate_results() -> dict[str, dict[str, int]]:
    keys = (
        "pass_0",
        "title_mismatch",
        "contract_mismatch",
        "remote_mismatch",
        "sponsorship",
        "agency_jd",
        "hash_exact",
        "cosine",
    )
    return {k: {"checked": 0, "flagged": 0, "duration_ms": 0} for k in keys}


def _pass1_metrics_linear(
    jobs: Sequence[ScrapedJob],
    pass0_flags: dict[uuid.UUID, str],
    config: SearchConfigRead,
    gate_results: dict[str, dict[str, int]],
) -> dict[uuid.UUID, str]:
    """
    Single pass over survivors: run_pass_1 once per job, update checked/flagged per gate.
    """
    survivors = [j for j in jobs if j.id not in pass0_flags]
    pass1_flags: dict[uuid.UUID, str] = {}

    for gate in PASS1_GATE_ORDER:
        gate_results[gate]["checked"] = 0
        gate_results[gate]["flagged"] = 0
        gate_results[gate]["duration_ms"] = 0

    for job in survivors:
        jd = (job.job_description or "").strip()
        if not jd:
            continue

        title = job.job_title or ""

        t0 = time.monotonic()
        targets = config.target_titles or []
        if targets:
            gate_results["title_mismatch"]["checked"] += 1
            if not any(term.lower() in title.lower() for term in targets):
                gate_results["title_mismatch"]["duration_ms"] += int(
                    (time.monotonic() - t0) * 1000
                )
                gate_results["title_mismatch"]["flagged"] += 1
                pass1_flags[job.id] = "title_mismatch"
                continue
        gate_results["title_mismatch"]["duration_ms"] += int(
            (time.monotonic() - t0) * 1000
        )

        title_l = title.lower()
        jd_l = jd.lower()
        blob = f"{title_l} {jd_l}"

        if config.no_contract:
            gate_results["contract_mismatch"]["checked"] += 1
            t0 = time.monotonic()
            if any(term in blob for term in CONTRACT_TERMS):
                gate_results["contract_mismatch"]["duration_ms"] += int(
                    (time.monotonic() - t0) * 1000
                )
                gate_results["contract_mismatch"]["flagged"] += 1
                pass1_flags[job.id] = "contract_mismatch"
                continue
            gate_results["contract_mismatch"]["duration_ms"] += int(
                (time.monotonic() - t0) * 1000
            )

        if config.remote_only:
            gate_results["remote_mismatch"]["checked"] += 1
            t0 = time.monotonic()
            if any(term in jd_l for term in REMOTE_MISMATCH_TERMS):
                gate_results["remote_mismatch"]["duration_ms"] += int(
                    (time.monotonic() - t0) * 1000
                )
                gate_results["remote_mismatch"]["flagged"] += 1
                pass1_flags[job.id] = "remote_mismatch"
                continue
            gate_results["remote_mismatch"]["duration_ms"] += int(
                (time.monotonic() - t0) * 1000
            )

        if config.needs_sponsorship:
            gate_results["sponsorship"]["checked"] += 1
            t0 = time.monotonic()
            if any(term in jd_l for term in SPONSORSHIP_TERMS):
                gate_results["sponsorship"]["duration_ms"] += int(
                    (time.monotonic() - t0) * 1000
                )
                gate_results["sponsorship"]["flagged"] += 1
                pass1_flags[job.id] = "sponsorship"
                continue
            gate_results["sponsorship"]["duration_ms"] += int(
                (time.monotonic() - t0) * 1000
            )

        if config.no_agency:
            gate_results["agency_jd"]["checked"] += 1
            t0 = time.monotonic()
            if any(term in jd_l for term in AGENCY_JD_TERMS):
                gate_results["agency_jd"]["duration_ms"] += int(
                    (time.monotonic() - t0) * 1000
                )
                gate_results["agency_jd"]["flagged"] += 1
                pass1_flags[job.id] = "agency"
                continue
            gate_results["agency_jd"]["duration_ms"] += int(
                (time.monotonic() - t0) * 1000
            )

    return pass1_flags


# (skip_reason, similarity_score or None, kept_original_job_id or None)
Pass2Flag = tuple[str, float | None, uuid.UUID | None]


def _resolve_chains(
    flagged: dict[uuid.UUID, Pass2Flag],
) -> tuple[dict[uuid.UUID, Pass2Flag], dict[str, int]]:
    """
    For any flagged job whose dedup_original_job_id points to another flagged job,
    walk the chain until the original is not in this pass's flagged set.
    """
    flagged_ids = set(flagged.keys())
    resolved: dict[uuid.UUID, Pass2Flag] = {}
    chain_count = 0
    max_depth_observed = 0

    for job_id, (reason, score, original_id) in flagged.items():
        if original_id is None or original_id not in flagged_ids:
            resolved[job_id] = (reason, score, original_id)
            continue

        chain_count += 1
        visited: set[uuid.UUID] = {job_id}
        current = original_id
        depth = 0
        while current in flagged_ids and depth < 20:
            if current in visited:
                break
            visited.add(current)
            nxt = flagged[current][2]
            if nxt is None:
                break
            current = nxt
            depth += 1
        max_depth_observed = max(max_depth_observed, depth)
        if current in flagged_ids:
            resolved[job_id] = (reason, score, original_id)
        else:
            resolved[job_id] = (reason, score, current)

    return resolved, {
        "chain_count": chain_count,
        "max_depth_observed": max_depth_observed,
    }


async def resolve_dedup_chains_in_db(db: AsyncSession) -> int:
    """
    One-time repair: for removed jobs whose dedup_original_job_id points to another
    removed job, walk to the passed (non-removed) ancestor and UPDATE.
    Returns number of rows updated.
    """
    pairs = (
        await db.execute(
            select(ScrapedJob.id, ScrapedJob.dedup_original_job_id).where(
                ScrapedJob.skip_reason.isnot(None),
                ScrapedJob.dedup_original_job_id.isnot(None),
            )
        )
    ).all()
    if not pairs:
        return 0

    id_to_original: dict[uuid.UUID, uuid.UUID] = {
        p.id: p.dedup_original_job_id for p in pairs if p.dedup_original_job_id is not None
    }

    removed_result = await db.execute(
        select(ScrapedJob.id).where(ScrapedJob.skip_reason.isnot(None))
    )
    removed_ids = set(removed_result.scalars().all())

    updates: dict[uuid.UUID, uuid.UUID] = {}
    for row in pairs:
        job_id = row.id
        orig = row.dedup_original_job_id
        if orig is None or orig not in removed_ids:
            continue

        visited: set[uuid.UUID] = {job_id}
        current: uuid.UUID | None = orig
        depth = 0
        while current is not None and current in removed_ids and depth < 20:
            if current in visited:
                break
            visited.add(current)
            current = id_to_original.get(current)
            depth += 1
        if current is not None and current not in removed_ids and current != orig:
            updates[job_id] = current

    count = 0
    for jid, new_orig in updates.items():
        await db.execute(
            update(ScrapedJob)
            .where(ScrapedJob.id == jid)
            .values(dedup_original_job_id=new_orig)
        )
        count += 1
    return count


async def _run_hash_exact(
    hash_input: list[uuid.UUID],
    db: AsyncSession,
) -> tuple[dict[uuid.UUID, Pass2Flag], dict[str, int]]:
    gate = {"checked": 0, "flagged": 0, "duration_ms": 0}
    if not hash_input:
        return {}, gate
    t0 = time.monotonic()
    hid = set(hash_input)
    rows = (
        await db.execute(
            select(ScrapedJob.id, ScrapedJob.raw_description_hash, ScrapedJob.created_at).where(
                ScrapedJob.id.in_(hid),
                ScrapedJob.raw_description_hash.isnot(None),
            )
        )
    ).all()
    by_hash: dict[str, list[tuple[uuid.UUID, datetime]]] = defaultdict(list)
    for jid, rh, cat in rows:
        if rh:
            by_hash[rh].append((jid, cat))
    flagged: dict[uuid.UUID, Pass2Flag] = {}
    for _h, group in by_hash.items():
        if len(group) < 2:
            continue
        rows_sorted = sorted(group, key=lambda x: x[1])
        oldest_id = rows_sorted[0][0]
        for jid, _cat in rows_sorted[1:]:
            flagged[jid] = ("already_scraped", None, oldest_id)
    gate["checked"] = len(rows)
    gate["flagged"] = len(flagged)
    gate["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return flagged, gate


async def _run_cosine(
    cosine_input: list[uuid.UUID],
    already_flagged_ids: set[uuid.UUID],
    exclude_pass_ids: set[uuid.UUID],
    db: AsyncSession,
    config: SearchConfigRead,
    settings: Settings,
) -> tuple[dict[uuid.UUID, Pass2Flag], dict[str, int]]:
    gate = {"checked": 0, "flagged": 0, "duration_ms": 0}
    flagged: dict[uuid.UUID, Pass2Flag] = {}
    cosine_set = set(cosine_input)
    batch_size = max(1, settings.dedup_cosine_batch_size)
    threshold = config.dedup_fuzzy_threshold / 100.0
    t_cos = time.monotonic()
    if not cosine_set:
        gate["duration_ms"] = int((time.monotonic() - t_cos) * 1000)
        JhaTrace.emit(
            "pass_2_cosine_start",
            {
                "stage": "pass_2_cosine",
                "corpus_size": 0,
                "batch_size": batch_size,
                "threshold": threshold,
            },
        )
        JhaTrace.emit(
            "pass_2_cosine_done",
            {
                "stage": "pass_2_cosine",
                "total_flagged": 0,
                "cosine_flagged_so_far_size": 0,
                "duration_ms": gate["duration_ms"],
            },
        )
        return flagged, gate

    total_count = (await db.execute(select(func.count()).select_from(ScrapedJob))).scalar_one()
    if config.dedup_fuzzy_threshold == 0 or total_count < 10:
        gate["duration_ms"] = int((time.monotonic() - t_cos) * 1000)
        JhaTrace.emit(
            "pass_2_cosine_start",
            {
                "stage": "pass_2_cosine",
                "corpus_size": 0,
                "batch_size": batch_size,
                "threshold": threshold,
            },
        )
        JhaTrace.emit(
            "pass_2_cosine_done",
            {
                "stage": "pass_2_cosine",
                "total_flagged": 0,
                "cosine_flagged_so_far_size": 0,
                "duration_ms": gate["duration_ms"],
            },
        )
        return flagged, gate

    t_cos = time.monotonic()
    try:
        exclude_for_extra = exclude_pass_ids | already_flagged_ids
        extra_q = select(ScrapedJob.id).where(
            ScrapedJob.skip_reason.is_(None),
            ScrapedJob.id.notin_(list(cosine_set)),
        )
        if exclude_for_extra:
            extra_q = extra_q.where(ScrapedJob.id.notin_(list(exclude_for_extra)))
        extra = (await db.execute(extra_q)).scalars().all()
        corpus_ids = cosine_set | set(extra)

        rows = (
            await db.execute(
                select(ScrapedJob.id, ScrapedJob.job_description, ScrapedJob.created_at).where(
                    ScrapedJob.id.in_(corpus_ids)
                )
            )
        ).all()

        corpus: list[tuple[uuid.UUID, str, datetime]] = []
        for jid, text, cat in rows:
            t = (text or "").strip()
            if t:
                corpus.append((jid, t, cat))

        batch_size = max(1, settings.dedup_cosine_batch_size)
        threshold = config.dedup_fuzzy_threshold / 100.0

        if len(corpus) < 2:
            gate["duration_ms"] = int((time.monotonic() - t_cos) * 1000)
            JhaTrace.emit(
                "pass_2_cosine_start",
                {
                    "stage": "pass_2_cosine",
                    "corpus_size": len(corpus),
                    "batch_size": batch_size,
                    "threshold": threshold,
                },
            )
            JhaTrace.emit(
                "pass_2_cosine_done",
                {
                    "stage": "pass_2_cosine",
                    "total_flagged": gate["flagged"],
                    "cosine_flagged_so_far_size": 0,
                    "duration_ms": gate["duration_ms"],
                },
            )
            return flagged, gate

        texts = [c[1] for c in corpus]
        vectorizer = TfidfVectorizer(max_features=10000)
        tfidf_matrix = vectorizer.fit_transform(texts)

        cosine_flagged_so_far: set[uuid.UUID] = set()

        JhaTrace.emit(
            "pass_2_cosine_start",
            {
                "stage": "pass_2_cosine",
                "corpus_size": len(corpus),
                "batch_size": batch_size,
                "threshold": threshold,
            },
        )

        for batch_index, i in enumerate(range(0, len(corpus), batch_size)):
            n_before = len(flagged)
            batch_vectors = tfidf_matrix[i : i + batch_size]
            sim_matrix = cosine_similarity(batch_vectors, tfidf_matrix)
            for row_idx, row in enumerate(corpus[i : i + batch_size]):
                job_id, _text, job_created_at = row
                if job_id not in cosine_set:
                    continue
                if job_id in cosine_flagged_so_far:
                    continue
                for col_idx, other in enumerate(corpus):
                    if job_id in cosine_flagged_so_far:
                        break
                    other_id, _ot, other_created_at = other
                    if job_id == other_id:
                        continue
                    if other_id in already_flagged_ids:
                        continue
                    if other_id in cosine_flagged_so_far:
                        continue
                    score = float(sim_matrix[row_idx][col_idx])
                    if score >= threshold:
                        if job_created_at > other_created_at:
                            flagged[job_id] = ("already_scraped", score, other_id)
                            cosine_flagged_so_far.add(job_id)
                        elif other_created_at > job_created_at and other_id in cosine_set:
                            if job_id in cosine_flagged_so_far:
                                continue
                            flagged[other_id] = ("already_scraped", score, job_id)
                            cosine_flagged_so_far.add(other_id)
            batch_flagged = len(flagged) - n_before
            JhaTrace.emit(
                "pass_2_cosine_batch",
                {
                    "stage": "pass_2_cosine",
                    "batch_index": batch_index,
                    "batch_size": min(batch_size, len(corpus) - i),
                    "batch_flagged": batch_flagged,
                },
            )

        gate["checked"] = sum(1 for c in corpus if c[0] in cosine_set)
        gate["flagged"] = sum(
            1
            for jid in cosine_set
            if jid in flagged and flagged[jid][1] is not None
        )
        gate["duration_ms"] = int((time.monotonic() - t_cos) * 1000)
        JhaTrace.emit(
            "pass_2_cosine_done",
            {
                "stage": "pass_2_cosine",
                "total_flagged": gate["flagged"],
                "cosine_flagged_so_far_size": len(cosine_flagged_so_far),
                "duration_ms": gate["duration_ms"],
            },
        )
    except Exception as e:
        logger.warning("Cosine dedup failed: %s", e, exc_info=True)
        gate["duration_ms"] = int((time.monotonic() - t_cos) * 1000)
        JhaTrace.emit(
            "pass_2_cosine_done",
            {
                "stage": "pass_2_cosine",
                "total_flagged": gate["flagged"],
                "cosine_flagged_so_far_size": 0,
                "duration_ms": gate["duration_ms"],
            },
        )

    return flagged, gate


async def run_pass_2(
    surviving_ids: list[uuid.UUID],
    pass0_flags: dict[uuid.UUID, str],
    pass1_flags: dict[uuid.UUID, str],
    db: AsyncSession,
    config: SearchConfigRead,
    settings: Settings,
) -> tuple[dict[uuid.UUID, Pass2Flag], dict[str, dict[str, int]]]:
    """
    Sequential sub-gates: hash_exact → cosine. Cosine never runs on hash-flagged ids.
    (URL exact removed: job_url is unique at ingest.)
    """
    gate_times = {
        "hash_exact": {"checked": 0, "flagged": 0, "duration_ms": 0},
        "cosine": {"checked": 0, "flagged": 0, "duration_ms": 0},
    }
    flagged: dict[uuid.UUID, Pass2Flag] = {}
    sid = list(surviving_ids)
    if not sid:
        return flagged, gate_times

    hash_flagged, hash_gate = await _run_hash_exact(sid, db)
    flagged.update(hash_flagged)
    gate_times["hash_exact"] = hash_gate
    JhaTrace.emit(
        "pass_2_hash_done",
        {
            "stage": "pass_2_hash",
            "checked": hash_gate["checked"],
            "flagged": hash_gate["flagged"],
            "duration_ms": hash_gate["duration_ms"],
        },
    )

    cosine_input = [i for i in sid if i not in flagged]
    already_flagged_ids = set(hash_flagged.keys())
    exclude_pass_ids = set(pass0_flags) | set(pass1_flags)
    cos_flagged, cos_gate = await _run_cosine(
        cosine_input, already_flagged_ids, exclude_pass_ids, db, config, settings
    )
    flagged.update(cos_flagged)
    gate_times["cosine"] = cos_gate

    return flagged, gate_times


def _dedup_config_snapshot(config: SearchConfigRead) -> dict:
    return {
        "blacklist_companies": list(config.blacklist_companies or []),
        "blacklist_locations": list(config.blacklist_locations or []),
        "blacklist_titles": list(config.blacklist_titles or []),
        "target_titles": list(config.target_titles or []),
        "allowed_languages": list(config.allowed_languages or []),
        "no_contract": config.no_contract,
        "remote_only": config.remote_only,
        "needs_sponsorship": config.needs_sponsorship,
        "no_agency": config.no_agency,
        "dedup_fuzzy_threshold": config.dedup_fuzzy_threshold,
    }


async def run_dedup(
    db: AsyncSession,
    config: SearchConfigRead,
    settings: Settings,
    scan_run_id: uuid.UUID | None = None,
    trigger: str = "manual",
) -> DedupReportRead:
    with trace_scope("dedup") as buffer:
        t_start = time.monotonic()
        try:
            result = await db.execute(
                select(ScrapedJob).where(ScrapedJob.skip_reason.is_(None))
            )
            jobs: list[ScrapedJob] = list(result.scalars().all())
            total_processed = len(jobs)

            JhaTrace.emit(
                "run_start",
                {
                    "stage": "dedup",
                    "total_processed": total_processed,
                    "trigger": trigger,
                    "scan_run_id": str(scan_run_id) if scan_run_id else None,
                    "config_snapshot": _dedup_config_snapshot(config),
                },
            )

            gate_results = _empty_gate_results()

            pass0_flags: dict[uuid.UUID, str] = {}
            t0 = time.monotonic()
            for job in jobs:
                r = run_pass_0(
                    job.job_title or "",
                    job.company or "",
                    job.location or "",
                    config,
                )
                if r:
                    pass0_flags[job.id] = r
            gate_results["pass_0"]["checked"] = total_processed
            gate_results["pass_0"]["flagged"] = len(pass0_flags)
            gate_results["pass_0"]["duration_ms"] = int((time.monotonic() - t0) * 1000)
            JhaTrace.emit(
                "pass_0_done",
                {
                    "stage": "dedup",
                    "checked": gate_results["pass_0"]["checked"],
                    "flagged": gate_results["pass_0"]["flagged"],
                    "duration_ms": gate_results["pass_0"]["duration_ms"],
                    "flag_counts": dict(Counter(pass0_flags.values())),
                },
            )

            pass1_flags = _pass1_metrics_linear(jobs, pass0_flags, config, gate_results)
            JhaTrace.emit(
                "pass_1_done",
                {
                    "stage": "dedup",
                    "checked": sum(gate_results[g]["checked"] for g in PASS1_GATE_ORDER),
                    "flagged": len(pass1_flags),
                    "duration_ms": sum(gate_results[g]["duration_ms"] for g in PASS1_GATE_ORDER),
                    "flag_counts": {g: gate_results[g]["flagged"] for g in PASS1_GATE_ORDER},
                },
            )

            surviving_ids = [
                j.id
                for j in jobs
                if j.id not in pass0_flags and j.id not in pass1_flags
            ]

            pass2_flags, pass2_times = await run_pass_2(
                surviving_ids, pass0_flags, pass1_flags, db, config, settings
            )
            pass2_flags, chain_meta = _resolve_chains(pass2_flags)
            JhaTrace.emit(
                "chain_resolve_done",
                {"stage": "dedup", **chain_meta},
            )
            for k, v in pass2_times.items():
                gate_results[k] = v

            all_flags: dict[uuid.UUID, Pass2Flag] = {}
            for jid, reason in pass0_flags.items():
                all_flags[jid] = (reason, None, None)
            for jid, reason in pass1_flags.items():
                all_flags[jid] = (reason, None, None)
            for jid, trip in pass2_flags.items():
                if jid not in all_flags:
                    all_flags[jid] = trip

            skip_reason_counts: dict[str, int] = defaultdict(int)
            for _jid, (reason, _s, _o) in all_flags.items():
                skip_reason_counts[reason] += 1

            for jid, (reason, score, orig_id) in all_flags.items():
                if reason == "already_scraped":
                    await db.execute(
                        update(ScrapedJob)
                        .where(ScrapedJob.id == jid, ScrapedJob.skip_reason.is_(None))
                        .values(
                            skip_reason=reason,
                            dedup_similarity_score=score if score is not None else None,
                            dedup_original_job_id=orig_id,
                        )
                    )
                else:
                    await db.execute(
                        update(ScrapedJob)
                        .where(ScrapedJob.id == jid, ScrapedJob.skip_reason.is_(None))
                        .values(skip_reason=reason, dedup_original_job_id=None)
                    )

            total_flagged = len(all_flags)
            total_passed = total_processed - total_flagged
            duration_ms = int((time.monotonic() - t_start) * 1000)

            gate_payload = {
                k: GateResult(
                    checked=v["checked"],
                    flagged=v["flagged"],
                    duration_ms=v["duration_ms"],
                )
                for k, v in gate_results.items()
            }

            report = DedupReport(
                scan_run_id=scan_run_id,
                trigger=trigger,
                total_processed=total_processed,
                total_flagged=total_flagged,
                total_passed=total_passed,
                gate_results={k: val.model_dump() for k, val in gate_payload.items()},
                skip_reason_counts=dict(skip_reason_counts),
                duration_ms=duration_ms,
            )
            db.add(report)
            await db.flush()
            await db.refresh(report)

            JhaTrace.emit(
                "run_end",
                {
                    "stage": "dedup",
                    "total_flagged": total_flagged,
                    "total_passed": total_passed,
                    "duration_ms": duration_ms,
                    "report_id": report.id,
                },
            )

            await flush_trace_to_report(
                db,
                report_model_cls=DedupReport,
                report_id=report.id,
                buffer=buffer,
                ring_size=settings.debug_log_ring_size,
            )
            await db.refresh(report)

            return DedupReportRead(
                id=report.id,
                scan_run_id=report.scan_run_id,
                trigger=report.trigger,
                total_processed=report.total_processed,
                total_flagged=report.total_flagged,
                total_passed=report.total_passed,
                gate_results=gate_payload,
                skip_reason_counts=dict(report.skip_reason_counts or {}),
                duration_ms=report.duration_ms,
                debug_log=report.debug_log,
                created_at=report.created_at,
            )
        except Exception as exc:
            await db.rollback()
            empty_gates = _empty_gate_results()
            stub = DedupReport(
                scan_run_id=scan_run_id,
                trigger=trigger,
                total_processed=0,
                total_flagged=0,
                total_passed=0,
                gate_results=empty_gates,
                skip_reason_counts={},
                duration_ms=int((time.monotonic() - t_start) * 1000),
            )
            db.add(stub)
            await db.flush()
            JhaTrace.emit(
                "run_crash",
                {
                    "stage": "dedup",
                    "error_class": type(exc).__name__,
                    "error_msg": str(exc)[:500],
                },
                level="error",
            )
            await flush_trace_to_report(
                db,
                report_model_cls=DedupReport,
                report_id=stub.id,
                buffer=buffer,
                ring_size=settings.debug_log_ring_size,
            )
            await db.commit()
            raise
