from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.database import get_db
from matching.normaliser import _load_aliases, skill_in_alias_lookup
from matching.skill_aliases_persist import (
    add_alias_to_canonical,
    find_canonical_key,
    load_raw_aliases_file,
    save_raw_aliases_file,
)
from models.skill_candidate import SkillCandidate
from schemas.skill_candidate import (
    RefreshAliasesResponse,
    SkillCandidateApproveRequest,
    SkillCandidateMergeRequest,
    SkillCandidateRead,
    SkillCandidatesListResponse,
    SkillCandidateStatsResponse,
)

router = APIRouter(prefix="/skills", tags=["skills"])


def _skill_to_read(row: SkillCandidate) -> SkillCandidateRead:
    return SkillCandidateRead(
        id=row.id,
        skill_name=row.skill_name,
        count=row.count,
        req_count=row.req_count,
        nth_count=row.nth_count,
        in_aliases=row.in_aliases,
        status=row.status,
        suggested_canonical=row.suggested_canonical,
        merge_target=row.merge_target,
        first_seen=row.first_seen,
        last_seen=row.last_seen,
        reviewed_at=row.reviewed_at,
    )


@router.get("/candidates/stats", response_model=SkillCandidateStatsResponse)
async def skill_candidate_stats(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    total_unique = await db.scalar(select(func.count()).select_from(SkillCandidate)) or 0
    total_in_aliases = (
        await db.scalar(
            select(func.count()).select_from(SkillCandidate).where(SkillCandidate.in_aliases.is_(True))
        )
        or 0
    )
    total_unknown = (
        await db.scalar(
            select(func.count()).select_from(SkillCandidate).where(SkillCandidate.in_aliases.is_(False))
        )
        or 0
    )
    total_occurrences = await db.scalar(select(func.coalesce(func.sum(SkillCandidate.count), 0))) or 0
    pending_review = (
        await db.scalar(
            select(func.count())
            .select_from(SkillCandidate)
            .where(SkillCandidate.status == "pending", SkillCandidate.in_aliases.is_(False))
        )
        or 0
    )

    top_q = (
        select(SkillCandidate.skill_name, SkillCandidate.count)
        .where(SkillCandidate.in_aliases.is_(False))
        .order_by(desc(SkillCandidate.count))
        .limit(10)
    )
    top_rows = (await db.execute(top_q)).all()
    top_unknown = [{"skill_name": r[0], "count": r[1]} for r in top_rows]

    return SkillCandidateStatsResponse(
        total_unique_skills=int(total_unique),
        total_in_aliases=int(total_in_aliases),
        total_unknown=int(total_unknown),
        total_occurrences=int(total_occurrences),
        top_unknown=top_unknown,
        pending_review=int(pending_review),
    )


@router.get("/candidates", response_model=SkillCandidatesListResponse)
async def list_skill_candidates(
    status: str = Query("all", description="all | pending | approved | rejected | merged"),
    in_aliases: bool | None = Query(None),
    sort_by: str = Query("count", description="count | first_seen | last_seen"),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    allowed_status = {"all", "pending", "approved", "rejected", "merged"}
    if status not in allowed_status:
        raise HTTPException(status_code=422, detail=f"status must be one of {sorted(allowed_status)}")
    if sort_by not in ("count", "first_seen", "last_seen"):
        raise HTTPException(status_code=422, detail="sort_by must be count, first_seen, or last_seen")

    conditions = []
    if status != "all":
        conditions.append(SkillCandidate.status == status)
    if in_aliases is not None:
        conditions.append(SkillCandidate.in_aliases.is_(bool(in_aliases)))

    count_stmt = select(func.count()).select_from(SkillCandidate)
    if conditions:
        count_stmt = count_stmt.where(*conditions)
    total = await db.scalar(count_stmt)
    if total is None:
        total = 0

    stmt = select(SkillCandidate)
    if conditions:
        stmt = stmt.where(*conditions)

    total_unknown = (
        await db.scalar(
            select(func.count()).select_from(SkillCandidate).where(SkillCandidate.in_aliases.is_(False))
        )
        or 0
    )
    total_known = (
        await db.scalar(
            select(func.count()).select_from(SkillCandidate).where(SkillCandidate.in_aliases.is_(True))
        )
        or 0
    )

    order_col = SkillCandidate.count
    order_fn = desc
    if sort_by == "first_seen":
        order_col = SkillCandidate.first_seen
        order_fn = desc
    elif sort_by == "last_seen":
        order_col = SkillCandidate.last_seen
        order_fn = desc
    stmt = stmt.order_by(order_fn(order_col)).offset(offset).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()

    return SkillCandidatesListResponse(
        items=[_skill_to_read(r) for r in rows],
        total=int(total),
        total_unknown=int(total_unknown),
        total_known=int(total_known),
    )


@router.put("/candidates/{candidate_id}/approve", response_model=SkillCandidateRead)
async def approve_skill_candidate(
    candidate_id: int,
    body: SkillCandidateApproveRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(SkillCandidate, candidate_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found")

    canonical = (body.suggested_canonical or row.skill_name).strip()
    if not canonical:
        raise HTTPException(status_code=422, detail="suggested_canonical or skill_name required")

    raw = load_raw_aliases_file()
    key = find_canonical_key(raw, canonical)
    if key:
        lst = raw[key]
        if not isinstance(lst, list):
            lst = []
            raw[key] = lst
        if row.skill_name != key and row.skill_name not in lst:
            lst.append(row.skill_name)
    else:
        raw[canonical] = []
        if row.skill_name != canonical:
            raw[canonical].append(row.skill_name)
    save_raw_aliases_file(raw)

    now = datetime.now(timezone.utc)
    row.status = "approved"
    row.reviewed_at = now
    if body.suggested_canonical:
        row.suggested_canonical = body.suggested_canonical.strip()
    row.in_aliases = skill_in_alias_lookup(row.skill_name)
    await db.flush()
    await db.commit()
    await db.refresh(row)
    return _skill_to_read(row)


@router.put("/candidates/{candidate_id}/merge", response_model=SkillCandidateRead)
async def merge_skill_candidate(
    candidate_id: int,
    body: SkillCandidateMergeRequest,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(SkillCandidate, candidate_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found")

    raw = load_raw_aliases_file()
    key = find_canonical_key(raw, body.merge_target)
    if not key:
        raise HTTPException(
            status_code=422,
            detail=f"merge_target {body.merge_target!r} is not an existing canonical",
        )

    add_alias_to_canonical(key, row.skill_name)

    now = datetime.now(timezone.utc)
    row.status = "merged"
    row.merge_target = key
    row.reviewed_at = now
    row.in_aliases = skill_in_alias_lookup(row.skill_name)
    await db.flush()
    await db.commit()
    await db.refresh(row)
    return _skill_to_read(row)


@router.put("/candidates/{candidate_id}/reject", response_model=SkillCandidateRead)
async def reject_skill_candidate(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    row = await db.get(SkillCandidate, candidate_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found")

    now = datetime.now(timezone.utc)
    row.status = "rejected"
    row.reviewed_at = now
    await db.flush()
    await db.commit()
    await db.refresh(row)
    return _skill_to_read(row)


@router.post("/candidates/refresh-aliases", response_model=RefreshAliasesResponse)
async def refresh_skill_candidate_aliases(
    db: AsyncSession = Depends(get_db),
    _user: dict = Depends(get_current_user),
):
    _load_aliases.cache_clear()
    rows = (await db.execute(select(SkillCandidate))).scalars().all()
    updated = 0
    for row in rows:
        new_flag = skill_in_alias_lookup(row.skill_name)
        if row.in_aliases != new_flag:
            row.in_aliases = new_flag
            updated += 1
    await db.commit()
    return RefreshAliasesResponse(updated=updated)
