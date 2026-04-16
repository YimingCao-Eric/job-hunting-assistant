from fastapi import APIRouter, Depends, HTTPException

from core.auth import get_current_user
from core.config_file import read_config_file, write_config_file
from schemas.config import SearchConfigRead, SearchConfigUpdate

router = APIRouter(prefix="/config", tags=["config"])


def _validate_scoring_config(merged: dict) -> None:
    try:
        nth_bonus_weight = float(merged.get("nth_bonus_weight", 0.10))
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail="nth_bonus_weight must be a number",
        ) from exc
    if not (0.0 <= nth_bonus_weight <= 1.0):
        raise HTTPException(
            status_code=422,
            detail="nth_bonus_weight must be between 0.0 and 1.0",
        )
    strong = float(merged.get("cpu_strong_threshold", 0.85))
    binary = float(merged.get("cpu_binary_threshold", 0.50))
    if not (0.0 < strong <= 1.0):
        raise HTTPException(
            status_code=422,
            detail="cpu_strong_threshold must be between 0 and 1",
        )
    if not (0.0 < binary < strong):
        raise HTTPException(
            status_code=422,
            detail="cpu_binary_threshold must be less than cpu_strong_threshold",
        )


@router.get("", response_model=SearchConfigRead)
async def get_config(_user: dict = Depends(get_current_user)):
    data = await read_config_file()
    return SearchConfigRead(**data)


@router.put("", response_model=SearchConfigRead)
async def update_config(
    body: SearchConfigUpdate,
    _user: dict = Depends(get_current_user),
):
    existing = await read_config_file()
    updates = body.model_dump(exclude_unset=True)
    existing.update(updates)
    existing.pop("fit_score_req_weight", None)
    existing.pop("fit_score_nth_weight", None)
    _validate_scoring_config(existing)
    await write_config_file(existing)
    return SearchConfigRead(**existing)
