import json
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, HTTPException

from core.auth import get_current_user
from core.config import settings
from schemas.config import SearchConfigRead, SearchConfigUpdate

router = APIRouter(prefix="/config", tags=["config"])

_config_path = Path(settings.config_path)


async def _read_config_file() -> dict:
    if not _config_path.exists():
        return {}
    try:
        async with aiofiles.open(_config_path, "r", encoding="utf-8") as f:
            raw = await f.read()
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"config.json is malformed: {exc}",
        )


async def _write_config_file(data: dict) -> None:
    async with aiofiles.open(_config_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


@router.get("", response_model=SearchConfigRead)
async def get_config(_user: dict = Depends(get_current_user)):
    data = await _read_config_file()
    return SearchConfigRead(**data)


@router.put("", response_model=SearchConfigRead)
async def update_config(
    body: SearchConfigUpdate,
    _user: dict = Depends(get_current_user),
):
    existing = await _read_config_file()
    updates = body.model_dump(exclude_unset=True)
    existing.update(updates)
    await _write_config_file(existing)
    return SearchConfigRead(**existing)
