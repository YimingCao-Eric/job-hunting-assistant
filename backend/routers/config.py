from fastapi import APIRouter, Depends

from core.auth import get_current_user
from core.config_file import read_config_file, write_config_file
from schemas.config import SearchConfigRead, SearchConfigUpdate

router = APIRouter(prefix="/config", tags=["config"])


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
    await write_config_file(existing)
    return SearchConfigRead(**existing)
