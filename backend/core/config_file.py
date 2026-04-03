"""Shared JSON config file read/write (used by config and dedup routers)."""

import json
from pathlib import Path

import aiofiles
from fastapi import HTTPException

from core.config import settings

_config_path = Path(settings.config_path)


async def read_config_file() -> dict:
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


async def write_config_file(data: dict) -> None:
    async with aiofiles.open(_config_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
